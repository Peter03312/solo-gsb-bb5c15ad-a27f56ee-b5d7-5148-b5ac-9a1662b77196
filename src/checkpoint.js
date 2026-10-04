'use strict';

/**
 * 命名演练副本检查点（仅已暂停副本可创建/回退）。
 *
 * 语义（与需求一一对应）：
 *  - 管理员在【已暂停】的命名演练副本中创建具名检查点：在单个事务内把
 *    站场定义（sections/switches/signals/routes/route_steps/route_switch_reqs）、
 *    区段占用与道岔位置、进路实例及锁闭与走行事件、等待申请、延时取消、
 *    临时封锁、定时走行计划与设置（meta）整体快照为 JSON 存入 checkpoints 表，
 *    同时记录各自增表的序列水位与基准时刻（暂停中的有效时刻 effectiveNow）。
 *    同一副本内检查点重名拒绝（表上 UNIQUE 约束兜底）。
 *  - 管理员可查看检查点编号、名称、创建时间与状态摘要（各类数量统计）。
 *  - 回退：在【同一业务库事务】内用快照整体替换上述业务表——
 *      · 自增序列恢复到检查点水位：申请顺位、实例与事件序号原样保留，
 *        后续编号从检查点水位继续，不会冲突；
 *      · 待处理延时取消 release_at 与活动计划待执行步 due_at 按
 *        "当前暂停基准时刻 − 检查点基准时刻"整体平移，即按检查点当时的
 *        剩余时间继续冻结；检查点当时已到期的事项平移后仍已到期，
 *        恢复副本后立即按现有规则复核，终态行原样恢复、不会重复执行；
 *      · 交接单表不参与替换：回退时未签收（active）交接单标记过期，
 *        已签收（signed）单保留供复盘；
 *      · 检查点行本身不删除，回退后仍可再次回退到同一检查点；
 *      · 副本保持暂停（不写主库注册表），其他站场与各会话的当前站场
 *        选择不受影响；事务内任何失败整体回滚，原状态不变。
 *  - 考核表（exams/exam_targets/exam_instances）不参与快照替换：回退使进行中
 *    的考核终止并记录原因，已交卷成绩保留可查。
 *  - 原站场与运行中（未暂停）副本的创建/回退一律拒绝；未知检查点的
 *    查看/回退返回 404。
 */

const { getDb, ORIGINAL_YARD_ID } = require('./db');
const { InterlockError } = require('./interlocking');
const yards = require('./yards');
const pause = require('./pause');

const NAME_RE = /^\S(?:.*\S)?$/;
const MAX_NAME_LEN = 30;
const SNAPSHOT_VERSION = 1;

/**
 * 快照覆盖的业务表（插入顺序：父表在前，满足外键引用）。
 * 交接单（handover_documents）与检查点（checkpoints）不在快照范围：
 * 前者回退时按"未签收过期、已签收保留"单独处理，后者回退后保留可再用。
 */
const SNAPSHOT_TABLES = [
  'meta',
  'sections', 'switches', 'signals', 'routes', 'route_steps', 'route_switch_reqs',
  'route_instances', 'route_locks', 'section_events',
  'waiting_applications', 'cancellation_applications', 'blockade_applications',
  'movement_plans', 'movement_plan_steps'
];

/** 删除顺序：子表在前（route_locks/section_events/plan 步骤等先删，再删父表） */
const DELETE_TABLES = [
  'movement_plan_steps', 'movement_plans',
  'section_events', 'route_locks', 'cancellation_applications',
  'waiting_applications', 'blockade_applications',
  'route_instances', 'route_steps', 'route_switch_reqs', 'routes',
  'signals', 'switches', 'sections', 'meta'
];

/** 快照内记录序列水位的自增表（恢复后后续编号从检查点水位继续，不冲突） */
const AUTOINCR_TABLES = [
  'route_steps', 'route_switch_reqs', 'route_instances', 'route_locks',
  'section_events', 'waiting_applications', 'cancellation_applications',
  'blockade_applications', 'movement_plans', 'movement_plan_steps'
];

/* ------------------------------ 校验 ------------------------------ */

/** 仅已暂停的命名演练副本允许创建/回退检查点；原站场与运行中副本拒绝。 */
function assertPausedCopy(yardId) {
  const row = yards.yardRow(yardId);
  if (!row) {
    throw new InterlockError(404, 'YARD_NOT_FOUND', '未知演练副本：该站场不存在');
  }
  if (row.id === ORIGINAL_YARD_ID || row.kind === 'original') {
    throw new InterlockError(400, 'CHECKPOINT_ORIGINAL_FORBIDDEN',
      '原站场不支持检查点：只能对已暂停的命名演练副本创建或回退检查点');
  }
  if (row.status !== 'paused') {
    throw new InterlockError(409, 'CHECKPOINT_YARD_NOT_PAUSED',
      '仅已暂停的命名演练副本可创建/回退检查点；请先暂停该副本，再执行检查点操作');
  }
  return row;
}

