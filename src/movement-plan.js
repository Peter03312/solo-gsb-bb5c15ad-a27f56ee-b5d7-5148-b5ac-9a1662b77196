'use strict';

/**
 * 定时走行计划。
 *
 * 语义（与需求一一对应）：
 *  - 值班员可对【已开放且尚未走行】（无任何走行事件，next_seq=1）的进路实例
 *    提交定时走行计划：步骤必须按进路区段顺序交替列出
 *    占用1→清空1→占用2→清空2→…，共 区段数×2 步，每步填写正整数秒等待时长。
 *  - 首步从【提交时刻】计时；后续每步从上一步【成功】时刻计时
 *    （movement_plan_steps.due_at 在步骤进入 pending 时写入）。
 *  - 到期处理（processPlanInTxn）在单个 SQLite 事务内：
 *      重查前提（实例仍开放、走行进度未被人工抢先改变、无延时取消申请、
 *      计划步骤仍与进路定义一致）→ 沿用现有事件序号（seq=步号）与走行校验，
 *      复用 interlocking.submitSectionEventInTxn 提交事件并推进计划。
 *      信号回红、逐段解锁、整条解除与等待兑现全部走现有规则。
 *  - 前提失效（人工事件抢先改变进度、延时取消申请、实例解除）或到期注入时
 *    走行校验未通过：计划停止（aborted）并写明原因，人工结果原样保留、
 *    不覆盖；步骤与事件在同一事务内更新，重复触发不会重发事件
 *    （section_events 的 UNIQUE(instance_id,seq) 也是最后防线）。
 *  - 末步成功后计划完成（completed）；本人终止（terminated）只停止后续注入，
 *    不解除进路。
 *  - 服务重启后继续未完成计划：定时器启动即扫描，已到期步骤立即处理，
 *    后续步骤按"上一步成功时刻"重新计时，逾期步骤依序逐个处理。
 *  - 每个站场各持一份本表；创建副本时不复制活动计划（复制白名单不含本表）。
 *
 * 时间全部存 epoch 毫秒整数（不依赖 datetime('now') 文本，重启/跨库可比较）。
 */

const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

const MAX_WAIT_SECONDS = 7 * 24 * 3600; // 单步等待上限 7 天（正整数）

let timer = null;

/** 定时计划自动注入事件时写入 section_events.client 的提交人标记 */
function planClient(planId) {
  return `定时计划#${planId}`;
}

/* ------------------------------ 提交前校验 ------------------------------ */

/**
 * 校验并规范化步骤列表：必须恰好 2N 步，按进路区段顺序交替
 * 占用(1)、清空(1)、占用(2)、清空(2)……，每步等待正整数秒。
 * 任一项不合法即 throw（非法计划整体拒绝，不留下任何数据）。
 * @returns {Array<{sectionId:string, action:'occupy'|'clear', waitSeconds:number}>}
 */
function validateSteps(routeSteps, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new InterlockError(400, 'PLAN_STEPS_REQUIRED',
      '定时走行计划必须包含非空的 steps 步骤列表（占用/清空交替，每步带正整数秒等待时长）');
  }
  const expectedCount = routeSteps.length * 2;
  if (rawSteps.length !== expectedCount) {
    throw new InterlockError(400, 'PLAN_STEPS_MISMATCH',
      `定时走行计划必须覆盖完整进路：进路有 ${routeSteps.length} 个区段，` +
      `应为 ${expectedCount} 步（占用/清空交替），收到 ${rawSteps.length} 步`,
      { expectedSteps: expectedCount, receivedSteps: rawSteps.length });
  }

  const normalized = [];
  rawSteps.forEach((raw, idx) => {
    const stepNo = idx + 1;
    const expectedSection = routeSteps[Math.floor(idx / 2)].section_id;
    const expectedAction = idx % 2 === 0 ? 'occupy' : 'clear';
    const item = raw && typeof raw === 'object' ? raw : {};

    const sectionId = String(item.sectionId == null ? '' : item.sectionId);
    const action = String(item.action == null ? '' : item.action);

    if (sectionId !== expectedSection) {
      throw new InterlockError(400, 'PLAN_STEP_SECTION_MISMATCH',
        `第 ${stepNo} 步的区段应为 ${expectedSection}（按进路区段顺序交替占用/清空），收到 ${sectionId || '空'}`,
        { step: stepNo, expectedSection, receivedSection: sectionId });
    }
    if (action !== expectedAction) {
      throw new InterlockError(400, 'PLAN_STEP_ACTION_MISMATCH',
        `第 ${stepNo} 步（区段 ${expectedSection}）应为 ${expectedAction === 'occupy' ? '占用' : '清空'}，收到 ${action || '空'}`,
        { step: stepNo, expectedAction, receivedAction: action });
    }

    const wait = Number(item.waitSeconds);
    if (!Number.isInteger(wait) || wait < 1 || wait > MAX_WAIT_SECONDS) {
      throw new InterlockError(400, 'BAD_WAIT_SECONDS',
        `第 ${stepNo} 步（${expectedAction === 'occupy' ? '占用' : '清空'} 区段 ${expectedSection}）` +
        `的等待时长必须是 1~${MAX_WAIT_SECONDS} 之间的正整数秒（收到 ${item.waitSeconds}）`,
        { step: stepNo, waitSeconds: item.waitSeconds });
    }

    normalized.push({ sectionId, action, waitSeconds: wait });
  });
  return normalized;
}

