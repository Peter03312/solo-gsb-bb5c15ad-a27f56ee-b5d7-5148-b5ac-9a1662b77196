'use strict';

/**
 * 等待申请（排路等待）。
 *
 * 语义（与需求一一对应）：
 *  - 值班员可按进路编号 + 所选道岔位置提交等待申请；申请本身不预锁任何资源。
 *  - 提交时，以及区段状态变化、道岔扳动、进路解除、服务重启后，自动尝试兑现。
 *  - 兑现必须在同一事务内重新执行现有开放校验与锁闭（复用
 *    interlocking.openRouteInTxn）；区段未知/占用、道岔实际位置不符、
 *    他路锁闭时继续等待，阻断原因刷新。
 *  - 顺序：共享区段或道岔的等待申请按提交顺序排队，仍有效的前项未兑现时
 *    后项不得越过；资源互不相交的申请可以先兑现。
 *  - 重复触发不会产生多个进路实例（waiting_applications.instance_id 唯一索引
 *    + 单次扫描内每个申请只尝试一次）。
 *  - 进路定义变更/删除使相关申请失效并写明原因；申请人退出、管理员重置推演
 *    撤销等待申请。
 *
 * 实现：
 *  - 整个扫描包在单个顶层事务内；对每条申请用 SAVEPOINT 尝试兑现，
 *    失败仅回滚该次尝试（不留下实例/部分锁定），随后把它占有的资源带入
 *    "前项占用集"以阻止后项越过。
 */

const { getDb } = require('./db');
const inter = require('./interlocking');
const { InterlockError } = require('./interlocking');

/* ------------------------------ 工具与校验 ------------------------------ */

function parsePositions(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

function normalizePositions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    out[String(k)] = String(v).toUpperCase();
  }
  return out;
}

function routeResourceKeys(routeId) {
  const db = getDb();
  const sections = db.prepare(
    `SELECT section_id FROM route_steps WHERE route_id=? ORDER BY step_order`
  ).all(routeId).map((r) => 'section:' + r.section_id);
  const switches = db.prepare(
    `SELECT switch_id FROM route_switch_reqs WHERE route_id=?`
  ).all(routeId).map((r) => 'switch:' + r.switch_id);
  return { sections, switches, all: [...sections, ...switches] };
}

/**
 * 提交前静态校验（不涉及瞬时占用/位置/锁状态，那些只决定能否兑现）。
 * 未知进路、缺失或不符定义的道岔选择一律拒绝。
 * @returns {{positions: Object}} 或 throw InterlockError
 */
function validateSubmission(routeId, rawPositions) {
  const db = getDb();
  const route = db.prepare(`SELECT id FROM routes WHERE id=?`).get(routeId);
  if (!route) throw new InterlockError(404, 'ROUTE_NOT_FOUND', `进路 ${routeId} 不存在`);

  const steps = db.prepare(`SELECT section_id FROM route_steps WHERE route_id=?`).all(routeId);
  if (steps.length === 0) {
    throw new InterlockError(400, 'EMPTY_ROUTE', `进路 ${routeId} 未定义区段，不能提交等待申请`);
  }
  for (const s of steps) {
    if (!db.prepare(`SELECT 1 FROM sections WHERE id=?`).get(s.section_id)) {
      throw new InterlockError(400, 'SECTION_MISSING',
        `不能提交：进路 ${routeId} 定义中的区段 ${s.section_id} 不存在，请通知管理员检查`);
    }
  }

  const reqs = db.prepare(
    `SELECT switch_id, req_position FROM route_switch_reqs WHERE route_id=?`
  ).all(routeId);
  const positions = normalizePositions(rawPositions);

  for (const r of reqs) {
    const sw = db.prepare(`SELECT 1 FROM switches WHERE id=?`).get(r.switch_id);
    if (!sw) {
      throw new InterlockError(400, 'SWITCH_MISSING',
        `不能提交：进路 ${routeId} 定义中的道岔 ${r.switch_id} 不存在，请通知管理员检查`);
    }
    const chosen = positions[r.switch_id];
    if (!chosen) {
      throw new InterlockError(400, 'SWITCH_NOT_CHOSEN',
        `不能提交：道岔 ${r.switch_id} 未选择所需位置（进路要求 ${r.req_position}）`);
    }
    if (!['N', 'R'].includes(chosen)) {
      throw new InterlockError(400, 'BAD_POSITION',
        `不能提交：道岔 ${r.switch_id} 选择位置 ${positions[r.switch_id]} 非法（只能是 N 或 R）`);
    }
    if (chosen !== r.req_position) {
      throw new InterlockError(409, 'SWITCH_POSITION_MISMATCH',
        `不能提交：道岔 ${r.switch_id} 所选位置 ${chosen} 与进路要求 ${r.req_position} 不符`);
    }
  }

  // 不符定义的"多余选择"：进路不要求的道岔也必须拒绝
  const reqIds = new Set(reqs.map((r) => r.switch_id));
  for (const sid of Object.keys(positions)) {
    if (!reqIds.has(sid)) {
      throw new InterlockError(400, 'SWITCH_NOT_IN_ROUTE',
        `不能提交：道岔 ${sid} 不属于进路 ${routeId} 的定义，选择与进路定义不符`);
    }
  }

  return { positions };
}

