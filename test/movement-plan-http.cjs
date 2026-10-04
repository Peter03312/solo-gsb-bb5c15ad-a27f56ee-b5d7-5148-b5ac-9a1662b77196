'use strict';

/**
 * 定时走行计划 HTTP 集成测试：
 *   临时库启动真实服务 → 值班员开放进路 → 提交定时走行计划（校验类整体拒绝、
 *   正常受理返回编号/状态/下一步/到期时刻）→ 到期自动依序注入占用/清空、
 *   信号回红、逐段解锁、末步完成且进路解除 → 人工事件抢先停止计划 →
 *   本人终止仅停止注入 → 延时取消使计划停止 → 重启后逾期步骤依序处理 →
 *   副本不复制活动计划 → 越权/列表接口。
 *
 * 运行：node test/movement-plan-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3921;
const DB_PATH = process.env.SMOKE_DB_PLAN || path.join(__dirname, '..', 'data', 'movement-plan-test.db');
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
let serverOut = '';
function wipeDb() {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }
  fs.rmSync(path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'), { recursive: true, force: true });
}
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) wipeDb();
    serverOut = '';
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      serverOut += s;
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      serverOut += s;
    });
    server.on('exit', (code, signal) => {
      clearTimeout(timer);
      serverOut += `\n[test-harness] 服务进程退出 code=${code} signal=${signal}\n`;
      if (!out.includes('已启动')) reject(new Error('服务异常退出: ' + out));
    });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    let killed = false;
    child.on('exit', () => {
      killed = true;
      server = null;
      resolve();
    });
    child.kill('SIGTERM');
    // 确保险些情况下旧进程已退出后再放行（避免延迟 SIGKILL 误杀同端口的新进程）
    setTimeout(() => { if (!killed) { try { child.kill('SIGKILL'); } catch (_) {} } }, 3000);
    // 兜底：即便 exit 事件错过，等待足够旧进程释放端口
    setTimeout(() => { if (!killed) { server = null; resolve(); } }, 5000);
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
async function reset(token) {
  const r = await api('/api/admin/reset/training', { token, method: 'POST' });
  if (r.status !== 200) throw new Error('重置失败: ' + JSON.stringify(r.data));
}
/** R1 三区段 6 步标准计划（steps 顺序 占1/清1/占3/清3/占5/清5） */
function planSteps(w) {
  return [
    { sectionId: '1', action: 'occupy', waitSeconds: w },
    { sectionId: '1', action: 'clear', waitSeconds: w },
    { sectionId: '3', action: 'occupy', waitSeconds: w },
    { sectionId: '3', action: 'clear', waitSeconds: w },
    { sectionId: '5', action: 'occupy', waitSeconds: w },
    { sectionId: '5', action: 'clear', waitSeconds: w }
  ];
}
async function waitPlan(token, id, statuses, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(`/api/movement-plans/${id}`, { token });
    if (r.status === 200 && statuses.includes(r.data.plan.status)) return r.data.plan;
    if (Date.now() > deadline) throw new Error(`计划 #${id} 未进入 ${statuses}（最后：${r.status} ${JSON.stringify(r.data).slice(0, 200)}）`);
    await sleep(150);
  }
}
async function waitInstanceGone(token, id, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await getState(token);
    if (!st.openInstances.some((x) => x.id === id)) return st;
    if (Date.now() > deadline) throw new Error(`实例 #${id} 超时未解除`);
    await sleep(150);
  }
}

