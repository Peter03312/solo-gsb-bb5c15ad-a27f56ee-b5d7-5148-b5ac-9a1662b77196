'use strict';

/**
 * 等待申请 HTTP 集成测试：
 *   临时库启动真实服务 → 值班员/管理员登录 → 端到端验证等待申请的
 *   提交、查看、撤销、自动兑现（FIFO/资源不相交）、定义失效、退出/重置撤销、
 *   服务重启后持久化与自动兑现。
 *
 * 运行：node test/waiting-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3917;
const DB_PATH = process.env.SMOKE_DB_WAITING || path.join(__dirname, '..', 'data', 'waiting-test.db');
const YARD_DB_PATH = path.join(path.dirname(DB_PATH), path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', 'yard-1.db');
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
  const bing = await login('dispatcher', '值班员丙');

  console.log('\n[1] 提交拒绝：未知进路 / 道岔缺失或不符定义');
  let r = await api('/api/routes/NOPE/waiting', { token: jia, method: 'POST', body: {} });
  eq('未知进路 404', r.status, 404);
  eq('错误码 ROUTE_NOT_FOUND', r.data.code, 'ROUTE_NOT_FOUND');

  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW8: 'N' } } });
  eq('缺少道岔选择 400', r.status, 400);
  eq('错误码 SWITCH_NOT_CHOSEN', r.data.code, 'SWITCH_NOT_CHOSEN');

  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  eq('道岔选择与定义不符 409', r.status, 409);
  eq('错误码 SWITCH_POSITION_MISMATCH', r.data.code, 'SWITCH_POSITION_MISMATCH');

  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N', XX: 'N' } } });
  eq('多余道岔选择 400', r.status, 400);
  eq('错误码 SWITCH_NOT_IN_ROUTE', r.data.code, 'SWITCH_NOT_IN_ROUTE');

  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'X' } } });
  eq('非法位置 400', r.status, 400);
  eq('错误码 BAD_POSITION', r.data.code, 'BAD_POSITION');

  console.log('\n[2] 鉴权：未登录/管理员不能访问值班员等待接口');
  r = await api('/api/waiting', {});
  eq('未登录 401', r.status, 401);
  r = await api('/api/waiting', { token: admin });
  eq('管理员访问 403', r.status, 403);

  console.log('\n[3] 占用区段时提交 R1 申请：进入等待，不预锁，可见阻断原因与顺位');
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('置区段5占用成功', r.status, 200);
  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('提交返回 201', r.status, 201);
  const w1 = r.data.waiting;
  eq('w1 等待中', w1.status, 'waiting');
  eq('w1 顺位 1', w1.position, 1);
  eq('w1 申请编号 1', w1.id, 1);
  ok('w1 阻断原因含区段5', w1.blockReasons.some((x) => x.includes('区段 5')), w1.blockReasons);
  // 不预锁：没有任何 route_locks / open instance
  const state = (await api('/api/state', { token: jia })).data.state;
  eq('等待中不产生进路实例', state.openInstances.length, 0);

  console.log('\n[4] 查看：列表/编号/顺位/阻断原因/申请人');
  r = await api('/api/waiting', { token: jia });
  eq('本人列表含 1 条', r.data.waiting.length, 1);
  r = await api('/api/waiting?scope=all', { token: yi });
  eq('全员列表可见他人申请', r.data.waiting.length >= 1 && r.data.waiting[0].applicant === '值班员甲', true);

  console.log('\n[5] 第二条相同 R1 申请：被前项顺序拦截，顺位 2，原因指向前项');
  r = await api('/api/routes/R1/waiting', { token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const w2 = r.data.waiting;
  eq('w2 等待中', w2.status, 'waiting');
  eq('w2 顺位 2', w2.position, 2);
  ok('w2 被前项 #1 拦截', w2.blockedBy.includes(1), w2.blockedBy);
  ok('w2 阻断原因说明前项未兑现', w2.blockReasons[0].includes('前项等待申请 #1'), w2.blockReasons);

  console.log('\n[6] 撤销：非本人拒绝；本人撤销未兑现成功；撤销后后项顺位前移并可能兑现');
  r = await api('/api/waiting/1/cancel', { token: yi, method: 'POST' });
  eq('非本人撤销 403', r.status, 403);
  eq('错误码 NOT_OWNER', r.data.code, 'NOT_OWNER');
  r = await api('/api/waiting/1/cancel', { token: jia, method: 'POST' });
  eq('本人撤销成功', r.status, 200);
  eq('w1 已撤销', r.data.waiting.status, 'cancelled');
  // w1 撤销且区段5仍占用 → w2 顺位前移到 1，但仍未兑现
  r = await api('/api/waiting', { token: yi });
  const w2after = r.data.waiting.find((x) => x.id === 2);
  eq('w2 顺位前移为 1', w2after.position, 1);
  eq('w2 仍等待（区段5占用）', w2after.status, 'waiting');
  // 重复撤销已结束申请拒绝
  r = await api('/api/waiting/1/cancel', { token: jia, method: 'POST' });
  eq('重复撤销 409', r.status, 409);

  console.log('\n[7] 区段清空触发兑现；重复触发不多产生实例');
  const locksBefore = (await api('/api/state', { token: jia })).data.state.openInstances.length;
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('清空成功并触发扫描', r.status, 200);
  r = await api('/api/waiting', { token: yi });
  const w2fulfilled = r.data.waiting.find((x) => x.id === 2);
  eq('w2 已兑现', w2fulfilled.status, 'fulfilled');
  ok('w2 记录实例编号', Number.isInteger(w2fulfilled.instanceId), w2fulfilled);
  // 再来一次无关状态变更（扳道岔 SW7 已被锁，会拒；改清空区段2 触发扫描）
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  const instId = w2fulfilled.instanceId;
  const instRows = (await api('/api/state', { token: jia })).data.state.openInstances;
  eq('只产生一个进路实例（无重复）', instRows.filter((x) => x.id === instId).length, 1);
  eq('开放实例数量为 1', instRows.length, 1);

  console.log('\n[8] 进路解除触发后项兑现（FIFO）');
  // 当前 R1 实例（乙）锁闭中。再排两条等待：甲的 R1（与实例冲突），顺序在前
  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const w3 = r.data.waiting;
  eq('w3 等待中（他路锁闭）', w3.status, 'waiting');
  ok('w3 阻断原因为他路锁闭', w3.blockReasons.some((x) => x.includes('进路 #')), w3.blockReasons);
  // 乙走行解除当前 R1 → w3 自动兑现
  await walkThrough(yi, instId, ['1', '3', '5']);
  r = await api('/api/waiting', { token: jia });
  const w3f = r.data.waiting.find((x) => x.id === 3);
  eq('w3 已随进路解除自动兑现', w3f.status, 'fulfilled');
  ok('w3 兑现实例不同于旧实例', w3f.instanceId !== instId, { w3: w3f.instanceId, old: instId });
  const w3inst = (await api('/api/state', { token: jia })).data.state.openInstances.find((x) => x.id === w3f.instanceId);
  eq('兑现实例信号绿灯', w3inst.signalState, 'green');
  // 清理 w3
  await walkThrough(jia, w3f.instanceId, ['1', '3', '5']);

  console.log('\n[9] 道岔扳动触发兑现（实际位置不符时等待，扳到要求位置后兑现）');
  // SW7 现在空闲（实例已解除），扳到 R → R1（要求 N）等待
  r = await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  eq('扳 SW7 到 R 成功', r.status, 200);
  r = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const w4 = r.data.waiting;
  eq('w4 等待（实际道岔位置不符）', w4.status, 'waiting');
  ok('w4 原因含实际位置', w4.blockReasons.some((x) => x.includes('实际位置')), w4.blockReasons);
  // 扳回 N → 自动兑现
  r = await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  r = await api('/api/waiting', { token: jia });
  const w4f = r.data.waiting.find((x) => x.id === 4);
  eq('w4 在道岔扳动后兑现', w4f.status, 'fulfilled');
  await walkThrough(jia, w4f.instanceId, ['1', '3', '5']);

  console.log('\n[10] 资源互不相交的申请可越过先兑现');
  // 管理员建一条只走区段 2 的独立进路 R9（无开放进路，允许编辑）
  let ar = await api('/api/admin/routes', { token: admin, method: 'POST', body: {
    id: 'R9', label: '独立侧线', origin: 'X2', destination: 'X4', steps: ['2'], switchReqs: []
  } });
  eq('管理员建独立进路 R9', ar.status, 200);
  // 区段5占用 → R1 等待；R9（只走2）应立即兑现
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  ar = await api('/api/routes/R9/waiting', { token: bing, method: 'POST', body: {} });
  const wR9id = ar.data.waiting.id;
  eq('资源不相交的 R9 立即兑现', ar.data.waiting.status, 'fulfilled');
  // 清理 R9 实例（解除后才允许改/删进路定义）
  await walkThrough(bing, ar.data.waiting.instanceId, ['2']);
  // R1 仍在等待
  let lw = (await api('/api/waiting', { token: jia })).data.waiting.find((x) => x.status === 'waiting');
  ok('R1 仍在等待（区段5占用）', !!lw && lw.routeId === 'R1', lw);

  console.log('\n[11] 进路定义修改/删除使相关申请失效并说明原因');
  // 改 R1 定义（R1 仍有等待申请；无开放实例，允许编辑）
  const wChangeId = lw.id;
  ar = await api('/api/admin/routes/R1', { token: admin, method: 'PUT', body: {
    id: 'R1', label: '正线通过(改)', origin: 'X1', destination: 'X3', entrySignalId: 'S1',
    steps: ['1', '3', '5'], switchReqs: [{ switchId: 'SW7', position: 'N' }, { switchId: 'SW8', position: 'N' }]
  } });
  eq('管理员改 R1 定义成功', ar.status, 200);
  r = await api('/api/waiting', { token: jia });
  const wc = r.data.waiting.find((x) => x.id === wChangeId);
  eq('改定义后相关申请失效', wc.status, 'invalid');
  ok('失效原因写明定义变更', wc.endReason.includes('定义'), wc.endReason);

  // 删除 R9 → 其等待申请失效（先造一条 R9 等待：占用区段2）
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  ar = await api('/api/routes/R9/waiting', { token: bing, method: 'POST', body: {} });
  const wDelId = ar.data.waiting.id;
  eq('R9 申请等待中', ar.data.waiting.status, 'waiting');
  ar = await api('/api/admin/routes/R9', { token: admin, method: 'DELETE' });
  eq('管理员删除 R9 成功', ar.status, 200);
  r = await api('/api/waiting?scope=all', { token: bing });
  const wd = r.data.waiting.find((x) => x.id === wDelId);
  eq('删除进路后相关申请失效', wd.status, 'invalid');
  ok('失效原因写明进路删除', wd.endReason.includes('删除'), wd.endReason);
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  // 恢复区段5空闲，便于后续步骤
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });

  console.log('\n[12] 申请人退出登录撤销其未兑现申请');
  const ding = await login('dispatcher', '值班员丁');
  // 占用区段5，保证申请进入等待而不是立即兑现
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  ar = await api('/api/routes/R1/waiting', { token: ding, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const wLogoutId = ar.data.waiting.id;
  eq('丁的申请等待中', ar.data.waiting.status, 'waiting');
  await api('/api/auth/logout', { token: ding, method: 'POST' });
  r = await api('/api/waiting?scope=all', { token: jia });
  const wl = r.data.waiting.find((x) => x.id === wLogoutId);
  eq('退出后申请已撤销', wl.status, 'cancelled');
  ok('撤销原因写明退出登录', wl.endReason.includes('退出'), wl.endReason);

  console.log('\n[13] 管理员重置推演撤销全部等待申请');
  ar = await api('/api/routes/R1/waiting', { token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const wResetId = ar.data.waiting.id;
  eq('重置前申请等待中', ar.data.waiting.status, 'waiting');
  ar = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('管理员重置成功', ar.status, 200);
  r = await api('/api/waiting', { token: jia });
  const wr = r.data.waiting.find((x) => x.id === wResetId);
  eq('重置后申请已撤销', wr.status, 'cancelled');
  ok('撤销原因写明管理员重置', wr.endReason.includes('管理员'), wr.endReason);
  // 重置后无开放实例
  eq('重置后无开放实例', ar.data.state.openInstances.length, 0);

  console.log('\n[14] 重启后状态可见，且满足条件时自动兑现（不多生实例）');
  // 造等待：占区段5 → 乙提交 R1 等待；停止服务后外部清空区段5，重启应自动兑现
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  ar = await api('/api/routes/R1/waiting', { token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const wRestartId = ar.data.waiting.id;
  eq('重启前为等待', ar.data.waiting.status, 'waiting');
  await stopServer();
  // 用独立连接把区段5改为空闲（模拟重启前外部条件具备）
  await new Promise((resolve, reject) => {
    const Database = require('better-sqlite3');
    const d = new Database(YARD_DB_PATH);
    d.prepare("UPDATE sections SET occ_state='free' WHERE id='5'").run();
    d.close();
    resolve();
  });
  await startServer(true);
  // 重启后用同名重新登录（浏览器刷新场景；申请按姓名归属，记录全部来自 SQLite）
  const yi2 = await login('dispatcher', '值班员乙');
  r = await api('/api/waiting', { token: yi2 });
  const wrst = r.data.waiting.find((x) => x.id === wRestartId);
  eq('重启后等待记录仍可见', !!wrst, true);
  eq('重启后自动兑现', wrst.status, 'fulfilled');
  ok('重启兑现产生实例', Number.isInteger(wrst.instanceId), wrst);
  const states2 = (await api('/api/state', { token: yi2 })).data.state;
  eq('重启后仅一个开放实例', states2.openInstances.length, 1);
  eq('开放实例即等待兑现实例', states2.openInstances[0].id, wrst.instanceId);
  // 再重启一次：不应产生第二个实例
  await stopServer();
  await startServer(true);
  const yi3 = await login('dispatcher', '值班员乙');
  const states3 = (await api('/api/state', { token: yi3 })).data.state;
  eq('再次重启不产生重复实例', states3.openInstances.length, 1);
  r = await api('/api/waiting', { token: yi3 });
  eq('申请仍只对应一个实例', r.data.waiting.find((x) => x.id === wRestartId).instanceId, wrst.instanceId);
  await walkThrough(yi3, wrst.instanceId, ['1', '3', '5']);

  console.log(`\n等待申请全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
