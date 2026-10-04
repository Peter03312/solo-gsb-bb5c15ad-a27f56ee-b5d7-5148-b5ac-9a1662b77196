'use strict';

/**
 * 命名演练副本学员考核。
 *
 * 语义（与需求一一对应）：
 *  - 管理员为【运行中的命名演练副本】指定一名学员与按顺序完成的进路目标后开考；
 *    原站场不能开考；同一副本只允许一场进行中的考核（部分唯一索引
 *    idx_exams_in_progress 兜底，重复开考拒绝）。
 *  - 开考时固定：学员、目标序列（编号+开考时名称快照）与起始状态
 *    （sections/switches 状态 + 当时开放实例的摘要），全部持久化在业务库，
 *    刷新/重启后仍可查询。
 *  - 仅考核【开考后】归属该学员的【新进路实例】：openRouteInTxn 成功后同事务
 *    登记（recordOpenInTxn），开考前已开放的实例不登记。等待申请自动兑现
 *    （source='waiting'）与直接开放同样登记。
 *  - 开放时进路与当前待达成目标（最靠前的 pending 目标）相符 → 挂接到该目标
 *    序号；不符（顺序外/目标外）→ 记为偏差，之后完成也不补算。其他人开放的
 *    实例不登记、不计偏差；联锁规则不因考核改变（考核登记失败随主事务回滚，
 *    不会出现"开放成功但未登记"的部分结果）。
 *  - 实例通过逐段走行【正常解除】（末段清空自动解除）时同事务写完成时刻并推进
 *    挂接目标（recordWalkthroughReleaseInTxn）；幂等重传在走行校验处提前返回，
 *    不会重复计数。人工释放、延时取消到期解除不调用本钩子，不算完成；定时走行
 *    计划注入的走行事件走同一末段清空路径，同样计入。
 *  - 副本暂停期间冻结有效用时：pause 业务库单库事务内把
 *    used_ms += now-live_since 并清空 live_since（与 yard_paused 界标同成同败，
 *    主库注册表翻转由下一步单库事务完成；中断收敛见 recovery.js）；resume 重设
 *    live_since；交卷/终止时结算。暂停状态跨重启持久化，冻结随之持续。
 *  - 检查点回退或站场重置：进行中的考核置 terminated 并记录原因，已交卷成绩
 *    （submitted）保留。考核表不参与检查点快照替换、创建副本时也不复制。
 */

const { getDb } = require('./db');

const MAX_TARGETS = 50;
const RECENT_LIMIT = 10;

function InterlockError(status, code, message, extra = {}) {
  // 懒加载避免与 interlocking 形成循环依赖
  return new (require('./interlocking').InterlockError)(status, code, message, extra);
}

/* ------------------------------ 校验 ------------------------------ */

function validateStudent(raw) {
  const student = String(raw == null ? '' : raw).trim();
  if (student.length < 1 || student.length > 30) {
    throw InterlockError(400, 'EXAM_STUDENT_INVALID', '请指定学员姓名（1~30 字）');
  }
  return student;
}

/**
 * 校验目标序列：非空数组，1~MAX_TARGETS 项，每项给 routeId（字符串或
 * {routeId}），进路必须存在于当前站场；允许同一进路重复出现（按顺序考两次）。
 * @returns {Array<{routeId:string, label:string}>}
 */
function validateTargets(rawTargets) {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw InterlockError(400, 'EXAM_TARGETS_REQUIRED', '请指定按顺序完成的进路目标列表（至少 1 项）');
  }
  if (rawTargets.length > MAX_TARGETS) {
    throw InterlockError(400, 'EXAM_TARGETS_TOO_MANY', `进路目标至多 ${MAX_TARGETS} 项（收到 ${rawTargets.length} 项）`);
  }
  const db = getDb();
  const targets = [];
  rawTargets.forEach((item, idx) => {
    const routeId = String(
      typeof item === 'string' ? item : (item && item.routeId) == null ? '' : item.routeId
    ).trim();
    if (!routeId) {
      throw InterlockError(400, 'EXAM_TARGET_INVALID',
        `第 ${idx + 1} 项目标缺少进路编号 routeId`, { seq: idx + 1 });
    }
    const route = db.prepare(`SELECT id, label FROM routes WHERE id=?`).get(routeId);
    if (!route) {
      throw InterlockError(404, 'EXAM_ROUTE_NOT_FOUND',
        `第 ${idx + 1} 项目标进路 ${routeId} 不存在，不能开考`, { seq: idx + 1, routeId });
    }
    targets.push({ seq: idx + 1, routeId: route.id, label: route.label });
  });
  return targets;
}

