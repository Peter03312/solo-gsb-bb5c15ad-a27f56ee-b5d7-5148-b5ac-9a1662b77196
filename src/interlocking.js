'use strict';

/**
 * 核心联锁逻辑。
 *
 * 设计要点：
 *  - openRoute / moveSwitch / submitSectionEvent / 人工解除 都包在 better-sqlite3
 *    的单个事务里执行；事务内任何一处校验失败即 throw，事务自动回滚，
 *    因此"开放失败不会留下任何部分锁定"。
 *  - route_locks 上 (resource_type,resource_id) 的唯一约束是争用仲裁的最后防线：
 *    两名值班员并发开放冲突进路时，后到事务插入重复锁必然失败 → 整条回滚，
 *    只有一条进路能成功。
 *  - 区段占用状态 unknown 与 occupied 同等对待（未知按占用处理）。
 *  - 事件序号按进路实例严格递增：同号同内容重传幂等；同号异内容、跳号拒绝。
 */

const { getDb } = require('./db');

class InterlockError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------ 基础查询 ------------------------------ */

function getRoute(routeId) {
  const route = getDb().prepare(`SELECT * FROM routes WHERE id=?`).get(routeId);
  if (!route) throw new InterlockError(404, 'ROUTE_NOT_FOUND', `进路 ${routeId} 不存在`);
  return route;
}

function getRouteSteps(routeId) {
  return getDb()
    .prepare(`SELECT step_order, section_id FROM route_steps WHERE route_id=? ORDER BY step_order`)
    .all(routeId);
}

function getRouteSwitchReqs(routeId) {
  return getDb()
    .prepare(`SELECT switch_id, req_position FROM route_switch_reqs WHERE route_id=?`)
    .all(routeId);
}

function getInstance(instanceId) {
  const inst = getDb()
    .prepare(`SELECT * FROM route_instances WHERE id=? AND status='open'`)
    .get(instanceId);
  if (!inst) {
    throw new InterlockError(404, 'INSTANCE_NOT_FOUND',
      `进路实例 ${instanceId} 不存在或已解除`);
  }
  return inst;
}

/** 找到当前锁定了某资源的开放进路（用于争用原因提示） */
function lockingInstance(resourceType, resourceId) {
  return getDb()
    .prepare(
      `SELECT i.id, i.route_id, i.opened_by
         FROM route_locks l JOIN route_instances i ON i.id=l.instance_id
        WHERE l.resource_type=? AND l.resource_id=? AND i.status='open'`
    )
    .get(resourceType, resourceId);
}

/** 区段上未结束（待生效/已生效）的临时封锁；无则 undefined */
function unfinishedBlockade(sectionId) {
  return getDb()
    .prepare(
      `SELECT id, reason, status FROM blockade_applications
        WHERE section_id=? AND status IN ('pending','active')`
    )
    .get(sectionId);
}

/** 封锁提示语（预检原因与开放拒绝共用同一措辞） */
function blockadeText(sectionId, b) {
  return `区段 ${sectionId} 已被临时封锁（申请 #${b.id}，` +
    `${b.status === 'active' ? '已生效' : '待生效'}，原因：${b.reason}）`;
}

/* --------------------------- 开放前预检（只读） --------------------------- */

/**
 * 预检某进路能否以给定道岔位置开放。
 * @param {string} routeId
 * @param {Object<string,'N'|'R'>} switchPositions 值班员选择的道岔位置
 *        （键为道岔号；未提供的要求道岔按"未选择/实际位置"参与判定）
 * @returns {{ok:boolean, reasons:Array, requirements:Object, signals:Array}}
 */