/* -------------------------------- 提交 -------------------------------- */

/**
 * 提交定时走行计划。校验全部通过才入库（单事务，非法计划整体拒绝）。
 * @returns {Object} 计划详情（编号、状态、下一步、到期时刻）
 */
function submitPlan(instanceId, rawSteps, applicant) {
  const db = getDb();
  const now = require('./pause').effectiveNow();

  const run = db.transaction(() => {
    const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(instanceId);
    if (!inst || inst.status !== 'open') {
      throw new InterlockError(404, 'INSTANCE_NOT_FOUND',
        `进路实例 ${instanceId} 不存在或已解除，不能提交定时走行计划`);
    }

    // 必须"尚未走行"：无任何走行事件（等价于 next_seq 仍为 1）
    const ev = db.prepare(
      `SELECT seq, section_id, action FROM section_events WHERE instance_id=? ORDER BY seq LIMIT 1`
    ).get(instanceId);
    if (ev || inst.next_seq !== 1) {
      throw new InterlockError(409, 'PLAN_PROGRESS_EXISTS',
        `进路实例 ${instanceId} 已有走行记录（序号 ${ev ? ev.seq : inst.next_seq - 1}），` +
        '定时走行计划只能对已开放且尚未走行的进路提交',
        { instanceId });
    }

    // 同一实例没有其他活动计划
    const active = db.prepare(
      `SELECT id FROM movement_plans WHERE instance_id=? AND status='active'`
    ).get(instanceId);
    if (active) {
      throw new InterlockError(409, 'PLAN_ALREADY_ACTIVE',
        `进路实例 ${instanceId} 已有活动的定时走行计划 #${active.id}，请先终止后再提交`,
        { planId: active.id });
    }

    // 存在待处理的延时取消申请时不能提交（计划与延时取消互斥：申请延时取消会令
    // 信号回红并等待保护期，自动走行首步占用又会按现有规则终止取消——二者只能先了
    // 结其一；取消释放/终止后实例仍开放且未走行时可再提交计划）。
    const pendingCancel = db.prepare(
      `SELECT id FROM cancellation_applications WHERE instance_id=? AND status='pending'`
    ).get(instanceId);
    if (pendingCancel) {
      throw new InterlockError(409, 'PLAN_CANCELLATION_PENDING',
        `进路实例 ${instanceId} 有待处理的延时取消申请 #${pendingCancel.id}，` +
        '不能提交定时走行计划；请待延时取消解除或终止后再提交',
        { cancellationId: pendingCancel.id });
    }

    const routeSteps = db.prepare(
      `SELECT step_order, section_id FROM route_steps WHERE route_id=? ORDER BY step_order`
    ).all(inst.route_id);
    const steps = validateSteps(routeSteps, rawSteps);

    const info = db.prepare(
      `INSERT INTO movement_plans(instance_id, applicant, route_id, status,
                                 total_steps, current_step, created_at)
       VALUES(?, ?, ?, 'active', ?, 1, ?)`
    ).run(instanceId, applicant, inst.route_id, steps.length, now);
    const planId = info.lastInsertRowid;

    const insStep = db.prepare(
      `INSERT INTO movement_plan_steps(plan_id, step_order, section_id, action,
                                      wait_seconds, due_at, status)
       VALUES(?, ?, ?, ?, ?, ?, 'pending')`
    );
    steps.forEach((s, idx) => {
      const stepNo = idx + 1;
      // 首步从提交时刻计时；后续步骤的 due_at 在其上一步成功时写入（此处留空）
      const dueAt = stepNo === 1 ? now + s.waitSeconds * 1000 : null;
      insStep.run(planId, stepNo, s.sectionId, s.action, s.waitSeconds, dueAt);
    });

    return planId;
  });

  const planId = run();
  return getPlan(planId);
}

