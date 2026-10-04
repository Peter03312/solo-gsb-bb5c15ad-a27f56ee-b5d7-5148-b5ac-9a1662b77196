'use strict';

/**
 * 进路延时取消申请。
 *
 * 语义（与需求一一对应）：
 *  - 值班员可对【已开放且尚无走行占用记录】的进路实例申请延时取消；
 *    申请立即令入口信号回红，原区段锁与道岔锁继续保留（route_locks 不动），
 *    等待中的等待申请不预锁资源、也不会被提前兑现（锁仍在，openRouteInTxn 会撞到锁）。
 *  - 保护时长由管理员设置（正整数秒）；申请落库时把时长与最早解除时刻一起快照，
 *    之后管理员修改设置不追改已有申请。
 *  - 到期处理（processOneInTxn，在单个 SQLite 事务内重查）：
 *      1) 实例不存在 / 已非 open（例如已被正常走行解除）→ 直接标记终态，不动锁；
 *      2) 存在走行占用事件（section_events 中 occupy）→ 终止申请，锁闭保留；
 *      3) 沿途任一区段非空闲（占用/未知）→ 终止申请，锁闭保留；
 *      4) 全部满足 → 解除进路：实例 released、信号红、删除全部锁；随后由外层
 *         触发等待申请兑现扫描，等待申请才有机会按序兑现。
 *  - 保护期内收到该实例的首段走行占用事件：按既有走行规则照常受理（同一事务内）
 *    并把 pending 申请终止（abortPendingByOccupyInTxn），信号保持红、锁闭保留。
 *  - 重复申请：同实例已有 pending 时返回原申请，不缩短期限、不产生第二笔
 *    （另有部分唯一索引 idx_cancel_pending_instance 兜底）。
 *  - 服务重启：定时扫描进程重启，到期/未到期申请继续按 release_at 处理；
 *    管理员重置推演删除进路实例时申请经外键级联一并清除。
 *
 * 时间全部存 epoch 毫秒整数（不依赖 datetime('now') 文本，重启/跨库也能正确比较）。
 */

const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

const DEFAULT_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 7 * 24 * 3600; // 设置上限 7 天
const META_KEY = 'cancel_protection_seconds';

let timer = null;

/* ------------------------------ 保护时长设置 ------------------------------ */

/** 当前保护时长（正整数秒）。仅读 meta，未设置时取默认值。 */
function getProtectionSeconds() {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key=?`).get(META_KEY);
  const n = row ? Number(row.value) : DEFAULT_DURATION_SECONDS;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_DURATION_SECONDS;
}

/** 管理员设置保护时长；必须是 1~MAX 的正整数，只影响之后新申请。 */
function setProtectionSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DURATION_SECONDS) {
    throw new InterlockError(400, 'BAD_PROTECTION_SECONDS',
      `延时取消保护时长必须是 1~${MAX_DURATION_SECONDS} 之间的正整数秒（收到 ${seconds}）`);
  }
  getDb().prepare(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(META_KEY, String(n));
  return getProtectionSeconds();
}

/* -------------------------------- 申请 -------------------------------- */

/**
 * 申请延时取消。成功（新建或命中已有 pending）返回申请详情。
 * @returns {{request:Object, created:boolean}} created=false 表示重复申请命中原记录
 */
function requestCancellation(instanceId, clientName) {
  const db = getDb();
  const now = require('./pause').effectiveNow();
  const run = db.transaction(() => {
    const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(instanceId);
    if (!inst || inst.status !== 'open') {
      throw new InterlockError(404, 'INSTANCE_NOT_FOUND',
        `进路实例 ${instanceId} 不存在或已解除，不能申请延时取消`);
    }

    // 重复申请：返回原 pending，不缩短期限、不产生第二笔
    const existing = db.prepare(
      `SELECT * FROM cancellation_applications WHERE instance_id=? AND status='pending'`
    ).get(instanceId);
    if (existing) return { row: existing, created: false };

    // 尚无走行占用记录（任一 occupy 事件都视为车列已进入）
    const occ = db.prepare(
      `SELECT 1 FROM section_events WHERE instance_id=? AND action='occupy' LIMIT 1`
    ).get(instanceId);
    if (occ) {
      throw new InterlockError(409, 'CANCEL_OCCUPANCY_EXISTS',
        `进路实例 ${instanceId} 已有走行占用记录（车列已进入），不能申请延时取消；` +
        `请按走行事件逐段解锁，末段清空后自动解除`,
        { instanceId });
    }

    const seconds = getProtectionSeconds();
    let info;
    try {
      info = db.prepare(
        `INSERT INTO cancellation_applications
           (instance_id, applicant, status, duration_seconds, requested_at, release_at)
         VALUES(?, ?, 'pending', ?, ?, ?)`
      ).run(instanceId, clientName, seconds, now, now + seconds * 1000);
    } catch (e) {
      // 并发重复申请撞到部分唯一索引：返回已有 pending（幂等）
      if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        const row2 = db.prepare(
          `SELECT * FROM cancellation_applications WHERE instance_id=? AND status='pending'`
        ).get(instanceId);
        if (row2) return { row: row2, created: false };
      }
      throw e;
    }

    // 立即令入口信号回红（即便已是红也无副作用）；区段/道岔锁原样保留
    db.prepare(`UPDATE route_instances SET signal_state='red' WHERE id=?`).run(instanceId);

    // 该实例若有活动定时走行计划：信号已回红、进入延时取消流程，计划前提失效，
    // 同一事务内停止计划（人工/取消结果保留，不让计划随后继续注入）。
    require('./movement-plan').abortActiveByCancellationInTxn(instanceId);

    return {
      row: db.prepare(`SELECT * FROM cancellation_applications WHERE id=?`).get(info.lastInsertRowid),
      created: true
    };
  });

  const { row, created } = run();
  return { request: rowToRequest(row), created };
}

/* ------------------------ 首段占用：保护期内终止申请 ------------------------ */

/**
 * 进路首段占用事件被受理时（在走行事件同一事务内）调用：
 * 若该实例有 pending 的延时取消申请，标记为 aborted，保留锁闭并写明原因。
 * 返回被终止的申请编号（无则 null）。
 */
function abortPendingByOccupyInTxn(instanceId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM cancellation_applications WHERE instance_id=? AND status='pending'`
  ).get(instanceId);
  if (!row) return null;
  db.prepare(
    `UPDATE cancellation_applications SET status='aborted', processed_at=?,
            end_reason='保护期内收到首段走行占用事件，取消申请终止；区段与道岔锁继续保留，按正常走行逐段解锁'
      WHERE id=?`
  ).run(Date.now(), row.id);
  return row.id;
}

