'use strict';

/**
 * 命名演练副本暂停/恢复。
 *
 * 暂停状态保存在主库 yards 注册表，业务库中的定时走行计划、延时取消等数据
 * 不复制、不停止为终态。恢复时用暂停时长整体平移：
 *  - 活动走行计划当前唯一已排期（pending 且 due_at 非空）步骤；
 *  - 全部待处理延时取消的 release_at。
 * 后续步骤仍按现有规则在“上一步成功时刻 + 等待时长”后到期。重复暂停/恢复
 * 直接幂等返回，不再次平移时间。
 */

const {
  getMainDb, withMainDb, yardDbPath, currentYardId,
  dropYardConnection, ORIGINAL_YARD_ID
} = require('./db');
const { InterlockError } = require('./interlocking');

function rowToPause(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    isOriginal: row.id === ORIGINAL_YARD_ID,
    sourceYardId: row.source_yard_id,
    status: row.status === 'paused' ? 'paused' : 'active',
    paused: row.status === 'paused',
    pausedBy: row.paused_by || null,
    pausedAt: row.paused_at || null,
    resumedBy: row.resumed_by || null,
    resumedAt: row.resumed_at || null,
    createdAt: row.created_at
  };
}

function getYardPause(yardId) {
  return withMainDb(() =>
    rowToPause(getMainDb().prepare(`SELECT * FROM yards WHERE id=?`).get(yardId)));
}

function isPaused(yardId = currentYardId()) {
  const yard = getYardPause(yardId);
  return !!yard && yard.paused;
}

/**
 * 暂停副本界面展示倒计时时使用的“虚拟当前时刻”：停在 pausedAt；
 * 恢复后返回真实当前时刻。这样冻结期间的剩余等待不会继续递减或显示逾期。
 */
function effectiveNow(yardId = currentYardId()) {
  const yard = getYardPause(yardId);
  if (yard && yard.paused && yard.pausedAt) return Number(yard.pausedAt);
  return Date.now();
}

function assertActive(yardId) {
  if (isPaused(yardId)) {
    throw new InterlockError(409, 'YARD_PAUSED',
      '该命名演练副本已暂停，暂停期间拒绝手工业务变更；只读查询和会话切换不受影响，请由管理员恢复后再操作');
  }
}

