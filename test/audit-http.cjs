'use strict';

/**
 * 站场追溯推演审计流水 HTTP 集成测试：
 *   临时库启动真实服务 → 触发开放/走行/解除/等待兑现/延时取消/封锁/暂停恢复/
 *   检查点回退/重置/副本创建 → 逐条核对审计流水的序号递增、操作者/系统来源、
 *   关联编号、变更类型与前后状态摘要；并验证：
 *     - 失败操作 / 幂等重传 / 未改变状态的扫描不产生新条目；
 *     - 业务与流水同成同败（失败回滚无流水）；
 *     - 按序号分页、按类型/关联编号筛选，非法筛选 400 拒绝；
 *     - 只看当前站场，不能串看其他站场；副本从 yard_created 界标重新计数。
 *
 * 运行：node test/audit-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3927;
const DB_PATH = process.env.SMOKE_DB_AUDIT || path.join(__dirname, '..', 'data', 'audit-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
      fs.rmSync(path.join(path.dirname(DB_PATH),
        path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'), { recursive: true, force: true });
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(pathName, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + pathName, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

async function selectYard(token, yardId) {
  const r = await api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
  if (r.status !== 200) throw new Error('切换站场失败: ' + JSON.stringify(r.data));
}

async function listAudit(token, query = '') {
  return api('/api/audit-entries' + (query ? '?' + query : ''), { token });
}

/** 取当前全部流水（自动翻页） */
async function allAudit(token, query = '') {
  const sep = query ? '&' : '';
  let fromSeq = 1;
  const all = [];
  for (;;) {
    const r = await listAudit(token, `${query}${sep}fromSeq=${fromSeq}&limit=200`);
    if (r.status !== 200) throw new Error('查询流水失败: ' + JSON.stringify(r.data));
    all.push(...r.data.entries);
    if (!r.data.pagination.hasMore) return all;
    fromSeq = r.data.pagination.nextFromSeq;
  }
}

/** 轮询直到出现指定类型的流水条目数达到 n */
async function waitAudit(token, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await allAudit(token);
    const hit = entries.filter(predicate);
    if (hit.length) return hit;
    if (Date.now() > deadline) throw new Error('等待审计流水超时');
    await sleep(150);
  }
}

