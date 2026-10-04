'use strict';

/**
 * 命名演练副本检查点 HTTP 集成测试。
 * 覆盖：原站场拒绝、运行中副本拒绝、创建/重名/查看、回退整体恢复、
 * 交接单未签收过期已签收保留、序列水位恢复（后续编号不冲突）、
 * 待处理取消/计划步骤按检查点剩余时间继续冻结、已到期事项恢复后立即复核、
 * 检查点可重复使用、副本保持暂停、其他站场与会话选择不受影响、跨重启持久化。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3930;
const DB_PATH = process.env.SMOKE_DB_CHECKPOINT || path.join(__dirname, '..', 'data', 'checkpoint-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let server = null;

function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  console.log('  ✓', name);
  passed++;
}
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
    server.on('exit', (code) => { if (code) reject(new Error('服务异常退出: ' + out)); });
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
async function api(url, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const r = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (r.status !== 200) throw new Error('登录失败: ' + r.data.error);
  return r.data.token;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stepsFor(sections, waitSeconds = 1) {
  const steps = [];
  sections.forEach((sectionId) => {
    steps.push({ sectionId, action: 'occupy', waitSeconds });
    steps.push({ sectionId, action: 'clear', waitSeconds });
  });
  return steps;
}
function yardFile(id) {
  return path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', `yard-${id}.db`);
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const a = await login('dispatcher', '检查点甲');
  const b = await login('dispatcher', '检查点乙');

  console.log('\n[1] 原站场：创建/回退拒绝，列表为空，未知检查点 404');
  let r = await api('/api/admin/yards/current/checkpoints', { token: admin, method: 'POST', body: { name: '基线' } });
  eq('原站场创建 400', r.status, 400);
  eq('原站场创建错误码', r.data.code, 'CHECKPOINT_ORIGINAL_FORBIDDEN');
  r = await api('/api/admin/yards/current/checkpoints/1/rollback', { token: admin, method: 'POST' });
  eq('原站场回退 400', r.status, 400);
  eq('原站场回退错误码', r.data.code, 'CHECKPOINT_ORIGINAL_FORBIDDEN');
  r = await api('/api/admin/yards/current/checkpoints', { token: admin });
  eq('原站场列表 200', r.status, 200);
  eq('原站场列表为空', r.data.checkpoints.length, 0);
  r = await api('/api/admin/yards/current/checkpoints/1', { token: admin });
  eq('原站场未知检查点 404', r.status, 404);
  eq('未知检查点错误码', r.data.code, 'CHECKPOINT_NOT_FOUND');
  r = await api('/api/admin/yards/current/checkpoints', { token: a, method: 'POST', body: { name: 'x' } });
  eq('值班员创建 403', r.status, 403);

  console.log('\n[2] 创建副本并准备盘面：开放进路/计划/延时取消/等待/封锁/交接单');
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '检查点演练' } });
  eq('创建副本', r.status, 201);
  const yardId = r.data.yard.id;
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '隔离对照副本' } });
  eq('创建对照副本', r.status, 201);
  const otherYardId = r.data.yard.id;
  for (const token of [admin, a, b]) {
    r = await api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
    eq('会话切换到副本', r.status, 200);
  }
  // 乙在对照副本开放 R1（验证回退不影响其他站场），随后切回
  r = await api('/api/auth/yard', { token: b, method: 'PUT', body: { yardId: otherYardId } });
  eq('乙切到对照副本', r.status, 200);
  r = await api('/api/routes/R1/open', { token: b, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('对照副本开放 R1', r.status, 200);
  r = await api('/api/auth/yard', { token: b, method: 'PUT', body: { yardId } });
  eq('乙切回演练副本', r.status, 200);

  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 3600 }
  });
  r = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: '9', label: '独立线', x1: 40, y1: 380, x2: 240, y2: 380 }
  });
  eq('新增独立区段', r.status, 200);
  await api('/api/sections/9/state', { token: a, method: 'POST', body: { action: 'clear' } });
  r = await api('/api/admin/routes', {
    token: admin, method: 'POST',
    body: { id: 'R4', label: '独立进路', origin: 'X9', destination: 'X99', steps: ['9'], switchReqs: [] }
  });
  eq('新增独立进路', r.status, 200);

  // 甲开放 R4（实例1）并挂定时走行计划（首步 10 秒）
  r = await api('/api/routes/R4/open', { token: a, method: 'POST', body: {} });
  eq('开放 R4', r.status, 200);
  const planInstanceId = r.data.instance.id;
  eq('R4 实例编号 1', planInstanceId, 1);
  r = await api(`/api/instances/${planInstanceId}/movement-plans`, {
    token: a, method: 'POST', body: { steps: stepsFor(['9'], 10) }
  });
  eq('提交走行计划', r.status, 201);
  const planId = r.data.plan.id;
  const planDueAt = r.data.plan.nextStep.dueAt;

  // 甲开放 R1（实例2）并申请延时取消（保护 3600 秒）
  r = await api('/api/routes/R1/open', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('开放 R1', r.status, 200);
  const cancelInstanceId = r.data.instance.id;
  eq('R1 实例编号 2', cancelInstanceId, 2);
  r = await api(`/api/instances/${cancelInstanceId}/cancel-delayed`, { token: a, method: 'POST' });
  eq('延时取消提交', r.status, 201);
  const cancelId = r.data.cancellation.id;

  // 乙对 R2 提交等待申请（与 R1 冲突，保持等待）
  r = await api('/api/routes/R2/waiting', {
    token: b, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('等待申请提交', r.status, 201);
  const waitingId = r.data.waiting.id;
  eq('等待申请编号 1', waitingId, 1);

  // 管理员封锁区段 2（空闲 → 直接生效）
  r = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '2', reason: '道岔检修' }
  });
  eq('封锁提交', r.status, 201);
  const blockadeId = r.data.blockade.id;

  // 交接单：H1 由乙签收（保留），H2 不签收（回退时过期）
  r = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单 H1 生成', r.status, 201);
  const h1 = r.data.handover.id;
  r = await api(`/api/handovers/${h1}/sign`, { token: b, method: 'POST' });
  eq('H1 签收', r.status, 201);
  r = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单 H2 生成', r.status, 201);
  const h2 = r.data.handover.id;

  console.log('\n[3] 暂停副本，把取消改为已到期，创建检查点');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('暂停成功', r.status, 200);
  const pausedAt1 = r.data.yard.pausedAt;
  // 延时取消改为"暂停前已到期未处理"：检查点按已到期事项保存
  const Database = require('better-sqlite3');
  let ydb = new Database(yardFile(yardId));
  ydb.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
    .run(pausedAt1 - 500, cancelId);
  ydb.close();

  r = await api('/api/admin/yards/current/checkpoints', { token: admin, method: 'POST', body: { name: '  ' } });
  eq('空白名称 400', r.status, 400);
  eq('空白名称错误码', r.data.code, 'CHECKPOINT_NAME_INVALID');
  r = await api('/api/admin/yards/current/checkpoints', { token: admin, method: 'POST', body: { name: '基线一' } });
  eq('创建检查点 201', r.status, 201);
  const cp1 = r.data.checkpoint.id;
  eq('检查点编号 1', cp1, 1);
  eq('检查点名称', r.data.checkpoint.name, '基线一');
  ok('检查点创建时间', Number.isInteger(r.data.checkpoint.createdAt), r.data.checkpoint);
  const sum = r.data.checkpoint.summary;
  eq('摘要-开放进路', sum.openInstances, 2);
  eq('摘要-等待', sum.waiting, 1);
  eq('摘要-延时取消', sum.pendingCancellations, 1);
  eq('摘要-封锁', sum.unfinishedBlockades, 1);
  eq('摘要-活动计划', sum.activeMovementPlans, 1);
  eq('摘要-区段数', sum.sections, 6);
  eq('摘要-进路定义数', sum.routes, 4);
  r = await api('/api/admin/yards/current/checkpoints', { token: admin, method: 'POST', body: { name: '基线一' } });
  eq('重名 409', r.status, 409);
  eq('重名错误码', r.data.code, 'CHECKPOINT_NAME_DUPLICATE');
  r = await api('/api/admin/yards/current/checkpoints', { token: admin });
  eq('列表含检查点', r.data.checkpoints.length, 1);
  eq('列表名称', r.data.checkpoints[0].name, '基线一');
  ok('列表含创建时间文本', !!r.data.checkpoints[0].createdAtText, r.data.checkpoints[0]);
  r = await api(`/api/admin/yards/current/checkpoints/${cp1}`, { token: admin });
  eq('查看检查点 200', r.status, 200);
  eq('查看摘要一致', r.data.checkpoint.summary.openInstances, 2);
  r = await api('/api/admin/yards/current/checkpoints/999', { token: admin });
  eq('查看未知检查点 404', r.status, 404);
  r = await api('/api/admin/yards/current/checkpoints/999/rollback', { token: admin, method: 'POST' });
  eq('回退未知检查点 404', r.status, 404);
  eq('回退未知错误码', r.data.code, 'CHECKPOINT_NOT_FOUND');

  console.log('\n[4] 恢复后大量变更（等待撤销/计划走行/新实例/新申请/交接单/封锁/区段状态）');
  r = await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('恢复成功', r.status, 200);
  eq('计划步平移 1', r.data.adjusted.movementPlanSteps, 1);
  eq('已到期取消不平移', r.data.adjusted.cancellations, 0);
  await sleep(700);
  r = await api('/api/cancellations?scope=all', { token: a });
  eq('恢复后已到期取消被复核解除', r.data.cancellations.find((x) => x.id === cancelId).status, 'released');

  r = await api(`/api/waiting/${waitingId}/cancel`, { token: b, method: 'POST' });
  eq('乙撤销等待', r.status, 200);
  // 人工走行 R4 实例（计划前提失效停止），走完后重新开放得到实例 3
  r = await api(`/api/instances/${planInstanceId}/events`, {
    token: a, method: 'POST', body: { seq: 1, sectionId: '9', action: 'occupy' }
  });
  eq('R4 人工占用', r.status, 200);
  r = await api(`/api/instances/${planInstanceId}/events`, {
    token: a, method: 'POST', body: { seq: 2, sectionId: '9', action: 'clear' }
  });
  eq('R4 人工清空（实例1解除）', r.status, 200);
  r = await api('/api/routes/R4/open', { token: a, method: 'POST', body: {} });
  eq('重新开放 R4', r.status, 200);
  eq('变更期新实例编号 3', r.data.instance.id, 3);
  const extraInstanceId = r.data.instance.id;
  r = await api(`/api/instances/${extraInstanceId}/cancel-delayed`, { token: a, method: 'POST' });
  eq('变更期新延时取消', r.status, 201);
  eq('变更期取消编号 2', r.data.cancellation.id, 2);
  r = await api('/api/sections/2/state', { token: a, method: 'POST', body: { action: 'occupy' } });
  eq('区段 2 置占用', r.status, 200);
  r = await api(`/api/admin/blockades/${blockadeId}/end`, { token: admin, method: 'POST' });
  eq('结束原封锁', r.status, 200);
  r = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '4', reason: '变更期新封锁' }
  });
  eq('变更期新封锁编号 2', r.status, 201);
  r = await api('/api/routes/R3/waiting', {
    token: b, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('变更期新等待编号 2', r.data.waiting.id, 2);
  r = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单 H3 生成（H2 被替换过期）', r.status, 201);
  const h3 = r.data.handover.id;

  console.log('\n[5] 再次暂停并回退到检查点：整体恢复');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('再次暂停', r.status, 200);
  const pausedAt2 = r.data.yard.pausedAt;
  ok('两次暂停时刻不同', pausedAt2 > pausedAt1, { pausedAt1, pausedAt2 });

  r = await api(`/api/admin/yards/current/checkpoints/${cp1}/rollback`, { token: admin, method: 'POST' });
  eq('回退成功', r.status, 200);
  eq('回退返回检查点', r.data.checkpoint.id, cp1);
  eq('回退后副本保持暂停', r.data.yard.paused, true);
  eq('回退过期未签收交接单 1 张', r.data.handoversExpired, 1);
  ok('回退时间平移为正', r.data.timeShiftMs > 0, r.data.timeShiftMs);

  // 盘面整体恢复
  r = await api('/api/state', { token: a });
  const st = r.data.state;
  eq('会话选择不受影响（仍在副本）', st.yard.id, yardId);
  eq('副本仍暂停', st.yard.paused, true);
  eq('开放实例恢复为 2 条', st.openInstances.length, 2);
  eq('实例1为 R4', st.openInstances[0].routeId, 'R4');
  eq('实例1信号恢复绿灯', st.openInstances[0].signalState, 'green');
  eq('实例1无走行事件', st.openInstances[0].events.length, 0);
  eq('实例2为 R1', st.openInstances[1].routeId, 'R1');
  eq('实例2信号恢复红灯（延时取消中）', st.openInstances[1].signalState, 'red');
  eq('变更期实例3已消失', st.openInstances.some((i) => i.id === extraInstanceId), false);
  eq('变更期解除记录消失', st.recentReleased.length, 0);
  const w1 = st.waitingApplications.find((x) => x.id === waitingId);
  eq('等待申请恢复等待中', w1 && w1.status, 'waiting');
  eq('变更期等待2已消失', st.waitingApplications.some((x) => x.id === 2), false);
  const c1 = st.cancellationRequests.find((x) => x.id === cancelId);
  eq('取消恢复待处理', c1 && c1.status, 'pending');
  eq('取消到期时刻按基准平移', c1.releaseAt, pausedAt2 - 500);
  eq('变更期取消2已消失', st.cancellationRequests.some((x) => x.id === 2), false);
  const pl = st.movementPlans.find((x) => x.id === planId);
  eq('计划恢复活动', pl && pl.status, 'active');
  eq('计划下一步到期时刻按基准平移', pl.nextStep.dueAt, planDueAt + (pausedAt2 - pausedAt1));
  eq('计划无已注入步骤', pl.steps.every((s) => s.status === 'pending'), true);
  const bk = st.blockades.find((x) => x.id === blockadeId);
  ok('原封锁恢复未结束', bk && bk.status !== 'ended', bk);
  eq('变更期封锁2已消失', st.blockades.some((x) => x.id === 2), false);
  eq('区段 2 恢复空闲', st.sections.find((s) => s.id === '2').occ_state, 'free');
  const hh1 = st.handovers.find((x) => x.id === h1);
  const hh2 = st.handovers.find((x) => x.id === h2);
  const hh3 = st.handovers.find((x) => x.id === h3);
  eq('已签收交接单保留', hh1 && hh1.status, 'signed');
  eq('H2 保持过期', hh2 && hh2.status, 'expired');
  eq('回退时未签收 H3 过期', hh3 && hh3.status, 'expired');
  ok('H3 过期原因提及检查点回退', hh3 && hh3.expireReason && hh3.expireReason.includes('检查点'), hh3);

  r = await api('/api/admin/yards/current/checkpoints', { token: admin });
  eq('回退后检查点仍在', r.data.checkpoints.length, 1);
  r = await api(`/api/admin/yards/current/checkpoints/${cp1}/rollback`, { token: admin, method: 'POST' });
  eq('同一检查点可再次回退', r.status, 200);

  console.log('\n[6] 跨服务重启：检查点与暂停状态持久化');
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  const a2 = await login('dispatcher', '检查点甲重启');
  const b2 = await login('dispatcher', '检查点乙重启');
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId } });
  await api('/api/auth/yard', { token: a2, method: 'PUT', body: { yardId } });
  await api('/api/auth/yard', { token: b2, method: 'PUT', body: { yardId } });
  r = await api('/api/admin/yards/current/checkpoints', { token: admin2 });
  eq('重启后检查点仍在', r.data.checkpoints.length, 1);
  eq('重启后检查点名称', r.data.checkpoints[0].name, '基线一');
  r = await api('/api/state', { token: a2 });
  eq('重启后副本仍暂停', r.data.state.yard.paused, true);
  eq('重启后取消未被扫描处理', r.data.state.cancellationRequests.find((x) => x.id === cancelId).status, 'pending');

  console.log('\n[7] 恢复副本：已到期取消立即复核，计划按检查点剩余时间继续');
  r = await api('/api/admin/yards/current/resume', { token: admin2, method: 'POST' });
  eq('恢复成功', r.status, 200);
  const resumedAt = r.data.yard.resumedAt;
  eq('已到期取消不参与平移', r.data.adjusted.cancellations, 0);
  await sleep(700);
  r = await api('/api/cancellations?scope=all', { token: a2 });
  const cc = r.data.cancellations.filter((x) => x.id === cancelId);
  eq('取消记录唯一（不重复执行）', cc.length, 1);
  eq('检查点已到期取消恢复后立即解除', cc[0].status, 'released');
  r = await api(`/api/movement-plans/${planId}`, { token: a2 });
  eq('计划仍活动', r.data.plan.status, 'active');
  ok('计划按检查点剩余时间继续冻结',
    r.data.plan.nextStep.dueAt > resumedAt + 8000 && r.data.plan.nextStep.dueAt <= resumedAt + 10000,
    { dueAt: r.data.plan.nextStep.dueAt, resumedAt });

  console.log('\n[8] 后续编号从检查点水位继续，不冲突');
  r = await api(`/api/instances/${planInstanceId}/events`, {
    token: a2, method: 'POST', body: { seq: 1, sectionId: '9', action: 'occupy' }
  });
  eq('事件序号从 1 继续', r.status, 200);
  r = await api(`/api/instances/${planInstanceId}/events`, {
    token: a2, method: 'POST', body: { seq: 2, sectionId: '9', action: 'clear' }
  });
  eq('实例1走完解除', r.status, 200);
  r = await api('/api/routes/R4/open', { token: a2, method: 'POST', body: {} });
  eq('新实例编号回到检查点水位 3', r.data.instance.id, 3);
  const newInstanceId = r.data.instance.id;
  r = await api(`/api/instances/${newInstanceId}/cancel-delayed`, { token: a2, method: 'POST' });
  eq('新取消编号 2', r.data.cancellation.id, 2);
  r = await api('/api/routes/R3/waiting', {
    token: b2, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('新等待编号 2', r.data.waiting.id, 2);
  r = await api('/api/admin/blockades', {
    token: admin2, method: 'POST', body: { sectionId: '4', reason: '回退后新封锁' }
  });
  eq('新封锁编号 2', r.data.blockade.id, 2);
  r = await api('/api/handovers', { token: a2, method: 'POST' });
  eq('交接单编号延续历史 4（已签收保留不冲突）', r.data.handover.id, 4);

  console.log('\n[9] 运行中副本拒绝创建/回退；其他站场不受影响');
  r = await api('/api/admin/yards/current/checkpoints', { token: admin2, method: 'POST', body: { name: '运行中' } });
  eq('运行中创建 409', r.status, 409);
  eq('运行中创建错误码', r.data.code, 'CHECKPOINT_YARD_NOT_PAUSED');
  r = await api(`/api/admin/yards/current/checkpoints/${cp1}/rollback`, { token: admin2, method: 'POST' });
  eq('运行中回退 409', r.status, 409);
  eq('运行中回退错误码', r.data.code, 'CHECKPOINT_YARD_NOT_PAUSED');
  r = await api('/api/admin/yards/current/checkpoints', { token: admin2 });
  eq('运行中仍可查看列表', r.status, 200);
  eq('检查点仍在', r.data.checkpoints.length, 1);

  await api('/api/auth/yard', { token: a2, method: 'PUT', body: {} });
  r = await api('/api/state', { token: a2 });
  eq('原站场无开放实例（未受影响）', r.data.state.openInstances.length, 0);
  await api('/api/auth/yard', { token: b2, method: 'PUT', body: { yardId: otherYardId } });
  r = await api('/api/state', { token: b2 });
  eq('对照副本开放实例仍在（未受影响）', r.data.state.openInstances.length, 1);
  eq('对照副本实例为 R1', r.data.state.openInstances[0].routeId, 'R1');

  await stopServer();
  console.log(`\n检查点 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
