'use strict';

/**
 * 临时封锁（管理员按区段发起）。
 *
 * 语义（与需求一一对应）：
 *  - 管理员按区段编号 + 封锁原因发起，返回申请编号、待生效/已生效状态与原因；
 *    未知区段、空白原因一律拒绝；同一区段存在未结束（待生效/已生效）封锁时，
 *    重复申请返回原申请，不产生第二笔（另有部分唯一索引兜底并发）。
 *  - 申请提交后立即阻止该区段参与新的进路预检、直接开放与等待兑现
 *    （pending 与 active 均阻止；判定在 interlocking.checkOpen / openRouteInTxn
 *    内与既有资源校验同事务执行）；等待申请保留顺位并在阻断原因中显示封锁原因。
 *  - 已开放进路不受封锁影响：原区段锁/道岔锁、走行事件与延时取消规则原样，
 *    不因封锁申请强制解除。
 *  - 状态转换：区段空闲且无进路锁时 pending 自动转 active；占用、未知或仍锁闭
 *    时维持 pending。提交时、走行出清、独立区段状态变化、延时取消到期、进路解除、
 *    服务重启后都会复核（refreshBlockadeStates 读取与开放校验同一份区段占用/
 *    锁闭状态，状态转换与资源检查一致）。
 *  - 管理员可结束 pending/active 封锁；结束后按现有联锁规则重试等待兑现，
 *    不改写区段占用状态。
 *  - 管理员重置推演清除全部封锁记录；服务重启后未结束封锁继续有效并参与复核。
 */

const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

const MAX_REASON_LEN = 200;

/* ------------------------------ 基础查询 ------------------------------ */

/** 区段上未结束（待生效/已生效）的封锁行；无则 undefined */
function unfinishedRow(sectionId) {
  return getDb()
    .prepare(
      `SELECT * FROM blockade_applications
        WHERE section_id=? AND status IN ('pending','active')`
    )
    .get(sectionId);
}

/**
 * 待生效封锁是否满足转已生效条件：区段存在、占用状态为空闲、且无开放进路锁。
 * 与 openRouteInTxn 的区段校验读取同一份 sections.occ_state 与 route_locks，
 * 保证状态转换与资源检查一致。
 */
function canActivate(sectionId) {
  const db = getDb();
  const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(sectionId);
  if (!sec) return false;                    // 区段不存在：维持待生效
  if (sec.occ_state !== 'free') return false; // 占用/未知（按占用）：维持待生效
  const lock = db.prepare(
    `SELECT 1 FROM route_locks l JOIN route_instances i ON i.id=l.instance_id
      WHERE l.resource_type='section' AND l.resource_id=? AND i.status='open' LIMIT 1`
  ).get(sectionId);
  return !lock;                               // 仍锁闭：维持待生效
}

/* ------------------------------ 状态复核 ------------------------------ */

/**
 * 复核全部待生效封锁：区段空闲且无进路锁的转为已生效。
 * 在单个事务内逐条重查，返回本轮转为已生效的申请编号列表。
 */
function refreshBlockadeStates(reason) {
  const db = getDb();
  const activated = [];
  db.transaction(() => {
    const pendings = db.prepare(
      `SELECT id, section_id FROM blockade_applications WHERE status='pending' ORDER BY id`
    ).all();
    for (const b of pendings) {
      if (canActivate(b.section_id)) {
        db.prepare(
          `UPDATE blockade_applications SET status='active', activated_at=datetime('now')
            WHERE id=?`
        ).run(b.id);
        // 审计：待生效→已生效（系统复核，与状态转换同事务）。
        // 没有转换的 pending 不产生条目（未改变状态的扫描不产生新条目）。
        require('./audit').recordBlockadeChangedInTxn({
          blockadeId: b.id,
          sectionId: b.section_id,
          trigger: reason || 'trigger',
          after: { sectionId: b.section_id, status: 'active' }
        });
        activated.push(b.id);
      }
    }
  })();
  if (activated.length) {
    console.log(`[blockade] 封锁复核（${reason || 'trigger'}）：申请 #${activated.join('、#')} 转为已生效`);
  }
  return activated;
}

