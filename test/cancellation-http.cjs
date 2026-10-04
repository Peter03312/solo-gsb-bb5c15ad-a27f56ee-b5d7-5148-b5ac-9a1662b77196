'use strict';

/**
 * 延时取消 HTTP 集成测试：
 *   临时库启动真实服务 → 管理员设置保护时长 → 值班员开放进路并申请延时取消 →
 *   验证申请状态/最早解除时间、信号立即回红与锁闭保留、重复申请幂等、
 *   等待申请不提前兑现、到期解除并触发等待兑现、保护期内首段占用终止取消、
 *   到期区段非空闲终止取消、改设置不追改、重启继续处理、重置清除。
 *
 * 运行：node test/cancellation-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3918;
const DB_PATH = process.env.SMOKE_DB_CANCEL || path.join(__dirname, '..', 'data', 'cancellation-test.db');
const YARD_DB_PATH = path.join(path.dirname(DB_PATH), path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', 'yard-1.db');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询某申请直到进入终态（released/aborted）或超时；保护时长 2 秒，定时扫描 0.5 秒 */
async function waitRequestDone(token, id, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(`/api/cancellations?scope=all`, { token });
    const row = r.data.cancellations.find((x) => x.id === id);
    if (row && row.status !== 'pending') return row;
    if (Date.now() > deadline) throw new Error(`申请 #${id} 在 ${timeoutMs}ms 内未进入终态`);
    await sleep(150);
  }
}

/** 轮询等待直到某实例不在开放列表中 */
async function waitInstanceGone(token, id, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await getState(token);
    if (!st.openInstances.some((x) => x.id === id)) return st;
    if (Date.now() > deadline) throw new Error(`实例 #${id} 在 ${timeoutMs}ms 内未解除`);
    await sleep(150);
  }
}

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