function pauseCurrentYard(yardId, operator) {
  return withMainDb(() => {
    const db = getMainDb();
    const row = db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
    if (!row) {
      throw new InterlockError(404, 'YARD_NOT_FOUND', `未知演练副本：该站场不存在`);
    }
    if (row.id === ORIGINAL_YARD_ID || row.kind === 'original') {
      throw new InterlockError(400, 'YARD_ORIGINAL_NOT_PAUSABLE', '原站场不可暂停，只能暂停管理员创建的命名演练副本');
    }
    if (row.status === 'paused') {
      return { yard: rowToPause(row), changed: false, alreadyPaused: true };
    }

    const now = Date.now();
    const alias = 'paused_yard_db';
    const attach = () => db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(yardDbPath(yardId));
    const detach = () => { try { db.exec(`DETACH DATABASE ${alias}`); } catch (_) {} };

    attach();
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE yards SET status='paused', paused_by=?, paused_at=?, resumed_by=NULL, resumed_at=NULL
            WHERE id=? AND status='active'`
        ).run(operator, now, yardId);
        // 考核有效用时冻结：把本段运行时间计入 used_ms 并清空 live_since。
        // 与暂停状态同一事务提交，避免暂停/用时状态不一致。
        db.prepare(
          `UPDATE ${alias}.exams SET used_ms = used_ms + MAX(0, ? - COALESCE(live_since, ?)),
                  live_since = NULL
            WHERE status='in_progress'`
        ).run(now, now);
        // 审计：暂停界标写入【该副本业务库】的流水表，与暂停状态同成同败
        // （yards 行在主库、流水在业务库，跨库 ATTACH 单事务提交）。
        require('./audit').recordYardPausedInTxn(db, `${alias}.audit_entries`, {
          yardId,
          actor: operator,
          pausedAt: now,
          before: { status: 'active', paused: false },
          after: { status: 'paused', paused: true, pausedBy: operator, pausedAt: now }
        });
      })();
    } finally {
      detach();
    }
    // ATTACH 已在业务库写入：丢弃缓存连接，确保后续以暂停语义读取新状态
    dropYardConnection(yardId);
    return {
      yard: rowToPause(db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId)),
      changed: true,
      alreadyPaused: false
    };
  });
}

function resumeCurrentYard(yardId, operator) {
  return withMainDb(() => {
    const db = getMainDb();
    const row = db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
    if (!row) {
      throw new InterlockError(404, 'YARD_NOT_FOUND', `未知演练副本：该站场不存在`);
    }
    if (row.id === ORIGINAL_YARD_ID || row.kind === 'original') {
      throw new InterlockError(400, 'YARD_ORIGINAL_NOT_RESUMABLE', '原站场始终运行，无需恢复');
    }
    if (row.status !== 'paused') {
      return { yard: rowToPause(row), changed: false, alreadyResumed: true, shiftMs: 0 };
    }

    const now = Date.now();
    const shiftMs = Math.max(0, now - Number(row.paused_at || now));
    const alias = 'paused_yard_db';
    const attach = () => db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(yardDbPath(yardId));
    const detach = () => { try { db.exec(`DETACH DATABASE ${alias}`); } catch (_) {} };

    attach();
    try {
      const adjusted = db.transaction(() => {
        // 仅平移活动计划当前已排期的一步；后续步骤 due_at 仍为 NULL，按现有规则计时。
        const planResult = db.prepare(
          `UPDATE ${alias}.movement_plan_steps
              SET due_at = due_at + @shiftMs
            WHERE status='pending'
              AND due_at IS NOT NULL
              AND due_at > @pausedAt
              AND plan_id IN (SELECT id FROM ${alias}.movement_plans WHERE status='active')`
        ).run({ shiftMs, pausedAt: Number(row.paused_at) });
        const cancelResult = db.prepare(
          `UPDATE ${alias}.cancellation_applications
              SET release_at = release_at + @shiftMs
            WHERE status='pending' AND release_at > @pausedAt`
        ).run({ shiftMs, pausedAt: Number(row.paused_at) });
        // 考核恢复计时：从恢复时刻起算新的运行段（暂停段已在 pause 时计入 used_ms）
        db.prepare(
          `UPDATE ${alias}.exams SET live_since = @now
            WHERE status='in_progress' AND live_since IS NULL`
        ).run({ now });
        db.prepare(
          `UPDATE yards SET status='active', resumed_by=?, resumed_at=?,
                  paused_by=NULL, paused_at=NULL
            WHERE id=? AND status='paused'`
        ).run(operator, now, yardId);
        // 审计：恢复界标（含平移时长与受影响条目数）写入副本业务库流水表，
        // 与恢复状态/时间平移同一事务提交。
        require('./audit').recordYardResumedInTxn(db, `${alias}.audit_entries`, {
          yardId,
          actor: operator,
          resumedAt: now,
          shiftMs,
          adjusted: {
            movementPlanSteps: planResult.changes,
            cancellations: cancelResult.changes
          },
          before: {
            status: 'paused', paused: true,
            pausedBy: row.paused_by || null, pausedAt: Number(row.paused_at)
          },
          after: { status: 'active', paused: false, resumedBy: operator, resumedAt: now }
        });
        return { movementPlanSteps: planResult.changes, cancellations: cancelResult.changes };
      })();
      return {
        yard: rowToPause(db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId)),
        changed: true,
        alreadyResumed: false,
        shiftMs,
        adjusted
      };
    } finally {
      detach();
    }
    // 主库连接通过 ATTACH 更新业务库后，丢弃该业务库此前缓存的连接，确保随后
    // 恢复复核读取到同一事务已提交的 due_at/release_at，而不是旧 WAL 快照。
    dropYardConnection(yardId);
  });
}

module.exports = {
  getYardPause,
  isPaused,
  effectiveNow,
  assertActive,
  pauseCurrentYard,
  resumeCurrentYard
};
