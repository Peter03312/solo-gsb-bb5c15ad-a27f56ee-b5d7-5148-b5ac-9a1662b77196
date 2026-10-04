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
 *
 * 崩溃安全（进程中断后重启自动收敛）：暂停/恢复同时改主库注册表与业务库，
 * 跨库 ATTACH 大事务在 WAL 多库下不具崩溃原子性，因此拆成三个单库步骤，
 * 中间用主库 yard_ops 意图台账衔接，收敛逻辑见 recovery.js：
 *   1) 主库写意图（携带发生时刻、操作人；恢复还携带 pausedAt/shiftMs）；
 *   2) 业务库【单库事务】完成考核有效用时结算/重设、到期时间平移与
 *      yard_paused/yard_resumed 审计界标（同成同败，界标即收敛判据）；
 *   3) 主库【单库事务】翻转注册表状态并删除意图。
 * 任一步骤中断，重启（或同一操作重试时）按业务库界标判定：界标在→只补
 * 主库翻转；界标不在→业务库变更未发生，按意图重做一次。不会重复平移、
 * 重复记账或重复写界标。
 */

const {
  getMainDb, withMainDb, yardDbPath, currentYardId,
  dropYardConnection, ORIGINAL_YARD_ID
} = require('./db');
const recovery = require('./recovery');
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
    broken: row.status === 'broken',
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

/**
 * 暂停副本。步骤：意图 → 业务库单库事务（考核结算 + 界标）→ 主库翻转。
 */
function pauseCurrentYard(yardId, operator) {
  return withMainDb(() => {
    const db = getMainDb();
    // 上一次暂停/恢复若因进程中断残留，先收敛，再按当前真实状态判定幂等
    recovery.reconcileYardOps(yardId);
    const row = db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
    if (!row) {
      throw new InterlockError(404, 'YARD_NOT_FOUND', `未知演练副本：该站场不存在`);
    }
    if (row.status === 'broken') {
      throw new InterlockError(503, 'YARD_BROKEN',
        `该副本业务数据已损坏且无法自动修复，已被隔离、拒绝访问：${row.broken_reason || ''}；其他站场可正常使用`);
    }
    if (row.id === ORIGINAL_YARD_ID || row.kind === 'original') {
      throw new InterlockError(400, 'YARD_ORIGINAL_NOT_PAUSABLE', '原站场不可暂停，只能暂停管理员创建的命名演练副本');
    }
    if (row.status === 'paused') {
      return { yard: rowToPause(row), changed: false, alreadyPaused: true };
    }
    if (row.status === 'creating') {
      throw new InterlockError(404, 'YARD_NOT_READY', '该副本尚在创建中，请稍后再暂停');
    }

    const now = Date.now();
    const params = { now, pausedBy: operator, fromStatus: row.status };

    // 步骤 1：登记暂停意图（主库单条事务）
    recovery.insertOp(yardId, 'pause', operator, params);

    // 步骤 2：业务库单库事务（考核有效用时结算 + yard_paused 界标）
    let conn;
    try {
      conn = recovery.openAux(yardId);
      recovery.settlePauseInYardTxn(conn, row, params);
    } catch (e) {
      if (recovery.isCorruptionError(e)) recovery.markBroken(yardId, e.message);
      // 业务库写入失败：意图保留给启动/重试收敛；本次请求报错，主库未翻转，
      // 对外语义仍是操作前（副本仍 active）。
      throw new InterlockError(500, 'YARD_PAUSE_FAILED',
        `暂停写入副本业务库失败（注册表仍为运行中，重启将自动收敛）：${e.message}`);
    } finally {
      if (conn) { try { conn.close(); } catch (_) {} }
    }

    // 步骤 3：主库翻转 + 清理意图（单主库事务）。中断在此之后由重启补做本步。
    db.transaction(() => {
      db.prepare(
        `UPDATE yards SET status='paused', paused_by=?, paused_at=?,
                resumed_by=NULL, resumed_at=NULL
          WHERE id=? AND status='active'`
      ).run(operator, now, yardId);
      recovery.clearOp(yardId, 'pause');
    })();

    // 业务库已由独立连接写入：丢弃缓存连接，确保随后以暂停语义读取新状态
    dropYardConnection(yardId);
    return {
      yard: rowToPause(db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId)),
      changed: true,
      alreadyPaused: false
    };
  });
}

/**
 * 恢复副本。步骤：意图 → 业务库单库事务（平移 + 考核重设 + 界标）→
 * 主库翻转。返回后由路由层执行恢复后的封锁/计划/取消/等待复核（全部为
 * 幂等扫描，重启时调度器也会补做）。
 */
function resumeCurrentYard(yardId, operator) {
  return withMainDb(() => {
    const db = getMainDb();
    // 收敛上一次中断残留（可能把状态直接补成 active）
    recovery.reconcileYardOps(yardId);
    const row0 = db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
    if (!row0) {
      throw new InterlockError(404, 'YARD_NOT_FOUND', `未知演练副本：该站场不存在`);
    }
    if (row0.status === 'broken') {
      throw new InterlockError(503, 'YARD_BROKEN',
        `该副本业务数据已损坏且无法自动修复，已被隔离、拒绝访问：${row0.broken_reason || ''}；其他站场可正常使用`);
    }
    if (row0.id === ORIGINAL_YARD_ID || row0.kind === 'original') {
      throw new InterlockError(400, 'YARD_ORIGINAL_NOT_RESUMABLE', '原站场始终运行，无需恢复');
    }
    if (row0.status !== 'paused') {
      return { yard: rowToPause(row0), changed: false, alreadyResumed: true, shiftMs: 0 };
    }

    const now = Date.now();
    const shiftMs = Math.max(0, now - Number(row0.paused_at || now));
    const params = {
      now,
      resumedBy: operator,
      pausedAt: Number(row0.paused_at),
      pausedBy: row0.paused_by || null,
      shiftMs
    };

    // 步骤 1：登记恢复意图
    recovery.insertOp(yardId, 'resume', operator, params);

    // 步骤 2：业务库单库事务（平移到期时间 + 考核重设 live_since + 界标）
    let conn;
    let adjusted = { movementPlanSteps: 0, cancellations: 0 };
    try {
      conn = recovery.openAux(yardId);
      adjusted = recovery.settleResumeInYardTxn(conn, row0, params);
    } catch (e) {
      if (recovery.isCorruptionError(e)) recovery.markBroken(yardId, e.message);
      throw new InterlockError(500, 'YARD_RESUME_FAILED',
        `恢复写入副本业务库失败（注册表仍为暂停中，重启将自动收敛）：${e.message}`);
    } finally {
      if (conn) { try { conn.close(); } catch (_) {} }
    }

    // 步骤 3：主库翻转 + 清理意图
    db.transaction(() => {
      db.prepare(
        `UPDATE yards SET status='active', resumed_by=?, resumed_at=?,
                paused_by=NULL, paused_at=NULL
          WHERE id=? AND status='paused'`
      ).run(operator, now, yardId);
      recovery.clearOp(yardId, 'resume');
    })();

    dropYardConnection(yardId);
    return {
      yard: rowToPause(db.prepare(`SELECT * FROM yards WHERE id=?`).get(yardId)),
      changed: true,
      alreadyResumed: false,
      shiftMs,
      adjusted
    };
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
