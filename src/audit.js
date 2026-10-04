'use strict';

/**
 * 站场追溯推演审计流水。
 *
 * 只记录真正改变推演状态的业务变更，变更类型（type）：
 *  - route_opened            进路开放（人工直接开放）
 *  - waiting_fulfilled       等待申请兑现（系统按提交顺序自动兑现，产生进路实例）
 *  - route_event             走行事件（占用/清空；系统定时计划注入同样记录）
 *  - route_released          进路解除（末段走行自动解除 / 人工解除）
 *  - cancellation_released   延时取消核验通过并解除进路
 *  - blockade_created        封锁发起（待生效/已生效）
 *  - blockade_changed        封锁状态变更（待生效→已生效）
 *  - blockade_ended          封锁结束（管理员结束 / 区段删除自动结束）
 *  - yard_paused / yard_resumed   命名演练副本暂停 / 恢复
 *  - checkpoint_rollback     检查点回退（旧流水保留，本条为界标）
 *  - yard_reset              站场重置（清空推演状态 / 培训重开；旧流水保留，本条为界标）
 *  - yard_created            副本创建界标（副本只记录创建后自身的新变化）
 *
 * 原子性（同成同败）：全部 insert* 函数只执行一条 INSERT，必须由调用方放在
 * 业务变更的同一个事务（含跨库 ATTACH 事务，此时显式传入 db 与表前缀）内调用。
 * 业务校验失败 → 事务回滚，流水随业务写入一起消失；幂等重传在业务层提前返回、
 * 不走到写入点；未改变任何状态的扫描（无兑现/无转换/无到期处理）不产生条目。
 *
 * 本表不参与检查点快照替换（checkpoint.js SNAPSHOT_TABLES/DELETE_TABLES
 * 均不含本表），创建副本时不复制（yards.js 复制白名单不含本表），因此
 * "回退/重置保留此前流水并写明界标，副本创建后只记录自身的新变化"。
 */

const { getDb, currentYardId } = require('./db');

const TYPES = [
  'route_opened', 'route_event', 'route_released',
  'waiting_fulfilled', 'cancellation_released',
  'blockade_created', 'blockade_changed', 'blockade_ended',
  'yard_paused', 'yard_resumed',
  'checkpoint_rollback', 'yard_reset', 'yard_created'
];
const TYPE_SET = new Set(TYPES);

const REF_TYPES = [
  'route_instance', 'waiting', 'cancellation', 'blockade',
  'checkpoint', 'yard', 'reset'
];

const TYPE_LABELS = {
  route_opened: '进路开放',
  route_event: '走行事件',
  route_released: '进路解除',
  waiting_fulfilled: '等待申请兑现',
  cancellation_released: '延时取消解除',
  blockade_created: '封锁发起',
  blockade_changed: '封锁状态变更',
  blockade_ended: '封锁结束',
  yard_paused: '副本暂停',
  yard_resumed: '副本恢复',
  checkpoint_rollback: '检查点回退',
  yard_reset: '站场重置',
  yard_created: '副本创建界标'
};

const REF_LABELS = {
  route_instance: '进路实例',
  waiting: '等待申请',
  cancellation: '延时取消申请',
  blockade: '封锁申请',
  checkpoint: '检查点',
  yard: '站场',
  reset: '重置'
};

function nowMs() {
  return Date.now();
}

/**
 * 在调用方事务内写入一条审计流水（最底层入口）。
 * @param {Object} db 执行连接（默认当前站场业务库；跨库 ATTACH 事务传主库连接）
 * @param {string} table 目标表名（跨库时为 '别名.audit_entries'）
 */