/* ------------------------------ 开考 ------------------------------ */

/**
 * 开考。须在当前站场上下文（withYard）内调用。
 * @param {number} yardId 当前会话选中的站场编号（原站场拒绝）
 * @param {string} rawStudent 学员姓名
 * @param {Array} rawTargets 进路目标序列
 * @param {string} operator 开考管理员
 */
function startExam(yardId, rawStudent, rawTargets, operator) {
  const student = validateStudent(rawStudent);
  const targets = validateTargets(rawTargets);

  const yards = require('./yards');
  const pause = require('./pause');
  const yard = yards.yardRow(yardId);
  if (!yard) throw InterlockError(404, 'YARD_NOT_FOUND', '未知演练副本：该站场不存在');
  if (yard.id === 1 || yard.kind === 'original') {
    throw InterlockError(400, 'EXAM_ORIGINAL_FORBIDDEN',
      '原站场不能开考：请先从原站场创建命名演练副本，在副本中指定学员与目标开考');
  }
  if (pause.isPaused(yardId)) {
    throw InterlockError(409, 'EXAM_YARD_PAUSED',
      '该命名演练副本已暂停，暂停期间不能开考；请由管理员恢复后再开考');
  }

  const db = getDb();
  const now = Date.now();

  const examId = db.transaction(() => {
    const active = db.prepare(`SELECT id FROM exams WHERE status='in_progress'`).get();
    if (active) {
      throw InterlockError(409, 'EXAM_ALREADY_ACTIVE',
        `本副本已有一场进行中的考核（#${active.id}，学员交卷或考核终止前不能重复开考）`,
        { examId: active.id });
    }

    // 起始状态快照（固定开考盘面；仅考核开考后的新进路实例）
    const startState = {
      time: now,
      sections: db.prepare(`SELECT id, occ_state FROM sections ORDER BY id`).all(),
      switches: db.prepare(`SELECT id, position FROM switches ORDER BY id`).all(),
      openInstances: db.prepare(
        `SELECT id, route_id AS routeId, opened_by AS openedBy, signal_state AS signalState,
                head_step AS headStep, tail_step AS tailStep
           FROM route_instances WHERE status='open' ORDER BY id`
      ).all()
    };

    const info = db.prepare(
      `INSERT INTO exams(student, status, targets_json, started_by, started_at,
                         used_ms, live_since, start_state)
       VALUES(?, 'in_progress', ?, ?, ?, 0, ?, ?)`
    ).run(student, JSON.stringify(targets.map(({ seq, routeId, label }) => ({ seq, routeId, label }))),
      operator || null, now, now, JSON.stringify(startState));
    const id = info.lastInsertRowid;

    const insTarget = db.prepare(
      `INSERT INTO exam_targets(exam_id, seq, route_id, label, status) VALUES(?,?,?,?,'pending')`
    );
    for (const t of targets) insTarget.run(id, t.seq, t.routeId, t.label);
    return id;
  })();

  return getExam(examId);
}

/* --------------------- 事务钩子：开放登记 / 正常解除推进 --------------------- */

/**
 * 进路开放成功后（在 openRouteInTxn 同一事务内）登记考核实例。
 *  - 无进行中考核 / 开放人不是指定学员 / 开考前实例（调用方只在新实例上调用）：
 *    不登记；
 *  - 进路与当前待达成目标相符：挂接该目标序号；否则记为偏差。
 * @returns {Object|null} 登记行信息（无考核时 null）
 */
