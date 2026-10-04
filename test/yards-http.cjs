'use strict';

/**
 * 命名演练副本 HTTP 集成测试：
 *   临时库启动真实服务 → 管理员从原站场创建命名副本 → 验证同事务复制
 *   （站场定义、区段/道岔状态、开放进路的锁与事件进度、未兑现等待、
 *   未完结延时取消沿用原到期时刻、未结束封锁；历史交接单不复制）→
 *   会话选择当前站场、未选择用原站场 → 副本/原站场独立运行（编辑、预检、
 *   开放、走行、调整、等待/取消、封锁、交接单、重置互不串用）→
 *   同名拒绝、未知副本/越权拒绝 → 重启后逐站场复核、副本取消不重新计时。
 *
 * 运行：node test/yards-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3921;
const DB_PATH = process.env.SMOKE_DB_YARDS || path.join(__dirname, '..', 'data', 'yards-test.db');
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
      fs.rmSync(path.join(path.dirname(DB_PATH),
        path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'),
        { recursive: true, force: true });
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

/** 按进路走完整条（占/清交错），推进到末段清空自动解除 */
async function walkThrough(token, instanceId, sections) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    await api(`/api/instances/${instanceId}/events`, {
      token, method: 'POST', body: { seq: seq++, sectionId: sections[i], action: 'occupy' }
    });
    if (i >= 1) {
      await api(`/api/instances/${instanceId}/events`, {
        token, method: 'POST', body: { seq: seq++, sectionId: sections[i - 1], action: 'clear' }
      });
    }
  }
  await api(`/api/instances/${instanceId}/events`, {
    token, method: 'POST', body: { seq: seq++, sectionId: sections[sections.length - 1], action: 'clear' }
  });
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 登录默认原站场；站场列表含原站场');
  let r = await api('/api/auth/yards', { token: jia });
  eq('站场列表 200', r.status, 200);
  eq('仅原站场', r.data.yards.length, 1);
  eq('原站场 id=1', r.data.yards[0].id, 1);
  eq('原站场名称', r.data.yards[0].name, '原站场');
  eq('原站场标记', r.data.yards[0].isOriginal, true);
  eq('未选择时当前为原站场', r.data.currentYardId, 1);
  r = await api('/api/state', { token: jia });
  eq('状态含当前站场', r.data.state.yard.id, 1);
  eq('状态含当前站场名', r.data.state.yard.name, '原站场');

  console.log('\n[2] 原站场造运行态（供复制）');
  // —— 先开放 R1（1,3,5；SW7=N、SW8=N），无任何走行事件
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 3600 }
  });
  const openRes = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('R1 开放', openRes.status, 200);
  const instId = openRes.data.instance.id;
  eq('R1 信号绿', openRes.data.instance.signalState, 'green');

  // —— 未兑现等待：乙对 R2 提交等待。R2=区段1,3,4 + SW7=N、SW8=R。
  // SW8 实际在 N（与要求不符）+ R1 已锁区段1/3 与 SW7/SW8 → 等待不兑现。
  const wRes = await api('/api/routes/R2/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('R2 等待申请已提交', wRes.status, 201);
  const waitingId = wRes.data.waiting.id;
  eq('R2 等待中（他路锁闭/道岔位置阻断）', wRes.data.waiting.status, 'waiting');

  // —— 对无走行的 R1 申请延时取消（信号回红、锁保留；区段全空闲，到期可解除）
  const cRes = await api(`/api/instances/${instId}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('延时取消 pending', cRes.data.cancellation.status, 'pending');
  const cancelId = cRes.data.cancellation.id;
  const releaseAt = cRes.data.cancellation.releaseAt;

  // —— 未结束封锁：区段2（空闲、无锁 → active）
  const bRes = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '2', reason: '施工封锁' }
  });
  eq('封锁生效', bRes.data.blockade.status, 'active');
  const blockadeId = bRes.data.blockade.id;

  // —— 区段状态调整：把区段5置为占用（复制 occ_state）
  await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });

  // —— 历史交接单（应只留在原站场）
  const hRes = await api('/api/handovers', { token: jia, method: 'POST' });
  eq('原站场交接单已生成', hRes.status, 201);
  const handoverId = hRes.data.handover.id;

  console.log('\n[3] 管理员创建命名副本：同事务复制，返回编号与状态，同名拒绝');
  const cpRes = await api('/api/admin/yards', {
    token: admin, method: 'POST', body: { name: '国庆演练A组' }
  });
  eq('创建副本 201', cpRes.status, 201);
  eq('副本编号=2', cpRes.data.yard.id, 2);
  eq('副本名回显', cpRes.data.yard.name, '国庆演练A组');
  eq('副本状态 active', cpRes.data.yard.status, 'active');
  eq('副本 kind=copy', cpRes.data.yard.kind, 'copy');
  eq('副本来源=原站场', cpRes.data.yard.sourceYardId, 1);
  eq('复制明细-区段5', cpRes.data.detail.copied.sections, 5);
  eq('复制明细-道岔2', cpRes.data.detail.copied.switches, 2);
  eq('复制明细-信号4', cpRes.data.detail.copied.signals, 4);
  eq('复制明细-进路3', cpRes.data.detail.copied.routes, 3);
  eq('复制明细-开放实例1', cpRes.data.detail.copied.openInstances, 1);
  eq('复制明细-未兑现等待1', cpRes.data.detail.copied.waiting, 1);
  eq('复制明细-pending 取消1', cpRes.data.detail.copied.pendingCancellations, 1);
  eq('复制明细-未结束封锁1', cpRes.data.detail.copied.unfinishedBlockades, 1);

  let bad = await api('/api/admin/yards', {
    token: admin, method: 'POST', body: { name: '国庆演练A组' }
  });
  eq('同名拒绝 409', bad.status, 409);
  eq('同名错误码', bad.data.code, 'YARD_NAME_DUPLICATE');
  bad = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '   ' } });
  eq('空白名称 400', bad.status, 400);
  bad = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '原站场' } });
  eq('保留名拒绝 409', bad.status, 409);
  bad = await api('/api/admin/yards', { token: jia, method: 'POST', body: { name: '越权副本' } });
  eq('值班员创建副本 403', bad.status, 403);
  bad = await api('/api/admin/yards', { method: 'POST', body: { name: '匿名副本' } });
  eq('未登录 401', bad.status, 401);

  r = await api('/api/auth/yards', { token: jia });
  eq('列表含两个站场', r.data.yards.length, 2);

  console.log('\n[4] 会话切换当前站场；复制内容逐项核对');
  r = await api('/api/auth/yard', { token: jia, method: 'PUT', body: { yardId: 2 } });
  eq('切换副本成功', r.status, 200);
  eq('切换回显编号', r.data.yardId, 2);
  eq('切换回显名称', r.data.yardName, '国庆演练A组');
  r = await api('/api/state', { token: jia });
  eq('当前状态属于副本', r.data.state.yard.id, 2);
  const copyInst = r.data.state.openInstances.find((x) => x.id === instId);
  ok('副本含复制的开放实例（编号一致）', !!copyInst, r.data.state.openInstances.map((x) => x.id));
  eq('副本实例信号红（复制的取消申请已令其回红）', copyInst.signalState, 'red');
  eq('副本实例下一序号=1（无走行事件复制）', copyInst.nextSeq, 1);
  ok('副本实例区段锁保留',
    JSON.stringify([...copyInst.lockedSections].sort()) === JSON.stringify(['1', '3', '5']),
    copyInst.lockedSections);
  ok('副本实例道岔锁保留',
    copyInst.lockedSwitches.includes('SW7') && copyInst.lockedSwitches.includes('SW8'));
  eq('副本无走行事件（原实例无占用记录）', copyInst.events.length, 0);
  eq('副本区段5=占用（occ_state 复制）',
    r.data.state.sections.find((s) => s.id === '5').occ_state, 'occupied');
  eq('副本道岔 SW8=N（位置复制）',
    r.data.state.switches.find((s) => s.id === 'SW8').position, 'N');
  const copyWait = r.data.state.waitingApplications.find((x) => x.id === waitingId);
  ok('副本含未兑现等待（编号一致、waiting）', copyWait && copyWait.status === 'waiting', copyWait);
  const copyCancel = r.data.state.cancellationRequests.find((x) => x.id === cancelId);
  ok('副本含 pending 取消', copyCancel && copyCancel.status === 'pending', copyCancel);
  eq('副本取消沿用原到期时刻（不重新计时）', copyCancel.releaseAt, releaseAt);
  const copyBlk = r.data.state.blockades.find((x) => x.id === blockadeId);
  ok('副本含未结束封锁', copyBlk && copyBlk.status === 'active', copyBlk);
  eq('副本封锁按区段索引', r.data.state.blockadesBySection['2'].id, blockadeId);
  ok('副本无原站场历史交接单',
    !r.data.state.handovers.find((x) => x.id === handoverId) && r.data.state.handovers.length === 0,
    r.data.state.handovers);
  eq('副本无已解除历史实例', r.data.state.recentReleased.length, 0);

  // 乙未切换，仍在原站场
  r = await api('/api/state', { token: yi });
  eq('乙未切换仍在原站场', r.data.state.yard.id, 1);

  bad = await api('/api/auth/yard', { token: jia, method: 'PUT', body: { yardId: 999 } });
  eq('未知副本 404', bad.status, 404);
  eq('未知副本错误码', bad.data.code, 'YARD_NOT_FOUND');
  // 切换被拒后会话仍停留在副本2
  r = await api('/api/state', { token: jia });
  eq('拒绝未知副本后当前站场不变', r.data.state.yard.id, 2);

  console.log('\n[5] 副本与原站场独立运行：走行/调整/重置互不串用');
  // 副本开放实例上走行：首段占用（seq=1）会终止 pending 取消（锁闭保留）
  r = await api(`/api/instances/${instId}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('副本首段占用受理', r.status, 200);
  r = await api('/api/cancellations?scope=all', { token: jia });
  const cc = r.data.cancellations.find((x) => x.id === cancelId);
  eq('副本 pending 取消因首段占用终止', cc.status, 'aborted');
  await walkThrough(jia, instId, ['1', '3', '5']);
  r = await api('/api/state', { token: jia });
  ok('副本实例走完已解除', r.data.state.recentReleased.some((x) => x.id === instId));
  // 原站场同编号实例仍开放、取消仍 pending
  const origSt = await api('/api/state', { token: yi });
  const origInst = origSt.data.state.openInstances.find((x) => x.id === instId);
  ok('原站场同编号实例仍开放（不串用）', !!origInst);
  eq('原站场实例序号仍为 1', origInst.nextSeq, 1);
  const origCancel = origSt.data.state.cancellationRequests.find((x) => x.id === cancelId);
  eq('原站场取消仍 pending（不串用）', origCancel.status, 'pending');

  // 副本解除后可扳道岔：SW7=R 仅作用于副本
  r = await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  eq('副本扳 SW7 到 R', r.status, 200);
  r = await api('/api/state', { token: yi });
  eq('原站场 SW7 仍为 N（独立）',
    r.data.state.switches.find((s) => s.id === 'SW7').position, 'N');

  // 副本重置：未兑现等待撤销、封锁清除、区段未知；原站场一概不受影响。
  // 管理员会话需先切换到副本2（所有管理操作只作用于其当前站场）。
  r = await api('/api/auth/yard', { token: admin, method: 'PUT', body: { yardId: 2 } });
  eq('管理员切换到副本2', r.status, 200);
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('副本重置 200', r.status, 200);
  r = await api('/api/state', { token: jia });
  ok('副本等待已撤销',
    !r.data.state.waitingApplications.some((x) => x.id === waitingId && x.status === 'waiting'));
  eq('副本封锁已清除', r.data.state.blockades.length, 0);
  eq('副本无开放实例', r.data.state.openInstances.length, 0);
  eq('副本区段全未知',
    r.data.state.sections.every((s) => s.occ_state === 'unknown'), true);
  const orig2 = await api('/api/state', { token: yi });
  eq('原站场未兑现等待仍在（重置不串用）',
    orig2.data.state.waitingApplications.find((x) => x.id === waitingId).status, 'waiting');
  ok('原站场封锁仍在（重置不串用）', !!orig2.data.state.blockadesBySection['2']);
  eq('原站场实例仍开放（重置不串用）', orig2.data.state.openInstances.length, 1);
  eq('原站场区段5仍占用（重置不串用）',
    orig2.data.state.sections.find((s) => s.id === '5').occ_state, 'occupied');

  // 副本解除/重置后可编辑拓扑：新增只存在于副本的区段
  r = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: 'COPYSEC', label: '副本专用', x1: 0, y1: 0, x2: 10, y2: 10 }
  });
  eq('副本新增区段成功（开放实例解除后可编辑）', r.status, 200);
  eq('副本新区段初始未知', r.data.section.occ_state, 'unknown');
  r = await api('/api/state', { token: yi });
  ok('原站场看不到副本专用区段',
    !r.data.state.sections.find((s) => s.id === 'COPYSEC'));

  console.log('\n[6] 越权/未知资源按当前站场拒绝');
  r = await api(`/api/instances/${instId}/release`, { token: jia, method: 'POST' });
  eq('副本访问已被重置删除的实例 404', r.status, 404);
  r = await api('/api/routes/NOPE/check', { token: jia, method: 'POST', body: {} });
  ok('未知进路预检不开放', r.data.check.ok === false, r.data.check);

  console.log('\n[7] 交接单按站场隔离：副本新单与原站场互不可见');
  r = await api('/api/handovers', { token: jia, method: 'POST' });
  const copyH1 = r.data.handover.id;
  eq('副本交接单 201', r.status, 201);
  r = await api('/api/handovers', { token: jia });
  ok('副本只见本副本单（原站场历史单不可见）',
    r.data.handovers.every((h) => h.id !== handoverId)
      && r.data.handovers.some((h) => h.id === copyH1));
  r = await api('/api/handovers', { token: yi });
  ok('原站场只见原站场单（副本单不可见）',
    r.data.handovers.every((h) => h.id !== copyH1)
      && r.data.handovers.some((h) => h.id === handoverId));

  console.log('\n[8] 会话切回原站场（yardId 缺省/1 等价）');
  r = await api('/api/auth/yard', { token: jia, method: 'PUT', body: {} });
  eq('缺省 yardId 切回原站场 200', r.status, 200);
  eq('回到原站场', r.data.yardId, 1);
  r = await api('/api/state', { token: jia });
  eq('状态恢复原站场', r.data.state.yard.id, 1);

  console.log('\n[9] 再建副本：编号递增，来源固定为原站场（与当前选择无关）');
  // 当前管理员会话语义上可能停在任意站场；创建来源始终为原站场
  const cp3 = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '夜训B组' } });
  eq('第二副本编号=3', cp3.data.yard.id, 3);
  eq('第二副本开放实例复制自原站场（1 条）', cp3.data.detail.copied.openInstances, 1);
  eq('第二副本未兑现等待1', cp3.data.detail.copied.waiting, 1);
  eq('第二副本来源=原站场', cp3.data.yard.sourceYardId, 1);

  console.log('\n[10] 服务重启：副本延时取消按原 release_at 逐站场复核');
  // 把副本3 的 pending 取消 release_at 改为过去（只改副本3 文件）；
  // 原站场与副本2 不变。重启后副本3 实例解除，他站场不受影响。
  await stopServer();
  // 副本3 复制时区段5为占用 → 到期核验会 abort。先在副本3 文件内把5改空闲，
  // 以验证"沿途均空闲才解除"的解除路径（外部条件，模拟现场出清）。
  const yardFile = (id) => path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', `yard-${id}.db`);
  await new Promise((resolve) => {
    const Database = require('better-sqlite3');
    const d = new Database(yardFile(3));
    d.prepare("UPDATE sections SET occ_state='free' WHERE id='5'").run();
    d.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
      .run(Date.now() - 1000, cancelId);
    d.close();
    resolve();
  });
  await startServer(true);
  const admin2 = await login('admin');
  const bing = await login('dispatcher', '值班员丙');
  r = await api('/api/auth/yard', { token: bing, method: 'PUT', body: { yardId: 3 } });
  eq('切换副本3', r.status, 200);
  r = await api('/api/state', { token: bing });
  const c3 = r.data.state.cancellationRequests.find((x) => x.id === cancelId);
  eq('副本3 到期取消状态 released', c3.status, 'released');
  ok('副本3 实例已解除', !r.data.state.openInstances.find((x) => x.id === instId));
  // 实例解除触发等待兑现扫描：R2 等待在副本3 是否兑现取决于道岔实际位置，
  // 这里只断言"锁与顺位按副本3 自身判定，不影响他站场"。
  // 原站场取消仍 pending（release_at 为 +3600s，未重新计时、未误处理）
  const ding = await login('dispatcher', '值班员丁');
  r = await api('/api/state', { token: ding });
  const cOrig = r.data.state.cancellationRequests.find((x) => x.id === cancelId);
  eq('原站场取消仍 pending（不重新计时/不误处理）', cOrig.status, 'pending');
  eq('原站场取消到期时刻不变', cOrig.releaseAt, releaseAt);
  ok('原站场实例仍开放', !!r.data.state.openInstances.find((x) => x.id === instId));
  ok('原站场历史交接单重启后仍在',
    r.data.state.handovers.some((x) => x.id === handoverId));
  // 副本2 已被重置（无取消/无实例），不受任何影响
  await api('/api/auth/yard', { token: bing, method: 'PUT', body: { yardId: 2 } });
  r = await api('/api/state', { token: bing });
  eq('副本2 仍为重置后空场（区段数含 COPYSEC=6）', r.data.state.sections.length, 6);
  eq('副本2 无开放实例', r.data.state.openInstances.length, 0);

  console.log('\n[11] 重启后站场注册持久；未知副本仍拒绝');
  r = await api('/api/auth/yards', { token: ding });
  eq('三个站场均持久', r.data.yards.length, 3);
  r = await api('/api/auth/yard', { token: ding, method: 'PUT', body: { yardId: 404 } });
  eq('未知副本仍 404', r.status, 404);
  r = await api('/api/admin/yards', { token: admin2 });
  eq('管理员列表 200', r.status, 200);
  eq('管理员列表数量', r.data.yards.length, 3);

  await stopServer();
  console.log(`\n命名演练副本全部 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