async function openR1(token) {
  const r = await api('/api/routes/R1/open', {
    token, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  if (r.status !== 200) throw new Error('开放 R1 失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
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

async function findRequest(token, predicate, scope = 'all') {
  const r = await api(`/api/cancellations?scope=${scope}`, { token });
  return r.data.cancellations.find(predicate);
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 保护时长设置：正整数校验 + 仅影响新申请');
  let r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 2 }
  });
  eq('设置 2 秒成功', r.status, 200);
  eq('返回新时长 2', r.data.protectionSeconds, 2);
  r = await api('/api/admin/settings/cancel-protection', { token: admin, method: 'GET' });
  eq('查询保护时长为 2', r.data.protectionSeconds, 2);
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 0 }
  });
  eq('0 秒拒绝 400', r.status, 400);
  eq('错误码 BAD_PROTECTION_SECONDS', r.data.code, 'BAD_PROTECTION_SECONDS');
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: -3 }
  });
  eq('负数拒绝 400', r.status, 400);
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 2.5 }
  });
  eq('小数拒绝 400', r.status, 400);
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 'x' }
  });
  eq('非数字拒绝 400', r.status, 400);

  console.log('\n[2] 鉴权与前置校验');
  r = await api('/api/instances/1/cancel-delayed', { method: 'POST' });
  eq('未登录 401', r.status, 401);
  r = await api('/api/instances/1/cancel-delayed', { token: admin, method: 'POST' });
  eq('管理员 403', r.status, 403);
  r = await api('/api/instances/999/cancel-delayed', { token: jia, method: 'POST' });
  eq('不存在实例 404', r.status, 404);
  eq('错误码 INSTANCE_NOT_FOUND', r.data.code, 'INSTANCE_NOT_FOUND');

  console.log('\n[3] 申请：返回状态与最早解除时间；信号立即回红、锁闭保留');
  const iid1 = await openR1(jia);
  const t0 = Date.now();
  r = await api(`/api/instances/${iid1}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('申请返回 201', r.status, 201);
  eq('created=true', r.data.created, true);
  const c1 = r.data.cancellation;
  eq('c1 pending', c1.status, 'pending');
  eq('c1 时长快照 2 秒', c1.durationSeconds, 2);
  ok('c1 最早解除时间约为 2 秒后',
    c1.releaseAt - t0 >= 1900 && c1.releaseAt - t0 <= 2300, { delta: c1.releaseAt - t0 });
  ok('c1 剩余时间约 2 秒', c1.remainingMs > 1700 && c1.remainingMs <= 2000, { remainingMs: c1.remainingMs });
  let st = await getState(jia);
  let inst = st.openInstances.find((x) => x.id === iid1);
  eq('申请后信号红', inst.signalState, 'red');
  eq('区段锁保留（3 段）', inst.lockedSections.length, 3);
  eq('道岔锁保留（2 个）', inst.lockedSwitches.length, 2);
  ok('state 含 pending 索引', !!st.pendingCancellations[String(iid1)]);
  eq('state 下发保护时长', st.cancelProtectionSeconds, 2);

  console.log('\n[4] 保护期内等待申请不得提前兑现；重复申请不缩短期限/不产生第二笔');
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const w = r.data.waiting;
  eq('同资源等待申请仍 waiting', w.status, 'waiting');
  ok('等待被锁阻断', w.blockReasons.join('；').includes('进路 #'), w.blockReasons);
  const releaseBefore = c1.releaseAt;
  await sleep(300);
  r = await api(`/api/instances/${iid1}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('重复申请返回 200', r.status, 200);
  eq('重复申请 created=false', r.data.created, false);
  eq('重复返回同一申请编号', r.data.cancellation.id, c1.id);
  eq('最早解除时刻不变（不缩短）', r.data.cancellation.releaseAt, releaseBefore);
  st = await getState(jia);
  eq('保护期内进路仍开放（未提前解除）', st.openInstances.filter((x) => x.id === iid1).length, 1);
  eq('等待申请未提前兑现',
    (st.waitingApplications.find((x) => x.id === w.id) || {}).status, 'waiting');

  console.log('\n[5] 到期核验通过 → 解除进路并触发等待兑现（同一事务重查）');
  const done1Row = await waitRequestDone(jia, c1.id);
  eq('c1 released', done1Row.status, 'released');
  ok('c1 解除说明', done1Row.endReason.includes('沿途区段均空闲'), done1Row.endReason);
  // 等待轮询兑现（进路解除后扫描触发，可能略晚于取消状态落库）
  let wAfter;
  const wDeadline = Date.now() + 4000;
  for (;;) {
    wAfter = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w.id);
    if (wAfter.status === 'fulfilled' || Date.now() > wDeadline) break;
    await sleep(150);
  }
  eq('等待申请随解除自动兑现', wAfter.status, 'fulfilled');
  ok('等待兑现实例编号', Number.isInteger(wAfter.instanceId), wAfter);
  st = await getState(jia);
  const wInst = st.openInstances.find((x) => x.id === wAfter.instanceId);
  eq('兑现实例信号绿', wInst.signalState, 'green');  // 清理兑现实例
  await walkThrough(yi, wAfter.instanceId, ['1', '3', '5']);

  console.log('\n[6] 保护期内收到首段占用事件：事件受理 + 取消终止 + 锁闭保留');
  const iid2 = await openR1(jia);
  r = await api(`/api/instances/${iid2}/cancel-delayed`, { token: jia, method: 'POST' });
  const c2 = r.data.cancellation.id;
  r = await api(`/api/instances/${iid2}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('首段占用事件受理', r.status, 200);
  eq('信号回红标记', r.data.result.signalTurnedRed, true);
  eq('返回被终止的申请编号', r.data.result.cancellationAborted, c2);
  const c2row = await findRequest(jia, (x) => x.id === c2);
  eq('c2 aborted', c2row.status, 'aborted');
  ok('c2 终止原因写明首段占用', c2row.endReason.includes('首段走行占用'), c2row.endReason);
  st = await getState(jia);
  inst = st.openInstances.find((x) => x.id === iid2);
  ok('取消终止后进路仍开放、锁闭保留',
    !!inst && inst.lockedSections.length === 3 && inst.lockedSwitches.length === 2);
  eq('取消终止后信号仍红', inst.signalState, 'red');
  // 已有走行占用后不能再次申请
  r = await api(`/api/instances/${iid2}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('走行后再申请 409', r.status, 409);
  eq('错误码 CANCEL_OCCUPANCY_EXISTS', r.data.code, 'CANCEL_OCCUPANCY_EXISTS');
  // 走行规则不变：继续走完全程自动解除
  await walkThrough(jia, iid2, ['1', '3', '5']);
  st = await getState(jia);
  eq('继续走行后正常解除', st.openInstances.some((x) => x.id === iid2), false);

  console.log('\n[7] 到期时沿途区段非空闲（独立置占用）：终止取消、保留锁闭并说明原因');
  const iid3 = await openR1(jia);
  r = await api(`/api/instances/${iid3}/cancel-delayed`, { token: jia, method: 'POST' });
  const c3 = r.data.cancellation.id;
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('保护期内独立置区段5占用成功', r.status, 200);
  const c3row = await waitRequestDone(jia, c3);
  eq('c3 aborted', c3row.status, 'aborted');
  ok('c3 原因指出区段5占用', c3row.endReason.includes('区段 5') && c3row.endReason.includes('占用'), c3row.endReason);
  st = await getState(jia);
  inst = st.openInstances.find((x) => x.id === iid3);
  ok('到期未解除、锁闭保留',
    !!inst && inst.lockedSections.length === 3 && inst.lockedSwitches.length === 2,
    { open: st.openInstances.map((x) => x.id) });
  // 既有接口约定保持：锁闭中区段不能独立清空（SECTION_LOCKED），须按走行事件处理
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('锁闭区段独立清空仍按既有规则拒绝', r.status, 409);
  eq('错误码 SECTION_LOCKED', r.data.code, 'SECTION_LOCKED');
  // 终止取消后保留锁闭，值班员按正常走行完成即可解除（人工/走行接口约定不变）
  await walkThrough(jia, iid3, ['1', '3', '5']);
  st = await getState(jia);
  eq('终止取消后走行正常解除', st.openInstances.some((x) => x.id === iid3), false);
  // 新开放一条空闲进路重新申请延时取消，到期应核验通过并解除
  const iid3b = await openR1(jia);
  r = await api(`/api/instances/${iid3b}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('条件恢复后可重新申请', r.status, 201);
  const c3b = r.data.cancellation.id;
  await waitInstanceGone(jia, iid3b);
  st = await getState(jia);
  eq('再次申请到期解除', st.openInstances.some((x) => x.id === iid3b), false);
  eq('再次申请 released', (await findRequest(jia, (x) => x.id === c3b)).status, 'released');

  console.log('\n[8] 修改设置不追改已有申请');
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 30 }
  });
  eq('改为 30 秒', r.data.protectionSeconds, 30);
  const iid4 = await openR1(jia);
  r = await api(`/api/instances/${iid4}/cancel-delayed`, { token: jia, method: 'POST' });
  const c4 = r.data.cancellation;
  eq('新申请快照 30 秒', c4.durationSeconds, 30);
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 1 }
  });
  eq('再改为 1 秒', r.data.protectionSeconds, 1);
  await sleep(1500);
  st = await getState(jia);
  const pending4 = st.pendingCancellations[String(iid4)];
  ok('已有申请仍 pending（未按新设置提前到期）', !!pending4);
  eq('已有申请时长快照仍 30 秒', pending4.durationSeconds, 30);
  ok('剩余仍大于 27 秒', pending4.remainingMs > 27000, { remainingMs: pending4.remainingMs });

  console.log('\n[9] 管理员重置推演：申请与实例一并清除');
  r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('重置成功', r.status, 200);
  eq('重置后无开放实例', r.data.state.openInstances.length, 0);
  eq('重置后无 pending 取消申请', Object.keys(r.data.state.pendingCancellations).length, 0);
  eq('重置后取消申请记录清空', r.data.state.cancellationRequests.length, 0);

  console.log('\n[10] 服务重启：继续处理未到期与已到期申请');
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 300 }
  });
  const iid5 = await openR1(jia);
  r = await api(`/api/instances/${iid5}/cancel-delayed`, { token: jia, method: 'POST' });
  const c5 = r.data.cancellation.id;
  await stopServer();
  await startServer(true); // 未到期：重启后仍 pending、信号红、锁保留
  st = await getState(jia);
  let p5 = st.pendingCancellations[String(iid5)];
  ok('重启后未到期申请仍在', !!p5);
  eq('重启后实例仍开放', st.openInstances.some((x) => x.id === iid5), true);
  eq('重启后信号仍红', st.openInstances.find((x) => x.id === iid5).signalState, 'red');
  // 外部把到期时刻改到过去，再次重启 → 启动即处理（已到期）
  await stopServer();
  await new Promise((resolve) => {
    const Database = require('better-sqlite3');
    const d = new Database(YARD_DB_PATH);
    d.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
      .run(Date.now() - 1000, c5);
    d.close();
    resolve();
  });
  await startServer(true);
  const c5row = await findRequest(jia, (x) => x.id === c5);
  eq('重启后已到期申请被处理为 released', c5row.status, 'released');
  st = await getState(jia);
  eq('到期申请解除实例', st.openInstances.some((x) => x.id === iid5), false);

  console.log(`\n延时取消全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