/* -------------------------------- 提交 -------------------------------- */

/**
 * 提交等待申请：校验通过即入库等待，立即自动尝试兑现一次。
 * @returns {Object} 申请详情（含本次兑现结果）
 */
function submitApplication(routeId, rawPositions, applicant) {
  const db = getDb();
  const { positions } = validateSubmission(routeId, rawPositions);

  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO waiting_applications(route_id, applicant, switch_positions, status)
       VALUES(?, ?, ?, 'waiting')`
    ).run(routeId, applicant, JSON.stringify(positions));
    return info.lastInsertRowid;
  })();

  sweepFulfillments('submit');
  return getApplication(id);
}

/* -------------------------------- 撤销 -------------------------------- */

/**
 * 撤销等待申请。仅申请人本人、且申请仍在等待中时允许。
 */
function cancelApplication(applicationId, clientName) {
  const db = getDb();
  const app = db.prepare(`SELECT * FROM waiting_applications WHERE id=?`).get(applicationId);
  if (!app) throw new InterlockError(404, 'WAITING_NOT_FOUND', `等待申请 ${applicationId} 不存在`);
  if (app.applicant !== clientName) {
    throw new InterlockError(403, 'NOT_OWNER',
      `不能撤销：等待申请 #${applicationId} 的申请人为 ${app.applicant}，只能由本人撤销`);
  }
  if (app.status !== 'waiting') {
    const map = { fulfilled: '已兑现', cancelled: '已撤销', invalid: '已失效' };
    throw new InterlockError(409, 'WAITING_NOT_ACTIVE',
      `不能撤销：等待申请 #${applicationId} 已${map[app.status] || app.status}，不能再撤销`);
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE waiting_applications SET status='cancelled', end_reason='申请人主动撤销',
              ended_at=datetime('now') WHERE id=?`
    ).run(applicationId);
  })();
  // 前项撤销后，后项可能满足兑现条件
  sweepFulfillments('cancelled');
  return getApplication(applicationId);
}

/**
 * 申请人退出登录：撤销其全部未兑现申请（与主动撤销路径区分，写明原因）。
 * 在鉴权路由中调用。
 */
function cancelByApplicant(applicant, reason, options = {}) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE waiting_applications SET status='cancelled', end_reason=?,
              ended_at=datetime('now')
        WHERE applicant=? AND status='waiting'`
    ).run(reason || '申请人退出登录，等待申请撤销', applicant);
  })();
  if (!options.skipSweep) sweepFulfillments('applicant_logout');
}

/* --------------------------- 定义变更 / 管理员重置 --------------------------- */

/**
 * 进路定义被修改：该进路全部等待中的申请失效（道岔位置快照可能已不适用）。
 * 应在管理员修改进路的事务内调用（同一事务）。
 */