/* -------------------------------- 发起 -------------------------------- */

/**
 * 发起临时封锁。未知区段 / 空白原因拒绝；同区段未结束封锁重复申请返回原申请。
 * 提交后立即复核一次（区段本已空闲且无锁时直接转为已生效）。
 * @returns {{blockade:Object, created:boolean}} created=false 表示命中已有未结束申请
 */
function submitBlockade(sectionId, rawReason, applicant) {
  const db = getDb();
  const sid = String(sectionId == null ? '' : sectionId).trim();
  const reason = String(rawReason == null ? '' : rawReason).trim();

  if (!reason) {
    throw new InterlockError(400, 'BLOCKADE_REASON_REQUIRED',
      '封锁原因不能为空，请填写发起临时封锁的原因');
  }
  if (reason.length > MAX_REASON_LEN) {
    throw new InterlockError(400, 'BLOCKADE_REASON_TOO_LONG',
      `封锁原因过长（最多 ${MAX_REASON_LEN} 字）`);
  }

  const result = db.transaction(() => {
    const sec = db.prepare(`SELECT id FROM sections WHERE id=?`).get(sid);
    if (!sec) {
      throw new InterlockError(404, 'SECTION_NOT_FOUND',
        `区段 ${sid} 不存在，不能发起临时封锁`, { sectionId: sid });
    }

    // 重复申请：同一区段已有未结束封锁 → 返回原申请，不产生第二笔
    const existing = unfinishedRow(sid);
    if (existing) return { id: existing.id, created: false };

    let info;
    try {
      info = db.prepare(
        `INSERT INTO blockade_applications(section_id, applicant, reason, status)
         VALUES(?, ?, ?, 'pending')`
      ).run(sid, applicant, reason);
    } catch (e) {
      // 并发重复申请撞到部分唯一索引：返回已有未结束申请（幂等）
      if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        const row2 = unfinishedRow(sid);
        if (row2) return { id: row2.id, created: false };
      }
      throw e;
    }
    // 审计：封锁发起（与申请入库同事务；重复申请在上面提前返回，不产生条目）。
    // 提交后若区段空闲会立即复核转已生效，那是另一条 blockade_changed。
    require('./audit').recordBlockadeCreatedInTxn({
      blockadeId: info.lastInsertRowid,
      sectionId: sid,
      actor: applicant,
      status: 'pending',
      reason,
      after: { sectionId: sid, status: 'pending', reason }
    });
    return { id: info.lastInsertRowid, created: true };
  })();

  // 提交后立即复核：区段空闲且无进路锁 → 直接转为已生效
  refreshBlockadeStates('submit');
  // 提交后立即阻止该区段参与等待兑现：扫描一次，使受影响的等待申请
  // 保留顺位并把阻断原因刷新为封锁原因（兑现校验在 openRouteInTxn 内同事务执行）
  try {
    require('./waiting').sweepFulfillments('blockade_submitted');
  } catch (e) {
    console.error('[blockade] 提交后等待兑现扫描失败:', e);
  }
  return { blockade: getBlockade(result.id), created: result.created };
}

/* -------------------------------- 结束 -------------------------------- */

/**
 * 结束待生效/已生效封锁。结束后按现有联锁规则重试等待兑现；
 * 不改写区段占用状态（区段 occupied/unknown/free 原样保留）。
 * @param {string|null} operator 操作人；管理员结束传姓名，区段删除自动结束传 null
 */