function validateName(rawName) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name || !NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    throw new InterlockError(400, 'CHECKPOINT_NAME_INVALID',
      `检查点名称需为 1~${MAX_NAME_LEN} 字非空白字符`);
  }
  return name;
}

/* ------------------------------ 快照 ------------------------------ */

/** 在当前站场业务库（调用方已绑定 withYard 上下文）内构建全量业务快照。 */
function buildSnapshotInTxn() {
  const db = getDb();
  const tables = {};
  for (const t of SNAPSHOT_TABLES) {
    tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  const sequences = {};
  for (const row of db.prepare(`SELECT name, seq FROM sqlite_sequence`).all()) {
    if (AUTOINCR_TABLES.includes(row.name)) sequences[row.name] = row.seq;
  }
  return {
    version: SNAPSHOT_VERSION,
    // 基准时刻：暂停副本的有效时刻（= 暂停时刻）。回退时按基准时刻差平移
    // 待处理取消与计划步骤的到期时间，使剩余等待与检查点当时一致。
    baseTime: pause.effectiveNow(),
    tables,
    sequences
  };
}

/** 状态摘要：创建时刻的各类数量统计（列表/详情展示用）。 */
function buildSummaryInTxn() {
  const db = getDb();
  const count = (sql) => db.prepare(sql).get().n;
  return {
    sections: count(`SELECT COUNT(*) AS n FROM sections`),
    switches: count(`SELECT COUNT(*) AS n FROM switches`),
    signals: count(`SELECT COUNT(*) AS n FROM signals`),
    routes: count(`SELECT COUNT(*) AS n FROM routes`),
    openInstances: count(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`),
    waiting: count(`SELECT COUNT(*) AS n FROM waiting_applications WHERE status='waiting'`),
    pendingCancellations: count(`SELECT COUNT(*) AS n FROM cancellation_applications WHERE status='pending'`),
    unfinishedBlockades: count(
      `SELECT COUNT(*) AS n FROM blockade_applications WHERE status IN ('pending','active')`),
    activeMovementPlans: count(`SELECT COUNT(*) AS n FROM movement_plans WHERE status='active'`)
  };
}

/* ------------------------------ 创建 ------------------------------ */

/**
 * 在当前（已暂停）副本中创建具名检查点。快照与写库在同一事务内完成。
 * @returns {Object} 检查点详情（编号/名称/创建时间/状态摘要）
 */
function createCheckpoint(yardId, rawName, operator) {
  assertPausedCopy(yardId);
  const name = validateName(rawName);
  const db = getDb();

  const id = db.transaction(() => {
    const dup = db.prepare(`SELECT id FROM checkpoints WHERE name=?`).get(name);
    if (dup) {
      throw new InterlockError(409, 'CHECKPOINT_NAME_DUPLICATE',
        `本副本已存在名为"${name}"的检查点（#${dup.id}），同一副本内重名拒绝，请更换名称`,
        { checkpointId: dup.id });
    }
    const snapshot = buildSnapshotInTxn();
    const summary = buildSummaryInTxn();
    try {
      const info = db.prepare(
        `INSERT INTO checkpoints(name, created_by, created_at, summary, snapshot)
         VALUES(?, ?, ?, ?, ?)`
      ).run(name, operator, Date.now(), JSON.stringify(summary), JSON.stringify(snapshot));
      return info.lastInsertRowid;
    } catch (e) {
      // 并发创建撞唯一约束：按重名拒绝返回
      if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new InterlockError(409, 'CHECKPOINT_NAME_DUPLICATE',
          `本副本已存在名为"${name}"的检查点，同一副本内重名拒绝，请更换名称`);
      }
      throw e;
    }
  })();

  return getCheckpoint(yardId, id);
}

/* ------------------------------ 回退 ------------------------------ */

function insertRows(db, table, rows) {
  if (!rows || rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
  );
  for (const row of rows) stmt.run(row);
}

/**
 * 把当前（已暂停）副本整体回退到指定检查点。
 * 全部替换写库在单个事务内：任何失败整体回滚，副本原状态不变；
 * 成功后检查点保留可再次使用，副本保持暂停。
 *
 * @returns {{checkpoint:Object, yard:Object, restored:Object,
 *            timeShiftMs:number, handoversExpired:number}}
 */