function insertEntryInTxn(db, table, e) {
  if (!TYPE_SET.has(e.type)) throw new Error(`未知审计变更类型: ${e.type}`);
  const actor = e.actor == null ? null : String(e.actor);
  db.prepare(
    `INSERT INTO ${table}
       (yard_id,type,ref_type,ref_id,actor,source,reason,before_state,after_state,detail,occurred_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    e.yardId == null ? currentYardId() : e.yardId,
    e.type,
    e.refType,
    String(e.refId),
    actor,
    e.source || (actor ? 'manual' : 'system'),
    e.reason == null ? null : String(e.reason),
    e.before == null ? null : JSON.stringify(e.before),
    e.after == null ? null : JSON.stringify(e.after),
    e.detail == null ? null : JSON.stringify(e.detail),
    e.occurredAt || nowMs()
  );
}

/** 在当前站场业务库、调用方事务内写入一条审计流水。 */
function recordInTxn(entry) {
  insertEntryInTxn(getDb(), 'audit_entries', entry);
}

function manual(actor) {
  return actor == null ? null : String(actor);
}

/* ------------------------------ 进路 ------------------------------ */

/**
 * 进路开放（人工直接开放；等待兑现走 recordWaitingFulfilledInTxn）。
 * 须在开放事务内、实例与锁写入成功后调用。
 */
function recordRouteOpenedInTxn({ instanceId, routeId, actor, before, after }) {
  recordInTxn({
    type: 'route_opened',
    refType: 'route_instance', refId: instanceId,
    actor: manual(actor),
    before, after,
    detail: { routeId }
  });
}

/**
 * 走行事件（占用/清空）。人工提交 actor=值班员；定时计划注入 actor=计划提交人、
 * source='system'。须在事件事务内调用。
 * @param {Object} p.before/after 进路实例推进摘要（signalState/nextSeq/headStep/tailStep）
 */
function recordRouteEventInTxn({ instanceId, routeId, seq, sectionId, action,
                                actor, source, before, after, extra }) {
  recordInTxn({
    type: 'route_event',
    refType: 'route_instance', refId: instanceId,
    actor: actor == null ? null : String(actor),
    source: source === 'system' ? 'system' : 'manual',
    before, after,
    detail: { routeId, seq, sectionId, action, ...(extra || {}) }
  });
}

/**
 * 进路解除（末段走行自动解除 / 人工解除 / 兜底解除）。
 * @param {string} how 'walkthrough' 末段走行自动解除 / 'manual' 人工解除
 */
function recordRouteReleasedInTxn({ instanceId, routeId, how, actor, source, before, after }) {
  recordInTxn({
    type: 'route_released',
    refType: 'route_instance', refId: instanceId,
    actor: actor == null ? null : String(actor),
    source: source === 'system' ? 'system' : 'manual',
    reason: how === 'walkthrough' ? '末段走行出清，进路自动解除'
      : how === 'manual' ? '值班员人工解除进路' : '进路解除',
    before, after,
    detail: { routeId, how }
  });
}

/* ------------------------------ 等待申请 ------------------------------ */

/**
 * 等待申请兑现（系统在兑现扫描事务内、开放事务体成功后调用）。
 * 兑现出的进路开放不再另写 route_opened，由本条覆盖（避免一次变更两条流水）。
 */
function recordWaitingFulfilledInTxn({ waitingId, instanceId, routeId, actor, before, after }) {
  recordInTxn({
    type: 'waiting_fulfilled',
    refType: 'waiting', refId: waitingId,
    actor: manual(actor),
    source: 'system',
    reason: '等待申请按提交顺序自动兑现',
    before, after,
    detail: { routeId, instanceId }
  });
}

/* ------------------------------ 延时取消 ------------------------------ */

/**
 * 延时取消核验通过、进路解除。系统到期处理；实例此前已解除时为收尾（already）。
 * 解除的进路不再另写 route_released，由本条覆盖。
 */
function recordCancellationReleasedInTxn({ cancellationId, instanceId, routeId,
                                          already, reason, before, after }) {
  recordInTxn({
    type: 'cancellation_released',
    refType: 'cancellation', refId: cancellationId,
    actor: null, source: 'system',
    reason: reason || (already
      ? '进路在到期处理前已解除，延时取消申请收尾为已解除'
      : '保护期满且核验通过，延时取消解除进路'),
    before, after,
    detail: { instanceId, routeId: routeId || null, already: !!already }
  });
}

/* ------------------------------ 封锁 ------------------------------ */

/** 封锁发起（管理员）。status 为提交后的 pending/active。 */
function recordBlockadeCreatedInTxn({ blockadeId, sectionId, actor, status, reason, after }) {
  recordInTxn({
    type: 'blockade_created',
    refType: 'blockade', refId: blockadeId,
    actor: manual(actor),
    before: { status: null },
    after: after || { sectionId, status, reason },
    detail: { sectionId, reason }
  });
}

/** 封锁待生效→已生效（系统复核；每笔转换一条）。 */
function recordBlockadeChangedInTxn({ blockadeId, sectionId, reason, trigger, after }) {
  recordInTxn({
    type: 'blockade_changed',
    refType: 'blockade', refId: blockadeId,
    actor: null, source: 'system',
    reason: reason || `封锁复核转已生效（${trigger || 'trigger'}）`,
    before: { status: 'pending' },
    after: after || { sectionId, status: 'active' },
    detail: { sectionId, trigger: trigger || null }
  });
}

/** 封锁结束（管理员结束，或区段被删除时同事务自动结束）。 */
function recordBlockadeEndedInTxn({ blockadeId, sectionId, actor, fromStatus, reason, before }) {
  recordInTxn({
    type: 'blockade_ended',
    refType: 'blockade', refId: blockadeId,
    actor: actor == null ? null : String(actor),
    source: actor ? 'manual' : 'system',
    reason: reason || (actor ? '管理员结束封锁' : '区段被管理员删除，封锁自动结束'),
    before: before || { sectionId, status: fromStatus || 'active' },
    after: { sectionId, status: 'ended' },
    detail: { sectionId, fromStatus: fromStatus || null }
  });
}

/* ------------------------------ 暂停 / 恢复 ------------------------------ */

/**
 * 副本暂停/恢复界标。这两类状态保存在主库 yards 表，流水写入对应站场业务库
 * （与暂停/恢复同一跨库 ATTACH 事务，调用方显式传主库连接与 '别名.audit_entries'）。
 */
function recordYardPausedInTxn(db, table, { yardId, actor, pausedAt, before, after }) {
  insertEntryInTxn(db, table, {
    yardId,
    type: 'yard_paused',
    refType: 'yard', refId: yardId,
    actor: manual(actor),
    before, after,
    detail: { pausedAt }
  });
}

function recordYardResumedInTxn(db, table, { yardId, actor, resumedAt, shiftMs, adjusted, before, after }) {
  insertEntryInTxn(db, table, {
    yardId,
    type: 'yard_resumed',
    refType: 'yard', refId: yardId,
    actor: manual(actor),
    before, after,
    detail: { resumedAt, shiftMs, adjusted: adjusted || {} }
  });
}

/* ------------------------------ 检查点回退 / 重置 / 副本界标 ------------------------------ */

/** 检查点回退界标：此前流水全部保留，本条标记回退点（旧数据回到检查点状态）。 */
function recordCheckpointRollbackInTxn({ checkpointId, checkpointName, actor,
                                        timeShiftMs, handoversExpired, terminatedExamId,
                                        restored, before }) {
  recordInTxn({
    type: 'checkpoint_rollback',
    refType: 'checkpoint', refId: checkpointId,
    actor: manual(actor),
    before: before || null,
    after: restored || null,
    detail: {
      checkpointName,
      timeShiftMs,
      handoversExpired: handoversExpired || 0,
      terminatedExamId: terminatedExamId || null,
      marker: true,
      note: '回退前流水保留；自本条起的流水为回退后的新变化'
    }
  });
}

/**
 * 站场重置界标（清空推演状态 / 培训重开）。重置不删除流水，本条标记界标；
 * before 记录重置前盘面统计，after 记录重置后盘面统计。
 */
function recordYardResetInTxn({ kind, actor, before, after, extra }) {
  recordInTxn({
    type: 'yard_reset',
    refType: 'reset', refId: kind,
    actor: manual(actor),
    reason: kind === 'training' ? '管理员执行培训重开（站场重置）' : '管理员清空推演状态（站场重置）',
    before, after,
    detail: { kind, ...(extra || {}), marker: true,
      note: '重置前流水保留；自本条起的流水为重置后的新变化' }
  });
}

/**
 * 副本创建界标（写入新副本业务库，在主库复制事务内、复制数据与注册行同一事务）。
 * 复制不带任何旧流水：副本流水从本条 seq=1 开始，之后只记录该副本自身的新变化。
 */
function recordYardCreatedInTxn(db, table, { yardId, name, actor, sourceYardId, copied }) {
  insertEntryInTxn(db, table, {
    yardId,
    type: 'yard_created',
    refType: 'yard', refId: yardId,
    actor: manual(actor),
    before: null,
    after: { name, status: 'active', copied: copied || {} },
    detail: {
      name,
      sourceYardId,
      copied: copied || {},
      marker: true,
      note: '副本不复制原站场审计流水；自本条起只记录本副本自身的新变化'
    }
  });
}

/* ------------------------------ 查询 ------------------------------ */

function parseJsonSafe(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function rowToEntry(row) {
  return {
    seq: row.seq,
    yardId: row.yard_id,
    type: row.type,
    typeLabel: TYPE_LABELS[row.type] || row.type,
    refType: row.ref_type,
    refTypeLabel: REF_LABELS[row.ref_type] || row.ref_type,
    refId: row.ref_id,
    actor: row.actor,
    source: row.source,
    reason: row.reason,
    before: parseJsonSafe(row.before_state),
    after: parseJsonSafe(row.after_state),
    detail: parseJsonSafe(row.detail),
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

/**
 * 按当前站场分页查询审计流水（序号递增顺序）。
 * @param {{fromSeq?:number, limit?:number, types?:string[], refType?:string, refId?:string}}
 *        filter.types 已校验为合法 type 集合；refType/refId 可任一或同时给出。
 *        refType/refId 只给其一时按该列过滤（"按关联编号筛选"通常两者一起给）。
 */
function listEntries(filter = {}) {
  const db = getDb();
  const where = [];
  const params = {};
  const fromSeq = Number.isInteger(filter.fromSeq) ? filter.fromSeq : 1;
  const limit = Number.isInteger(filter.limit) ? filter.limit : 50;
  where.push('seq >= @fromSeq');
  params.fromSeq = fromSeq;
  if (Array.isArray(filter.types) && filter.types.length > 0) {
    where.push(`type IN (${filter.types.map((_, i) => `@type${i}`).join(',')})`);
    filter.types.forEach((t, i) => { params[`type${i}`] = t; });
  }
  if (filter.refType) { where.push('ref_type = @refType'); params.refType = filter.refType; }
  if (filter.refId != null) { where.push('ref_id = @refId'); params.refId = String(filter.refId); }

  const rows = db.prepare(
    `SELECT * FROM audit_entries WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT @limit`
  ).all({ ...params, limit });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_entries`).get().n;
  const lastSeq = total === 0 ? 0 : db.prepare(`SELECT MAX(seq) AS m FROM audit_entries`).get().m;
  const entries = rows.map(rowToEntry);
  const lastReturned = entries.length ? entries[entries.length - 1].seq : null;
  return {
    entries,
    pagination: {
      fromSeq,
      limit,
      returned: entries.length,
      nextFromSeq: lastReturned == null ? null : lastReturned + 1,
      hasMore: lastReturned == null ? false : lastReturned < lastSeq
    },
    types: TYPES,
    typeLabels: TYPE_LABELS,
    refTypes: REF_TYPES
  };
}

module.exports = {
  TYPES,
  REF_TYPES,
  TYPE_LABELS,
  insertEntryInTxn,
  recordInTxn,
  recordRouteOpenedInTxn,
  recordRouteEventInTxn,
  recordRouteReleasedInTxn,
  recordWaitingFulfilledInTxn,
  recordCancellationReleasedInTxn,
  recordBlockadeCreatedInTxn,
  recordBlockadeChangedInTxn,
  recordBlockadeEndedInTxn,
  recordYardPausedInTxn,
  recordYardResumedInTxn,
  recordCheckpointRollbackInTxn,
  recordYardResetInTxn,
  recordYardCreatedInTxn,
  listEntries
};
