'use strict';

/**
 * 临时封锁 HTTP 集成测试：
 *   临时库启动真实服务 → 管理员按区段+原因发起封锁 →
 *   验证申请编号/待生效/已生效状态返回、未知区段与空白原因拒绝、重复申请幂等、
 *   提交后立即阻止预检/直接开放/等待兑现（等待保留顺位并显示封锁原因）、
 *   已开放进路锁闭/走行/延时取消规则不受影响、走行出清/独立状态变化/取消到期/
 *   服务重启后继续复核（待生效→已生效）、结束后按联锁规则重试等待兑现且不改写
 *   区段占用状态、值班员可见、管理员重置清除封锁记录。
 *
 * 运行：node test/blockade-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3919;
const DB_PATH = process.env.SMOKE_DB_BLOCKADE || path.join(__dirname, '..', 'data', 'blockade-test.db');
const YARD_DB_PATH = path.join(path.dirname(DB_PATH), path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', 'yard-1.db');
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

/** 轮询直到某封锁申请进入指定状态 */
async function waitBlockadeStatus(token, id, status, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api('/api/admin/blockades', { token });
    const row = r.data.blockades.find((x) => x.id === id);
    if (row && row.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(`封锁申请 #${id} 在 ${timeoutMs}ms 内未转为 ${status}（当前 ${row && row.status}）`);
    }
    await sleep(150);
  }
}