function checkOpen(routeId, switchPositions = {}) {
  const db = getDb();
  const route = db.prepare(`SELECT * FROM routes WHERE id=?`).get(routeId);
  const reasons = [];
  if (!route) {
    return {
      ok: false,
      reasons: [`进路 ${routeId} 不存在`],
      requirements: { sections: [], switches: [] },
      signals: []
    };
  }

  const steps = getRouteSteps(routeId);
  const reqs = getRouteSwitchReqs(routeId);

  if (steps.length === 0) reasons.push(`进路 ${routeId} 未定义任何区段，请先由管理员完善`);

  // 1) 沿途区段：未知/占用、临时封锁、已被其他开放进路锁定 → 阻断
  const sectionResults = steps.map((s) => {
    const sec = db.prepare(`SELECT id,label,occ_state FROM sections WHERE id=?`).get(s.section_id);
    const problems = [];
    if (!sec) {
      problems.push(`区段 ${s.section_id} 不存在（进路定义可能已失效）`);
    } else {
      if (sec.occ_state === 'occupied') problems.push(`区段 ${sec.id} 已被占用`);
      if (sec.occ_state === 'unknown') problems.push(`区段 ${sec.id} 占用状态未知，按占用处理`);
      const blockade = unfinishedBlockade(s.section_id);
      if (blockade) problems.push(blockadeText(s.section_id, blockade));
      const holder = lockingInstance('section', s.section_id);
      if (holder) {
        problems.push(`区段 ${s.section_id} 已被已开放进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`);
      }
    }
    if (problems.length) reasons.push(...problems);
    return { step: s.step_order, sectionId: s.section_id,
      state: sec ? sec.occ_state : 'missing', problems };
  });

  // 2) 道岔：值班员选择位置必须与进路要求一致；与实际位置不符时提示先扳动；
  //    已被其他进路锁定（即使要求位置恰好相同）也不能再锁 → 阻断
  const switchResults = reqs.map((r) => {
    const sw = db.prepare(`SELECT id,label,position FROM switches WHERE id=?`).get(r.switch_id);
    const chosen = switchPositions[r.switch_id] || null;
    const problems = [];
    if (!sw) {
      problems.push(`道岔 ${r.switch_id} 不存在（进路定义可能已失效）`);
    } else {
      if (!chosen) {
        problems.push(`道岔 ${sw.id} 未选择所需位置（进路要求 ${r.req_position}）`);
      } else if (chosen !== r.req_position) {
        problems.push(`道岔 ${sw.id} 所选位置 ${chosen} 与进路要求 ${r.req_position} 不符`);
      }
      if (sw && sw.position !== r.req_position) {
        problems.push(`道岔 ${sw.id} 实际位置为 ${sw.position}，需先扳至 ${r.req_position}`);
      }
      const holder = lockingInstance('switch', r.switch_id);
      if (holder) {
        problems.push(`道岔 ${r.switch_id} 已被已开放进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`);
      }
    }
    if (problems.length) reasons.push(...problems);
    return { switchId: r.switch_id, required: r.req_position,
      chosen, actual: sw ? sw.position : null, problems };
  });

  const entrySignal = route.entry_signal_id
    ? db.prepare(`SELECT * FROM signals WHERE id=?`).get(route.entry_signal_id)
    : null;

  return {
    ok: reasons.length === 0,
    reasons,
    requirements: {
      sections: sectionResults,
      switches: switchResults,
      entrySignal: entrySignal ? { id: entrySignal.id, label: entrySignal.label } : null
    },
    // 预检通过时信号将显示绿灯，否则红灯
    signalPreview: reasons.length === 0 ? 'green' : 'red'
  };
}

/* ------------------------------ 开放进路 ------------------------------ */

/**
 * 开放进路：openRouteInTxn 的事务包装（供直接开放与等待兑现复用同一套
 * 校验+锁闭代码路径）。
 *
 * 仅人工直接开放在此顶层事务内追加 route_opened 审计流水（与业务同成同败）；
 * 等待申请兑现复用 openRouteInTxn 但审计由 waiting.sweepFulfillments 写
 * waiting_fulfilled，避免一次兑现产生两条流水。
 */
function openRoute(routeId, switchPositions, clientName) {
  const db = getDb();
  const instanceId = db.transaction(() => {
    const id = openRouteInTxn(routeId, switchPositions, clientName);
    const detail = getInstanceDetail(id);
    require('./audit').recordRouteOpenedInTxn({
      instanceId: id,
      routeId,
      actor: clientName,
      before: { routeId, status: 'none', signalState: 'red' },
      after: {
        routeId,
        status: 'open',
        signalState: 'green',
        openedBy: clientName,
        lockedSections: detail.lockedSections,
        lockedSwitches: detail.lockedSwitches
      }
    });
    return id;
  })();
  return getInstanceDetail(instanceId);
}

/**
 * 开放进路（事务体）：定义校验→区段占用/锁定校验→道岔选择/实际/锁定校验
 * →写实例→写全部区段/道岔锁→入口信号转绿。任何一步失败 throw，由外层事务
 * （或等待兑现扫描中的 SAVEPOINT）整体回滚，不留下部分锁定。
 *
 * 直接开放时由 openRoute 包一层顶层事务；等待申请兑现扫描时，本函数在
 * 扫描事务内的 SAVEPOINT 中执行，失败只回滚本次兑现尝试。
 * @param {string} source 'manual' 直接开放 / 'waiting' 等待申请自动兑现
 * @returns {number} 新建立的进路实例编号
 */