/* ------------------------------ 到期处理 ------------------------------ */

/**
 * 处理单个到期申请（事务体）：在同一事务内重查全部解除条件。
 * @param {string} trigger 到期处理来源（timer/server_start/yard_copied 等，审计用）
 * @returns {{released:boolean, aborted:boolean, reason?:string}}
 */
function processOneInTxn(row, trigger = 'timer') {
  const db = getDb();
  const now = require('./pause').effectiveNow();

  const inst = db.prepare(`SELECT * FROM route_instances WHERE id=?`).get(row.instance_id);

  // 1) 实例不存在：历史记录随级联已清除，理论不可达，防御性兜底
  if (!inst) {
    db.prepare(
      `UPDATE cancellation_applications SET status='aborted', processed_at=?,
              end_reason='进路实例已不存在' WHERE id=?`
    ).run(now, row.id);
    return { aborted: true, reason: '进路实例已不存在' };
  }

  // 2) 实例已非 open（已被正常走行/人工解除）：仅收尾，不再动锁
  if (inst.status !== 'open') {
    db.prepare(
      `UPDATE cancellation_applications SET status='released', processed_at=?,
              end_reason='进路在到期处理前已解除（走行/人工解除）' WHERE id=?`
    ).run(now, row.id);
    // 审计：申请收尾为已解除（进路此前已由走行/人工解除并另行记过流水，
    // 本条只描述取消申请本身的状态变化；already 标记不重复描述进路）
    require('./audit').recordCancellationReleasedInTxn({
      cancellationId: row.id, instanceId: row.instance_id, routeId: inst.route_id,
      already: true,
      reason: '进路在到期处理前已解除（走行/人工解除），延时取消申请收尾为已解除',
      before: { cancellationStatus: 'pending', instanceStatus: inst.status },
      after: { cancellationStatus: 'released', instanceStatus: inst.status }
    });
    return { released: true, already: true };
  }

  // 3) 保护期内出现走行占用记录（首段进入时通常已被 abortPendingByOccupyInTxn
  //    终止；此处对历史/边界情况再查一遍）→ 终止，锁闭保留
  const occ = db.prepare(
    `SELECT section_id FROM section_events WHERE instance_id=? AND action='occupy' LIMIT 1`
  ).get(row.instance_id);
  if (occ) {
    const reason = `保护期内进路出现走行占用记录（首段 ${occ.section_id}），车列已进入，延时取消终止，锁闭保留`;
    db.prepare(
      `UPDATE cancellation_applications SET status='aborted', processed_at=?, end_reason=? WHERE id=?`
    ).run(now, reason, row.id);
    return { aborted: true, reason };
  }

  // 4) 沿途区段必须均空闲（含首段）；任一占用/未知（独立置占用等）→ 终止，锁闭保留
  const steps = db.prepare(
    `SELECT s.section_id, sec.occ_state
       FROM route_steps s JOIN sections sec ON sec.id=s.section_id
      WHERE s.route_id=? ORDER BY s.step_order`
  ).all(inst.route_id);
  if (steps.length === 0) {
    const reason = `到期核验未通过：进路 ${inst.route_id} 已无区段定义，解除条件不满足，` +
      '延时取消终止；锁闭保留';
    db.prepare(
      `UPDATE cancellation_applications SET status='aborted', processed_at=?, end_reason=? WHERE id=?`
    ).run(now, reason, row.id);
    return { aborted: true, reason };
  }
  const bad = steps.find((s) => s.occ_state !== 'free');
  if (bad) {
    const stateText = bad.occ_state === 'unknown' ? '占用状态未知（按占用处理）' : '被占用';
    const reason = `到期核验未通过：沿途区段 ${bad.section_id} 当前${stateText}，进路解除条件不满足，` +
      `延时取消终止；区段与道岔锁继续保留，可继续走行或重新申请延时取消`;
    db.prepare(
      `UPDATE cancellation_applications SET status='aborted', processed_at=?, end_reason=? WHERE id=?`
    ).run(now, reason, row.id);
    return { aborted: true, reason };
  }

  // 5) 全部满足：同一事务内解除进路（信号红、删除全部区段/道岔锁）
  const lockedSections = db.prepare(
    `SELECT resource_id FROM route_locks WHERE instance_id=? AND resource_type='section' ORDER BY id`
  ).all(inst.id).map((r) => r.resource_id);
  const lockedSwitches = db.prepare(
    `SELECT resource_id FROM route_locks WHERE instance_id=? AND resource_type='switch' ORDER BY id`
  ).all(inst.id).map((r) => r.resource_id);
  db.prepare(
    `UPDATE route_instances SET status='released', signal_state='red', released_at=datetime('now')
      WHERE id=?`
  ).run(inst.id);
  db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(inst.id);
  db.prepare(
    `UPDATE cancellation_applications SET status='released', processed_at=?,
            end_reason='保护期满且核验通过（进路仍开放、无走行占用、沿途区段均空闲），进路已解除'
      WHERE id=?`
  ).run(now, row.id);
  // 审计：延时取消核验通过解除进路（系统来源，与解除同事务）。
  // 进路解除不再另写 route_released，由本条覆盖。
  require('./audit').recordCancellationReleasedInTxn({
    cancellationId: row.id, instanceId: inst.id, routeId: inst.route_id,
    already: false,
    reason: `保护期满且核验通过（${trigger}），延时取消解除进路`,
    before: {
      cancellationStatus: 'pending',
      instanceStatus: 'open',
      signalState: inst.signal_state,
      lockedSections,
      lockedSwitches
    },
    after: {
      cancellationStatus: 'released',
      instanceStatus: 'released',
      signalState: 'red',
      lockedSections: [],
      lockedSwitches: []
    }
  });
  return { released: true };
}