function invalidateByRouteChange(routeId, reasonText) {
  getDb().prepare(
    `UPDATE waiting_applications SET status='invalid', end_reason=?, ended_at=datetime('now')
      WHERE route_id=? AND status='waiting'`
  ).run(reasonText || `进路 ${routeId} 定义已变更，原等待申请失效`, routeId);
}

/**
 * 进路被删除：相关等待申请失效并说明原因（应在管理员删除进路的事务内调用，
 * 即 DELETE FROM routes 之后）。
 *
 * route_instances.route_id 对 routes 是普通外键（无级联，且已兑现实例要保留
 * 供复盘）；这里对"等待中"（没有实例）的申请把 route_id 解除为对已删进路的
 * 文本快照，避免悬空外键阻止进路删除；失效原因中仍保留原进路编号。
 * 已兑现申请的 route_id 必须保留（与 route_instances 外键一致）。
 */
function invalidateByRouteDelete(routeId) {
  getDb().prepare(
    `UPDATE waiting_applications
        SET status='invalid',
            route_id='(deleted) ' || route_id,
            end_reason=?, ended_at=datetime('now')
      WHERE route_id=? AND status='waiting'`
  ).run(`进路 ${routeId} 已被删除，等待申请失效`, routeId);
}

/**
 * 管理员重置推演：撤销全部未兑现等待申请。应在重置事务内调用。
 */
function cancelAllByReset(reasonText) {
  getDb().prepare(
    `UPDATE waiting_applications SET status='cancelled', end_reason=?, ended_at=datetime('now')
      WHERE status='waiting'`
  ).run(reasonText || '管理员重置推演，全部等待申请撤销');
}

/* ------------------------------ 兑现扫描 ------------------------------ */

/**
 * 按提交顺序扫描全部等待中的申请，尝试兑现。整个过程在单个顶层事务内：
 *  - 定义已失效（进路/区段/道岔缺失、道岔要求与申请快照不符）→ 标记 invalid；
 *  - 与仍在等待且更靠前的申请共享资源 → 不得越过，记录"前项未兑现"并把本
 *    申请的资源并入占用集；
 *  - 其余申请：在 SAVEPOINT 内重新执行现有开放校验+锁闭；成功即 fulfilled
 *    并写回实例编号；失败回滚到 SAVEPOINT，按最新阻断原因继续等待，同时把
 *    资源并入占用集。
 * 资源互不相交的申请互不阻塞，可在同一次扫描中先后兑现。
 *
 * @returns {{attempted:number, fulfilled:Array<number>}}
 */
