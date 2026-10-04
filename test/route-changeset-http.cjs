'use strict';

/**
 * 进路定义批量变更集 HTTP 集成测试：
 *   临时库启动真实服务 → 预览返回逐条结果/受影响等待申请/阻断原因/修订标识
 *   → 合法整批发布（沿用单条编辑规则失效等待、删除历史实例、重试兑现）
 *   → 非法整批不落地 → 预览后定义/引用资源/等待申请变化拒绝发布并说明原因
 *   → 开放进路阻断 → 暂停副本拒绝发布但可预览 → 越权/重启后标识失效
 *   → 现有单条编辑与排路接口仍可用。
 *
 * 运行：node test/route-changeset-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3931;
const DB_PATH = process.env.SMOKE_DB_CHANGESET
  || path.join(__dirname, '..', 'data', 'changeset-test.db');
const BASE = `http://127.0.0.1:${PORT}`;

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
function rmDb() {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }
  fs.rmSync(path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'),
    { recursive: true, force: true });
}
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) rmDb();
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

async function preview(token, changes) {
  return api('/api/admin/route-changeset/preview', { token, method: 'POST', body: { changes } });
}
async function publish(token, previewId) {
  return api('/api/admin/route-changeset/publish', { token, method: 'POST', body: { previewId } });
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 预览合法整批：创建 R4 + 修改 R1 + 删除 R3，返回修订标识与受影响等待');
  // 先制造一条对 R1 的等待申请（会因 SW7 未扳到 N 以外的状态而等待——这里先
  // 把 SW7 扳到 R，使 R1 等待持有阻断原因）
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  const wRes = await api('/api/routes/R1/waiting', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('R1 等待申请提交', wRes.status, 201);
  const waitingId = wRes.data.waiting.id;
  eq('R1 等待中', wRes.data.waiting.status, 'waiting');
  ok('R1 等待带有阻断原因', (wRes.data.waiting.blockReasons || []).length > 0,
    wRes.data.waiting.blockReasons);

  const changes = [
    { op: 'create', id: 'R4', label: '新增侧线', origin: 'X2', destination: 'X4',
      entrySignalId: 'S2', steps: ['2', '4'], switchReqs: [{ switchId: 'SW8', position: 'R' }] },
    { op: 'update', id: 'R1', label: '正线通过 X1→X3', origin: 'X1', destination: 'X3',
      entrySignalId: 'S1', steps: ['1', '3', '5'], switchReqs: [{ switchId: 'SW7', position: 'N' }, { switchId: 'SW8', position: 'N' }] },
    { op: 'delete', id: 'R3' }
  ];
  let r = await preview(admin, changes);
  eq('预览 200', r.status, 200);
  const p = r.data.preview;
  ok('预览返回修订标识', typeof p.revision === 'string' && p.revision.startsWith('rev1-'), p.revision);
  ok('预览返回一次性令牌 previewId', typeof p.previewId === 'string' && p.previewId.startsWith('prev-'), p.previewId);
  eq('整批合法 valid=true', p.valid, true);
  eq('阻断原因为空', p.blockReasons.length, 0);
  eq('汇总-创建1', p.summary.create, 1);
  eq('汇总-修改1', p.summary.update, 1);
  eq('汇总-删除1', p.summary.delete, 1);
  eq('逐条结果 3 条', p.results.length, 3);
  eq('创建项合法', p.results[0].valid, true);
  eq('修改项合法', p.results[1].valid, true);
  eq('删除项合法', p.results[2].valid, true);
  eq('受影响等待 1 条', p.affectedWaiting.length, 1);
  eq('受影响等待编号', p.affectedWaiting[0].id, waitingId);
  eq('受影响等待路由', p.affectedWaiting[0].routeId, 'R1');
  ok('受影响等待附当前阻断原因', p.affectedWaiting[0].currentBlockReasons.length > 0,
    p.affectedWaiting[0].currentBlockReasons);
  eq('修改项挂接受影响等待', p.results[1].affectedWaiting[0], waitingId);

  console.log('\n[2] 非法整批预览：逐条列出原因，valid=false');
  const bad = await preview(admin, [
    { op: 'create', id: 'R1', label: '重名', origin: 'X1', destination: 'X3', steps: ['1'] },       // 重名
    { op: 'update', id: 'NOPE', label: 'x', origin: 'a', destination: 'b', steps: ['1'] },          // 不存在
    { op: 'delete', id: 'MISSING' },                                                                // 不存在
    { op: 'create', id: 'R9', label: 'x', origin: 'a', destination: 'b', steps: ['1', '1'] },       // 区段重复
    { op: 'create', id: 'R8', label: 'x', origin: 'a', destination: 'b',
      steps: ['999'], switchReqs: [{ switchId: 'SW99', position: 'N' }], entrySignalId: 'S99' },    // 引用缺失
    { op: 'wat', id: 'X' }                                                                          // op 非法
  ]);
  eq('非法预览仍 200', bad.status, 200);
  eq('valid=false', bad.data.preview.valid, false);
  eq('非法项 6 条', bad.data.preview.results.every((x) => !x.valid), true);
  const reasons = bad.data.preview.blockReasons.join('\n');
  ok('阻断原因含创建重名', reasons.includes('已存在'), reasons);
  ok('阻断原因含修改不存在', reasons.includes('R1 不存在'.replace('R1', 'NOPE')) || reasons.includes('NOPE 不存在'), reasons);
  ok('阻断原因含区段重复', reasons.includes('区段顺序重复'), reasons);
  ok('阻断原因含区段不存在', reasons.includes('不存在的区段 999'), reasons);
  ok('阻断原因含道岔不存在', reasons.includes('不存在的道岔 SW99'), reasons);
  ok('阻断原因含信号机不存在', reasons.includes('入口信号机 S99 不存在'), reasons);

  console.log('\n[3] 批内编号重复 + 非法预览携带标识发布被拒（整批不落地）');
  const dup = await preview(admin, [
    { op: 'create', id: 'R5', label: 'a', origin: 'X1', destination: 'X3', steps: ['1'] },
    { op: 'create', id: 'R5', label: 'b', origin: 'X1', destination: 'X3', steps: ['3'] }
  ]);
  eq('重复编号 valid=false', dup.data.preview.valid, false);
  ok('阻断原因含批内重复', dup.data.preview.blockReasons.join('').includes('批内进路编号 R5 重复'),
    dup.data.preview.blockReasons);
  let pub = await publish(admin, dup.data.preview.previewId);
  eq('非法整批发布 409', pub.status, 409);
  eq('错误码 CHANGESET_BLOCKED', pub.data.code, 'CHANGESET_BLOCKED');
  ok('错误体含 blockReasons', Array.isArray(pub.data.blockReasons) && pub.data.blockReasons.length > 0,
    pub.data.blockReasons);
  let st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R5 未落地', !st.routes.some((x) => x.id === 'R5'));

  console.log('\n[4] 空批 / 非数组 400；未知标识发布 409 REVISION_STALE');
  eq('空批 400', (await preview(admin, [])).status, 400);
  eq('非数组 400', (await preview(admin, null)).status, 400);
  pub = await publish(admin, 'prev-doesnotexist');
  eq('未知标识 409', pub.status, 409);
  eq('未知标识错误码', pub.data.code, 'REVISION_STALE');

  // 同内容两次预览：修订标识相同，但一次性令牌各自独立、互不顶替
  const sameChanges = [{ op: 'create', id: 'R6A', label: 'a', origin: 'X1', destination: 'X3', steps: ['5'] }];
  const pa1 = (await preview(admin, sameChanges)).data.preview;
  const pa2 = (await preview(admin, sameChanges)).data.preview;
  eq('同内容修订标识一致', pa1.revision, pa2.revision);
  ok('同内容两次预览令牌不同', pa1.previewId !== pa2.previewId, [pa1.previewId, pa2.previewId]);
  const pubA1 = await publish(admin, pa1.previewId);
  eq('第一个令牌发布 200', pubA1.status, 200);
  // 第一个发布改变了快照 → 第二个令牌按 REVISION_CHANGED 拒绝（未被顶替，仍有效）
  const pubA2 = await publish(admin, pa2.previewId);
  eq('第二个令牌未被顶替（因快照变化拒绝而非令牌失效）', pubA2.data.code, 'REVISION_CHANGED');

  console.log('\n[5] 预览后定义变化（单条编辑）→ 发布拒绝 REVISION_CHANGED 并列明类别');
  const p5 = (await preview(admin, [
    { op: 'create', id: 'R6', label: 'a', origin: 'X1', destination: 'X3', steps: ['5'] }
  ])).data.preview;
  // 预览后用现有单条编辑接口改动另一条进路 R2（改名，确保定义内容确实变化）
  const updR2 = await api('/api/admin/routes/R2', {
    token: admin, method: 'PUT',
    body: { id: 'R2', label: '正线至侧线 X1→X4（改名）', origin: 'X1', destination: 'X4',
      entrySignalId: 'S1', steps: ['1', '3', '4'],
      switchReqs: [{ switchId: 'SW7', position: 'N' }, { switchId: 'SW8', position: 'R' }] }
  });
  eq('单条编辑接口仍可用', updR2.status, 200);
  pub = await publish(admin, p5.previewId);
  eq('过期发布 409', pub.status, 409);
  eq('错误码 REVISION_CHANGED', pub.data.code, 'REVISION_CHANGED');
  ok('变化类别含 routes', pub.data.changedCategories.includes('routes'), pub.data.changedCategories);
  ok('变化明细提到 R2', JSON.stringify(pub.data.changes).includes('R2'), pub.data.changes);
  st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R6 未落地', !st.routes.some((x) => x.id === 'R6'));

  console.log('\n[6] 预览后引用资源变化（新增区段）→ 拒绝发布并说明 sections 类别');
  const p6 = (await preview(admin, [
    { op: 'create', id: 'R6', label: 'a', origin: 'X1', destination: 'X3', steps: ['5'] }
  ])).data.preview;
  const newSec = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: 'SEC9', label: '新增', x1: 0, y1: 0, x2: 10, y2: 10 }
  });
  eq('单条新增区段成功', newSec.status, 200);
  pub = await publish(admin, p6.previewId);
  eq('资源变化后发布 409', pub.status, 409);
  ok('变化类别含 sections', pub.data.changedCategories.includes('sections'), pub.data.changedCategories);

  console.log('\n[7] 预览后等待申请变化（值班员撤销）→ REVISION_CHANGED，类别 waiting');
  const p7 = (await preview(admin, [
    { op: 'create', id: 'R6', label: 'a', origin: 'X1', destination: 'X3', steps: ['5'] }
  ])).data.preview;
  const cancel = await api(`/api/waiting/${waitingId}/cancel`, { token: jia, method: 'POST' });
  eq('撤销等待成功', cancel.status, 200);
  pub = await publish(admin, p7.previewId);
  eq('等待变化后发布 409', pub.status, 409);
  ok('变化类别含 waiting', pub.data.changedCategories.includes('waiting'), pub.data.changedCategories);

  console.log('\n[8] 存在开放进路时：预览 valid=false 并列阻断，发布 409 CHANGESET_BLOCKED');
  // 扳回 SW7=N 以便 R1 可开放（SW8 当前 N）
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  const open = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('R1 开放成功', open.status, 200);
  const instId = open.data.instance.id;
  const pOpen = await preview(admin, [
    { op: 'create', id: 'R6', label: 'a', origin: 'X1', destination: 'X3', steps: ['5'] }
  ]);
  eq('有开放进路时预览仍 200', pOpen.status, 200);
  eq('valid=false', pOpen.data.preview.valid, false);
  ok('阻断原因含开放进路', pOpen.data.preview.blockReasons.join('').includes('已开放进路'),
    pOpen.data.preview.blockReasons);
  eq('预览返回 openInstances', pOpen.data.preview.openInstances[0].id, instId);
  pub = await publish(admin, pOpen.data.preview.previewId);
  eq('开放进路时发布 409', pub.status, 409);
  eq('错误码 CHANGESET_BLOCKED', pub.data.code, 'CHANGESET_BLOCKED');
  ok('阻断原因含开放进路', pub.data.blockReasons.join('').includes('已开放进路'), pub.data.blockReasons);
  // 按标准交错序列走完整条进路解除：占1→占3→清1→占5→清3→清5
  const walkSeq = [
    ['1', 'occupy'], ['3', 'occupy'], ['1', 'clear'],
    ['5', 'occupy'], ['3', 'clear'], ['5', 'clear']
  ];
  for (let i = 0; i < walkSeq.length; i++) {
    const [sectionId, action] = walkSeq[i];
    const ev = await api(`/api/instances/${instId}/events`, {
      token: jia, method: 'POST', body: { seq: i + 1, sectionId, action }
    });
    ok(`走行事件 ${i + 1} ${action} ${sectionId} 受理`, ev.status === 200, ev.data);
  }
  st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R1 走完已解除', !st.openInstances.some((x) => x.id === instId));

  console.log('\n[9] 合法整批成功发布：仅所列进路变化，等待失效/历史实例删除/后项重试');
  // 先给 R3 走一条完整进路，产生一条已解除历史实例（删除定义时应一并清理）
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  const r3open = await api('/api/routes/R3/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  const r3InstId = r3open.data.instance.id;
  for (const [sectionId, action] of [
    ['2', 'occupy'], ['3', 'occupy'], ['2', 'clear'],
    ['5', 'occupy'], ['3', 'clear'], ['5', 'clear']
  ]) {
    const s0 = (await api('/api/admin/state', { token: admin })).data.state.openInstances
      .find((x) => x.id === r3InstId);
    await api(`/api/instances/${r3InstId}/events`, {
      token: jia, method: 'POST', body: { seq: s0.nextSeq, sectionId, action }
    });
  }
  st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R3 走完解除（产生历史实例）', st.recentReleased.some((x) => x.id === r3InstId));

  // 制造等待：乙对 R3 与 R2 各提交一条等待，用区段占用保证它们暂不兑现
  // （R3=2,3,5 道岔 SW7=R SW8=N；R2=1,3,4 道岔 SW7=N SW8=R）
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  const wR3 = await api('/api/routes/R3/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('R3 等待提交 201', wR3.status, 201);
  const wR3Id = wR3.data.waiting.id;
  eq('R3 等待中（区段5占用阻断）', wR3.data.waiting.status, 'waiting');
  const wR2 = await api('/api/routes/R2/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('R2 等待提交 201', wR2.status, 201);
  const wR2Id = wR2.data.waiting.id;
  eq('R2 等待中（区段3占用阻断）', wR2.data.waiting.status, 'waiting');

  const batch = [
    { op: 'create', id: 'R4', label: '新增侧线 X2→X4', origin: 'X2', destination: 'X4',
      entrySignalId: 'S2', steps: ['2', '4'], switchReqs: [{ switchId: 'SW8', position: 'R' }] },
    { op: 'delete', id: 'R3' }
  ];
  const okPrev = (await preview(admin, batch)).data.preview;
  eq('合法批 valid=true', okPrev.valid, true);
  ok('删除项将清理 1 条历史实例',
    okPrev.results.find((x) => x.routeId === 'R3').releasedInstancesToDelete >= 1,
    okPrev.results);
  ok('受影响等待为 R3 的申请',
    okPrev.affectedWaiting.some((w) => w.id === wR3Id)
      && !okPrev.affectedWaiting.some((w) => w.id === wR2Id),
    okPrev.affectedWaiting.map((w) => w.id));

  const done = await publish(admin, okPrev.previewId);
  eq('发布 200', done.status, 200);
  eq('汇总创建 1', done.data.summary.create, 1);
  eq('汇总删除 1', done.data.summary.delete, 1);
  ok('汇总删除历史实例≥1', done.data.summary.releasedInstancesDeleted >= 1, done.data.summary);
  ok('失效等待含 R3 申请', done.data.invalidatedWaiting.some((w) => w.id === wR3Id),
    done.data.invalidatedWaiting);
  ok('失效等待不含 R2 申请', !done.data.invalidatedWaiting.some((w) => w.id === wR2Id),
    done.data.invalidatedWaiting);
  ok('发布返回新修订标识', !!done.data.revision && done.data.revision !== okPrev.revision);

  st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R4 已创建', st.routes.some((x) => x.id === 'R4'));
  ok('R3 已删除', !st.routes.some((x) => x.id === 'R3'));
  ok('R1/R2 仍在', st.routes.some((x) => x.id === 'R1') && st.routes.some((x) => x.id === 'R2'));
  const wR3After = st.waitingApplications.find((x) => x.id === wR3Id);
  eq('R3 等待已失效', wR3After.status, 'invalid');
  ok('失效原因说明删除', /R3/.test(wR3After.endReason || ''), wR3After.endReason);
  const wR2After = st.waitingApplications.find((x) => x.id === wR2Id);
  eq('R2 等待保持原状（waiting）', wR2After.status, 'waiting');
  ok('R3 历史实例已随定义删除',
    !st.recentReleased.some((x) => x.id === r3InstId)
      && st.waitingApplications.every((w) => w.instanceId !== r3InstId));
  // 区段占用/锁闭未被批量操作改动：区段5仍占用、SW7 仍为 N
  eq('区段占用未被批量操作改动（5 仍占用）',
    st.sections.find((x) => x.id === '5').occ_state, 'occupied');
  eq('道岔位置未被批量操作改动（SW7 仍 N）',
    st.switches.find((x) => x.id === 'SW7').position, 'N');
  // 新 R4 定义完整：扳 SW8=R 后可预检通过（R4 路径 2,4 当前空闲）
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'R' } });
  const r4check = await api('/api/routes/R4/check', {
    token: jia, method: 'POST', body: { switchPositions: { SW8: 'R' } }
  });
  eq('新 R4 可预检（定义完整、区段空闲）', r4check.data.check.ok, true);

  // 修订标识一次性：重复发布同一标识应失败
  const republish = await publish(admin, okPrev.previewId);
  eq('重复发布旧标识 409', republish.status, 409);
  eq('重复发布错误码', republish.data.code, 'REVISION_STALE');

  console.log('\n[10] 暂停副本：预览允许（列暂停阻断），发布 409 YARD_PAUSED');
  const cp = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '暂停测试副本' } });
  eq('创建副本', cp.status, 201);
  const yardId = cp.data.yard.id;
  await api('/api/auth/yard', { token: admin, method: 'PUT', body: { yardId } });
  const paused = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('副本已暂停', paused.status, 200);
  const pPause = await preview(admin, [
    { op: 'create', id: 'R7', label: 'a', origin: 'X1', destination: 'X3', steps: ['1'] }
  ]);
  eq('暂停副本可预览', pPause.status, 200);
  eq('预览 paused=true', pPause.data.preview.paused, true);
  eq('暂停导致 valid=false', pPause.data.preview.valid, false);
  ok('阻断原因含暂停', pPause.data.preview.blockReasons.join('').includes('已暂停'),
    pPause.data.preview.blockReasons);
  pub = await publish(admin, pPause.data.preview.previewId);
  eq('暂停副本发布 409', pub.status, 409);
  eq('暂停错误码', pub.data.code, 'YARD_PAUSED');
  st = (await api('/api/admin/state', { token: admin })).data.state;
  ok('R7 未落地（暂停副本）', !st.routes.some((x) => x.id === 'R7'));

  console.log('\n[11] 越权：值班员不能预览/发布；未登录 401');
  eq('值班员预览 403', (await preview(jia, [])).status, 403);
  eq('值班员发布 403', (await publish(jia, 'x')).status, 403);
  eq('未登录预览 401', (await preview(undefined, [])).status, 401);

  console.log('\n[12] 服务重启后旧修订标识失效，须重新预览；重新预览后可正常发布');
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId } });
  // 仍暂停 → 先恢复（恢复接口不受暂停写限制）
  await api('/api/admin/yards/current/resume', { token: admin2, method: 'POST' });
  pub = await publish(admin2, pPause.data.preview.previewId);
  eq('重启后旧标识 409', pub.status, 409);
  eq('错误码 REVISION_STALE', pub.data.code, 'REVISION_STALE');
  const pAfter = await preview(admin2, [
    { op: 'create', id: 'R7', label: '重启后发布', origin: 'X1', destination: 'X3', steps: ['1'] }
  ]);
  eq('重新预览 200', pAfter.status, 200);
  const done2 = await publish(admin2, pAfter.data.preview.previewId);
  eq('重新预览后发布 200', done2.status, 200);
  st = (await api('/api/admin/state', { token: admin2 })).data.state;
  ok('R7 已落地', st.routes.some((x) => x.id === 'R7'));

  console.log('\n[13] 现有单条编辑与排路接口继续可用（副本内）');
  const single = await api('/api/admin/routes', {
    token: admin2, method: 'POST',
    body: { id: 'R8', label: '单条新建', origin: 'X2', destination: 'X4',
      entrySignalId: null, steps: ['2'], switchReqs: [] }
  });
  eq('单条创建仍可用', single.status, 200);
  const dispatcher = await login('dispatcher', '值班员戊');
  await api('/api/auth/yard', { token: dispatcher, method: 'PUT', body: { yardId } });
  const openR8 = await api('/api/routes/R8/open', { token: dispatcher, method: 'POST', body: {} });
  eq('排路（开放）接口仍可用', openR8.status, 200);

  await stopServer();
  console.log(`\n进路批量变更集全部 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
