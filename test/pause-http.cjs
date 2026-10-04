'use strict';

/**
 * 命名演练副本暂停/恢复 HTTP 集成测试。
 * 覆盖：原站场不可暂停、只读写操作拒绝、暂停冻结定时走行/延时取消、
 * 退出撤销等待但不兑现、恢复平移时间、暂停跨重启有效、重复操作幂等。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3928;
const DB_PATH = process.env.SMOKE_DB_PAUSE || path.join(__dirname, '..', 'data', 'pause-test.db');
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

async function main() {
  await startServer();
  const admin = await login('admin');
  const a = await login('dispatcher', '暂停测试甲');
  const b = await login('dispatcher', '暂停测试乙');

  console.log('\n[1] 原站场不可暂停；创建并选择副本');
  let r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('原站场暂停 400', r.status, 400);
  eq('原站场暂停错误码', r.data.code, 'YARD_ORIGINAL_NOT_PAUSABLE');
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '暂停演练' } });
  eq('创建副本', r.status, 201);
  const yardId = r.data.yard.id;
  for (const token of [admin, a, b]) {
    r = await api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
    eq('会话切换到副本', r.status, 200);
  }

  console.log('\n[2] 准备两个互不冲突的开放进路：一个挂活动计划，一个挂延时取消');
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 3600 }
  });
  let prep = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: '9', label: '独立线', x1: 40, y1: 380, x2: 240, y2: 380 }
  });
  eq('新增独立区段', prep.status, 200);
  // 新建设计保存后默认为 unknown，核实为空闲，供 R4 开放
  await api('/api/sections/9/state', { token: a, method: 'POST', body: { action: 'clear' } });
  prep = await api('/api/admin/routes', {
    token: admin, method: 'POST',
    body: {
      id: 'R4', label: '独立进路', origin: 'X9', destination: 'X99',
      steps: ['9'], switchReqs: []
    }
  });
  eq('新增独立进路', prep.status, 200);

  const openPlanRoute = await api('/api/routes/R4/open', { token: a, method: 'POST', body: {} });
  eq('开放 R4', openPlanRoute.status, 200);
  const planInstanceId = openPlanRoute.data.instance.id;
  const plan = await api(`/api/instances/${planInstanceId}/movement-plans`, {
    token: a, method: 'POST', body: { steps: stepsFor(['9'], 10) }
  });
  eq('提交走行计划', plan.status, 201);
  const planId = plan.data.plan.id;
  const firstDueBefore = plan.data.plan.nextStep.dueAt;

  const open = await api('/api/routes/R1/open', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('开放 R1', open.status, 200);
  const instanceId = open.data.instance.id;
  const throwawayPlan = await api(`/api/instances/${instanceId}/movement-plans`, {
    token: a, method: 'POST', body: { steps: stepsFor(['1', '3', '5'], 10) }
  });
  r = await api(`/api/movement-plans/${throwawayPlan.data.plan.id}/terminate`, { token: a, method: 'POST' });
  eq('终止临时计划', r.status, 200);
  const cancel = await api(`/api/instances/${instanceId}/cancel-delayed`, { token: a, method: 'POST' });
  eq('延时取消提交', cancel.status, 201);
  const cancelId = cancel.data.cancellation.id;
  const releaseBefore = cancel.data.cancellation.releaseAt;

  // 乙的 R2 与 R1 共享资源，保持 waiting
  const wait = await api('/api/routes/R2/waiting', {
    token: b, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('等待申请提交', wait.status, 201);
  const waitingId = wait.data.waiting.id;

  console.log('\n[3] 暂停：手工变更拒绝，只读、预检和会话切换照常');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('暂停成功', r.status, 200);
  eq('暂停结果 changed=true', r.data.changed, true);
  eq('暂停人', r.data.yard.pausedBy, '管理员');
  ok('暂停时间返回', !!r.data.yard.pausedAt, r.data.yard);
  const pausedAt = r.data.yard.pausedAt;
  r = await api(`/api/movement-plans/${planId}`, { token: a });
  eq('暂停时计划仍 active', r.data.plan.status, 'active');
  eq('暂停时下一步到期时刻不变', r.data.plan.nextStep.dueAt, firstDueBefore);
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('重复暂停幂等', r.status, 200);
  eq('重复暂停不改变', r.data.alreadyPaused, true);

  let blocked = await api('/api/routes/R3/open', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('排路拒绝', blocked.status, 409);
  eq('排路错误码', blocked.data.code, 'YARD_PAUSED');
  blocked = await api('/api/routes/R3/waiting', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('等待提交拒绝', blocked.status, 409);
  blocked = await api(`/api/instances/${instanceId}/cancel-delayed`, { token: a, method: 'POST' });
  eq('延时取消申请拒绝', blocked.status, 409);
  blocked = await api(`/api/instances/${planInstanceId}/movement-plans`, {
    token: a, method: 'POST', body: { steps: stepsFor(['9'], 1) }
  });
  eq('计划提交拒绝', blocked.status, 409);
  blocked = await api(`/api/movement-plans/${planId}/terminate`, { token: a, method: 'POST' });
  eq('计划终止拒绝', blocked.status, 409);
  blocked = await api('/api/switches/SW7/move', {
    token: a, method: 'POST', body: { position: 'R' }
  });
  eq('扳动道岔拒绝', blocked.status, 409);
  blocked = await api('/api/sections/5/state', {
    token: a, method: 'POST', body: { action: 'occupy' }
  });
  eq('区段状态调整拒绝', blocked.status, 409);
  blocked = await api(`/api/instances/${instanceId}/events`, {
    token: a, method: 'POST', body: { seq: 2, sectionId: '1', action: 'clear' }
  });
  eq('走行拒绝', blocked.status, 409);
  blocked = await api(`/api/instances/${instanceId}/release`, { token: a, method: 'POST' });
  eq('人工解除拒绝', blocked.status, 409);
  blocked = await api(`/api/waiting/${waitingId}/cancel`, { token: b, method: 'POST' });
  eq('手工撤销等待拒绝', blocked.status, 409);
  blocked = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单生成拒绝', blocked.status, 409);
  blocked = await api('/api/handovers/999/sign', { token: a, method: 'POST' });
  eq('交接单签收拒绝', blocked.status, 409);
  blocked = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('重置拒绝', blocked.status, 409);
  blocked = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '2', reason: '暂停期间封锁' }
  });
  eq('封锁拒绝', blocked.status, 409);
  blocked = await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 1 }
  });
  eq('设置修改拒绝', blocked.status, 409);

  r = await api('/api/state', { token: a });
  eq('只读状态 200', r.status, 200);
  eq('状态显示暂停', r.data.state.yard.paused, true);
  eq('状态显示暂停人', r.data.state.yard.pausedBy, '管理员');
  r = await api('/api/routes/R3/check', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('只读预检 200', r.status, 200);
  r = await api('/api/auth/yard', { token: a, method: 'PUT', body: {} });
  eq('会话切到原站场', r.status, 200);
  r = await api('/api/auth/yard', { token: a, method: 'PUT', body: { yardId } });
  eq('会话切回暂停副本', r.status, 200);

  console.log('\n[4] 暂停跨真实时间：调度器不解除取消、不处理封锁/等待');
  await sleep(1250);
  r = await api(`/api/movement-plans/${planId}`, { token: a });
  eq('暂停期间走行计划仍 active', r.data.plan.status, 'active');
  eq('暂停期间计划下一步不推进', r.data.plan.nextStep.dueAt, firstDueBefore);
  eq('暂停期间计划无已注入事件', r.data.plan.steps[0].status, 'pending');
  r = await api('/api/cancellations?scope=all', { token: a });
  let c = r.data.cancellations.find((x) => x.id === cancelId);
  eq('暂停期间取消仍 pending', c.status, 'pending');
  eq('暂停期间取消到期时刻未改', c.releaseAt, releaseBefore);
  // 原站场仍可操作（不会因副本暂停而停摆）
  await api('/api/auth/yard', { token: a, method: 'PUT', body: {} });
  const origOpen = await api('/api/routes/R1/open', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('暂停副本不影响原站场', origOpen.status, 200);
  await api('/api/auth/yard', { token: a, method: 'PUT', body: { yardId } });

  console.log('\n[5] 值班员退出：撤销暂停副本等待申请，但不在暂停副本兑现后项');
  // 把暂停期间一笔取消改为“暂停前已到期但未处理”：恢复后必须立即按原规则复核。
  const yardFile = (id) => path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', `yard-${id}.db`);
  const Database = require('better-sqlite3');
  const ydb = new Database(yardFile(yardId));
  ydb.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
    .run(pausedAt - 500, cancelId);
  ydb.prepare(`UPDATE movement_plan_steps SET due_at=? WHERE plan_id=? AND status='pending'`)
    .run(pausedAt - 500, planId);
  ydb.close();

  // 乙只有这一个 waiting；退出后状态 cancelled。没有后项，仅验证不触发异常/兑现。
  const logout = await api('/api/auth/logout', { token: b, method: 'POST' });
  eq('退出成功', logout.status, 200);
  r = await api('/api/waiting?scope=all', { token: a });
  const w = r.data.waiting.find((x) => x.id === waitingId);
  eq('退出撤销暂停副本等待', w.status, 'cancelled');
  ok('退出原因保留', w.endReason.includes('退出登录'), w.endReason);

  console.log('\n[6] 暂停跨服务重启；恢复后平移并立即复核已到期事项');
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  const a2 = await login('dispatcher', '暂停测试甲重启');
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId } });
  await api('/api/auth/yard', { token: a2, method: 'PUT', body: { yardId } });
  r = await api('/api/admin/yards/current/pause', { token: admin2, method: 'POST' });
  eq('重启后仍暂停/重复暂停幂等', r.data.alreadyPaused, true);
  r = await api('/api/cancellations?scope=all', { token: a2 });
  c = r.data.cancellations.find((x) => x.id === cancelId);
  eq('重启后暂停副本取消不被启动扫描处理', c.status, 'pending');

  r = await api('/api/admin/yards/current/resume', { token: admin2, method: 'POST' });
  eq('恢复成功', r.status, 200);
  eq('恢复 changed=true', r.data.changed, true);
  ok('平移时长为正', r.data.shiftMs > 1000, r.data.shiftMs);
  // 活动计划下一步此前被外部改为暂停前已到期：不做平移，恢复后立即注入。
  eq('恢复扫描不计数已到期计划步', r.data.adjusted.movementPlanSteps, 0);
  // 延时取消同样被外部改为暂停前已到期，不做平移，恢复后立即复核。
  eq('平移 pending 取消数量', r.data.adjusted.cancellations, 0);
  const resumedAt = r.data.yard.resumedAt;
  r = await api(`/api/movement-plans/${planId}`, { token: a2 });
  eq('恢复后计划仍 active', r.data.plan.status, 'active');
  eq('暂停前已到期计划步恢复后立即注入', r.data.plan.steps[0].status, 'done');
  ok('下一步恢复后继续计时',
    r.data.plan.nextStep.dueAt > resumedAt && r.data.plan.nextStep.dueAt <= resumedAt + 11000,
    { dueAt: r.data.plan.nextStep.dueAt, resumedAt });
  r = await api('/api/cancellations?scope=all', { token: a2 });
  c = r.data.cancellations.find((x) => x.id === cancelId);
  ok('取消恢复后立即按原规则处理', ['released', 'aborted'].includes(c.status), c.status);
  eq('暂停前已到期取消到期时刻不平移', c.releaseAt, pausedAt - 500);
  r = await api('/api/admin/yards/current/resume', { token: admin2, method: 'POST' });
  eq('重复恢复幂等', r.status, 200);
  eq('重复恢复不调整', r.data.alreadyResumed, true);
  eq('重复恢复平移 0', r.data.shiftMs, 0);

  console.log('\n[7] 列表与状态显示暂停审计字段');
  r = await api('/api/auth/yards', { token: a2 });
  const y = r.data.yards.find((x) => x.id === yardId);
  eq('列表状态 active', y.status, 'active');
  eq('列表 paused=false', y.paused, false);
  eq('列表恢复人', y.resumedBy, '管理员');
  ok('列表恢复时间', !!y.resumedAt, y);
  r = await api('/api/state', { token: a2 });
  eq('状态显示 active', r.data.state.yard.status, 'active');
  eq('状态 paused=false', r.data.state.yard.paused, false);

  await stopServer();
  console.log(`\n暂停/恢复 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