async function main() {
  await startServer();
  const admin = await login('admin', 'admin123');
  const token = await login('dispatcher', '值班员甲');
  const tokenB = await login('dispatcher', '值班员乙');

  console.log('[1] 提交校验：非法计划整体拒绝（不产生任何数据）');
  {
    const instId = await openR1(token);

    let r = await api(`/api/instances/${instId}/movement-plans`, { token, method: 'POST', body: { steps: [] } });
    eq('空步骤 400 PLAN_STEPS_REQUIRED', r.status, 400);
    eq('错误码', r.data.code, 'PLAN_STEPS_REQUIRED');

    const missing = planSteps(1).slice(0, 4); // 只覆盖到区段3
    r = await api(`/api/instances/${instId}/movement-plans`, { token, method: 'POST', body: { steps: missing } });
    eq('步数不足 400 PLAN_STEPS_MISMATCH', r.status, 400);
    eq('错误码', r.data.code, 'PLAN_STEPS_MISMATCH');
    eq('响应给出期望步数', r.data.expectedSteps, 6);

    const wrong = planSteps(1);
    wrong[1] = { sectionId: '3', action: 'clear', waitSeconds: 1 }; // 第2步应清空区段1
    r = await api(`/api/instances/${instId}/movement-plans`, { token, method: 'POST', body: { steps: wrong } });
    eq('区段顺序不符 400', r.status, 400);
    eq('错误码', r.data.code, 'PLAN_STEP_SECTION_MISMATCH');

    const wrongAction = planSteps(1);
    wrongAction[0].action = 'clear'; // 首步必须占用
    r = await api(`/api/instances/${instId}/movement-plans`, { token, method: 'POST', body: { steps: wrongAction } });
    eq('动作交替不符 400 PLAN_STEP_ACTION_MISMATCH', r.status, 400);
    eq('错误码', r.data.code, 'PLAN_STEP_ACTION_MISMATCH');

    for (const bad of [0, -1, 1.5, 'abc', null]) {
      const steps = planSteps(1);
      steps[2].waitSeconds = bad;
      r = await api(`/api/instances/${instId}/movement-plans`, { token, method: 'POST', body: { steps } });
      eq(`等待时长 ${JSON.stringify(bad)} 400 BAD_WAIT_SECONDS`, r.status, 400);
      eq('错误码', r.data.code, 'BAD_WAIT_SECONDS');
    }

    // 全部拒绝后该实例无任何计划（可再次正常提交验证）
    const list = await api(`/api/movement-plans?scope=all`, { token });
    eq('非法计划不留记录', list.data.plans.length, 0);

    // 不存在/已解除实例 404
    r = await api(`/api/instances/999/movement-plans`, { token, method: 'POST', body: { steps: planSteps(1) } });
    eq('未知实例 404 INSTANCE_NOT_FOUND', r.status, 404);

    // 未登录 401；管理员 403
    r = await api(`/api/instances/${instId}/movement-plans`, { method: 'POST', body: { steps: planSteps(1) } });
    eq('未登录 401', r.status, 401);
    r = await api(`/api/instances/${instId}/movement-plans`, { token: admin, method: 'POST', body: { steps: planSteps(1) } });
    eq('管理员 403', r.status, 403);

    await reset(admin);
  }

  console.log('[2] 正常提交：返回计划编号、状态、下一步与到期时刻');
  {
    const instId = await openR1(token);
    const t0 = Date.now();
    const r = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    eq('提交 201', r.status, 201);
    const p = r.data.plan;
    ok('计划编号为正整数', Number.isInteger(p.id) && p.id > 0, p.id);
    eq('状态 active', p.status, 'active');
    eq('总步数 6', p.totalSteps, 6);
    eq('下一步步号 1', p.nextStep.step, 1);
    eq('下一步动作 occupy', p.nextStep.action, 'occupy');
    eq('下一步区段 1', p.nextStep.sectionId, '1');
    ok('到期时刻≈提交+1s', Math.abs(p.nextStep.dueAt - (t0 + 1000)) < 1000, p.nextStep.dueAt);
    eq('后续步未排期(null)', p.steps[1].dueAt, null);
    eq('instanceId 正确', p.instanceId, instId);

    // 同一实例重复提交活动计划拒绝
    const r2 = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    eq('重复活动计划 409', r2.status, 409);
    eq('错误码 PLAN_ALREADY_ACTIVE', r2.data.code, 'PLAN_ALREADY_ACTIVE');

    // 等待完成（每步2s，约12s内）
    const done = await waitPlan(token, p.id, ['completed']);
    eq('末步完成', done.status, 'completed');
    eq('currentStep 越过末步', done.currentStep, 7);
    const st = await waitInstanceGone(token, instId);
    const rel = st.recentReleased.find((x) => x.id === instId);
    ok('进路已解除且红灯', rel && rel.status === 'released' && rel.signalState === 'red', rel);
    eq('恰好 6 个事件', rel.events.length, 6);
    const seq = rel.events.map((e) => `${e.seq}:${e.action}:${e.section_id}`);
    eq('事件1', seq[0], '1:occupy:1');
    eq('事件2', seq[1], '2:clear:1');
    eq('事件3', seq[2], '3:occupy:3');
    eq('事件4', seq[3], '4:clear:3');
    eq('事件5', seq[4], '5:occupy:5');
    eq('事件6', seq[5], '6:clear:5');
    ok('自动事件 client 带计划标记', rel.events[0].client.includes(`定时计划#${p.id}`), rel.events[0].client);
    // 沿途区段最终空闲
    const secs = Object.fromEntries(st.sections.map((s) => [s.id, s.occ_state]));
    eq('区段1空闲', secs['1'], 'free');
    eq('区段3空闲', secs['3'], 'free');
    eq('区段5空闲', secs['5'], 'free');

    // 完成后可对新实例提交新计划（不冲突）
    await reset(admin);
  }

  console.log('[3] 人工事件抢先改变进度 → 计划停止，不覆盖人工结果，不重发事件');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    const planId = created.data.plan.id;
    // 等首步（占用区段1）自动注入（1s 等待 + 0.5s 扫描粒度 + 请求耗时余量）
    await sleep(1900);
    let st = await getState(token);
    let inst = st.openInstances.find((x) => x.id === instId);
    eq('首步已自动注入(1个事件)', inst.events.length, 1);
    eq('信号已回红', inst.signalState, 'red');

    // 人工提交序号2（清空区段1）抢先
    const man = await api(`/api/instances/${instId}/events`, {
      token: tokenB, method: 'POST', body: { seq: 2, sectionId: '1', action: 'clear' }
    });
    eq('人工事件受理 200', man.status, 200);

    const stopped = await waitPlan(token, planId, ['aborted']);
    ok('停止原因说明人工抢先', /人工事件抢先/.test(stopped.endReason), stopped.endReason);
    // 再等超过一个等待周期：计划不得再注入（事件数停在2）
    await sleep(2600);
    st = await getState(token);
    inst = st.openInstances.find((x) => x.id === instId);
    ok('实例仍开放（未被计划走完）', !!inst, null);
    eq('事件数停在2，不重发', inst.events.length, 2);
    eq('人工结果保留(序号2清空1)', inst.events[1].action === 'clear' && inst.events[1].section_id === '1', true);
    // 停止后原申请人可提交新计划？该实例已有走行记录 → 拒绝（尚未走行前提）
    const again = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    eq('已有走行再提交 409 PLAN_PROGRESS_EXISTS', again.status, 409);
    eq('错误码', again.data.code, 'PLAN_PROGRESS_EXISTS');

    await reset(admin);
  }

  console.log('[4] 本人终止：仅停止后续注入，不解除进路；非本人拒绝');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(60) }
    });
    const planId = created.data.plan.id;

    const forbid = await api(`/api/movement-plans/${planId}/terminate`, { token: tokenB, method: 'POST' });
    eq('非本人终止 403 NOT_OWNER', forbid.status, 403);
    eq('错误码', forbid.data.code, 'NOT_OWNER');

    const term = await api(`/api/movement-plans/${planId}/terminate`, { token, method: 'POST' });
    eq('本人终止 200', term.status, 200);
    eq('状态 terminated', term.data.plan.status, 'terminated');
    ok('终止原因说明不解除进路', /不解除进路/.test(term.data.plan.endReason), term.data.plan.endReason);

    await sleep(1500);
    const st = await getState(token);
    const inst = st.openInstances.find((x) => x.id === instId);
    ok('进路仍开放', !!inst, null);
    eq('信号仍绿（未注入过）', inst.signalState, 'green');
    eq('无任何事件', inst.events.length, 0);

    // 重复终止 → 非活动 409
    const again = await api(`/api/movement-plans/${planId}/terminate`, { token, method: 'POST' });
    eq('重复终止 409', again.status, 409);
    eq('错误码 MOVEMENT_PLAN_NOT_ACTIVE', again.data.code, 'MOVEMENT_PLAN_NOT_ACTIVE');
    // 未知计划 404
    const nf = await api(`/api/movement-plans/999`, { token });
    eq('未知计划 404', nf.status, 404);

    await reset(admin);
  }

  console.log('[5] 延时取消申请使活动计划同事务停止');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(60) }
    });
    const planId = created.data.plan.id;
    const c = await api(`/api/instances/${instId}/cancel-delayed`, { token, method: 'POST' });
    eq('延时取消受理 201', c.status, 201);
    const p = await waitPlan(token, planId, ['aborted']);
    ok('原因提到延时取消', /延时取消/.test(p.endReason), p.endReason);
    await sleep(800); // 超过首步等待，确认未注入
    const st = await getState(token);
    const inst = st.openInstances.find((x) => x.id === instId);
    eq('计划未注入事件', inst.events.length, 0);
    eq('信号红（取消令其回红）', inst.signalState, 'red');

    // 延时取消仍 pending 时，对同一未走行实例再提交计划 → 拒绝（二者互斥）
    const retry = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    eq('有 pending 取消时再提交 409', retry.status, 409);
    eq('错误码 PLAN_CANCELLATION_PENDING', retry.data.code, 'PLAN_CANCELLATION_PENDING');
    await reset(admin);
  }

  console.log('[6] 重启后继续未完成计划：逾期步骤依序处理，后续按成功时刻计时');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(1) }
    });
    const planId = created.data.plan.id;
    // 停服，在停机期间让前 2 步以上逾期（服务停止期间无定时器）
    await stopServer();
    await sleep(2600);
    await startServer(true);
    // 启动即处理逾期：第1步到期注入→第2步从成功时刻+1s（尚未到期）
    await sleep(400);
    let p = await waitPlan(token, planId, ['active', 'completed']);
    let st = await getState(token);
    let inst = st.openInstances.find((x) => x.id === instId);
    eq('重启后立即只补注入逾期的第1步', inst.events.length, 1);
    eq('计划仍在活动(等第2步)', p.status, 'active');
    // 等待整条走完
    p = await waitPlan(token, planId, ['completed']);
    eq('重启后最终完成', p.status, 'completed');
    await waitInstanceGone(token, instId);
    await reset(admin);
  }

  console.log('[7] 创建副本不复制活动计划；原站场计划继续运行');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(30) }
    });
    const planId = created.data.plan.id;

    const cp = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '计划副本' } });
    eq('创建副本 201', cp.status, 201);
    const yardId = cp.data.yard.id;

    // 切到副本：有复制来的开放实例，但没有活动计划
    const sel = await api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
    eq('切换副本 200', sel.status, 200);
    let st = await getState(token);
    eq('副本复制了开放实例', st.openInstances.length, 1);
    eq('副本无活动计划', (st.activeMovementPlans ? Object.keys(st.activeMovementPlans).length : 0), 0);
    const cpList = await api('/api/movement-plans?scope=all', { token });
    eq('副本计划列表为空', cpList.data.plans.length, 0);

    // 切回原站场：原计划仍在
    await api('/api/auth/yard', { token, method: 'PUT', body: { yardId: 1 } });
    st = await getState(token);
    eq('原站场仍有1个活动计划', Object.keys(st.activeMovementPlans || {}).length, 1);
    const p = await api(`/api/movement-plans/${planId}`, { token });
    eq('原站场计划仍 active', p.data.plan.status, 'active');
    // 终止它收尾
    await api(`/api/movement-plans/${planId}/terminate`, { token, method: 'POST' });
    await reset(admin);
  }

  console.log('[8] 列表/详情/权限与重置清除');
  {
    const instId = await openR1(token);
    const created = await api(`/api/instances/${instId}/movement-plans`, {
      token, method: 'POST', body: { steps: planSteps(30) }
    });
    const planId = created.data.plan.id;

    // 默认只看本人（乙看不到甲的活动计划）
    const listB = await api('/api/movement-plans', { token: tokenB });
    eq('他人默认列表不含该计划', listB.data.plans.some((x) => x.id === planId), false);
    const listAll = await api('/api/movement-plans?scope=all&status=active', { token: tokenB });
    ok('scope=all 可见活动计划', listAll.data.plans.some((x) => x.id === planId), null);
    eq('status 过滤生效', listAll.data.plans.every((x) => x.status === 'active'), true);
    // 乙不能终止甲的计划（已在[4]测），但可查看详情（值班台共用）
    const one = await api(`/api/movement-plans/${planId}`, { token: tokenB });
    eq('他人可查看详情 200', one.status, 200);

    // 管理员重置清除活动计划
    await reset(admin);
    const after = await api('/api/movement-plans?scope=all', { token });
    eq('重置后无活动计划', after.data.plans.filter((x) => x.status === 'active').length, 0);
  }

  await stopServer();
  console.log(`\n定时走行计划全部 ${passed} 项断言通过 ✅`);
}

main().catch(async (e) => {
  console.error('测试失败:', e);
  if (serverOut) {
    console.error('---- 服务进程输出 ----');
    console.error(serverOut.slice(-4000));
  }
  try { await stopServer(); } catch (_) {}
  process.exit(1);
});