function openRouteInTxn(routeId, switchPositions, clientName, source = 'manual') {
  const db = getDb();

  const route = getRoute(routeId);
  const steps = getRouteSteps(routeId);
  const reqs = getRouteSwitchReqs(routeId);
  if (steps.length === 0) {
    throw new InterlockError(400, 'EMPTY_ROUTE', `进路 ${routeId} 未定义区段，无法开放`);
  }

  // 区段校验
  for (const s of steps) {
    const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(s.section_id);
    if (!sec) throw new InterlockError(400, 'SECTION_MISSING',
      `进路定义中的区段 ${s.section_id} 不存在，请通知管理员检查进路 ${routeId}`,
      { sectionId: s.section_id });
    if (sec.occ_state === 'occupied') {
      throw new InterlockError(409, 'SECTION_OCCUPIED',
        `不能开放：区段 ${s.section_id} 已被占用`, { sectionId: s.section_id });
    }
    if (sec.occ_state === 'unknown') {
      throw new InterlockError(409, 'SECTION_UNKNOWN',
        `不能开放：区段 ${s.section_id} 占用状态未知，按占用处理；请先核实并提交清空`,
        { sectionId: s.section_id });
    }
    // 临时封锁（待生效/已生效均阻止新排路；已开放进路不受影响）
    const blockade = unfinishedBlockade(s.section_id);
    if (blockade) {
      throw new InterlockError(409, 'SECTION_BLOCKADED',
        `不能开放：${blockadeText(s.section_id, blockade)}`,
        { sectionId: s.section_id, blockadeId: blockade.id });
    }
    const holder = lockingInstance('section', s.section_id);
    if (holder) {
      throw new InterlockError(409, 'RESOURCE_LOCKED',
        `不能开放：区段 ${s.section_id} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`,
        { sectionId: s.section_id, holder: holder.id });
    }
  }

  // 道岔校验
  for (const r of reqs) {
    const sw = db.prepare(`SELECT position FROM switches WHERE id=?`).get(r.switch_id);
    if (!sw) throw new InterlockError(400, 'SWITCH_MISSING',
      `进路定义中的道岔 ${r.switch_id} 不存在`, { switchId: r.switch_id });
    const chosen = (switchPositions || {})[r.switch_id];
    if (!chosen) {
      throw new InterlockError(400, 'SWITCH_NOT_CHOSEN',
        `不能开放：道岔 ${r.switch_id} 未选择所需位置（进路要求 ${r.req_position}）`,
        { switchId: r.switch_id, required: r.req_position });
    }
    if (chosen !== r.req_position) {
      throw new InterlockError(409, 'SWITCH_POSITION_MISMATCH',
        `不能开放：道岔 ${r.switch_id} 选择位置 ${chosen} 与进路要求 ${r.req_position} 不符`,
        { switchId: r.switch_id, chosen, required: r.req_position });
    }
    if (sw.position !== r.req_position) {
      throw new InterlockError(409, 'SWITCH_ACTUAL_MISMATCH',
        `不能开放：道岔 ${r.switch_id} 实际位置为 ${sw.position}，与进路要求 ${r.req_position} 不符，请先扳道岔`,
        { switchId: r.switch_id, actual: sw.position, required: r.req_position });
    }
    const holder = lockingInstance('switch', r.switch_id);
    if (holder) {
      throw new InterlockError(409, 'RESOURCE_LOCKED',
        `不能开放：道岔 ${r.switch_id} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁定`,
        { switchId: r.switch_id, holder: holder.id });
    }
  }

  // 建立进路实例（信号初始绿灯 = 允许车列进入）
  const info = db
    .prepare(`INSERT INTO route_instances(route_id,opened_by,status,signal_state,next_seq,head_step,tail_step)
              VALUES(?,?, 'open','green',1,1,1)`)
    .run(routeId, clientName);
  const instanceId = info.lastInsertRowid;

  const insLock = db.prepare(
    `INSERT INTO route_locks(instance_id,resource_type,resource_id,step_order) VALUES(?,?,?,?)`
  );
  try {
    for (const s of steps) insLock.run(instanceId, 'section', s.section_id, s.step_order);
    for (const r of reqs) insLock.run(instanceId, 'switch', r.switch_id, null);
  } catch (e) {
    // 唯一约束冲突 = 并发争用仲裁失败；外层事务将整体回滚，无部分锁定
    if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new InterlockError(409, 'CONTENTION_LOST',
        `开放失败：与并发申请的进路争用资源，本进路未获得锁（请刷新后重试）`,
        { contention: true });
    }
    throw e;
  }

  // 考核登记（同一事务内）：仅当本副本有进行中考核且开放人为指定学员时，
  // 登记该开考后新实例并判定顺序挂接/偏差；无考核时为空操作。随主事务提交。
  require('./exam').recordOpenInTxn(instanceId, routeId, clientName, source);

  return instanceId;
}