function sweepFulfillments(reason) {
  const db = getDb();
  const fulfilled = [];

  // SAVEPOINT 包装（在外层扫描事务内调用时自动转为 SAVEPOINT/RELEASE/ROLLBACK TO）
  const attempt = db.transaction((app) => {
    const positions = parsePositions(app.switch_positions);
    const instanceId = inter.openRouteInTxn(app.route_id, positions, app.applicant, 'waiting');
    db.prepare(
      `UPDATE waiting_applications SET status='fulfilled', instance_id=?,
              block_reasons='[]', blocked_by=NULL, ended_at=datetime('now')
        WHERE id=?`
    ).run(instanceId, app.id);
    // 审计：等待申请兑现（系统按序自动兑现）。与兑现同事务：
    // SAVEPOINT 回滚（兑现失败）时本条一并回滚，不产生流水。
    const detail = inter.getInstanceDetail(instanceId);
    require('./audit').recordWaitingFulfilledInTxn({
      waitingId: app.id,
      instanceId,
      routeId: app.route_id,
      actor: app.applicant,
      before: { waitingStatus: 'waiting', instanceId: null },
      after: {
        waitingStatus: 'fulfilled',
        instanceId,
        instanceStatus: 'open',
        signalState: 'green',
        lockedSections: detail.lockedSections,
        lockedSwitches: detail.lockedSwitches
      }
    });
    fulfilled.push(app.id);
  });

  const run = db.transaction(() => {
    const waiting = db.prepare(
      `SELECT * FROM waiting_applications WHERE status='waiting' ORDER BY id`
    ).all();

    // 仍在等待（本轮被拦截或兑现条件不满足）的申请占有的资源
    // key: 'section:1' / 'switch:SW7' -> 最早占住它的申请编号
    const blockedResources = new Map();

    for (const app of waiting) {
      // 1) 定义一致性校验（进路/区段/道岔是否仍存在；申请快照是否仍符合定义）
      const invalidReason = definitionInvalidationReason(app);
      if (invalidReason) {
        db.prepare(
          `UPDATE waiting_applications SET status='invalid', end_reason=?, ended_at=datetime('now')
            WHERE id=?`
        ).run(invalidReason, app.id);
        continue;
      }

      const keys = routeResourceKeys(app.route_id);

      // 2) 前项顺序约束：共享资源且仍有效的前项未兑现 → 不得越过
      const blockers = [];
      for (const key of keys.all) {
        const holder = blockedResources.get(key);
        if (holder && holder !== app.id && !blockers.includes(holder)) blockers.push(holder);
      }
      if (blockers.length) {
        const overlap = keys.all
          .filter((k) => blockers.includes(blockedResources.get(k)))
          .map((k) => `${kindOf(k)} ${k.split(':')[1]}`);
        db.prepare(
          `UPDATE waiting_applications SET block_reasons=?, blocked_by=? WHERE id=?`
        ).run(JSON.stringify([
          `前项等待申请 #${blockers.join('、#')} 尚未兑现，共享 ${[...new Set(overlap)].join('、')}，按提交顺序不得越过`
        ]), blockers.join(','), app.id);
        for (const k of keys.all) if (!blockedResources.has(k)) blockedResources.set(k, app.id);
        continue;
      }

      // 3) 无前项拦截：在 SAVEPOINT 内重新执行现有开放校验与锁闭
      try {
        attempt(app);
        // 已兑现：资源由 route_locks 实际锁定，后项的 openRouteInTxn 会自行撞到锁
      } catch (e) {
        // 仅回滚本次尝试；按最新原因继续等待
        const reasonText = e && e.message ? e.message : String(e);
        db.prepare(
          `UPDATE waiting_applications SET block_reasons=?, blocked_by=NULL WHERE id=?`
        ).run(JSON.stringify([reasonText]), app.id);
        for (const k of keys.all) if (!blockedResources.has(k)) blockedResources.set(k, app.id);
      }
    }
  });

  run();
  if (fulfilled.length) {
    console.log(`[waiting] 自动兑现扫描（${reason || 'trigger'}）兑现申请 #${fulfilled.join('、#')}`);
  }
  return { attempted: true, fulfilled };
}

function kindOf(key) {
  return key.startsWith('section:') ? '区段' : '道岔';
}

/**
 * 定义是否已使申请失效：进路/区段/道岔缺失，或进路道岔要求与申请时快照不符。
 * @returns {string|null} 失效原因；null 表示仍有效
 */