/* --------------------------- 前提失效：同事务停止 --------------------------- */

/**
 * 在调用方事务内停止某实例的活动计划（通用）。返回被停止的计划编号（无则 null）。
 * 不解除进路、不改写任何走行结果。
 */
function abortActiveInTxn(instanceId, reason) {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM movement_plans WHERE instance_id=? AND status='active'`
  ).get(instanceId);
  if (!row) return null;
  db.prepare(
    `UPDATE movement_plans SET status='aborted', ended_at=?, end_reason=? WHERE id=?`
  ).run(Date.now(), reason, row.id);
  return row.id;
}

/** 人工走行事件抢先改变进度（在人工事件同一事务内调用）。 */
function abortActiveByManualInTxn(instanceId, detail) {
  return abortActiveInTxn(instanceId,
    `人工事件抢先改变走行进度，定时走行计划停止，不覆盖人工结果（${detail}）`);
}

/** 延时取消申请：申请立即令信号回红，计划前提失效，同事务停止。 */
function abortActiveByCancellationInTxn(instanceId) {
  return abortActiveInTxn(instanceId,
    '该进路提交了延时取消申请（入口信号回红、锁闭保留），定时走行计划前提失效，计划停止');
}

/* ------------------------------ 本人终止 ------------------------------ */

/**
 * 提交人主动终止计划：只停止后续注入，不解除进路、不改动已注入的走行结果。
 * 仅本人、且计划仍活动时允许。
 */
function terminatePlan(planId, clientName) {
  const db = getDb();
  const plan = db.prepare(`SELECT * FROM movement_plans WHERE id=?`).get(planId);
  if (!plan) throw new InterlockError(404, 'MOVEMENT_PLAN_NOT_FOUND', `定时走行计划 ${planId} 不存在`);
  if (plan.applicant !== clientName) {
    throw new InterlockError(403, 'NOT_OWNER',
      `不能终止：定时走行计划 #${planId} 的提交人为 ${plan.applicant}，只能由本人终止`);
  }
  if (plan.status !== 'active') {
    const map = { completed: '已完成', aborted: '已停止', terminated: '已终止' };
    throw new InterlockError(409, 'MOVEMENT_PLAN_NOT_ACTIVE',
      `定时走行计划 #${planId} ${map[plan.status] || plan.status}，不能再终止`);
  }
  db.prepare(
    `UPDATE movement_plans SET status='terminated', ended_at=?,
            end_reason='提交人主动终止：仅停止后续定时注入，不解除进路、已注入的走行结果保留'
      WHERE id=?`
  ).run(Date.now(), planId);
  return getPlan(planId);
}

/* ------------------------------ 到期处理 ------------------------------ */

/**
 * 处理单个活动计划（事务体）：把所有已到期步骤依序注入并推进计划。
 *  - 每步注入前重查前提；前提失效 → aborted（整笔回滚该步注入，保留既有结果）；
 *  - 注入用 SAVEPOINT：走行校验未通过只回滚本步写入，随后标记 aborted；
 *  - 一步成功后为下一步写 due_at=成功时刻+等待时长；未到期即结束本轮；
 *  - 末步成功 → completed（此时走行规则通常已令整条进路解除）。
 *
 * @returns {{injected:number, completed:boolean, aborted:boolean, abortedReason?:string,
 *            releasedInstance?:number}}
 */