/* ------------------------------ 扳动道岔 ------------------------------ */

/** 扳动未锁闭道岔。被任意开放进路锁定的道岔拒绝。 */
function moveSwitch(switchId, targetPosition, clientName) {
  if (!['N', 'R'].includes(targetPosition)) {
    throw new InterlockError(400, 'BAD_POSITION', `道岔位置只能是 N(定位) 或 R(反位)`);
  }
  const db = getDb();
  const txn = db.transaction(() => {
    const sw = db.prepare(`SELECT * FROM switches WHERE id=?`).get(switchId);
    if (!sw) throw new InterlockError(404, 'SWITCH_NOT_FOUND', `道岔 ${switchId} 不存在`);
    const holder = lockingInstance('switch', switchId);
    if (holder) {
      throw new InterlockError(409, 'SWITCH_LOCKED',
        `道岔 ${switchId} 已被进路 #${holder.id}（${holder.route_id}，${holder.opened_by}）锁闭，不能扳动`,
        { switchId, holder: holder.id });
    }
    db.prepare(`UPDATE switches SET position=? WHERE id=?`).run(targetPosition, switchId);
  });
  txn();
  // 道岔扳动后自动尝试兑现等待申请
  triggerWaitingSweep('switch_moved');
  return { switchId, position: targetPosition, by: clientName };
}

/* ------------------------ 独立区段占用/清空（排路前） ------------------------ */

/**
 * 不依附进路实例的区段事件：用于把"未知"区段核实为空闲（清空），
 * 或培训时手工设置占用。未知状态按占用处理，因此新建区段必须先清空才能排路。
 */
function setSectionState(sectionId, action, clientName) {
  const db = getDb();
  const txn = db.transaction(() => {
    const sec = db.prepare(`SELECT * FROM sections WHERE id=?`).get(sectionId);
    if (!sec) throw new InterlockError(404, 'SECTION_NOT_FOUND', `区段 ${sectionId} 不存在`);
    const holder = lockingInstance('section', sectionId);
    if (holder && action === 'clear') {
      throw new InterlockError(409, 'SECTION_LOCKED',
        `区段 ${sectionId} 在进路 #${holder.id} 锁闭中，清空请按该进路的事件序号提交`,
        { sectionId, holder: holder.id });
    }
    const state = action === 'occupy' ? 'occupied' : 'free';
    db.prepare(`UPDATE sections SET occ_state=? WHERE id=?`).run(state, sectionId);
  });
  txn();
  // 区段状态变化（占用/清空）后自动尝试兑现等待申请
  triggerWaitingSweep('section_state_changed');
  return { sectionId, occState: action === 'occupy' ? 'occupied' : 'free', by: clientName };
}

/* --------------------------- 进路走行事件（序号） --------------------------- */

/**
 * 按进路实例提交占用/清空事件（人工接口包装）。
 * 规则：
 *  - seq 必须等于实例 next_seq（严格递增）；小则重传，大则跳号。
 *  - 同号同内容：幂等成功，不重复生效；同号异内容：拒绝。
 *  - 占用：只能作用于"当前可进入区段" head_step；首段被占用 → 信号回红。
 *  - 清空：只能作用于"当前最早未出清区段" tail_step；清空后删除该区段锁（逐段解锁）；
 *    清空末段后整条进路自动解除（实例 released，道岔锁随之释放）。
 *
 * 人工事件在同一事务内使该实例的活动定时走行计划前提失效（人工抢先），
 * 计划立即停止，人工结果原样保留；定时走行计划自身注入走 source='plan'
 * 的 submitSectionEventInTxn，不触发该钩子。
 */
function submitSectionEvent(instanceId, seq, sectionId, action, clientName) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new InterlockError(400, 'BAD_SEQ', `事件序号必须是从 1 开始的正整数（收到 ${seq}）`);
  }
  if (!['occupy', 'clear'].includes(action)) {
    throw new InterlockError(400, 'BAD_ACTION', `事件类型只能是 occupy(占用) 或 clear(清空)`);
  }

  const db = getDb();
  const txn = db.transaction(() => {
    const r = submitSectionEventInTxn(instanceId, seq, sectionId, action, clientName,
      'manual', { actor: clientName });
    // 人工事件（非幂等重传）抢先改变了走行进度：同事务停止活动定时走行计划，
    // 不覆盖人工结果；幂等重传不重复处理计划。
    if (!r.idempotent) {
      r.planAborted = require('./movement-plan').abortActiveByManualInTxn(
        instanceId, `人工走行事件抢先改变进度（序号 ${seq}：${action === 'occupy' ? '占用' : '清空'} 区段 ${sectionId}），定时走行计划停止；人工结果保留`);
    }
    return r;
  });

  const result = txn();
  result.detail = getInstanceDetail(instanceId, true);
  // 走行事件可能逐段解锁或整条进路解除 → 自动尝试兑现等待申请
  triggerWaitingSweep('section_event');
  return result;
}