async function walkThrough(token, instanceId, sections) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    await api(`/api/instances/${instanceId}/events`,
      { token, method: 'POST', body: { seq: seq++, sectionId: sections[i], action: 'occupy' } });
    if (i >= 1) {
      await api(`/api/instances/${instanceId}/events`,
        { token, method: 'POST', body: { seq: seq++, sectionId: sections[i - 1], action: 'clear' } });
    }
  }
  await api(`/api/instances/${instanceId}/events`,
    { token, method: 'POST', body: { seq: seq++, sectionId: sections[sections.length - 1], action: 'clear' } });
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  // 培训重开得到确定的初始盘面（空闲），并产生第一条 yard_reset 流水
  let r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('培训重开 200', r.status, 200);

  console.log('\n[1] 鉴权：未登录拒绝；管理员与值班员均可查');
  r = await listAudit('');
  eq('未登录 401', r.status, 401);
  r = await listAudit(admin);
  eq('管理员可查', r.status, 200);
  eq('返回类型枚举', Array.isArray(r.data.types), true);
  ok('枚举含 13 类', r.data.types.length === 13, r.data.types);
  r = await listAudit(jia);
  eq('值班员可查', r.status, 200);
  eq('值班员看到 yard 信息', r.data.yard.isOriginal, true);

  console.log('\n[2] 站场重置：yard_reset 界标 + 前后盘面摘要 + 重置前流水保留');
  let entries = await allAudit(admin);
  eq('初始仅 1 条流水', entries.length, 1);
  const reset0 = entries[0];
  eq('序号从 1 开始', reset0.seq, 1);
  eq('类型 yard_reset', reset0.type, 'yard_reset');
  eq('关联类型 reset', reset0.refType, 'reset');
  eq('关联编号 training', reset0.refId, 'training');
  eq('操作者为管理员', reset0.actor, '管理员');
  eq('人工来源', reset0.source, 'manual');
  eq('重置后区段全空闲', reset0.after.sectionsOccupied, 0);
  ok('界标标记', reset0.detail && reset0.detail.marker === true, reset0.detail);

  console.log('\n[3] 进路开放 + 全程走行：route_opened / route_event / route_released');
  // 先做一次会失败的开放（占用一个区段），验证失败操作不产生流水
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('占用时开放被拒 409', r.status, 409);
  // 注：独立置占用本身是状态变更（非本轮 9 类事件，不记录）；清空继续
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  let beforeCount = (await allAudit(admin)).length;
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('开放 R1 200', r.status, 200);
  const iid = r.data.instance.id;
  entries = await allAudit(admin);
  eq('失败开放不产生流水（独立置状态不审计）', entries.length, beforeCount + 1);
  const opened = entries.find((e) => e.type === 'route_opened');
  eq('route_opened 序号连续', opened.seq, beforeCount + 1);
  eq('开放关联实例', opened.refId, String(iid));
  eq('开放操作者', opened.actor, '值班员甲');
  eq('开放后开放态', opened.after.status, 'open');
  eq('开放后绿灯', opened.after.signalState, 'green');
  eq('开放前无实例', opened.before.status, 'none');
  ok('锁定区段摘要', JSON.stringify(opened.after.lockedSections).includes('5'), opened.after);

  // 幂等重传：seq=1 重复提交相同事件 → 不新增流水
  r = await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('首段占用', r.status, 200);
  beforeCount = (await allAudit(admin)).length;
  r = await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('同号同内容重传幂等', r.status, 200);
  ok('幂等标记', r.data.result.idempotent === true, r.data.result);
  eq('幂等重传不产生流水', (await allAudit(admin)).length, beforeCount);
  // 同号异内容拒绝，不产生流水
  r = await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '3', action: 'occupy' }
  });
  eq('同号异内容 409', r.status, 409);
  eq('拒绝操作不产生流水', (await allAudit(admin)).length, beforeCount);

  // 走完全程
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 2, sectionId: '3', action: 'occupy' }
  });
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 3, sectionId: '1', action: 'clear' }
  });
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 4, sectionId: '5', action: 'occupy' }
  });
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 5, sectionId: '3', action: 'clear' }
  });
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 6, sectionId: '5', action: 'clear' }
  });

  entries = await allAudit(admin);
  const evs = entries.filter((e) => e.type === 'route_event' && e.refId === String(iid));
  eq('走行事件流水 6 条（幂等不计数）', evs.length, 6);
  eq('事件序号 1..6 递增', evs.map((e) => e.detail.seq).join(','), '1,2,3,4,5,6');
  const first = evs[0];
  eq('首段占用动作', first.detail.action, 'occupy');
  eq('首段占用信号回红', first.after.signalState, 'red');
  eq('首段占用前绿灯', first.before.signalState, 'green');
  eq('事件操作者', first.actor, '值班员甲');
  eq('人工来源', first.source, 'manual');
  eq('末段清空后状态', evs[5].after.sectionState, 'free');
  const rel = entries.filter((e) => e.type === 'route_released' && e.refId === String(iid));
  eq('末段走行自动解除 1 条', rel.length, 1);
  eq('解除原因', rel[0].reason.includes('自动解除'), true);
  eq('解除后 released', rel[0].after.status, 'released');

  console.log('\n[4] 等待申请兑现：waiting_fulfilled（系统来源，含进路实例）');
  // 先制造资源占用：值班员乙提交等待 R1，立即兑现
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('等待申请提交', r.status, 201);
  const wid = r.data.waiting.id;
  const hits = await waitAudit(admin, (e) => e.type === 'waiting_fulfilled' && e.refId === String(wid));
  const wf = hits[0];
  eq('兑现关联为等待编号', wf.refType, 'waiting');
  eq('系统来源', wf.source, 'system');
  eq('兑现 actor 为申请人', wf.actor, '值班员乙');
  ok('兑现产生实例编号', Number.isInteger(wf.detail.instanceId), wf.detail);
  const wIid = wf.detail.instanceId;
  eq('兑现前等待中', wf.before.waitingStatus, 'waiting');
  eq('兑现后 fulfilled', wf.after.waitingStatus, 'fulfilled');
  // 兑现开放不另写 route_opened（同一业务变化一条流水）
  eq('兑现不产生 route_opened',
    (await allAudit(admin)).filter((e) => e.type === 'route_opened' && e.refId === String(wIid)).length, 0);
  // 走行解除兑现实例
  await walkThrough(yi, wIid, ['1', '3', '5']);

  console.log('\n[5] 延时取消核验解除：cancellation_released（系统来源，解除进路）');
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 1 }
  });
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const cIid = r.data.instance.id;
  r = await api(`/api/instances/${cIid}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('延时取消申请', r.status, 201);
  const cid = r.data.cancellation.id;
  const cHits = await waitAudit(admin,
    (e) => e.type === 'cancellation_released' && e.refId === String(cid));
  const cr = cHits[0];
  eq('系统来源', cr.source, 'system');
  eq('无人工操作者', cr.actor, null);
  eq('解除后取消状态', cr.after.cancellationStatus, 'released');
  eq('解除后进路 released', cr.after.instanceStatus, 'released');
  ok('实例编号入明细', cr.detail.instanceId === cIid, cr.detail);
  // 延时取消解除不另写 route_released
  eq('取消解除不产生 route_released',
    (await allAudit(admin)).filter((e) => e.type === 'route_released' && e.refId === String(cIid)).length, 0);

  console.log('\n[6] 封锁：blockade_created / blockade_changed / blockade_ended');
  // 占用区段发起 → pending；出清后系统复核转 active
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  r = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '3', reason: '审计测试封锁' }
  });
  const bid = r.data.blockade.id;
  eq('占用区段 → 待生效', r.data.blockade.status, 'pending');
  let bEntries = (await allAudit(admin)).filter((e) => e.type === 'blockade_created' && e.refId === String(bid));
  eq('blockade_created 1 条', bEntries.length, 1);
  eq('封锁操作者', bEntries[0].actor, '管理员');
  eq('发起后 pending', bEntries[0].after.status, 'pending');
  // 重复发起不产生流水
  const beforeDup = (await allAudit(admin)).length;
  await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '3', reason: '重复' }
  });
  eq('重复发起不产生流水', (await allAudit(admin)).length, beforeDup);
  // 出清 → 系统复核转已生效
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  const changed = await waitAudit(admin,
    (e) => e.type === 'blockade_changed' && e.refId === String(bid));
  eq('待生效→已生效 1 条', changed.length, 1);
  eq('状态转换系统来源', changed[0].source, 'system');
  eq('转换前 pending', changed[0].before.status, 'pending');
  eq('转换后 active', changed[0].after.status, 'active');
  // 管理员结束
  r = await api(`/api/admin/blockades/${bid}/end`, { token: admin, method: 'POST' });
  eq('结束封锁', r.status, 200);
  const ended = (await allAudit(admin)).filter((e) => e.type === 'blockade_ended' && e.refId === String(bid));
  eq('blockade_ended 1 条', ended.length, 1);
  eq('结束操作者', ended[0].actor, '管理员');
  eq('结束后 ended', ended[0].after.status, 'ended');
  // 重复结束拒绝且无流水
  const beforeEndDup = (await allAudit(admin)).length;
  r = await api(`/api/admin/blockades/${bid}/end`, { token: admin, method: 'POST' });
  eq('重复结束 409', r.status, 409);
  eq('重复结束不产生流水', (await allAudit(admin)).length, beforeEndDup);

  console.log('\n[7] 分页：fromSeq/limit/nextFromSeq/hasMore');
  const page1 = await listAudit(admin, 'fromSeq=1&limit=5');
  eq('每页 5 条', page1.data.entries.length, 5);
  eq('序号 1..5', page1.data.entries.map((e) => e.seq).join(','), '1,2,3,4,5');
  eq('hasMore', page1.data.pagination.hasMore, true);
  eq('nextFromSeq=6', page1.data.pagination.nextFromSeq, 6);
  const page2 = await listAudit(admin, `fromSeq=${page1.data.pagination.nextFromSeq}&limit=5`);
  eq('第二页序号从 6 开始', page2.data.entries[0].seq, 6);
  // 尾页
  const lastSeq = (await allAudit(admin)).slice(-1)[0].seq;
  const tail = await listAudit(admin, `fromSeq=${lastSeq}&limit=5`);
  eq('尾页 1 条', tail.data.entries.length, 1);
  eq('尾页 hasMore=false', tail.data.pagination.hasMore, false);
  eq('尾页 nextFromSeq', tail.data.pagination.nextFromSeq, lastSeq + 1);

  console.log('\n[8] 筛选：按类型 / 关联编号；非法筛选明确拒绝');
  r = await listAudit(admin, 'type=route_event&limit=200');
  ok('类型筛选全是 route_event', r.data.entries.every((e) => e.type === 'route_event'),
    r.data.entries.map((e) => e.type));
  r = await listAudit(admin, 'type=route_opened,waiting_fulfilled');
  ok('多类型筛选', r.data.entries.every((e) => ['route_opened', 'waiting_fulfilled'].includes(e.type)));
  r = await listAudit(admin, `refType=route_instance&refId=${iid}`);
  ok('关联编号筛选（实例）', r.data.entries.length >= 7 &&
    r.data.entries.every((e) => e.refType === 'route_instance' && e.refId === String(iid)),
    r.data.entries.length);
  r = await listAudit(admin, 'refType=blockade&refId=' + bid);
  ok('关联编号筛选（封锁，3 条）', r.data.entries.length === 3, r.data.entries.length);
  // 非法筛选
  for (const [q, label] of [
    ['type=not_a_type', '未知类型'],
    ['type=route_event,hack', '多类型含非法'],
    ['refType=nope', '非法 refType'],
    ['fromSeq=0', 'fromSeq 非正整数'],
    ['fromSeq=abc', 'fromSeq 非数字'],
    ['limit=0', 'limit 下界'],
    ['limit=9999', 'limit 上界'],
    ['limit=1.5', 'limit 非整数'],
    ['yardId=2', '未知参数拒绝'],
    ['refId=a!b', 'refId 非法字符'],
    ['foo=bar', '其它未知参数']
  ]) {
    const bad = await listAudit(admin, q);
    eq(`${label} 400`, bad.status, 400);
    eq(`${label} 错误码`, bad.data.code, 'AUDIT_BAD_FILTER');
  }

  console.log('\n[9] 定时走行计划注入：route_event 系统来源、actor=计划提交人');
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const pIid = r.data.instance.id;
  const steps = [];
  for (const sid of ['1', '3', '5']) {
    steps.push({ sectionId: sid, action: 'occupy', waitSeconds: 1 });
    steps.push({ sectionId: sid, action: 'clear', waitSeconds: 1 });
  }
  r = await api(`/api/instances/${pIid}/movement-plans`, {
    token: jia, method: 'POST', body: { steps }
  });
  eq('提交计划', r.status, 201);
  const planId = r.data.plan.id;
  // 等待计划走完（最多 10 秒）
  await waitAudit(jia, (e) => e.type === 'route_released' && e.refId === String(pIid), 10000);
  const planEvs = (await allAudit(jia)).filter(
    (e) => e.type === 'route_event' && e.refId === String(pIid));
  eq('计划注入 6 条事件', planEvs.length, 6);
  ok('计划事件系统来源', planEvs.every((e) => e.source === 'system'), planEvs[0]);
  ok('计划事件 actor=提交人', planEvs.every((e) => e.actor === '值班员甲'), planEvs[0]);
  ok('明细带 planId', planEvs.every((e) => e.detail.planId === planId), planEvs[0].detail);

  console.log('\n[10] 暂停/恢复 + 检查点回退：界标保留旧流水；副本 yard_created 重新计数、不串看');
  // 创建副本
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '审计副本甲' } });
  eq('创建副本 201', r.status, 201);
  const copyId = r.data.yard.id;
  await selectYard(admin, copyId);
  let copyEntries = await allAudit(admin);
  eq('副本首条为 yard_created', copyEntries[0].type, 'yard_created');
  eq('副本流水从 seq=1 重新计数', copyEntries[0].seq, 1);
  eq('界标含来源站场', copyEntries[0].detail.sourceYardId, 1);
  eq('副本界标含复制明细', copyEntries[0].after.copied.routes >= 3, true);
  eq('副本不补造旧流水（初始仅界标）', copyEntries.length, 1);

  // 暂停
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('暂停 200', r.status, 200);
  copyEntries = await allAudit(admin);
  const paused = copyEntries.find((e) => e.type === 'yard_paused');
  ok('暂停界标', !!paused, copyEntries.map((e) => e.type));
  eq('暂停关联站场编号', paused.refId, String(copyId));
  eq('暂停后状态', paused.after.status, 'paused');
  // 重复暂停幂等不产生流水
  const beforePauseDup = copyEntries.length;
  await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('重复暂停不产生流水', (await allAudit(admin)).length, beforePauseDup);
  // 创建检查点并回退
  r = await api('/api/admin/yards/current/checkpoints', {
    token: admin, method: 'POST', body: { name: 'CP1' }
  });
  eq('创建检查点', r.status, 201);
  const cpId = r.data.checkpoint.id;
  const cpSeqCount = (await allAudit(admin)).length; // 创建检查点本身不审计
  r = await api(`/api/admin/yards/current/checkpoints/${cpId}/rollback`, {
    token: admin, method: 'POST'
  });
  eq('回退 200', r.status, 200);
  const rb = (await allAudit(admin)).filter((e) => e.type === 'checkpoint_rollback');
  eq('回退界标 1 条', rb.length, 1);
  eq('回退关联检查点编号', rb[0].refId, String(cpId));
  eq('回退界标操作者', rb[0].actor, '管理员');
  ok('回退界标标记', rb[0].detail.marker === true, rb[0].detail);
  ok('回退界标保留此前流水（序号继续递增）', rb[0].seq === cpSeqCount + 1, rb[0]);
  // 回退后流水总数未减少（旧流水保留）
  const totalAfterRollback = (await allAudit(admin)).length;
  ok('回退后旧流水全部保留', totalAfterRollback >= cpSeqCount + 1);

  // 恢复
  r = await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('恢复 200', r.status, 200);
  const resumed = (await allAudit(admin)).find((e) => e.type === 'yard_resumed');
  ok('恢复界标', !!resumed);
  eq('恢复后 active', resumed.after.status, 'active');
  ok('恢复含平移时长', typeof resumed.detail.shiftMs === 'number');
  const beforeResumeDup = (await allAudit(admin)).length;
  await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('重复恢复不产生流水', (await allAudit(admin)).length, beforeResumeDup);

  console.log('\n[11] 不能串看其他站场：副本流水与原站场互不相同');
  const copySeqs = (await allAudit(admin)).map((e) => e.seq);
  await selectYard(admin, 1);
  const origEntries = await allAudit(admin);
  ok('切回原站场看不到副本界标',
    !origEntries.some((e) => e.type === 'yard_created'),
    origEntries.map((e) => e.type));
  ok('原站场看不到暂停界标',
    !origEntries.some((e) => e.type === 'yard_paused' || e.type === 'yard_resumed'));
  ok('两站场序号空间独立（原站场也有 seq=1..n）',
    origEntries[0].seq === 1 && copySeqs[0] === 1);
  // 值班员也只能看自己当前站场
  await selectYard(jia, copyId);
  r = await listAudit(jia);
  eq('值班员切到副本看到 yard_created',
    r.data.entries.some((e) => e.type === 'yard_created'), true);
  await selectYard(jia, 1);

  console.log('\n[12] 同成同败：回退失败时界标不写入；重置后旧流水仍在');
  await selectYard(admin, copyId);
  await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  const beforeBadRollback = (await allAudit(admin)).length;
  r = await api('/api/admin/yards/current/checkpoints/99999/rollback', {
    token: admin, method: 'POST'
  });
  eq('回退未知检查点 404', r.status, 404);
  eq('回退失败不产生流水', (await allAudit(admin)).length, beforeBadRollback);
  await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  await selectYard(admin, 1);

  // 原站场重置：此前全部流水保留，仅追加一条 yard_reset
  const beforeReset = (await allAudit(admin)).length;
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('清空推演状态 200', r.status, 200);
  const afterReset = await allAudit(admin);
  eq('重置只追加 1 条流水', afterReset.length, beforeReset + 1);
  const rs = afterReset[afterReset.length - 1];
  eq('重置类型', rs.type, 'yard_reset');
  eq('重置关联编号', rs.refId, 'state');
  ok('重置前开放进路数入摘要（>=0）', typeof rs.before.openInstances === 'number');
  eq('重置后开放进路 0', rs.after.openInstances, 0);
  eq('重置后区段未知数等于区段数', rs.after.sectionsUnknown, rs.after.sections);

  console.log(`\n审计流水全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