/** 轮询直到某等待申请进入指定状态 */
async function waitWaitingStatus(token, id, status, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api('/api/waiting?scope=all', { token });
    const row = r.data.waiting.find((x) => x.id === id);
    if (row && row.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(`等待申请 #${id} 在 ${timeoutMs}ms 内未转为 ${status}（当前 ${row && row.status}）`);
    }
    await sleep(150);
  }
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');
  const bing = await login('dispatcher', '值班员丙');

  console.log('\n[1] 鉴权与提交校验：未登录/值班员/未知区段/空白原因');
  let r = await api('/api/admin/blockades', { method: 'POST', body: { sectionId: '1', reason: '施工' } });
  eq('未登录 401', r.status, 401);
  r = await api('/api/admin/blockades', { token: jia, method: 'POST', body: { sectionId: '1', reason: '施工' } });
  eq('值班员发起 403', r.status, 403);
  r = await api('/api/admin/blockades', { token: jia, method: 'GET' });
  eq('值班员查管理员列表 403', r.status, 403);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: 'NOPE', reason: '施工' } });
  eq('未知区段 404', r.status, 404);
  eq('错误码 SECTION_NOT_FOUND', r.data.code, 'SECTION_NOT_FOUND');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1' } });
  eq('缺失原因 400', r.status, 400);
  eq('错误码 BLOCKADE_REASON_REQUIRED', r.data.code, 'BLOCKADE_REASON_REQUIRED');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1', reason: '   ' } });
  eq('纯空格原因 400', r.status, 400);
  eq('纯空格错误码 BLOCKADE_REASON_REQUIRED', r.data.code, 'BLOCKADE_REASON_REQUIRED');

  console.log('\n[2] 空闲区段：提交即已生效，返回编号/状态/原因；重复申请返回原申请');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1', reason: ' 线路施工 ' } });
  eq('发起返回 201', r.status, 201);
  eq('created=true', r.data.created, true);
  const b1 = r.data.blockade;
  ok('返回申请编号', Number.isInteger(b1.id), b1);
  eq('空闲无锁 → 立即已生效', b1.status, 'active');
  eq('原因去空白后原样返回', b1.reason, '线路施工');
  eq('区段编号', b1.sectionId, '1');
  ok('记录生效时刻', !!b1.activatedAt, b1);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1', reason: '另一个原因' } });
  eq('重复申请返回 200', r.status, 200);
  eq('重复申请 created=false', r.data.created, false);
  eq('重复返回同一申请编号', r.data.blockade.id, b1.id);
  eq('重复申请保留原原因', r.data.blockade.reason, '线路施工');
  r = await api('/api/admin/blockades?status=active', { token: admin });
  eq('active 过滤命中', r.data.blockades.filter((x) => x.id === b1.id).length, 1);
  r = await api('/api/admin/blockades?status=pending', { token: admin });
  eq('pending 过滤不命中', r.data.blockades.filter((x) => x.id === b1.id).length, 0);
  let st = await getState(jia);
  eq('值班台 state 含封锁列表', st.blockades.filter((x) => x.id === b1.id).length, 1);
  eq('state 按区段索引未结束封锁', st.blockadesBySection['1'].id, b1.id);

  console.log('\n[3] 已生效封锁立即阻止：预检 / 直接开放 / 等待兑现（保留顺位并显示原因）');
  r = await api('/api/routes/R1/check', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('预检不可开放', r.data.check.ok, false);
  ok('预检原因含临时封锁', r.data.check.reasons.some((x) => x.includes('临时封锁') && x.includes('线路施工')),
    r.data.check.reasons);
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('直接开放 409', r.status, 409);
  eq('错误码 SECTION_BLOCKADED', r.data.code, 'SECTION_BLOCKADED');
  ok('拒绝信息含封锁原因', r.data.error.includes('线路施工'), r.data);
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('等待申请提交 201', r.status, 201);
  const w1 = r.data.waiting;
  eq('等待申请保持 waiting', w1.status, 'waiting');
  eq('顺位 1', w1.position, 1);
  ok('等待显示封锁原因', w1.blockReasons.some((x) => x.includes('临时封锁') && x.includes('线路施工')),
    w1.blockReasons);
  r = await api('/api/routes/R1/waiting', {
    token: bing, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const w2 = r.data.waiting;
  eq('第二等待申请顺位 2（保留顺位）', w2.position, 2);
  ok('第二等待显示前项未兑现', w2.blockReasons.some((x) => x.includes('前项')), w2.blockReasons);

  console.log('\n[4] 结束封锁：按现有联锁规则重试等待兑现；结束校验');
  r = await api('/api/admin/blockades/999/end', { token: admin, method: 'POST' });
  eq('结束不存在 404', r.status, 404);
  eq('错误码 BLOCKADE_NOT_FOUND', r.data.code, 'BLOCKADE_NOT_FOUND');
  r = await api(`/api/admin/blockades/${b1.id}/end`, { token: admin, method: 'POST' });
  eq('结束返回 200', r.status, 200);
  eq('状态已结束', r.data.blockade.status, 'ended');
  ok('记录结束时刻', !!r.data.blockade.endedAt, r.data.blockade);
  r = await api(`/api/admin/blockades/${b1.id}/end`, { token: admin, method: 'POST' });
  eq('重复结束 409', r.status, 409);
  eq('错误码 BLOCKADE_NOT_ACTIVE', r.data.code, 'BLOCKADE_NOT_ACTIVE');
  // 结束后按联锁规则重试：前项 w1 先兑现，w2 因 w1 的锁继续等待
  const w1After = await waitWaitingStatus(yi, w1.id, 'fulfilled');
  ok('w1 兑现出产进路实例', Number.isInteger(w1After.instanceId), w1After);
  st = await getState(jia);
  eq('w2 因前项兑现的锁继续等待',
    st.waitingApplications.find((x) => x.id === w2.id).status, 'waiting');
  await walkThrough(yi, w1After.instanceId, ['1', '3', '5']);
  const w2After = await waitWaitingStatus(bing, w2.id, 'fulfilled');
  await walkThrough(bing, w2After.instanceId, ['1', '3', '5']);
  st = await getState(jia);
  eq('全部走行完毕无开放进路', st.openInstances.length, 0);

  console.log('\n[5] 占用/未知区段维持待生效；独立区段状态变化后自动转已生效');
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('独立置区段5占用', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '5', reason: '水害抢修' } });
  eq('占用区段发起 201', r.status, 201);
  const b2 = r.data.blockade;
  eq('占用 → 待生效', b2.status, 'pending');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '5', reason: '重复' } });
  eq('待生效重复申请 200', r.status, 200);
  eq('待生效重复返回原申请', r.data.blockade.id, b2.id);
  // 未知状态：管理员新建区段（初始未知，按占用处理）
  r = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: '9', label: '9G', x1: 40, y1: 300, x2: 160, y2: 300 }
  });
  eq('新建区段 9', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '9', reason: '设备检查' } });
  const b3 = r.data.blockade;
  eq('未知 → 待生效', b3.status, 'pending');
  // 独立清空（排路前状态变化）→ 自动转已生效
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('独立清空区段5', r.status, 200);
  eq('区段5出清后封锁转已生效', (await waitBlockadeStatus(admin, b2.id, 'active')).status, 'active');
  r = await api('/api/sections/9/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('独立清空区段9', r.status, 200);
  await waitBlockadeStatus(admin, b3.id, 'active');
  eq('区段9核实后封锁转已生效', (await api('/api/admin/blockades', { token: admin }))
    .data.blockades.find((x) => x.id === b3.id).status, 'active');
  // 待生效/已生效期间同样阻止开放
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('已生效封锁仍阻止开放（区段5）', r.status, 409);
  eq('错误码仍为 SECTION_BLOCKADED', r.data.code, 'SECTION_BLOCKADED');
  await api(`/api/admin/blockades/${b2.id}/end`, { token: admin, method: 'POST' });
  await api(`/api/admin/blockades/${b3.id}/end`, { token: admin, method: 'POST' });
  // 删除区段 9：其封锁记录保留为已结束
  r = await api('/api/admin/sections/9', { token: admin, method: 'DELETE' });
  eq('删除区段 9', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin });
  eq('区段删除后封锁记录保留为已结束',
    r.data.blockades.find((x) => x.id === b3.id).status, 'ended');

  console.log('\n[6] 已开放进路不因封锁强制解除：锁闭/信号/走行/延时取消规则不变；走行出清后转已生效');
  const iid1 = await openR1(jia);
  r = await api(`/api/instances/${iid1}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('开放进路可申请延时取消（规则不变）', r.status, 201);
  const c1 = r.data.cancellation.id;
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '3', reason: '道岔检修' } });
  eq('锁闭区段发起 201', r.status, 201);
  const b4 = r.data.blockade;
  eq('仍锁闭 → 待生效', b4.status, 'pending');
  st = await getState(jia);
  let inst = st.openInstances.find((x) => x.id === iid1);
  ok('进路保持开放且锁闭保留', !!inst && inst.lockedSections.length === 3 && inst.lockedSwitches.length === 2);
  eq('延时取消信号回红规则不变', inst.signalState, 'red');
  // 走行事件照常受理：首段占用终止延时取消（既有规则），逐段解锁
  r = await api(`/api/instances/${iid1}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('走行事件照常受理', r.status, 200);
  eq('首段占用终止延时取消', r.data.result.cancellationAborted, c1);
  st = await getState(jia);
  eq('封锁仍待生效（区段3仍锁闭）',
    st.blockades.find((x) => x.id === b4.id).status, 'pending');
  // 继续走完全程：区段3出清解锁后封锁自动转已生效
  await api(`/api/instances/${iid1}/events`, { token: jia, method: 'POST', body: { seq: 2, sectionId: '3', action: 'occupy' } });
  await api(`/api/instances/${iid1}/events`, { token: jia, method: 'POST', body: { seq: 3, sectionId: '1', action: 'clear' } });
  st = await getState(jia);
  eq('区段3仍锁闭（未出清）维持待生效', st.blockades.find((x) => x.id === b4.id).status, 'pending');
  await api(`/api/instances/${iid1}/events`, { token: jia, method: 'POST', body: { seq: 4, sectionId: '5', action: 'occupy' } });
  await api(`/api/instances/${iid1}/events`, { token: jia, method: 'POST', body: { seq: 5, sectionId: '3', action: 'clear' } });
  eq('走行出清区段3后转已生效', (await waitBlockadeStatus(admin, b4.id, 'active')).status, 'active');
  await api(`/api/instances/${iid1}/events`, { token: jia, method: 'POST', body: { seq: 6, sectionId: '5', action: 'clear' } });
  st = await getState(jia);
  eq('走行完毕进路正常解除', st.openInstances.some((x) => x.id === iid1), false);
  await api(`/api/admin/blockades/${b4.id}/end`, { token: admin, method: 'POST' });

  console.log('\n[7] 延时取消到期后继续复核（锁释放 → 待生效转已生效）');
  r = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 1 }
  });
  eq('保护时长设为 1 秒', r.status, 200);
  const iid2 = await openR1(jia);
  r = await api(`/api/instances/${iid2}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('延时取消申请 201', r.status, 201);
  const c2 = r.data.cancellation.id;
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '5', reason: '临时限速' } });
  const b5 = r.data.blockade;
  eq('锁闭中 → 待生效', b5.status, 'pending');
  // 取消到期解除进路（锁释放）→ 封锁复核转已生效
  const deadline = Date.now() + 6000;
  let c2row;
  for (;;) {
    c2row = (await api('/api/cancellations?scope=all', { token: jia }))
      .data.cancellations.find((x) => x.id === c2);
    if (c2row.status === 'released' || Date.now() > deadline) break;
    await sleep(150);
  }
  eq('延时取消到期解除', c2row.status, 'released');
  eq('锁释放后封锁转已生效', (await waitBlockadeStatus(admin, b5.id, 'active')).status, 'active');
  await api(`/api/admin/blockades/${b5.id}/end`, { token: admin, method: 'POST' });

  console.log('\n[8] 结束封锁不改写区段占用状态');
  r = await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('独立置区段2占用', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '2', reason: '人员上线' } });
  const b6 = r.data.blockade;
  eq('占用 → 待生效', b6.status, 'pending');
  r = await api(`/api/admin/blockades/${b6.id}/end`, { token: admin, method: 'POST' });
  eq('结束待生效封锁 200', r.status, 200);
  st = await getState(jia);
  eq('结束后区段2仍为占用（不改写占用状态）',
    st.sections.find((x) => x.id === '2').occ_state, 'occupied');
  await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });

  console.log('\n[9] 值班员只读查看封锁');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '4', reason: '接触网停电' } });
  const b7 = r.data.blockade;
  eq('空闲区段4立即已生效', b7.status, 'active');
  r = await api('/api/blockades', { token: jia });
  eq('值班员查看 200', r.status, 200);
  ok('值班员看到封锁原因', r.data.blockades.some((x) => x.id === b7.id && x.reason === '接触网停电'), r.data);
  r = await api('/api/blockades?status=pending', { token: jia });
  eq('值班员按状态过滤', r.data.blockades.filter((x) => x.id === b7.id).length, 0);
  r = await api('/api/blockades', { method: 'GET' });
  eq('未登录查看 401', r.status, 401);
  r = await api(`/api/admin/blockades/${b7.id}/end`, { token: admin, method: 'POST' });
  eq('结束区段4封锁', r.status, 200);

  console.log('\n[10] 服务重启后继续复核');
  r = await api('/api/sections/4/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('独立置区段4占用', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '4', reason: '重启复核' } });
  const b8 = r.data.blockade;
  eq('占用 → 待生效', b8.status, 'pending');
  await stopServer();
  await startServer(true); // 占用未变：重启后仍待生效
  r = await api('/api/admin/blockades', { token: admin });
  eq('重启后占用未清仍待生效', r.data.blockades.find((x) => x.id === b8.id).status, 'pending');
  // 重启期间区段被出清（模拟现场核实）：启动复核应转为已生效
  await stopServer();
  await new Promise((resolve) => {
    const Database = require('better-sqlite3');
    const d = new Database(YARD_DB_PATH);
    d.prepare(`UPDATE sections SET occ_state='free' WHERE id='4'`).run();
    d.close();
    resolve();
  });
  await startServer(true);
  r = await api('/api/admin/blockades', { token: admin });
  eq('重启后复核转为已生效', r.data.blockades.find((x) => x.id === b8.id).status, 'active');
  // 重启后未结束封锁仍阻止开放（R2 途经区段 4）
  r = await api('/api/routes/R2/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'R' } }
  });
  eq('重启后封锁仍阻止开放', r.status, 409);
  eq('错误码 SECTION_BLOCKADED', r.data.code, 'SECTION_BLOCKADED');
  // 之前的 b7（区段4 已结束）与 b8（区段4 已生效）不冲突：结束 b8
  await api(`/api/admin/blockades/${b8.id}/end`, { token: admin, method: 'POST' });

  console.log('\n[11] 管理员重置推演：清除封锁记录');
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1', reason: '重置前封锁' } });
  eq('重置前发起成功', r.status, 201);
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('清空推演状态 200', r.status, 200);
  eq('重置后 state 无封锁记录', r.data.state.blockades.length, 0);
  eq('重置后无未结束封锁索引', Object.keys(r.data.state.blockadesBySection).length, 0);
  r = await api('/api/admin/blockades', { token: admin });
  eq('重置后封锁列表为空', r.data.blockades.length, 0);
  // 重置后区段为未知：再次发起应待生效；培训重开同样清除
  r = await api('/api/admin/blockades', { token: admin, method: 'POST', body: { sectionId: '1', reason: '重置后再封锁' } });
  eq('重置后（区段未知）发起为待生效', r.data.blockade.status, 'pending');
  r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('培训重开 200', r.status, 200);
  r = await api('/api/admin/blockades', { token: admin });
  eq('培训重开后封锁记录清空', r.data.blockades.length, 0);

  console.log(`\n临时封锁全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