/**
 * 走行事件事务体（人工提交与定时走行计划到期注入共用同一份序号/走行校验与
 * 状态推进代码路径，保证信号回红、逐段解锁、延时取消终止等规则完全一致）。
 * 必须在外层事务/SAVEPOINT 内调用。
 *
 * @param {string} source 'manual' 人工接口 / 'plan' 定时走行计划到期自动注入
 * @param {{actor?:string, planId?:number}} auditCtx 审计上下文：
 *        人工提交时 {actor:值班员}；计划注入时 {actor:计划提交人, planId}。
 *        幂等重传分支提前返回、不写流水。
 */
function submitSectionEventInTxn(instanceId, seq, sectionId, action, clientName, source = 'manual', auditCtx = null) {
  const db = getDb();
  const inst = getInstance(instanceId);
  const steps = getRouteSteps(inst.route_id);
  const lastStep = steps.length;

  // 1) 序号校验（幂等 / 冲突 / 跳号）
  const existing = db.prepare(
    `SELECT seq, section_id, action FROM section_events WHERE instance_id=? AND seq=?`
  ).get(instanceId, seq);

  if (existing) {
    if (existing.section_id === sectionId && existing.action === action) {
      return { idempotent: true, instanceId, seq, sectionId, action };
    }
    throw new InterlockError(409, 'SEQ_CONFLICT',
      `序号 ${seq} 已用于 ${existing.action === 'occupy' ? '占用' : '清空'} 区段 ${existing.section_id}，` +
      `不能再提交为${action === 'occupy' ? '占用' : '清空'}区段 ${sectionId}（同号异内容拒绝）`,
      { seq, existing, received: { sectionId, action } });
  }
  if (seq < inst.next_seq) {
    // 理论上上面已命中历史事件，兜底
    throw new InterlockError(409, 'SEQ_CONFLICT', `序号 ${seq} 已使用（同号异内容）`);
  }
  if (seq > inst.next_seq) {
    throw new InterlockError(409, 'SEQ_GAP',
      `跳号拒绝：期望下一个序号为 ${inst.next_seq}，收到 ${seq}（涉及区段 ${sectionId}）`,
      { expectedSeq: inst.next_seq, receivedSeq: seq, sectionId });
  }

  // 2) 区段归属校验
  const step = steps.find((s) => s.section_id === sectionId);
  if (!step) {
    throw new InterlockError(400, 'SECTION_NOT_IN_ROUTE',
      `区段 ${sectionId} 不属于进路 ${inst.route_id}（实例 #${instanceId}）的经过区段`,
      { sectionId, routeId: inst.route_id });
  }

  // 3) 走行顺序校验 + 状态变更
  if (action === 'occupy') {
    if (step.step_order !== inst.head_step) {
      throw new InterlockError(409, 'OUT_OF_ORDER',
        `占用顺序不符：当前应进入第 ${inst.head_step} 个区段 ${steps[inst.head_step - 1].section_id}，` +
        `收到的是第 ${step.step_order} 个区段 ${sectionId}`,
        { sectionId, expectedSection: steps[inst.head_step - 1].section_id });
    }
    db.prepare(`UPDATE sections SET occ_state='occupied' WHERE id=?`).run(sectionId);
    db.prepare(
      `INSERT INTO section_events(instance_id,seq,section_id,action,client) VALUES(?,?,?,?,?)`
    ).run(instanceId, seq, sectionId, action, clientName);

    const updates = ['next_seq = next_seq + 1', 'head_step = head_step + 1'];
    // 列车进入首段 → 入口信号回红
    if (step.step_order === 1) updates.push(`signal_state='red'`);
    db.prepare(`UPDATE route_instances SET ${updates.join(', ')} WHERE id=?`).run(instanceId);

    // 首段占用：若该实例有 pending 的延时取消申请，同一事务内终止（锁闭保留）
    let cancellationAborted = null;
    if (step.step_order === 1) {
      cancellationAborted = require('./cancellation').abortPendingByOccupyInTxn(instanceId);
    }

    // 审计流水（与事件同事务）：人工 actor=值班员；计划注入 actor=计划提交人、
    // source=system（首段占用还记录被同步终止的延时取消编号）
    require('./audit').recordRouteEventInTxn({
      instanceId, routeId: inst.route_id, seq, sectionId, action,
      actor: auditCtx ? auditCtx.actor : clientName,
      source: source === 'plan' ? 'system' : 'manual',
      before: {
        sectionState: 'free',
        signalState: inst.signal_state,
        nextSeq: inst.next_seq,
        headStep: inst.head_step
      },
      after: {
        sectionState: 'occupied',
        signalState: step.step_order === 1 ? 'red' : inst.signal_state,
        nextSeq: inst.next_seq + 1,
        headStep: inst.head_step + 1
      },
      extra: {
        ...(step.step_order === 1 ? { signalTurnedRed: true } : {}),
        ...(auditCtx && auditCtx.planId != null ? { planId: auditCtx.planId } : {}),
        ...(cancellationAborted != null ? { cancellationAborted } : {})
      }
    });

    return { idempotent: false, instanceId, seq, sectionId, action,
      signalTurnedRed: step.step_order === 1, cancellationAborted };
  }

  // action === 'clear'
  if (step.step_order !== inst.tail_step) {
    throw new InterlockError(409, 'OUT_OF_ORDER',
      `清空顺序不符：当前应先出清第 ${inst.tail_step} 个区段 ${steps[inst.tail_step - 1].section_id}，` +
      `不能提前清空第 ${step.step_order} 个区段 ${sectionId}（须按走行方向逐段解锁）`,
      { sectionId, expectedSection: steps[inst.tail_step - 1].section_id });
  }
  const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(sectionId);
  if (sec.occ_state !== 'occupied') {
    throw new InterlockError(409, 'NOT_OCCUPIED',
      `区段 ${sectionId} 当前并非占用状态（${sec.occ_state === 'unknown' ? '未知' : '空闲'}），不能提交清空事件`,
      { sectionId, state: sec.occ_state });
  }

  db.prepare(`UPDATE sections SET occ_state='free' WHERE id=?`).run(sectionId);
  db.prepare(
    `INSERT INTO section_events(instance_id,seq,section_id,action,client) VALUES(?,?,?,?,?)`
  ).run(instanceId, seq, sectionId, action, clientName);
  // 逐段解锁：删除该区段锁
  db.prepare(
    `DELETE FROM route_locks WHERE instance_id=? AND resource_type='section' AND resource_id=?`
  ).run(instanceId, sectionId);

  if (step.step_order === lastStep) {
    // 末段已清空 → 整条进路解除（道岔锁随实例删除，保留实例/事件记录供复盘）
    db.prepare(
      `UPDATE route_instances SET status='released', signal_state='red',
              next_seq=next_seq+1, tail_step=tail_step+1, released_at=datetime('now')
       WHERE id=?`
    ).run(instanceId);
    db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(instanceId);

    // 审计：末段走行出清事件 + 进路自动解除（同一事务两条流水，同成同败）
    const audit = require('./audit');
    audit.recordRouteEventInTxn({
      instanceId, routeId: inst.route_id, seq, sectionId, action,
      actor: auditCtx ? auditCtx.actor : clientName,
      source: source === 'plan' ? 'system' : 'manual',
      before: {
        sectionState: 'occupied',
        signalState: inst.signal_state,
        nextSeq: inst.next_seq,
        tailStep: inst.tail_step
      },
      after: {
        sectionState: 'free',
        signalState: 'red',
        nextSeq: inst.next_seq + 1,
        tailStep: inst.tail_step + 1
      },
      extra: {
        routeReleased: true,
        ...(auditCtx && auditCtx.planId != null ? { planId: auditCtx.planId } : {})
      }
    });
    audit.recordRouteReleasedInTxn({
      instanceId, routeId: inst.route_id, how: 'walkthrough',
      actor: auditCtx ? auditCtx.actor : clientName,
      source: source === 'plan' ? 'system' : 'manual',
      before: {
        routeId: inst.route_id, status: 'open', signalState: inst.signal_state,
        lockedSections: null, tailStep: inst.tail_step
      },
      after: {
        routeId: inst.route_id, status: 'released', signalState: 'red',
        lockedSections: [], lockedSwitches: []
      }
    });
    // 考核计数（同一事务内）：逐段走行【正常解除】才推进当前目标；人工释放/
    // 延时取消解除不经过此路径；幂等重传在上面的历史事件分支已提前返回。
    const examResult = require('./exam').recordWalkthroughReleaseInTxn(instanceId);
    return { idempotent: false, instanceId, seq, sectionId, action, routeReleased: true, examResult };
  }

  db.prepare(
    `UPDATE route_instances SET next_seq=next_seq+1, tail_step=tail_step+1 WHERE id=?`
  ).run(instanceId);

  // 审计：非末段出清（逐段解锁）
  require('./audit').recordRouteEventInTxn({
    instanceId, routeId: inst.route_id, seq, sectionId, action,
    actor: auditCtx ? auditCtx.actor : clientName,
    source: source === 'plan' ? 'system' : 'manual',
    before: {
      sectionState: 'occupied',
      signalState: inst.signal_state,
      nextSeq: inst.next_seq,
      tailStep: inst.tail_step
    },
    after: {
      sectionState: 'free',
      signalState: inst.signal_state,
      nextSeq: inst.next_seq + 1,
      tailStep: inst.tail_step + 1
    },
    extra: {
      sectionUnlocked: true,
      ...(auditCtx && auditCtx.planId != null ? { planId: auditCtx.planId } : {})
    }
  });
  return { idempotent: false, instanceId, seq, sectionId, action, sectionUnlocked: true };
}