/**
 * 扫描全部到期 pending 申请并处理。每笔在独立事务内重查，互不影响；
 * 解除成功后于事务外触发等待申请兑现（兑现失败不影响已解除结果）。
 * @returns {{released:Array<number>, aborted:Array<number>}} 申请编号列表
 */
function processDue(trigger = 'timer') {
  const db = getDb();
  const now = require('./pause').effectiveNow();
  const due = db.prepare(
    `SELECT * FROM cancellation_applications WHERE status='pending' AND release_at<=? ORDER BY release_at, id`
  ).all(now);

  const released = [];
  const aborted = [];
  for (const row of due) {
    const txn = db.transaction((r) => processOneInTxn(r, trigger));
    let res;
    try {
      res = txn(row);
    } catch (e) {
      // 单条处理异常不应拖垮整个扫描：记录日志，下轮再试（仍 pending）
      console.error(`[cancel] 申请 #${row.id} 到期处理失败，下轮重试:`, e);
      continue;
    }
    if (res.released) released.push(row.id);
    if (res.aborted) aborted.push(row.id);
  }

  if (released.length) {
    console.log(`[cancel] 延时取消到期核验通过、进路解除（${trigger}）：申请 #${released.join('、#')}`);
    try {
      require('./interlocking').triggerWaitingSweep('cancellation_released');
    } catch (e) {
      console.error('[cancel] 解除后等待兑现扫描失败:', e);
    }
  }
  if (aborted.length) {
    console.log(`[cancel] 延时取消到期核验未通过、申请终止（${trigger}）：申请 #${aborted.join('、#')}`);
  }
  return { released, aborted };
}

/* ------------------------------ 定时与重启 ------------------------------ */

/**
 * 扫描一次全部站场：在各站场自己的上下文/事务内按 release_at 复核。
 * 副本复制来的延时取消沿用原 release_at（不重新计时）；到期则按该副本
 * 自身状态核验解除或终止，跨站场互不影响、不会重复兑现。
 */