function rollbackToCheckpoint(yardId, checkpointId, operator) {
  assertPausedCopy(yardId);
  const db = getDb();

  const result = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM checkpoints WHERE id=?`).get(checkpointId);
    if (!row) {
      throw new InterlockError(404, 'CHECKPOINT_NOT_FOUND',
        `检查点 #${checkpointId} 不存在（或不属于当前副本），无法回退`);
    }
    let snap;
    try {
      snap = JSON.parse(row.snapshot);
    } catch (e) {
      snap = null;
    }
    if (!snap || snap.version !== SNAPSHOT_VERSION || !snap.tables) {
      // 快照损坏：抛错回滚，副本原状态不变
      throw new InterlockError(500, 'CHECKPOINT_SNAPSHOT_INVALID',
        `检查点 #${checkpointId} 的快照数据无法解析，回退已取消，副本状态未改变`);
    }

    // 回退前的盘面统计（审计 before；成功写入后本表自身保留旧流水）
    const beforeSummary = buildSummaryInTxn();

    // 1) 清空快照覆盖的业务表（子表在前）
    for (const t of DELETE_TABLES) db.prepare(`DELETE FROM ${t}`).run();

    // 2) 按快照整体恢复（父表在前，显式编号插入，顺位/实例/事件序号原样保留）
    for (const t of SNAPSHOT_TABLES) insertRows(db, t, snap.tables[t]);

    // 3) 时间平移：待处理取消与活动计划待执行步按基准时刻差平移，
    //    即按检查点当时的剩余时间继续冻结；检查点当时已到期者平移后
    //    仍已到期，恢复副本后立即按现有规则复核（终态行不改动，不重复执行）。
    const shiftMs = pause.effectiveNow() - Number(snap.baseTime || 0);
    if (shiftMs !== 0) {
      db.prepare(
        `UPDATE cancellation_applications SET release_at = release_at + ? WHERE status='pending'`
      ).run(shiftMs);
      db.prepare(
        `UPDATE movement_plan_steps SET due_at = due_at + ?
          WHERE status='pending' AND due_at IS NOT NULL`
      ).run(shiftMs);
    }

    // 4) 自增序列恢复到检查点水位：后续编号从检查点水位继续，不会冲突
    db.prepare(
      `DELETE FROM sqlite_sequence WHERE name IN (${AUTOINCR_TABLES.map(() => '?').join(',')})`
    ).run(...AUTOINCR_TABLES);
    const upSeq = db.prepare(`INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES(?,?)`);
    for (const t of AUTOINCR_TABLES) {
      if (Number.isInteger(snap.sequences && snap.sequences[t])) {
        upSeq.run(t, snap.sequences[t]);
      }
    }

    // 5) 交接单不参与快照替换：未签收（active）单过期，已签收（signed）单保留
    const expired = db.prepare(
      `UPDATE handover_documents SET status='expired', expire_reason=? WHERE status='active'`
    ).run(JSON.stringify({
      reason: `管理员将副本回退到检查点 #${row.id}「${row.name}」，未签收交接单过期；已签收单保留供复盘`,
      categories: [],
      changes: [],
      checkpointRollback: true
    })).changes;

    // 6) 考核表不参与快照替换：进行中的考核随回退终止并记录原因（已交卷成绩保留）
    const terminatedExamId = require('./exam').terminateActiveInTxn(
      `管理员将副本回退到检查点 #${row.id}「${row.name}」，进行中的考核终止；已交卷成绩保留`);

    // 7) 审计界标（audit_entries 不参与快照替换，回退后旧流水全部保留；
    //    本条写在同一回退事务内，失败则整体回滚、原状态不变）。
    const restoredSummary = safeParse(row.summary, {});
    require('./audit').recordCheckpointRollbackInTxn({
      checkpointId: row.id,
      checkpointName: row.name,
      actor: operator,
      timeShiftMs: shiftMs,
      handoversExpired: expired,
      terminatedExamId,
      restored: restoredSummary,
      before: beforeSummary
    });

    return { row, shiftMs, expired, terminatedExamId };
  })();

  return {
    checkpoint: rowToCheckpoint(result.row),
    yard: yards.getYard(yardId), // 仍为暂停状态（注册表未改动）
    restored: safeParse(result.row.summary, {}),
    timeShiftMs: result.shiftMs,
    handoversExpired: result.expired,
    terminatedExamId: result.terminatedExamId,
    note: '副本已整体回退到检查点并保持暂停；检查点保留可再次使用，恢复副本后按现有规则继续运行'
  };
}

/* ------------------------------ 查询 ------------------------------ */

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function rowToCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    createdAtText: new Date(Number(row.created_at)).toLocaleString('zh-CN', { hour12: false }),
    summary: safeParse(row.summary, {})
  };
}

/**
 * 查看单个检查点（编号/名称/创建时间/状态摘要）。未知检查点 404。
 * 只读操作：暂停与运行中的副本均可查看（原站场无检查点，恒 404）。
 */
function getCheckpoint(yardId, checkpointId) {
  const row = getDb().prepare(`SELECT * FROM checkpoints WHERE id=?`).get(checkpointId);
  if (!row) {
    throw new InterlockError(404, 'CHECKPOINT_NOT_FOUND',
      `检查点 #${checkpointId} 不存在（或不属于当前副本）`);
  }
  return rowToCheckpoint(row);
}

/** 检查点列表（编号升序；原站场恒为空表）。 */
function listCheckpoints() {
  return getDb()
    .prepare(`SELECT * FROM checkpoints ORDER BY id`)
    .all()
    .map(rowToCheckpoint);
}

module.exports = {
  createCheckpoint,
  rollbackToCheckpoint,
  getCheckpoint,
  listCheckpoints
};