/* ------------------------------ 人工解除进路 ------------------------------ */

/**
 * 值班员请求提前解除进路。联锁规则：末段未清空前不得解除整条进路。
 * 正常走行完毕时系统会在末段清空后自动解除，无需调用本接口。
 */
function releaseInstance(instanceId, clientName) {
  const db = getDb();
  const before = {
    routeId: null, status: 'open', signalState: null,
    lockedSections: null, lockedSwitches: null
  };
  const txn = db.transaction(() => {
    const inst = getInstance(instanceId);
    const steps = getRouteSteps(inst.route_id);
    const lastStep = steps.length;
    const lastSection = steps[lastStep - 1].section_id;
    const lock = db.prepare(
      `SELECT 1 FROM route_locks WHERE instance_id=? AND resource_type='section' AND resource_id=?`
    ).get(instanceId, lastSection);
    if (lock) {
      throw new InterlockError(409, 'LAST_SECTION_NOT_CLEARED',
        `不能解除：末段区段 ${lastSection} 尚未清空（须按序提交占用/清空事件，末段清空后进路自动解除）`,
        { lastSection });
    }
    before.routeId = inst.route_id;
    before.signalState = inst.signal_state;
    before.lockedSections = db.prepare(
      `SELECT resource_id FROM route_locks WHERE instance_id=? AND resource_type='section'`
    ).all(instanceId).map((r) => r.resource_id);
    before.lockedSwitches = db.prepare(
      `SELECT resource_id FROM route_locks WHERE instance_id=? AND resource_type='switch'`
    ).all(instanceId).map((r) => r.resource_id);
    // 末段锁已不存在说明走行已完成，正常应已自动 released；此处兜底完成解除
    db.prepare(
      `UPDATE route_instances SET status='released', released_at=datetime('now') WHERE id=?`
    ).run(instanceId);
    db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(instanceId);
    // 人工/兜底解除：同事务停止活动定时走行计划（人工结果保留，不覆盖）
    require('./movement-plan').abortActiveByManualInTxn(
      instanceId, '进路被人工解除，定时走行计划停止；人工结果保留');
    // 审计：人工解除进路（与解除同事务；校验失败已在上面抛错回滚）
    require('./audit').recordRouteReleasedInTxn({
      instanceId, routeId: inst.route_id, how: 'manual',
      actor: clientName, source: 'manual',
      before,
      after: {
        routeId: inst.route_id, status: 'released', signalState: 'red',
        lockedSections: [], lockedSwitches: []
      }
    });
  });
  txn();
  // 进路解除后资源释放 → 自动尝试兑现等待申请
  triggerWaitingSweep('route_released');
  return getInstanceDetail(instanceId, true);
}