function endBlockade(applicationId, operator = '管理员', reasonText) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM blockade_applications WHERE id=?`).get(applicationId);
  if (!row) {
    throw new InterlockError(404, 'BLOCKADE_NOT_FOUND', `封锁申请 ${applicationId} 不存在`);
  }
  if (row.status === 'ended') {
    throw new InterlockError(409, 'BLOCKADE_NOT_ACTIVE',
      `封锁申请 #${applicationId} 已结束，不能重复结束`);
  }
  const fromStatus = row.status;
  db.transaction(() => {
    db.prepare(
      `UPDATE blockade_applications SET status='ended', ended_at=datetime('now'),
              end_reason=? WHERE id=?`
    ).run(reasonText || '管理员结束封锁', applicationId);
    // 审计：封锁结束（与更新同事务；重复结束在上面抛错，不产生条目）
    require('./audit').recordBlockadeEndedInTxn({
      blockadeId: applicationId,
      sectionId: row.section_id,
      actor: operator,
      fromStatus,
      reason: reasonText || '管理员结束封锁',
      before: { sectionId: row.section_id, status: fromStatus }
    });
  })();
  // 封锁解除后，此前被封锁阻断的等待申请可能已满足兑现条件
  try {
    require('./waiting').sweepFulfillments('blockade_ended');
  } catch (e) {
    console.error('[blockade] 结束后等待兑现扫描失败:', e);
  }
  return getBlockade(applicationId);
}

/* --------------------------- 区段删除 / 管理员重置 --------------------------- */

/**
 * 区段被管理员删除：该区段未结束封锁在同一事务内标记结束（保留记录与原因）。
 * 应在管理员删除区段的事务内调用；审计流水同事务写入（系统来源，actor 为
 * 执行删除的管理员、原因标明"区段删除自动结束"）。
 */
function endBySectionDelete(sectionId, operator = '管理员') {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, status FROM blockade_applications
      WHERE section_id=? AND status IN ('pending','active')`
  ).all(sectionId);
  const reason = `区段 ${sectionId} 已被管理员删除，封锁自动结束`;
  for (const row of rows) {
    db.prepare(
      `UPDATE blockade_applications SET status='ended', ended_at=datetime('now'),
              end_reason=? WHERE id=?`
    ).run(reason, row.id);
    require('./audit').recordBlockadeEndedInTxn({
      blockadeId: row.id,
      sectionId,
      actor: operator,
      fromStatus: row.status,
      reason,
      before: { sectionId, status: row.status }
    });
  }
}

/**
 * 管理员重置推演：清除全部封锁记录。应在重置事务内调用。
 */
function clearAllByReset() {
  getDb().prepare(`DELETE FROM blockade_applications`).run();
  return true;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToBlockade(row) {
  if (!row) return null;
  return {
    id: row.id,
    sectionId: row.section_id,
    applicant: row.applicant,
    reason: row.reason,
    status: row.status,            // pending 待生效 / active 已生效 / ended 已结束
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    endedAt: row.ended_at,
    endReason: row.end_reason
  };
}

function getBlockade(id) {
  const row = getDb().prepare(`SELECT * FROM blockade_applications WHERE id=?`).get(id);
  return rowToBlockade(row);
}

/**
 * 封锁列表：未结束（待生效/已生效）按编号升序在前，已结束按编号倒序在后。
 * @param {{status?:string}} filter
 */
function listBlockades(filter = {}) {
  let rows = getDb().prepare(
    `SELECT * FROM blockade_applications
      ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END,
               CASE status WHEN 'ended' THEN -id ELSE id END`
  ).all();
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.map(rowToBlockade);
}

/** 未结束封锁按区段索引（随 /api/state 下发，页面据此显示封锁状态） */
function unfinishedBySection() {
  const rows = getDb().prepare(
    `SELECT * FROM blockade_applications WHERE status IN ('pending','active') ORDER BY id`
  ).all();
  const map = {};
  for (const r of rows) map[r.section_id] = rowToBlockade(r);
  return map;
}

module.exports = {
  submitBlockade,
  endBlockade,
  endBySectionDelete,
  clearAllByReset,
  refreshBlockadeStates,
  getBlockade,
  listBlockades,
  unfinishedBySection
};