function recordOpenInTxn(instanceId, routeId, openedBy, source = 'manual') {
  const db = getDb();
  const exam = db.prepare(`SELECT * FROM exams WHERE status='in_progress'`).get();
  if (!exam || exam.student !== openedBy) return null;

  const dup = db.prepare(
    `SELECT id FROM exam_instances WHERE exam_id=? AND instance_id=?`
  ).get(exam.id, instanceId);
  if (dup) return { examId: exam.id, id: dup.id, duplicated: true };

  const target = db.prepare(
    `SELECT * FROM exam_targets WHERE exam_id=? AND status='pending' ORDER BY seq LIMIT 1`
  ).get(exam.id);

  let targetSeq = null;
  let isDeviation = 1;
  let note = null;
  if (target && target.route_id === routeId) {
    targetSeq = target.seq;
    isDeviation = 0;
  } else {
    note = target
      ? `顺序外开放：当前待达成目标为第 ${target.seq} 项（${target.route_id}），实际开放 ${routeId}，记为偏差；之后完成也不补算`
      : `全部目标达成后开放进路 ${routeId}，记为偏差`;
  }

  const info = db.prepare(
    `INSERT INTO exam_instances(exam_id, instance_id, route_id, opened_by, source,
                                target_seq, is_deviation, note)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(exam.id, instanceId, routeId, openedBy, source, targetSeq, isDeviation, note);
  return { examId: exam.id, id: info.lastInsertRowid, targetSeq, isDeviation: !!isDeviation };
}

/**
 * 进路实例【逐段走行正常解除】时（末段清空分支的同一事务内）调用：
 * 写登记行完成时刻，并把挂接的待达成目标推进为 done。
 * 人工释放/延时取消解除不调用本函数；幂等重传在走行校验处提前返回，不会到这里。
 * 考核已交卷/终止后才解除的实例只保留登记，不推进目标。
 * @returns {Object|null}
 */
function recordWalkthroughReleaseInTxn(instanceId, nowMs = Date.now()) {
  const db = getDb();
  const reg = db.prepare(
    `SELECT ei.*, e.status AS exam_status
       FROM exam_instances ei JOIN exams e ON e.id=ei.exam_id
      WHERE ei.instance_id=? AND ei.completed_at IS NULL`
  ).get(instanceId);
  if (!reg) return null;

  db.prepare(`UPDATE exam_instances SET completed_at=? WHERE id=?`).run(nowMs, reg.id);
  if (reg.exam_status !== 'in_progress' || reg.target_seq == null || reg.is_deviation) {
    return { examId: reg.exam_id, instanceId, advanced: false };
  }
  const done = db.prepare(
    `UPDATE exam_targets SET status='done', instance_id=?, completed_at=?
      WHERE exam_id=? AND seq=? AND status='pending'`
  ).run(instanceId, nowMs, reg.exam_id, reg.target_seq);
  return { examId: reg.exam_id, instanceId, advanced: done.changes > 0, seq: reg.target_seq };
}

/* ------------------------------ 交卷 ------------------------------ */

/**
 * 学员交卷。仅指定学员本人、且考核进行中允许；交卷时结算有效用时。
 * @returns {Object} 考核详情（逐项目标状态、偏差、有效用时）
 */
function submitExam(examId, studentName) {
  const db = getDb();
  const id = Number(examId);
  if (!Number.isInteger(id)) {
    throw InterlockError(404, 'EXAM_NOT_FOUND', `考核 ${examId} 不存在`);
  }
  const row = db.prepare(`SELECT * FROM exams WHERE id=?`).get(id);
  if (!row) throw InterlockError(404, 'EXAM_NOT_FOUND', `考核 #${id} 不存在`);
  if (row.student !== studentName) {
    throw InterlockError(403, 'EXAM_NOT_ASSIGNED',
      `不能交卷：考核 #${id} 的指定学员为 ${row.student}，其他人的操作不计入考核`);
  }
  if (row.status === 'submitted') {
    throw InterlockError(409, 'EXAM_ALREADY_SUBMITTED',
      `考核 #${id} 已交卷，重复交卷拒绝`);
  }
  if (row.status === 'terminated') {
    throw InterlockError(409, 'EXAM_TERMINATED',
      `考核 #${id} 已终止（${row.end_reason || '副本回退或重置'}），不能交卷；已终止记录仍可查询`);
  }

  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `UPDATE exams SET status='submitted', submitted_at=@now,
              used_ms=used_ms + MAX(0, @now - COALESCE(live_since, @now)),
              live_since=NULL
        WHERE id=@id AND status='in_progress'`
    ).run({ now, id });
  })();
  return getExam(id);
}

/* ------------------- 检查点回退 / 站场重置：终止考核 ------------------- */

/**
 * 终止当前副本进行中的考核（检查点回退 / 站场重置事务内调用）。
 * 已交卷（submitted）与已终止记录保留。
 * @returns {number} 被终止的考核编号（无则 null）
 */
function terminateActiveInTxn(reasonText, nowMs = Date.now()) {
  const db = getDb();
  const row = db.prepare(`SELECT id, used_ms, live_since FROM exams WHERE status='in_progress'`).get();
  if (!row) return null;
  db.prepare(
    `UPDATE exams SET status='terminated', terminated_at=?, end_reason=?,
            used_ms=used_ms + MAX(0, ? - COALESCE(live_since, ?)),
            live_since=NULL
      WHERE id=?`
  ).run(nowMs, reasonText, nowMs, nowMs, row.id);
  return row.id;
}