/* ------------------------------ 状态快照 ------------------------------ */

function getInstanceDetail(instanceId, includeReleased = false) {
  const db = getDb();
  const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(instanceId);
  if (!inst || (inst.status !== 'open' && !includeReleased)) return null;
  if (!inst) return null;
  const steps = getRouteSteps(inst.route_id);
  const reqs = getRouteSwitchReqs(inst.route_id);
  const locks = db.prepare(
    `SELECT resource_type, resource_id, step_order FROM route_locks WHERE instance_id=?`
  ).all(instanceId);
  const events = db.prepare(
    `SELECT seq, section_id, action, client, created_at FROM section_events
      WHERE instance_id=? ORDER BY seq`
  ).all(instanceId);
  return {
    id: inst.id,
    routeId: inst.route_id,
    openedBy: inst.opened_by,
    status: inst.status,
    signalState: inst.signal_state,
    nextSeq: inst.next_seq,
    headStep: inst.head_step,
    tailStep: inst.tail_step,
    createdAt: inst.created_at,
    releasedAt: inst.released_at,
    sections: steps,
    switchReqs: reqs,
    lockedSections: locks.filter((l) => l.resource_type === 'section').map((l) => l.resource_id),
    lockedSwitches: locks.filter((l) => l.resource_type === 'switch').map((l) => l.resource_id),
    events
  };
}