function processPlanInTxn(plan) {
  const db = getDb();
  const result = { injected: 0, completed: false, aborted: false, releasedInstance: null };

  const fail = (reason) => {
    db.prepare(
      `UPDATE movement_plans SET status='aborted', ended_at=?, end_reason=? WHERE id=?`
    ).run(Date.now(), reason, plan.id);
    result.aborted = true;
    result.abortedReason = reason;
    return result;
  };

  for (;;) {
    const row = db.prepare(`SELECT * FROM movement_plans WHERE id=?`).get(plan.id);
    if (!row || row.status !== 'active') return result; // 已被并发路径终止

    const step = db.prepare(
      `SELECT * FROM movement_plan_steps WHERE plan_id=? AND status='pending'
        ORDER BY step_order LIMIT 1`
    ).get(plan.id);

    if (!step) {
      // 无待执行步却仍 active（边界兜底）：按完成收尾
      db.prepare(
        `UPDATE movement_plans SET status='completed', current_step=total_steps+1,
                ended_at=?, end_reason='全部步骤已成功注入，定时走行计划完成' WHERE id=?`
      ).run(Date.now(), plan.id);
      result.completed = true;
      return result;
    }
    if (step.due_at == null || step.due_at > Date.now()) return result; // 尚未到期

    // —— 到期：同事务重查全部前提 ——
    const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(row.instance_id);
    if (!inst || inst.status !== 'open') {
      return fail('到期处理时进路实例已不存在或已解除，定时走行计划停止；已有走行结果保留');
    }
    // 人工抢先改变进度：下一个事件序号必须仍对应当前步号
    if (inst.next_seq !== step.step_order) {
      return fail(
        `到期处理时走行进度已被人工事件改变（期望下一序号 ${step.step_order}，实际为 ${inst.next_seq}），` +
        '定时走行计划停止，不覆盖人工结果');
    }
    // 延时取消申请（pending）：信号已回红、等待保护期处理，计划不再注入
    const cancel = db.prepare(
      `SELECT 1 FROM cancellation_applications WHERE instance_id=? AND status='pending' LIMIT 1`
    ).get(row.instance_id);
    if (cancel) {
      return fail('到期处理时该进路存在待处理的延时取消申请，定时走行计划前提失效，计划停止');
    }
    // 计划步骤仍须与当前进路定义一致（开放期间拓扑禁改，此处防御性再查）
    const def = db.prepare(
      `SELECT section_id FROM route_steps WHERE route_id=? AND step_order=?`
    ).get(row.route_id, step.step_order % 2 === 1 ? (step.step_order + 1) / 2 : step.step_order / 2);
    if (!def || def.section_id !== step.section_id) {
      return fail(
        `到期处理时进路 ${row.route_id} 定义已与计划第 ${step.step_order} 步不一致，定时走行计划停止`);
    }

    // —— 沿用现有事件序号（seq=步号）与走行校验注入；失败只回滚本步 ——
    // 审计上下文：source=system，actor 为计划提交人（流水可追溯"系统按谁的计划注入"）。
    const attempt = db.transaction(() =>
      require('./interlocking').submitSectionEventInTxn(
        row.instance_id, step.step_order, step.section_id, step.action,
        planClient(plan.id), 'plan', { actor: row.applicant, planId: plan.id }));
    let injected;
    try {
      injected = attempt();
    } catch (e) {
      const reason = (e && e.message) ? e.message : String(e);
      return fail(
        `到期注入第 ${step.step_order} 步（${step.action === 'occupy' ? '占用' : '清空'} 区段 ${step.section_id}）` +
        `未通过现有走行校验：${reason}；定时走行计划停止，不覆盖人工结果`);
    }

    // submitSectionEventInTxn 对该 seq 必然是新事件（前提已保证 next_seq=步号）；
    // 若返回幂等说明事件已由其他路径写入，按抢先处理，保守停止。
    if (injected.idempotent) {
      return fail(
        `第 ${step.step_order} 步的走行事件已存在（序号 ${step.step_order}），定时走行计划停止，不重复发事件`);
    }
    if (injected.routeReleased) result.releasedInstance = row.instance_id;

    db.prepare(
      `UPDATE movement_plan_steps SET status='done', event_seq=? WHERE id=?`
    ).run(step.step_order, step.id);
    result.injected++;

    const isLast = step.step_order >= row.total_steps;
    if (isLast) {
      db.prepare(
        `UPDATE movement_plans SET status='completed', current_step=total_steps+1,
                ended_at=?, end_reason='末步走行事件成功，定时走行计划完成（进路按现有规则逐段解锁/解除）'
          WHERE id=?`
      ).run(Date.now(), plan.id);
      result.completed = true;
      return result;
    }

    // 推进下一步；其到期时刻 = 本步成功时刻 + 该步等待时长
    const next = db.prepare(
      `SELECT * FROM movement_plan_steps WHERE plan_id=? AND step_order=?`
    ).get(plan.id, step.step_order + 1);
    db.prepare(
      `UPDATE movement_plans SET current_step=? WHERE id=?`
    ).run(step.step_order + 1, plan.id);
    db.prepare(
      `UPDATE movement_plan_steps SET due_at=? WHERE id=?`
    ).run(Date.now() + next.wait_seconds * 1000, next.id);
    // 下一步至少等待正整数秒，本轮循环下次判断时必然未到期 → 退出等待定时器
  }
}

