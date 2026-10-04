'use strict';

/**
 * 交接班交接单 HTTP 集成测试：
 *   临时库启动真实服务 → 交班人生成交接单（六类状态原子快照）→
 *   接班人查看/签收（姓名须不同；本人签收拒绝）→ 生成后任一状态变化则签收拒绝、
 *   列出变化类别并把该单标记过期（区段占用、道岔位置、开放进路信号与走行进度、
 *   等待申请、延时取消申请、未结束封锁逐类覆盖）→ 同一人重复签收幂等返回原结果、
 *   其他人重复签收拒绝 → 并发签收/并发状态变更不会使过时交接单签收成功 →
 *   交接单不阻塞既有操作 → 站场重置使未签收单过期、已签收单保留 →
 *   服务重启后记录仍可查询与签收。
 *
 * 运行：node test/handover-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3920;
const DB_PATH = process.env.SMOKE_DB_HANDOVER || path.join(__dirname, '..', 'data', 'handover-test.db');
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
      fs.rmSync(path.join(path.dirname(DB_PATH), path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'), { recursive: true, force: true });
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

async function getState(token) {
  return (await api('/api/state', { token })).data.state;
}

async function gen(token) {
  const r = await api('/api/handovers', { token, method: 'POST' });
  if (r.status !== 201) throw new Error('生成交接单失败: ' + JSON.stringify(r.data));
  return r.data.handover;
}

async function openR1(token) {
  const r = await api('/api/routes/R1/open', {
    token, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  if (r.status !== 200) throw new Error('开放 R1 失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
}

async function resetState(adminToken, kind = 'state') {
  await api(`/api/admin/reset/${kind}`, { token: adminToken, method: 'POST' });
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');
  const bing = await login('dispatcher', '值班员丙');

  console.log('\n[1] 鉴权：未登录拒绝、管理员身份拒绝、值班员可访问');
  let r = await api('/api/handovers', { method: 'POST' });
  eq('未登录生成 401', r.status, 401);
  r = await api('/api/handovers');
  eq('未登录查看 401', r.status, 401);
  r = await api('/api/handovers', { token: admin, method: 'POST' });
  eq('管理员生成 403', r.status, 403);
  r = await api('/api/handovers/1/sign', { token: admin, method: 'POST' });
  eq('管理员签收 403', r.status, 403);

  console.log('\n[2] 生成：201，含生成时间/交班人/六类快照；state 一并下发');
  let h = await gen(jia);
  eq('生成 201 状态 active', h.status, 'active');
  eq('交班人', h.fromName, '值班员甲');
  ok('接班人空', h.toName === null);
  ok('生成时间 epoch 毫秒', Number.isFinite(h.generatedAt) && h.generatedAt > 0, h.generatedAt);
  ok('生成时间文本', /20\d\d/.test(h.generatedAtText), h.generatedAtText);
  ok('快照-区段占用（示例 1~5）',
    Object.keys(h.snapshot.sections).length === 5 && h.snapshot.sections['1'] === 'free', h.snapshot.sections);
  ok('快照-道岔位置', h.snapshot.switches.SW7 === 'N' && h.snapshot.switches.SW8 === 'N');
  ok('快照-开放进路为空对象', JSON.stringify(h.snapshot.openInstances) === '{}');
  for (const k of ['waiting', 'cancellations', 'blockades']) {
    ok(`快照-${k} 存在`, h.snapshot[k] && typeof h.snapshot[k] === 'object');
  }
  let st = await getState(jia);
  eq('state 含交接单列表', st.handovers.some((x) => x.id === h.id), true);

  console.log('\n[3] 本人签收拒绝；接班人姓名须与交班人不同');
  r = await api(`/api/handovers/${h.id}/sign`, { token: jia, method: 'POST' });
  eq('交班人本人签收 409', r.status, 409);
  eq('错误码 HANDOVER_SAME_PERSON', r.data.code, 'HANDOVER_SAME_PERSON');
  // 未签收成功，单子仍 active
  r = await api(`/api/handovers/${h.id}`, { token: yi });
  eq('本人尝试后单子仍待签收', r.data.handover.status, 'active');

  console.log('\n[4] 无变化：他人签收成功（201），写入接班人/签收时间');
  r = await api(`/api/handovers/${h.id}/sign`, { token: yi, method: 'POST' });
  eq('他人签收 201', r.status, 201);
  eq('repeated=false', r.data.repeated, false);
  eq('状态 signed', r.data.handover.status, 'signed');
  eq('接班人', r.data.handover.toName, '值班员乙');
  ok('签收时间', Number.isFinite(r.data.handover.signedAt), r.data.handover);

  console.log('\n[5] 重复签收：同一人幂等返回原结果；其他人拒绝');
  r = await api(`/api/handovers/${h.id}/sign`, { token: yi, method: 'POST' });
  eq('同一人重复签收 200', r.status, 200);
  eq('repeated=true 幂等', r.data.repeated, true);
  eq('幂等返回原接班人', r.data.handover.toName, '值班员乙');
  r = await api(`/api/handovers/${h.id}/sign`, { token: bing, method: 'POST' });
  eq('其他人重复签收 409', r.status, 409);
  eq('错误码 HANDOVER_ALREADY_SIGNED', r.data.code, 'HANDOVER_ALREADY_SIGNED');
  eq('返回原签收人', r.data.signedBy, '值班员乙');

  console.log('\n[6] 不存在 / 状态过滤 / scope=mine');
  r = await api('/api/handovers/999', { token: jia });
  eq('查看不存在 404', r.status, 404);
  eq('错误码 HANDOVER_NOT_FOUND', r.data.code, 'HANDOVER_NOT_FOUND');
  r = await api('/api/handovers/999/sign', { token: yi, method: 'POST' });
  eq('签收不存在 404', r.status, 404);
  r = await api('/api/handovers?status=signed', { token: jia });
  eq('signed 过滤命中已签单', r.data.handovers.filter((x) => x.id === h.id).length, 1);
  r = await api('/api/handovers?status=active', { token: jia });
  eq('active 过滤不含已签单', r.data.handovers.filter((x) => x.id === h.id).length, 0);
  r = await api('/api/handovers?scope=mine', { token: bing });
  eq('丙的 mine 不含与己无关的单', r.data.handovers.filter((x) => x.id === h.id).length, 0);
  r = await api('/api/handovers?scope=mine', { token: yi });
  eq('乙的 mine 含其签收的单', r.data.handovers.some((x) => x.id === h.id), true);

  console.log('\n[7] 同交班人生成新单：此前未签收单被替换过期；已签收单不受影响');
  const h2 = await gen(yi);           // 乙交班
  const h3 = await gen(yi);           // 乙再次交班：h2 应过期
  r = await api('/api/handovers', { token: jia });
  const findDoc = (id) => r.data.handovers.find((x) => x.id === id);
  eq('被替换单 expired', findDoc(h2.id).status, 'expired');
  ok('替换过期说明', /新的交接单/.test(findDoc(h2.id).expireReason), findDoc(h2.id).expireReason);
  eq('新单 active', findDoc(h3.id).status, 'active');
  eq('甲此前已签收单仍 signed（不受他人生成影响）', findDoc(h.id).status, 'signed');
  // 被替换单签收 → HANDOVER_EXPIRED
  r = await api(`/api/handovers/${h2.id}/sign`, { token: bing, method: 'POST' });
  eq('被替换单签收 409', r.status, 409);
  eq('错误码 HANDOVER_EXPIRED', r.data.code, 'HANDOVER_EXPIRED');

  console.log('\n[8] 区段占用变化 → 签收拒绝、列出类别并标记过期');
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  r = await api(`/api/handovers/${h3.id}/sign`, { token: jia, method: 'POST' });
  eq('变化后签收 409', r.status, 409);
  eq('错误码 HANDOVER_STALE', r.data.code, 'HANDOVER_STALE');
  eq('变化类别 sections', JSON.stringify(r.data.changedCategories), JSON.stringify(['sections']));
  ok('变化明细含区段2', r.data.changes[0].details.some((d) => d.includes('区段 2') && d.includes('占用')),
    r.data.changes);
  r = await api(`/api/handovers/${h3.id}`, { token: jia });
  eq('该单已持久化标记 expired', r.data.handover.status, 'expired');
  eq('单上记录变化类别', JSON.stringify(r.data.handover.changedCategories), JSON.stringify(['sections']));
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });

  console.log('\n[9] 道岔位置变化 → switches 类别');
  const h4 = await gen(jia);
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  r = await api(`/api/handovers/${h4.id}/sign`, { token: yi, method: 'POST' });
  eq('道岔变化后签收拒绝', r.status, 409);
  eq('变化类别 switches', JSON.stringify(r.data.changedCategories), JSON.stringify(['switches']));
  ok('明细含 SW7 N→R', r.data.changes[0].details[0].includes('SW7') &&
    r.data.changes[0].details[0].includes('N') && r.data.changes[0].details[0].includes('R'),
    r.data.changes);
  // 扳回（状态复原也仍是不同的单——需重新生成）
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });

  console.log('\n[10] 开放进路：信号与走行进度变化逐处检出');
  const h5 = await gen(jia);
  const iid = await openR1(jia);
  r = await api(`/api/handovers/${h5.id}/sign`, { token: yi, method: 'POST' });
  eq('新开放进路后签收拒绝', r.status, 409);
  eq('变化类别 openInstances', JSON.stringify(r.data.changedCategories),
    JSON.stringify(['openInstances']));
  ok('明细含新开放进路', r.data.changes[0].details.some((d) => d.includes('新开放')), r.data.changes);

  // 含开放进路的快照
  const h6 = await gen(jia);
  ok('快照含该开放进路', h6.snapshot.openInstances[iid] &&
    h6.snapshot.openInstances[iid].signalState === 'green', h6.snapshot.openInstances);
  // 首段占用：信号红 + 事件 + 走行进度
  await api(`/api/instances/${iid}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  r = await api(`/api/handovers/${h6.id}/sign`, { token: yi, method: 'POST' });
  eq('首段占用后签收拒绝', r.status, 409);
  eq('类别含 openInstances', r.data.changedCategories.includes('openInstances'), true);
  const instDetails = r.data.changes.find((c) => c.category === 'openInstances').details.join('\n');
  ok('明细含信号变化', instDetails.includes('信号'), instDetails);
  ok('明细含走行事件', instDetails.includes('占用 区段 1'), instDetails);

  console.log('\n[11] 等待申请变化：新提交/兑现均可检出；交接单不阻塞既有操作');
  const h7 = await gen(jia);
  // 进路仍锁区段1/3/5：R1 等待必为 waiting
  r = await api('/api/routes/R1/waiting', {
    token: bing, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('等待申请照常提交（交接单不阻塞）', r.status, 201);
  const wid = r.data.waiting.id;
  r = await api(`/api/handovers/${h7.id}/sign`, { token: yi, method: 'POST' });
  eq('新等待后签收拒绝', r.status, 409);
  eq('类别含 waiting', r.data.changedCategories.includes('waiting'), true);
  ok('明细含新提交等待', r.data.changes.find((c) => c.category === 'waiting')
    .details[0].includes('新提交'), r.data.changes);
  // 走行清空解除进路 → 等待自动兑现，另一张单应检出 waiting 状态流转
  const h8 = await gen(jia);
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
  // 等待兑现可能稍后完成，轮询
  const deadline = Date.now() + 5000;
  let wRow;
  for (;;) {
    wRow = (await api(`/api/waiting?scope=all`, { token: jia })).data.waiting.find((x) => x.id === wid);
    if (wRow.status === 'fulfilled' || Date.now() > deadline) break;
    await sleep(120);
  }
  eq('等待申请已兑现为进路', wRow.status, 'fulfilled');
  r = await api(`/api/handovers/${h8.id}/sign`, { token: yi, method: 'POST' });
  eq('进路解除+等待兑现后签收拒绝', r.status, 409);
  ok('类别含开放进路与等待', r.data.changedCategories.includes('openInstances') &&
    r.data.changedCategories.includes('waiting'), r.data.changedCategories);
  ok('等待明细含已兑现', r.data.changes.find((c) => c.category === 'waiting')
    .details.join('').includes('已兑现'), r.data.changes);
  // 清掉兑现的进路，恢复空场
  const widInst = wRow.instanceId;
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 2, sectionId: '3', action: 'occupy' }
  });
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 3, sectionId: '1', action: 'clear' }
  });
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 4, sectionId: '5', action: 'occupy' }
  });
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 5, sectionId: '3', action: 'clear' }
  });
  await api(`/api/instances/${widInst}/events`, {
    token: bing, method: 'POST', body: { seq: 6, sectionId: '5', action: 'clear' }
  });
  st = await getState(jia);
  eq('空场恢复（无开放进路）', st.openInstances.length, 0);

  console.log('\n[12] 延时取消申请变化：新申请/终止均可检出，走行与既有接口照常');
  const cIid = await openR1(jia);
  const h9 = await gen(jia);
  r = await api(`/api/instances/${cIid}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('延时取消照常申请（交接单不阻塞）', r.status, 201);
  const cid = r.data.cancellation.id;
  r = await api(`/api/handovers/${h9.id}/sign`, { token: yi, method: 'POST' });
  eq('新延时取消后签收拒绝', r.status, 409);
  eq('类别含 cancellations', r.data.changedCategories.includes('cancellations'), true);
  // 含取消申请的快照；首段占用使取消终止 → 变化
  const h10 = await gen(jia);
  ok('快照含延时取消申请', h10.snapshot.cancellations[cid] &&
    h10.snapshot.cancellations[cid].status === 'pending', h10.snapshot.cancellations);
  r = await api(`/api/instances/${cIid}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('既有走行接口照常受理且终止取消', r.data.result.cancellationAborted, cid);
  r = await api(`/api/handovers/${h10.id}/sign`, { token: yi, method: 'POST' });
  eq('取消终止后签收拒绝', r.status, 409);
  const cancelDetail = r.data.changes.find((c) => c.category === 'cancellations').details.join('');
  ok('延时取消明细含待处理→已终止', cancelDetail.includes('待处理') && cancelDetail.includes('已终止'), cancelDetail);
  // 走完该进路恢复空场
  for (const [seq, sid, act] of [
    [2, '3', 'occupy'], [3, '1', 'clear'], [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
  ]) {
    await api(`/api/instances/${cIid}/events`, {
      token: jia, method: 'POST', body: { seq, sectionId: sid, action: act }
    });
  }
  st = await getState(jia);
  eq('空场恢复（无开放进路）', st.openInstances.length, 0);

  console.log('\n[13] 临时封锁变化：新发起/结束均检出');
  const h11 = await gen(jia);
  r = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '4', reason: '交接测试封锁' }
  });
  eq('封锁照常发起（交接单不阻塞）', r.status, 201);
  const blkId = r.data.blockade.id;
  r = await api(`/api/handovers/${h11.id}/sign`, { token: yi, method: 'POST' });
  eq('新封锁后签收拒绝', r.status, 409);
  eq('类别含 blockades', r.data.changedCategories.includes('blockades'), true);
  ok('封锁明细含区段4', r.data.changes.find((c) => c.category === 'blockades')
    .details.join('').includes('区段 4'), r.data.changes);
  const h12 = await gen(jia);
  await api(`/api/admin/blockades/${blkId}/end`, { token: admin, method: 'POST' });
  r = await api(`/api/handovers/${h12.id}/sign`, { token: yi, method: 'POST' });
  eq('封锁结束后签收拒绝', r.status, 409);
  ok('封锁明细含已结束', r.data.changes.find((c) => c.category === 'blockades')
    .details.join('').includes('封锁已结束'), r.data.changes);

  console.log('\n[14] 多类别同时变化：一次返回全部类别');
  const h13 = await gen(jia);
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'R' } });
  await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '2', reason: '多类别' }
  });
  r = await api(`/api/handovers/${h13.id}/sign`, { token: yi, method: 'POST' });
  eq('多类别变化签收拒绝', r.status, 409);
  ok('一次列出多个类别', r.data.changedCategories.length >= 3, r.data.changedCategories);
  ok('含 sections/switches/blockades',
    ['sections', 'switches', 'blockades'].every((c) => r.data.changedCategories.includes(c)),
    r.data.changedCategories);
  // 复原
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  const b2 = (await api('/api/admin/blockades', { token: admin })).data.blockades
    .find((x) => x.sectionId === '2' && x.status !== 'ended');
  if (b2) await api(`/api/admin/blockades/${b2.id}/end`, { token: admin, method: 'POST' });

  console.log('\n[15] 并发：签收与状态变更同时进行，过时交接单不可能签收成功');
  // 15a 两个接班人同时签同一张新鲜单：恰好一人成功，另一人必为 ALREADY_SIGNED
  let success = 0, already = 0;
  for (let round = 0; round < 8; round++) {
    const hd = await gen(jia);
    const [s1, s2] = await Promise.all([
      api(`/api/handovers/${hd.id}/sign`, { token: yi, method: 'POST' }),
      api(`/api/handovers/${hd.id}/sign`, { token: bing, method: 'POST' })
    ]);
    const codes = [s1, s2].map((x) => (x.status === 201 ? 'OK' : x.data.code));
    const nOk = codes.filter((c) => c === 'OK').length;
    const nAlready = codes.filter((c) => c === 'HANDOVER_ALREADY_SIGNED').length;
    ok(`第 ${round + 1} 轮双签恰有一单成功`, nOk === 1 && nAlready === 1, codes);
    success += nOk; already += nAlready;
  }
  eq('8 轮共 8 单成功', success, 8);
  eq('8 轮共 8 次他人重复签收拒绝', already, 8);

  // 15b 签收与区段占用并发：只可能 (签收成功+操作照常) 或 (签收 STALE+操作照常)，
  //     绝不可能出现"签收成功但状态已变化"。better-sqlite3 的同步事务在单连接上
  //     串行执行，两笔事务各为原子，因此两种顺序都合法、第三种结果不可能出现。
  for (let round = 0; round < 10; round++) {
    const hd = await gen(jia);
    const [signRes, occRes] = await Promise.all([
      api(`/api/handovers/${hd.id}/sign`, { token: yi, method: 'POST' }),
      api('/api/sections/5/state', { token: bing, method: 'POST', body: { action: 'occupy' } })
    ]);
    eq('区段操作始终照常成功（不被交接单阻塞）', occRes.status, 200);
    st = await getState(jia);
    const docAfter = st.handovers.find((x) => x.id === hd.id);
    if (signRes.status === 201) {
      // 签收先于占用：合法；此时单子 signed
      eq('签收成功者对应单据为 signed', docAfter.status, 'signed');
    } else {
      eq('签收失败者错误码为 STALE', signRes.data.code, 'HANDOVER_STALE');
      eq('失败单据为 expired', docAfter.status, 'expired');
    }
    // 关键不变量：任何一轮结束后，signed 单据的快照与签收时刻一致——
    // 不存在"signed 却已过期"的单据；占用/清空操作从未被交接单阻塞。
    await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  }

  // 15c 强制另一种提交顺序：先占用（在途）再签收，必为 STALE 过期，覆盖两种合法时序。
  {
    const hd = await gen(jia);
    await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
    const signRes = await api(`/api/handovers/${hd.id}/sign`, { token: yi, method: 'POST' });
    eq('占用先于签收 → STALE', signRes.status, 409);
    eq('错误码 HANDOVER_STALE', signRes.data.code, 'HANDOVER_STALE');
    st = await getState(jia);
    eq('占用先序对应单据 expired', st.handovers.find((x) => x.id === hd.id).status, 'expired');
    await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
    // 状态恢复后旧单仍不能签收（已过期），必须重新生成
    const retry = await api(`/api/handovers/${hd.id}/sign`, { token: yi, method: 'POST' });
    eq('状态复原后旧过期单仍拒绝', retry.data.code, 'HANDOVER_EXPIRED');
    const fresh = await gen(jia);
    const okSign = await api(`/api/handovers/${fresh.id}/sign`, { token: yi, method: 'POST' });
    eq('交班人重新生成后签收成功', okSign.status, 201);
  }

  console.log('\n[16] 站场重置：未签收单过期、已签收单保留供复盘');
  // 先制造一张已签收单与一张待签收单
  const signedKeep = await gen(jia);
  await api(`/api/handovers/${signedKeep.id}/sign`, { token: yi, method: 'POST' });
  const activeExpire = await gen(jia);
  // 另一名交班人的待签收单也应过期
  const activeOther = await gen(bing);
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('重置 200', r.status, 200);
  const docsReset = r.data.state.handovers;
  eq('待签收单（甲）重置后 expired', docsReset.find((x) => x.id === activeExpire.id).status, 'expired');
  eq('待签收单（丙）重置后 expired', docsReset.find((x) => x.id === activeOther.id).status, 'expired');
  eq('已签收单保留 signed', docsReset.find((x) => x.id === signedKeep.id).status, 'signed');
  const kept = docsReset.find((x) => x.id === signedKeep.id);
  ok('已签收单保留交班/接班人', kept.fromName === '值班员甲' && kept.toName === '值班员乙');
  ok('已签收单保留快照', kept.snapshot && kept.snapshot.sections);
  ok('重置过期原因', /站场重置|清空推演状态/.test(docsReset.find((x) => x.id === activeExpire.id).expireReason),
    docsReset.find((x) => x.id === activeExpire.id).expireReason);
  // 重置后待签收单不能再签收
  r = await api(`/api/handovers/${activeExpire.id}/sign`, { token: yi, method: 'POST' });
  eq('重置过期单签收拒绝', r.status, 409);
  eq('错误码 HANDOVER_EXPIRED', r.data.code, 'HANDOVER_EXPIRED');
  // 已签收单仍可查看（复盘）；他人重复签收仍拒绝
  r = await api(`/api/handovers/${signedKeep.id}`, { token: bing });
  eq('已签收单重置后仍可查询', r.status, 200);
  eq('复盘单状态仍 signed', r.data.handover.status, 'signed');

  console.log('\n[17] 培训重开同样使未签收单过期、已签收保留');
  const active2 = await gen(yi);
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  r = await api('/api/handovers', { token: jia });
  eq('培训重开后待签收单 expired', r.data.handovers.find((x) => x.id === active2.id).status, 'expired');
  ok('培训重开过期原因', /培训重开/.test(r.data.handovers.find((x) => x.id === active2.id).expireReason));

  console.log('\n[18] 服务重启：记录持久化，待签收单重启后仍可按状态原子判定签收');
  const persistSigned = await gen(jia);
  await api(`/api/handovers/${persistSigned.id}/sign`, { token: yi, method: 'POST' });
  const persistActive = await gen(jia); // 培训重开后空场，状态应仍一致
  await stopServer();
  await startServer(true);
  // 旧 token 为 sessions 表持久化，重启后仍有效
  r = await api('/api/handovers', { token: jia });
  eq('重启后已签收单仍 signed', r.data.handovers.find((x) => x.id === persistSigned.id).status, 'signed');
  const pending = r.data.handovers.find((x) => x.id === persistActive.id);
  eq('重启后待签收单仍 active', pending.status, 'active');
  // 重启后状态未变 → 签收成功
  r = await api(`/api/handovers/${persistActive.id}/sign`, { token: bing, method: 'POST' });
  eq('重启后签收成功', r.status, 201);
  eq('重启后签收状态 signed', r.data.handover.status, 'signed');

  console.log(`\n交接班交接单全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