/* ------------------------------ 查询 / 序列化 ------------------------------ */

function parseJson(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/** 有效用时（毫秒）：进行中按有效当前时刻实时计算；终态为结算值 */
function effectiveElapsedMs(row, now) {
  const base = Number(row.used_ms || 0);
  if (row.status !== 'in_progress') return base;
  if (row.live_since == null) return base; // 暂停冻结中
  return base + Math.max(0, now - Number(row.live_since));
}

function rowToInstanceReg(row) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    routeId: row.route_id,
    openedBy: row.opened_by,
    source: row.source,                 // manual / waiting（定时走行不另开实例）
    targetSeq: row.target_seq,          // 挂接目标序号；偏差为 null
    deviation: !!row.is_deviation,
    completed: row.completed_at != null,
    completedAt: row.completed_at,      // 逐段走行正常解除时刻；未完成为 null
    note: row.note,
    createdAt: row.created_at
  };
}

function rowToExam(row) {
  if (!row) return null;
  const db = getDb();
  const now = require('./pause').effectiveNow();

  const targetRows = db.prepare(
    `SELECT * FROM exam_targets WHERE exam_id=? ORDER BY seq`
  ).all(row.id);
  const targets = targetRows.map((t) => ({
    seq: t.seq,
    routeId: t.route_id,
    label: t.label,
    status: t.status,                   // pending / done
    done: t.status === 'done',
    instanceId: t.instance_id,
    completedAt: t.completed_at
  }));
  const regs = db.prepare(
    `SELECT * FROM exam_instances WHERE exam_id=? ORDER BY id`
  ).all(row.id).map(rowToInstanceReg);
  const deviations = regs.filter((r) => r.deviation);

  return {
    id: row.id,
    student: row.student,
    status: row.status,                 // in_progress / submitted / terminated
    inProgress: row.status === 'in_progress',
    targets,
    currentTarget: targets.find((t) => t.status === 'pending') || null,
    completedTargetCount: targets.filter((t) => t.status === 'done').length,
    totalTargetCount: targets.length,
    allTargetsDone: targets.length > 0 && targets.every((t) => t.status === 'done'),
    instances: regs,                    // 学员在本场考核中的全部新实例登记
    deviations,                         // 顺序外/目标外开放（即使未走完也列出）
    deviationCount: deviations.length,
    startedBy: row.started_by,
    startedAt: row.started_at,
    startedAtText: new Date(Number(row.started_at)).toLocaleString('zh-CN', { hour12: false }),
    submittedAt: row.submitted_at,
    terminatedAt: row.terminated_at,
    endReason: row.end_reason,
    effectiveElapsedMs: effectiveElapsedMs(row, now), // 有效用时（暂停冻结）
    startState: parseJson(row.start_state, {})        // 开考起始状态快照
  };
}

function getExam(id) {
  const row = getDb().prepare(`SELECT * FROM exams WHERE id=?`).get(Number(id));
  return row ? rowToExam(row) : null;
}

/**
 * 考核列表：进行中在前（最新开考在前），交卷/已终止在后（最近结束在前）。
 */
function listExams() {
  const rows = getDb().prepare(
    `SELECT * FROM exams
      ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
               CASE status WHEN 'in_progress' THEN id ELSE -COALESCE(submitted_at, terminated_at, id) END DESC,
               id DESC`
  ).all();
  return rows.map(rowToExam);
}

/** /api/state 快照用：当前进行中考核 + 最近若干场（刷新/重启后可展示） */
function getStateSummary() {
  const db = getDb();
  const currentRow = db.prepare(`SELECT * FROM exams WHERE status='in_progress'`).get();
  const recentRows = db.prepare(
    `SELECT * FROM exams ORDER BY
       CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, id DESC LIMIT ?`
  ).all(RECENT_LIMIT);
  return {
    current: currentRow ? rowToExam(currentRow) : null,
    recent: recentRows.map(rowToExam)
  };
}

module.exports = {
  MAX_TARGETS,
  startExam,
  submitExam,
  recordOpenInTxn,
  recordWalkthroughReleaseInTxn,
  terminateActiveInTxn,
  getExam,
  listExams,
  getStateSummary
};