function processDueAllYards(trigger) {
  const { withYard } = require('./db');
  let yardsList;
  try {
    yardsList = require('./yards').listYards();
  } catch (e) {
    yardsList = null;
  }
  if (!yardsList) {
    // yards 注册表尚不可用（脚本直调场景）：直接处理当前连接
    return processDue(trigger);
  }
  const released = [];
  const aborted = [];
  for (const y of yardsList) {
    if (y.broken) continue;                    // 损坏隔离副本不参与任何扫描
    if (require('./pause').isPaused(y.id)) continue;
    try {
      const r = withYard(y.id, () => processDue(trigger + `:yard${y.id}`));
      for (const id of r.released) released.push({ yard: y.id, id });
      for (const id of r.aborted) aborted.push({ yard: y.id, id });
    } catch (e) {
      if (require('./recovery').quarantineIfCorrupt(y.id, e)) continue;
      console.error(`[cancel] 站场 ${y.id} 定时扫描失败:`, e);
    }
  }
  return { released, aborted };
}

/**
 * 启动到期扫描定时器（服务启动时调用一次）。
 * 同时立即扫描一次：服务重启期间可能已有申请到期，启动即处理；
 * 按各站场分别复核，复制来的副本不重新计时。
 */
function startScheduler() {
  stopScheduler();
  try {
    const r = processDueAllYards('server_start');
    const rel = r.released.map((x) => `#${x.id}(站场${x.yard})`);
    const abr = r.aborted.map((x) => `#${x.id}(站场${x.yard})`);
    if (rel.length || abr.length) {
      console.log(`[startup] 重启后处理延时取消申请：解除 ${rel.join('、') || '无'}，` +
        `终止 ${abr.join('、') || '无'}`);
    }
  } catch (e) {
    console.error('[startup] 延时取消到期扫描失败:', e);
  }
  timer = setInterval(() => {
    try { processDueAllYards('timer'); } catch (e) { console.error('[cancel] 定时扫描失败:', e); }
  }, 500);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* --------------------------- 管理员重置：一并清除 --------------------------- */

/**
 * 管理员重置推演：清除全部待处理延时取消申请（进路实例随后被删除，
 * 外键级联也会删，这里在同一重置事务内显式清理，保持语义清晰）。
 * 应在管理员重置事务内调用。
 */
function clearAllByReset(reasonText) {
  getDb().prepare(
    `DELETE FROM cancellation_applications WHERE status='pending'`
  ).run();
  return true;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToRequest(row) {
  if (!row) return null;
  const now = require('./pause').effectiveNow();
  return {
    id: row.id,
    instanceId: row.instance_id,
    applicant: row.applicant,
    status: row.status,                  // pending / released / aborted
    durationSeconds: row.duration_seconds,
    requestedAt: row.requested_at,
    releaseAt: row.release_at,
    processedAt: row.processed_at,
    remainingMs: row.status === 'pending' ? Math.max(0, row.release_at - now) : 0,
    overDue: row.status === 'pending' ? row.release_at <= now : false,
    endReason: row.end_reason
  };
}

function getRequest(id) {
  return rowToRequest(getDb().prepare(`SELECT * FROM cancellation_applications WHERE id=?`).get(id));
}

/**
 * 申请列表：pending 在前（按最早解除时刻升序），终态在后（按处理时刻倒序）。
 * @param {{applicant?:string, status?:string}} filter
 */
function listRequests(filter = {}) {
  const db = getDb();
  let rows;
  if (filter.applicant) {
    rows = db.prepare(
      `SELECT * FROM cancellation_applications WHERE applicant=?
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                 CASE status WHEN 'pending' THEN release_at ELSE -COALESCE(processed_at,0) END`
    ).all(filter.applicant);
  } else {
    rows = db.prepare(
      `SELECT * FROM cancellation_applications
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                 CASE status WHEN 'pending' THEN release_at ELSE -COALESCE(processed_at,0) END`
    ).all();
  }
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.map(rowToRequest);
}

/** 全部 pending（供 /api/state 快照下发，值班台据此显示取消状态与剩余时间） */
function pendingByInstance() {
  const rows = getDb().prepare(
    `SELECT * FROM cancellation_applications WHERE status='pending' ORDER BY release_at, id`
  ).all();
  const map = {};
  for (const r of rows) map[r.instance_id] = rowToRequest(r);
  return map;
}

module.exports = {
  DEFAULT_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  getProtectionSeconds,
  setProtectionSeconds,
  requestCancellation,
  abortPendingByOccupyInTxn,
  processDue,
  startScheduler,
  stopScheduler,
  clearAllByReset,
  getRequest,
  listRequests,
  pendingByInstance
};
