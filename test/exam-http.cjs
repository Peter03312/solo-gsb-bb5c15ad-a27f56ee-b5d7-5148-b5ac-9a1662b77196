'use strict';

/**
 * 命名演练副本学员考核 HTTP 集成测试。
 * 覆盖：原站场拒考、开考校验与重复开考拒绝、仅学员开考后新实例计入、
 * 顺序外开放记偏差且完成不补算、他人操作不计入、幂等重传不重复计数、
 * 等待申请自动兑现与定时走行计入、延时取消/人工释放不算完成、
 * 暂停冻结有效用时、检查点回退与站场重置终止进行中考核且已交卷成绩保留、
 * 非指定学员/已终止/重复交卷拒绝、刷新与重启后成绩可查、其他副本互不影响。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3939;
const DB_PATH = process.env.SMOKE_DB_EXAM || path.join(__dirname, '..', 'data', 'exam-test.db');
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
async function moveSwitch(token, id, pos) {
  const r = await api(`/api/switches/${id}/move`, { token, method: 'POST', body: { position: pos } });
  if (r.status !== 200) throw new Error('扳道岔失败: ' + JSON.stringify(r.data));
}
async function walk(token, instanceId, sections) {
  let seq = 1;
  for (const s of sections) {
    for (const action of ['occupy', 'clear']) {
      const r = await api(`/api/instances/${instanceId}/events`,
        { token, method: 'POST', body: { seq, sectionId: s, action } });
      if (r.status !== 200) throw new Error(`走行事件失败 seq=${seq} ${action} ${s}: ${JSON.stringify(r.data)}`);
      seq++;
    }
  }
}
function planSteps(sections, waitSeconds = 1) {
  const steps = [];
  for (const s of sections) {
    steps.push({ sectionId: s, action: 'occupy', waitSeconds });
    steps.push({ sectionId: s, action: 'clear', waitSeconds });
  }
  return steps;
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const stu = await login('dispatcher', '学员张三');
  const other = await login('dispatcher', '值班员李四');

  console.log('\n[1] 原站场不能开考；开考参数校验');
  let r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1'] }
  });
  eq('原站场开考 400', r.status, 400);
  eq('原站场错误码', r.data.code, 'EXAM_ORIGINAL_FORBIDDEN');

  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '考核副本' } });
  eq('创建考核副本', r.status, 201);
  const yardId = r.data.yard.id;
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '对照副本' } });
  eq('创建对照副本', r.status, 201);
  const otherYardId = r.data.yard.id;
  for (const t of [admin, stu, other]) {
    r = await api('/api/auth/yard', { token: t, method: 'PUT', body: { yardId } });
    eq('会话切到考核副本', r.status, 200);
  }

  r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1', 'NOPE'] }
  });
  eq('未知进路 404', r.status, 404);
  eq('未知进路码', r.data.code, 'EXAM_ROUTE_NOT_FOUND');
  r = await api('/api/admin/exams/start', { token: admin, method: 'POST', body: { student: ' ', targets: ['R1'] } });
  eq('学员为空 400', r.status, 400);
  r = await api('/api/admin/exams/start', { token: admin, method: 'POST', body: { student: '学员张三', targets: [] } });
  eq('目标为空 400', r.status, 400);
  r = await api('/api/admin/exams/start', {
    token: stu, method: 'POST', body: { student: '学员张三', targets: ['R1'] }
  });
  eq('值班员开考 403', r.status, 403);

  console.log('\n[2] 开考固定目标与起始状态；重复开考拒绝');
  r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1', 'R2'] }
  });
  eq('开考 201', r.status, 201);
  const exam1 = r.data.exam.id;
  eq('考核编号 1', exam1, 1);
  eq('目标总数', r.data.exam.totalTargetCount, 2);
  eq('当前目标 R1', r.data.exam.currentTarget.routeId, 'R1');
  eq('完成数 0', r.data.exam.completedTargetCount, 0);
  ok('起始状态快照含区段', Array.isArray(r.data.exam.startState.sections));
  eq('起始状态无开放实例', r.data.exam.startState.openInstances.length, 0);
  r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1'] }
  });
  eq('重复开考 409', r.status, 409);
  eq('重复开考码', r.data.code, 'EXAM_ALREADY_ACTIVE');
  r = await api('/api/exams/999', { token: stu });
  eq('未知考核 404', r.status, 404);
  eq('未知考核码', r.data.code, 'EXAM_NOT_FOUND');

  console.log('\n[3] 他人操作不计入；顺序外开放记偏差，完成不补算');
  // 李四开放 R3 并走完：不登记、不算偏差
  await moveSwitch(other, 'SW7', 'R');
  r = await api('/api/routes/R3/open', {
    token: other, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('李四开放 R3', r.status, 200);
  await walk(other, r.data.instance.id, ['2', '3', '5']);
  // 张三顺序外开放 R2（当前目标是 R1）并走完：偏差，目标不推进
  await moveSwitch(stu, 'SW7', 'N');
  await moveSwitch(stu, 'SW8', 'R');
  r = await api('/api/routes/R2/open', {
    token: stu, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('张三顺序外开放 R2', r.status, 200);
  const deviationInst = r.data.instance.id;
  await walk(stu, deviationInst, ['1', '3', '4']);
  r = await api(`/api/exams/${exam1}`, { token: stu });
  eq('目标1 仍 pending', r.data.exam.targets[0].status, 'pending');
  eq('偏差数 1', r.data.exam.deviationCount, 1);
  eq('偏差进路', r.data.exam.deviations[0].routeId, 'R2');
  eq('偏差已正常走完', r.data.exam.deviations[0].completed, true);
  ok('偏差实例挂空目标序号', r.data.exam.deviations[0].targetSeq == null);
  ok('李四的实例未登记', !r.data.exam.instances.some((x) => x.openedBy === '值班员李四'));

  console.log('\n[4] 幂等重传不重复计数；当前目标正常走行推进');
  await moveSwitch(stu, 'SW8', 'N');
  r = await api('/api/routes/R1/open', {
    token: stu, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('张三开放 R1', r.status, 200);
  const r1Inst = r.data.instance.id;
  r = await api(`/api/instances/${r1Inst}/events`, {
    token: stu, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('首段占用', r.status, 200);
  r = await api(`/api/instances/${r1Inst}/events`, {
    token: stu, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('同号重传幂等', r.status, 200);
  eq('重传标记幂等', r.data.result.idempotent, true);
  // 继续走完（seq 2..6）
  let seq = 2;
  for (const [sectionId, action] of [
    ['1', 'clear'], ['3', 'occupy'], ['3', 'clear'], ['5', 'occupy'], ['5', 'clear']
  ]) {
    r = await api(`/api/instances/${r1Inst}/events`,
      { token: stu, method: 'POST', body: { seq, sectionId, action } });
    eq(`走行 seq=${seq}`, r.status, 200);
    seq++;
  }
  r = await api(`/api/exams/${exam1}`, { token: stu });
  eq('目标1 done', r.data.exam.targets[0].status, 'done');
  eq('目标1 挂接实例', r.data.exam.targets[0].instanceId, r1Inst);
  eq('完成数 1', r.data.exam.completedTargetCount, 1);
  eq('当前目标变为 R2', r.data.exam.currentTarget.routeId, 'R2');
  ok('目标达成实例非偏差', !r.data.exam.instances.find((x) => x.instanceId === r1Inst).deviation);

  console.log('\n[5] 等待申请自动兑现计入目标');
  // 李四占用区段 1 阻断 R2；张三排队等待，李四清空后自动兑现，张三再走完
  r = await api('/api/sections/1/state', { token: other, method: 'POST', body: { action: 'occupy' } });
  eq('李四占用区段1', r.status, 200);
  await moveSwitch(stu, 'SW8', 'R');
  r = await api('/api/routes/R2/waiting', {
    token: stu, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('提交等待申请', r.status, 201);
  eq('申请等待中', r.data.waiting.status, 'waiting');
  const waitingId = r.data.waiting.id;
  r = await api('/api/sections/1/state', { token: other, method: 'POST', body: { action: 'clear' } });
  eq('李四清空触发兑现', r.status, 200);
  r = await api('/api/waiting', { token: stu });
  const w = r.data.waiting.find((x) => x.id === waitingId);
  eq('等待已兑现', w.status, 'fulfilled');
  const r2Inst = w.instanceId;
  await walk(stu, r2Inst, ['1', '3', '4']);
  r = await api(`/api/exams/${exam1}`, { token: stu });
  eq('目标2 done', r.data.exam.targets[1].status, 'done');
  eq('全部目标达成', r.data.exam.allTargetsDone, true);
  eq('偏差不补算仍为 1', r.data.exam.deviationCount, 1);
  const waitReg = r.data.exam.instances.find((x) => x.instanceId === r2Inst);
  eq('兑现实例来源 waiting', waitReg.source, 'waiting');
  eq('兑现实例挂目标2', waitReg.targetSeq, 2);

  console.log('\n[6] 交卷返回目标状态/偏差/有效用时；非法交卷拒绝');
  const beforeSubmit = Date.now();
  r = await api(`/api/exams/${exam1}/submit`, { token: other, method: 'POST' });
  eq('非学员交卷 403', r.status, 403);
  eq('非学员错误码', r.data.code, 'EXAM_NOT_ASSIGNED');
  r = await api(`/api/exams/${exam1}/submit`, { token: stu, method: 'POST' });
  eq('学员交卷 200', r.status, 200);
  eq('状态 submitted', r.data.exam.status, 'submitted');
  eq('交卷返回目标数', r.data.exam.targets.length, 2);
  eq('交卷返回偏差数', r.data.exam.deviationCount, 1);
  ok('交卷返回有效用时', Number.isFinite(r.data.exam.effectiveElapsedMs) &&
    r.data.exam.effectiveElapsedMs >= 0 && r.data.exam.effectiveElapsedMs <= Date.now() - beforeSubmit + 5000);
  r = await api(`/api/exams/${exam1}/submit`, { token: stu, method: 'POST' });
  eq('重复交卷 409', r.status, 409);
  eq('重复交卷码', r.data.code, 'EXAM_ALREADY_SUBMITTED');

  console.log('\n[7] 定时走行计入；暂停冻结有效用时');
  await moveSwitch(stu, 'SW8', 'N');
  r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1'] }
  });
  eq('第二场开考', r.status, 201);
  const exam2 = r.data.exam.id;
  r = await api('/api/routes/R1/open', {
    token: stu, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const planInst = r.data.instance.id;
  r = await api(`/api/instances/${planInst}/movement-plans`,
    { token: stu, method: 'POST', body: { steps: planSteps(['1', '3', '5'], 1) } });
  eq('提交定时走行计划', r.status, 201);
  await sleep(8500);
  r = await api(`/api/exams/${exam2}`, { token: stu });
  eq('定时走行后目标 done', r.data.exam.targets[0].status, 'done');
  eq('定时走行实例已完成',
    r.data.exam.instances.find((x) => x.instanceId === planInst).completed, true);
  const elapsedActive = r.data.exam.effectiveElapsedMs;
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('暂停副本', r.status, 200);
  await sleep(1200);
  r = await api(`/api/exams/${exam2}`, { token: stu });
  const elapsedFrozen = r.data.exam.effectiveElapsedMs;
  ok('暂停期间有效用时冻结', Math.abs(elapsedFrozen - elapsedActive) < 100,
    { elapsedFrozen, elapsedActive });
  r = await api(`/api/exams/${exam2}/submit`, { token: stu, method: 'POST' });
  eq('暂停中交卷 409', r.status, 409);
  eq('暂停中错误码', r.data.code, 'YARD_PAUSED');
  r = await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('恢复副本', r.status, 200);
  await sleep(300);
  r = await api(`/api/exams/${exam2}`, { token: stu });
  ok('恢复后有效用时继续走', r.data.exam.effectiveElapsedMs >= elapsedFrozen);

  console.log('\n[8] 检查点回退终止进行中考核；已交卷成绩保留');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('再次暂停', r.status, 200);
  r = await api('/api/admin/yards/current/checkpoints',
    { token: admin, method: 'POST', body: { name: '存档点' } });
  eq('创建检查点', r.status, 201);
  const cpId = r.data.checkpoint.id;
  r = await api(`/api/admin/yards/current/checkpoints/${cpId}/rollback`, { token: admin, method: 'POST' });
  eq('回退 200', r.status, 200);
  eq('回退终止考核编号', r.data.terminatedExamId, exam2);
  r = await api(`/api/exams/${exam2}`, { token: stu });
  eq('考核状态 terminated', r.data.exam.status, 'terminated');
  ok('终止原因含检查点', /检查点/.test(r.data.exam.endReason), r.data.exam.endReason);
  r = await api(`/api/exams/${exam1}`, { token: stu });
  eq('已交卷成绩保留', r.data.exam.status, 'submitted');
  eq('成绩目标1 保留 done', r.data.exam.targets[0].status, 'done');
  eq('成绩目标2 保留 done', r.data.exam.targets[1].status, 'done');
  eq('成绩偏差保留', r.data.exam.deviationCount, 1);
  // 恢复后已终止考核交卷拒绝
  await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  r = await api(`/api/exams/${exam2}/submit`, { token: stu, method: 'POST' });
  eq('已终止交卷 409', r.status, 409);
  eq('已终止错误码', r.data.code, 'EXAM_TERMINATED');

  console.log('\n[9] 延时取消解除不算完成；走行中人工释放拒绝（结构上不会由人工释放完成）');
  r = await api('/api/admin/settings/cancel-protection',
    { token: admin, method: 'PUT', body: { protectionSeconds: 1 } });
  eq('保护时长设 1 秒', r.status, 200);
  r = await api('/api/admin/exams/start', {
    token: admin, method: 'POST', body: { student: '学员张三', targets: ['R1', 'R2'] }
  });
  eq('第三场开考', r.status, 201);
  const exam3 = r.data.exam.id;
  r = await api('/api/routes/R1/open', {
    token: stu, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const cancelInst = r.data.instance.id;
  // 走行未完成时人工释放被联锁规则拒绝，考核目标不变化
  r = await api(`/api/instances/${cancelInst}/release`, { token: stu, method: 'POST' });
  eq('末段未清空人工释放 409', r.status, 409);
  r = await api(`/api/exams/${exam3}`, { token: stu });
  eq('人工释放拒绝后目标仍 pending', r.data.exam.targets[0].status, 'pending');
  // 延时取消到期解除：登记实例不算完成
  r = await api(`/api/instances/${cancelInst}/cancel-delayed`, { token: stu, method: 'POST' });
  eq('申请延时取消', r.status, 201);
  await sleep(1700);
  r = await api(`/api/exams/${exam3}`, { token: stu });
  eq('延时取消后目标仍 pending', r.data.exam.targets[0].status, 'pending');
  const cancelReg = r.data.exam.instances.find((x) => x.instanceId === cancelInst);
  eq('延时取消实例不算完成', cancelReg.completed, false);
  eq('开放挂接未变（不转偏差）', cancelReg.targetSeq, 1);
  // 站场重置终止考核（已交卷成绩不受影响，见上面 exam1）
  r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('培训重开 200', r.status, 200);
  r = await api(`/api/exams/${exam3}`, { token: stu });
  eq('重置终止考核', r.data.exam.status, 'terminated');
  ok('重置终止原因', /重置|重开/.test(r.data.exam.endReason), r.data.exam.endReason);

  console.log('\n[10] 跨服务重启：成绩与进度可查询；其他副本互不影响');
  // 重启后先在对照副本开一场，再回考核副本核对
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  const stu2 = await login('dispatcher', '学员张三');
  await api('/api/auth/yard', { token: stu2, method: 'PUT', body: { yardId } });
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId } });
  r = await api('/api/exams', { token: stu2 });
  eq('重启后考核场次 3', r.data.exams.length, 3);
  r = await api(`/api/exams/${exam1}`, { token: stu2 });
  eq('重启后成绩可查', r.status, 200);
  eq('重启后状态 submitted', r.data.exam.status, 'submitted');
  eq('重启后完成目标保留', r.data.exam.completedTargetCount, 2);
  eq('重启后偏差保留', r.data.exam.deviationCount, 1);
  ok('重启后有效用时保留', Number.isFinite(r.data.exam.effectiveElapsedMs));
  r = await api('/api/state', { token: stu2 });
  ok('state 含考核摘要', r.data.state.exams && Array.isArray(r.data.state.exams.recent));
  eq('进行中考核为空', r.data.state.exams.current, null);
  // 对照副本没有任何考核
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId: otherYardId } });
  r = await api('/api/admin/exams', { token: admin2 });
  eq('对照副本考核列表为空', r.data.exams.length, 0);

  await stopServer();
  console.log(`\n学员考核 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