function definitionInvalidationReason(app) {
  const db = getDb();
  const positions = parsePositions(app.switch_positions);

  if (!db.prepare(`SELECT 1 FROM routes WHERE id=?`).get(app.route_id)) {
    return `进路 ${app.route_id} 已被删除，等待申请失效`;
  }
  const steps = db.prepare(`SELECT section_id FROM route_steps WHERE route_id=?`).all(app.route_id);
  if (steps.length === 0) return `进路 ${app.route_id} 定义已变更（无区段），原等待申请失效`;
  for (const s of steps) {
    if (!db.prepare(`SELECT 1 FROM sections WHERE id=?`).get(s.section_id)) {
      return `进路 ${app.route_id} 定义已变更：区段 ${s.section_id} 已不存在，原等待申请失效`;
    }
  }

  const reqs = db.prepare(
    `SELECT switch_id, req_position FROM route_switch_reqs WHERE route_id=?`
  ).all(app.route_id);
  const reqIds = new Set(reqs.map((r) => r.switch_id));
  for (const r of reqs) {
    if (!db.prepare(`SELECT 1 FROM switches WHERE id=?`).get(r.switch_id)) {
      return `进路 ${app.route_id} 定义已变更：道岔 ${r.switch_id} 已不存在，原等待申请失效`;
    }
    if (positions[r.switch_id] !== r.req_position) {
      return `进路 ${app.route_id} 的道岔 ${r.switch_id} 要求位置已变更为 ${r.req_position}，与申请时选择 ${positions[r.switch_id]} 不符，申请失效`;
    }
  }
  for (const sid of Object.keys(positions)) {
    if (!reqIds.has(sid)) {
      return `进路 ${app.route_id} 定义已变更：道岔 ${sid} 已不在进路定义中，原等待申请失效`;
    }
  }
  return null;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToApplication(row, queueOrder) {
  const instance = row.instance_id
    ? inter.getInstanceDetail(row.instance_id, true)
    : null;
  return {
    id: row.id,
    seq: row.id,                       // 申请编号即提交序号（自增，按提交顺序）
    routeId: row.route_id,
    applicant: row.applicant,
    switchPositions: parsePositions(row.switch_positions),
    status: row.status,                // waiting/fulfilled/cancelled/invalid
    instanceId: row.instance_id,
    instance: instance ? {
      id: instance.id,
      routeId: instance.routeId,
      openedBy: instance.openedBy,
      status: instance.status,
      signalState: instance.signalState
    } : null,
    blockReasons: parseReasons(row.block_reasons),
    blockedBy: row.blocked_by ? row.blocked_by.split(',').map(Number) : [],
    endReason: row.end_reason,
    position: row.status === 'waiting'
      ? computeQueuePosition(row, queueOrder) : null,
    createdAt: row.created_at,
    endedAt: row.ended_at
  };
}

function parseReasons(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/**
 * 顺位：对每条等待中的申请，统计提交更早、且与其共享区段/道岔、仍在等待的
 * 申请数 + 1。资源互不相交的申请不参与顺位（可先兑现）。
 * 顺位随兑现/撤销动态前移。
 */
function computeQueuePosition(row, queueOrder) {
  const myKeys = new Set(queueOrder.keysOf(row.id));
  let n = 0;
  for (const other of queueOrder.waiting) {
    if (other.id >= row.id) break;
    if (queueOrder.keysOf(other.id).some((k) => myKeys.has(k))) n++;
  }
  return n + 1;
}

function buildQueueOrder() {
  const db = getDb();
  const waiting = db.prepare(
    `SELECT id, route_id FROM waiting_applications WHERE status='waiting' ORDER BY id`
  ).all();
  const cache = new Map();
  return {
    waiting,
    keysOf(id) {
      if (!cache.has(id)) {
        const w = waiting.find((x) => x.id === id);
        cache.set(id, w ? routeResourceKeys(w.route_id).all : []);
      }
      return cache.get(id);
    }
  };
}

function getApplication(id) {
  const row = getDb().prepare(`SELECT * FROM waiting_applications WHERE id=?`).get(id);
  if (!row) return null;
  return rowToApplication(row, buildQueueOrder());
}

/**
 * 申请列表：等待中按编号升序在前，已结束（兑现/撤销/失效）按编号倒序在后。
 * @param {{applicant?:string, status?:string}} filter
 */
function listApplications(filter = {}) {
  const db = getDb();
  let rows;
  if (filter.applicant) {
    rows = db.prepare(
      `SELECT * FROM waiting_applications WHERE applicant=?
        ORDER BY CASE status WHEN 'waiting' THEN 0 ELSE 1 END,
                 CASE status WHEN 'waiting' THEN id ELSE -id END`
    ).all(filter.applicant);
  } else {
    rows = db.prepare(
      `SELECT * FROM waiting_applications
        ORDER BY CASE status WHEN 'waiting' THEN 0 ELSE 1 END,
                 CASE status WHEN 'waiting' THEN id ELSE -id END`
    ).all();
  }
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  const order = buildQueueOrder();
  return rows.map((r) => rowToApplication(r, order));
}

module.exports = {
  submitApplication,
  cancelApplication,
  cancelByApplicant,
  invalidateByRouteChange,
  invalidateByRouteDelete,
  cancelAllByReset,
  sweepFulfillments,
  getApplication,
  listApplications
};