/** 全量状态：前端刷新后据此恢复全部已提交状态 */
function getState() {
  const db = getDb();
  const sections = db.prepare(`SELECT * FROM sections ORDER BY id`).all();
  const switches = db.prepare(`SELECT * FROM switches ORDER BY id`).all();
  const signals = db.prepare(`SELECT * FROM signals ORDER BY id`).all();
  const routes = db.prepare(`SELECT * FROM routes ORDER BY id`).all().map((r) => ({
    ...r,
    steps: getRouteSteps(r.id),
    switchReqs: getRouteSwitchReqs(r.id)
  }));
  const openInstances = db.prepare(
    `SELECT id FROM route_instances WHERE status='open' ORDER BY id`
  ).all().map((r) => getInstanceDetail(r.id));
  const recentReleased = db.prepare(
    `SELECT id FROM route_instances WHERE status='released' ORDER BY id DESC LIMIT 20`
  ).all().map((r) => getInstanceDetail(r.id, true));

  return {
    serverTime: new Date().toISOString(),
    serverTimeMs: Date.now(),
    yard: currentYardInfo(),
    sections,
    switches,
    signals,
    routes,
    openInstances,
    recentReleased,
    // 懒加载避免与 waiting.js / cancellation.js / blockade.js 的循环依赖
    waitingApplications: require('./waiting').listApplications(),
    // 延时取消：全部申请（值班台显示取消状态与剩余时间）+ pending 按实例索引 + 保护时长
    cancellationRequests: require('./cancellation').listRequests(),
    pendingCancellations: require('./cancellation').pendingByInstance(),
    cancelProtectionSeconds: require('./cancellation').getProtectionSeconds(),
    // 临时封锁：全部申请（管理员/值班台显示）+ 未结束封锁按区段索引
    blockades: require('./blockade').listBlockades(),
    blockadesBySection: require('./blockade').unfinishedBySection(),
    // 交接班交接单（最近 200 张；待签收在前，刷新/重启后仍可查询与签收）
    handovers: require('./handover').listHandovers(),
    // 定时走行计划：全部计划（值班台查看/终止）+ 活动计划按实例索引
    movementPlans: require('./movement-plan').listPlans(),
    activeMovementPlans: require('./movement-plan').activeByInstance(),
    // 学员考核：当前进行中考核 + 最近若干场（管理台/值班台显示进度与结果）
    exams: require('./exam').getStateSummary()
  };
}

/** 当前请求上下文的站场信息；脚本/测试等无上下文场景返回 null */
function currentYardInfo() {
  const { currentYardId } = require('./db');
  const id = currentYardId();
  try {
    const y = require('./yards').getYard(id);
    if (!y) return null;
    return {
      id: y.id, name: y.name, isOriginal: y.isOriginal, kind: y.kind,
      status: y.status, paused: y.paused, broken: !!y.broken,
      pausedBy: y.pausedBy, pausedAt: y.pausedAt,
      resumedBy: y.resumedBy, resumedAt: y.resumedAt,
      brokenReason: y.brokenReason || null
    };
  } catch (_) {
    // yards 表不可用等极端场景不阻塞状态读取
    return { id, name: id === 1 ? '原站场' : `#${id}`, isOriginal: id === 1, kind: id === 1 ? 'original' : 'copy' };
  }
}

/**
 * 状态变化后先复核临时封锁（待生效→已生效），再触发等待申请兑现扫描。
 * 懒加载以避免循环依赖；复核/兑现不应影响已成功的主操作，异常仅记录日志。
 */
function triggerWaitingSweep(reason) {
  try {
    require('./blockade').refreshBlockadeStates(reason);
  } catch (e) {
    console.error('[blockade] 封锁状态复核失败:', e);
  }
  try {
    require('./waiting').sweepFulfillments(reason);
  } catch (e) {
    console.error('[waiting] 兑现扫描失败:', e);
  }
}

module.exports = {
  InterlockError,
  checkOpen,
  openRoute,
  openRouteInTxn,
  moveSwitch,
  setSectionState,
  submitSectionEvent,
  submitSectionEventInTxn,
  releaseInstance,
  getState,
  getInstanceDetail,
  triggerWaitingSweep
};