/**
 * 扫描当前站场全部到期活动计划并处理。每个计划独立事务，互不影响；
 * 有事件成功注入的，事务外统一触发一次等待兑现扫描（信号回红/逐段解锁/解除
 * 均已在注入事务内按现有规则完成）。
 * @returns {{processed:Array<number>, completed:Array<number>, aborted:Array<{id:number,reason:string}>}}
 */
function processDue(trigger = 'timer') {
  const db = getDb();
  const now = require('./pause').effectiveNow();
  const duePlans = db.prepare(
    `SELECT p.* FROM movement_plans p
      WHERE p.status='active'
        AND EXISTS (
          SELECT 1 FROM movement_plan_steps s
           WHERE s.plan_id=p.id AND s.status='pending' AND s.due_at IS NOT NULL AND s.due_at<=?)
      ORDER BY (SELECT MIN(s.due_at) FROM movement_plan_steps s
                 WHERE s.plan_id=p.id AND s.status='pending'), p.id`
  ).all(now);

  const processed = [];
  const completed = [];
  const aborted = [];
  let anyInjected = false;
  let anyReleased = false;

  for (const plan of duePlans) {
    const txn = db.transaction((p) => processPlanInTxn(p));
    let res;
    try {
      res = txn(plan);
    } catch (e) {
      // 单计划处理异常不应拖垮扫描：记录日志，下轮再试（计划仍 active，不重发已成功步）
      console.error(`[movement-plan] 计划 #${plan.id} 到期处理失败，下轮重试:`, e);
      continue;
    }
    if (res.injected > 0 || res.completed || res.aborted) processed.push(plan.id);
    if (res.injected > 0) anyInjected = true;
    if (res.releasedInstance) anyReleased = true;
    if (res.completed) completed.push(plan.id);
    if (res.aborted) {
      aborted.push({ id: plan.id, reason: res.abortedReason });
      console.log(`[movement-plan] 计划 #${plan.id} 前提失效停止（${trigger}）：${res.abortedReason}`);
    }
  }

  if (completed.length) {
    console.log(`[movement-plan] 定时走行计划完成（${trigger}）：#${completed.join('、#')}`);
  }
  if (anyInjected) {
    // 与人工走行事件同一套后置动作：封锁复核 + 等待申请兑现（异常不影响已成功注入）
    try {
      require('./interlocking').triggerWaitingSweep(
        anyReleased ? 'movement_plan_released' : 'movement_plan_event');
    } catch (e) {
      console.error('[movement-plan] 注入后等待兑现扫描失败:', e);
    }
  }
  return { processed, completed, aborted };
}

/* ------------------------------ 定时与重启 ------------------------------ */

/** 扫描一次全部站场：各站场在自己的上下文内按 due_at 处理，互不串用。 */
function processDueAllYards(trigger) {
  const { withYard } = require('./db');
  let yardsList;
  try {
    yardsList = require('./yards').listYards();
  } catch (e) {
    yardsList = null;
  }
  if (!yardsList) return processDue(trigger); // yards 注册表不可用（脚本直调）
  const summary = [];
  for (const y of yardsList) {
    if (require('./pause').isPaused(y.id)) continue;
    try {
      const r = withYard(y.id, () => processDue(`${trigger}:yard${y.id}`));
      summary.push({ yard: y.id, ...r });
    } catch (e) {
      console.error(`[movement-plan] 站场 ${y.id} 定时扫描失败:`, e);
    }
  }
  return summary;
}

/**
 * 启动定时器（服务启动时调用一次）：立即扫描一次以处理重启期间已到期的步骤
 * （逾期步骤依序处理；后续步骤从上一步成功时刻重新计时），之后每 0.5 秒扫描。
 */
function startScheduler() {
  stopScheduler();
  try {
    processDueAllYards('server_start');
  } catch (e) {
    console.error('[startup] 定时走行计划到期扫描失败:', e);
  }
  timer = setInterval(() => {
    try { processDueAllYards('timer'); } catch (e) { console.error('[movement-plan] 定时扫描失败:', e); }
  }, 500);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* --------------------------- 管理员重置：一并清除 --------------------------- */

/**
 * 管理员重置推演：清除全部活动定时走行计划（随后删除进路实例也会级联清除，
 * 这里在同一重置事务内显式清理，语义清晰）。应在管理员重置事务内调用。
 */
function clearAllByReset() {
  getDb().prepare(`DELETE FROM movement_plans WHERE status='active'`).run();
  return true;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToStep(row, now) {
  return {
    step: row.step_order,
    sectionId: row.section_id,
    action: row.action,                 // occupy / clear
    actionText: row.action === 'occupy' ? '占用' : '清空',
    waitSeconds: row.wait_seconds,
    status: row.status,                 // pending / done
    dueAt: row.due_at,                  // 到期时刻（epoch 毫秒；未排期为 null）
    remainingMs: row.status === 'pending' && row.due_at != null
      ? Math.max(0, row.due_at - now) : null,
    overDue: row.status === 'pending' && row.due_at != null ? row.due_at <= now : false,
    eventSeq: row.event_seq
  };
}

function rowToPlan(row) {
  if (!row) return null;
  const db = getDb();
  const now = require('./pause').effectiveNow();
  const stepRows = db.prepare(
    `SELECT * FROM movement_plan_steps WHERE plan_id=? ORDER BY step_order`
  ).all(row.id);
  const steps = stepRows.map((s) => rowToStep(s, now));
  const nextStepRow = stepRows.find((s) => s.status === 'pending') || null;
  const nextStep = nextStepRow ? rowToStep(nextStepRow, now) : null;

  return {
    id: row.id,
    instanceId: row.instance_id,
    routeId: row.route_id,
    applicant: row.applicant,
    status: row.status,                 // active / completed / aborted / terminated
    totalSteps: row.total_steps,
    currentStep: row.current_step,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    nextStep,                           // 下一步（编号/动作/区段/到期时刻）；无则 null
    steps                               // 全量步骤（查看计划时返回）
  };
}

function getPlan(id) {
  return rowToPlan(getDb().prepare(`SELECT * FROM movement_plans WHERE id=?`).get(id));
}

/**
 * 计划列表：活动在前（按最早到期步升序），终态在后（按结束时刻倒序）。
 * @param {{applicant?:string, status?:string, steps?:boolean}} filter
 *        steps=false 时省略全量步骤（/api/state 快照只需要下一步）
 */
function listPlans(filter = {}) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.* FROM movement_plans p
      ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
               CASE p.status WHEN 'active' THEN
                 (SELECT MIN(s.due_at) FROM movement_plan_steps s
                   WHERE s.plan_id=p.id AND s.status='pending')
                 ELSE -COALESCE(p.ended_at,0) END,
               p.id DESC`
  ).all();
  let list = rows;
  if (filter.applicant) list = list.filter((r) => r.applicant === filter.applicant);
  if (filter.status) list = list.filter((r) => r.status === filter.status);
  return list.map((r) => {
    const plan = rowToPlan(r);
    if (filter.steps === false) delete plan.steps;
    return plan;
  });
}

/** 全部活动计划按实例索引（供 /api/state 快照下发，值班台据此显示徽标/倒计时） */
function activeByInstance() {
  const rows = getDb().prepare(
    `SELECT * FROM movement_plans WHERE status='active' ORDER BY id`
  ).all();
  const map = {};
  for (const r of rows) {
    const plan = rowToPlan(r);
    delete plan.steps; // 索引视图只保留下一步，减小快照体积
    map[r.instance_id] = plan;
  }
  return map;
}

module.exports = {
  MAX_WAIT_SECONDS,
  submitPlan,
  terminatePlan,
  abortActiveInTxn,
  abortActiveByManualInTxn,
  abortActiveByCancellationInTxn,
  processDue,
  startScheduler,
  stopScheduler,
  clearAllByReset,
  getPlan,
  listPlans,
  activeByInstance
};
