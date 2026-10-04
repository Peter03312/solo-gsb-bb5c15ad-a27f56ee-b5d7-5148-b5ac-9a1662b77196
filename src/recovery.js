'use strict';

/**
 * 进程中断后的站场状态收敛（故障恢复）。
 *
 * 副本创建、暂停、恢复同时改写【主库注册表】与【站场独立业务库】。SQLite
 * 的跨库 ATTACH 事务在多个 WAL 业务库之间不提供崩溃原子性，因此本模块把这
 * 三类操作重写为"意图台账 + 若干个单库事务"的序列，并在服务启动（以及同一
 * 操作重试）时按本模块把中断残留收敛到操作前或操作后的完整状态：
 *
 *  副本创建 create_copy：
 *    1) 注册行以 status='creating' 落库（占用编号与同名）；
 *    2) 业务库完整复制到临时文件（单库事务内连 yard_copy_manifest 一并写入）；
 *    3) 临时文件原子改名为正式文件；
 *    4) 注册行翻转 active、删除意图行，随后按既有规则做新副本首次复核。
 *    中断在 1~3：重启删除注册行与残留文件 → 操作前（同名释放，编号不回收复用）；
 *    中断在 4 之后：校验文件完整即翻转 active → 操作后。绝不留下"已注册却
 *    打不开"或"只复制部分数据"的副本。
 *
 *  暂停 pause：
 *    1) 主库登记意图（携带 pausedAt/pausedBy）；
 *    2) 业务库单库事务：考核有效用时结算（used_ms += pausedAt-live_since，
 *       live_since=NULL）+ 写 yard_paused 审计界标（二者同成同败）；
 *    3) 主库单库事务翻转 status='paused' 并删除意图。
 *
 *  恢复 resume：
 *    1) 主库登记意图（携带 pausedAt/shiftMs/resumedAt）；
 *    2) 业务库单库事务：平移活动计划当前步 due_at 与待处理延时取消
 *       release_at（仅平移暂停时刻仍未到期者）、考核 live_since 重设、
 *       写 yard_resumed 审计界标（含 shiftMs 与受影响数量）；
 *    3) 主库单库事务翻转 status='active' 并删除意图。
 *
 * 收敛判据以业务库中的审计界标（yard_paused/yard_resumed，按
 * ref_id/refType=yard 精确匹配本操作的发生时刻）为准：
 *  - 界标不存在 → 业务库变更未生效，按操作前收敛（可能需回补/清理主库）；
 *  - 界标已存在 → 业务库变更已生效且天然完整（同事务），只补主库翻转，
 *    绝不重复平移、重复记账或重复写界标。
 *
 * 无法自动修复的损坏（业务库文件缺失/无法打开/完整性校验失败/清单不符）：
 * 对应副本标记 status='broken' 并写明原因，该副本的所有访问被明确拒绝；
 * 其他站场的启动复核与正常使用不受影响。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  ORIGINAL_YARD_ID,
  getMainDb, yardsDir, yardDbPath, yardDbFile, readSql,
  getYardConnection, dropYardConnection, withYard
} = require('./db');

/* ------------------------------ 意图台账 ------------------------------ */

/** 登记一条待完成的站场操作意图（主库单条写入）。 */
function insertOp(yardId, op, operator, params = {}) {
  getMainDb().prepare(
    `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
     VALUES(?,?, 'pending', ?, ?, ?)`
  ).run(yardId, op, operator == null ? null : String(operator), Date.now(), JSON.stringify(params));
}

function getPendingOp(yardId, op) {
  const row = getMainDb().prepare(
    `SELECT * FROM yard_ops WHERE yard_id=? AND op=? AND status='pending'`
  ).get(yardId, op);
  return row || null;
}

function clearOp(yardId, op) {
  getMainDb().prepare(
    `DELETE FROM yard_ops WHERE yard_id=? AND op=? AND status='pending'`
  ).run(yardId, op);
}

function parseParams(row) {
  try { return JSON.parse(row.params_json || '{}'); } catch (_) { return {}; }
}

/* ------------------------------ 损坏隔离 ------------------------------ */

/**
 * 把站场标记为 broken（损坏隔离）：其他站场照常使用；该站场之后的所有
 * 访问都会被 resolveSessionYard/openYard 明确拒绝并说明原因。
 * 主库单行更新，永不抛出（标记失败只记录日志，避免阻断启动循环）。
 */
function markBroken(yardId, reason) {
  const db = getMainDb();
  const text = `站场 #${yardId} 业务库损坏，已隔离拒绝访问：${reason}`;
  try {
    db.prepare(
      `UPDATE yards SET status='broken', broken_reason=?, broken_at=? WHERE id=?`
    ).run(String(reason).slice(0, 1000), Date.now(), yardId);
  } catch (e) {
    console.error('[recovery] 标记站场损坏失败:', text, e);
    return;
  }
  dropYardConnection(yardId);
  console.error('[recovery] ' + text);
}

/**
 * 校验已注册站场的业务库是否可安全打开且结构完整。
 * 返回 true=完整；false/抛错=无法自动修复（调用方标记 broken）。
 * @param {Object} row yards 注册行
 */
function validateRegisteredYard(row) {
  const filePath = yardDbPath(row.id);
  if (!fs.existsSync(filePath)) {
    throw new Error(`业务数据文件 ${yardDbFile(row.id)} 不存在（可能在创建/写入过程中进程中断且文件丢失）`);
  }
  let conn;
  try {
    conn = new Database(filePath, { fileMustExist: true });
    const ok = conn.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error(`数据库完整性校验未通过（quick_check=${ok}）`);
    const t = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit_entries'`)
      .get();
    if (!t) throw new Error('业务库缺少 audit_entries 表（文件不是完整的站场业务库）');
    if (row.kind === 'copy') {
      const m = conn.prepare(`SELECT * FROM yard_copy_manifest WHERE yard_id=?`).get(row.id);
      if (!m) throw new Error('业务库缺少副本创建清单 yard_copy_manifest（副本可能只复制了部分数据）');
      if (m.source_yard_id !== ORIGINAL_YARD_ID) {
        throw new Error(`副本创建清单来源站场异常（source=${m.source_yard_id}）`);
      }
    }
    return true;
  } finally {
    if (conn) try { conn.close(); } catch (_) {}
  }
}

/** 删除某副本编号的正式文件与复制临时残留（尽力清理，文件缺失不算错误）。 */
function removeYardFiles(yardId) {
  const dir = yardsDir();
  for (const p of [
    path.join(dir, yardDbFile(yardId)),
    path.join(dir, `yard-${yardId}.copying.tmp`)
  ]) {
    for (const f of [p, p + '-wal', p + '-shm']) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

/* ---------------------- 业务库侧界标查询（收敛判据） ---------------------- */

/** 打开业务库做读写检查/收敛（不使用缓存连接，避免与损坏隔离互相污染）。 */
function openAux(yardId) {
  const conn = new Database(yardDbPath(yardId), { fileMustExist: true });
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  return conn;
}

/** 判断错误是否属于业务库损坏（无法自动修复）。 */
function isCorruptionError(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e || '');
  return code === 'YARD_DB_MISSING' || code === 'YARD_DB_CORRUPT' ||
    /SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|database disk image is malformed/i.test(msg);
}

/**
 * 查询某次暂停是否已在业务库留下匹配的 yard_paused 界标。
 * 匹配条件：refType=yard、ref_id=yardId、occurred_at=pausedAt。
 */
function findPauseMarker(conn, yardId, pausedAt) {
  return conn.prepare(
    `SELECT seq, occurred_at AS occurredAt FROM audit_entries
      WHERE type='yard_paused' AND ref_type='yard' AND ref_id=? AND occurred_at=?
      ORDER BY seq DESC LIMIT 1`
  ).get(String(yardId), pausedAt) || null;
}

function findResumeMarker(conn, yardId, resumedAt) {
  return conn.prepare(
    `SELECT seq, occurred_at AS occurredAt, detail FROM audit_entries
      WHERE type='yard_resumed' AND ref_type='yard' AND ref_id=? AND occurred_at=?
      ORDER BY seq DESC LIMIT 1`
  ).get(String(yardId), resumedAt) || null;
}

/* ------------------------------ 意图收敛 ------------------------------ */

/**
 * 收敛单个中断残留的暂停/恢复意图。幂等：可被启动流程与运行时重试反复调用。
 * @param {Object} op yard_ops 行
 * @returns {{converged:string, yard:number}} 'before' 收敛到操作前 / 'after' 操作后
 */
function reconcilePauseResumeOp(op) {
  const main = getMainDb();
  const row = main.prepare(`SELECT * FROM yards WHERE id=?`).get(op.yard_id);
  if (!row) {
    clearOp(op.yard_id, op.op);
    return { converged: 'before', yard: op.yard_id };
  }
  const p = parseParams(op);
  const filePath = yardDbPath(op.yard_id);

  // 业务库文件缺失/无法打开/损坏：无法自动修复——若主库已经翻转则保留
  // 翻转结果并隔离；尚未翻转则回到操作前（删除意图，保持原状态）。
  let conn = null;
  let broken = null;
  if (!fs.existsSync(filePath)) {
    broken = '业务数据文件不存在';
  } else {
    try {
      conn = openAux(op.yard_id);
      const ok = conn.pragma('quick_check', { simple: true });
      if (ok !== 'ok') broken = `数据库完整性校验未通过（quick_check=${ok}）`;
    } catch (e) {
      broken = `业务库无法打开（${e.message}）`;
    }
  }
  if (broken) {
    if (conn) try { conn.close(); } catch (_) {}
    // 已注册站场的业务库不可用且无法核实操作结果：不能安全地宣称操作前或
    // 操作后，按损坏隔离（明确拒绝访问并说明原因），避免后续请求在未知状态
    // 上继续读写。主库已翻转为 paused 的保留该展示状态，一并标记 broken。
    clearOp(op.yard_id, op.op);
    markBroken(op.yard_id, broken);
    return { converged: row.status === 'paused' ? 'after' : 'before', yard: op.yard_id };
  }

  try {
    if (op.op === 'pause') {
      return reconcilePause(conn, row, p);
    }
    return reconcileResume(conn, row, p);
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

/** 暂停意图收敛。 */
function reconcilePause(conn, row, p) {
  const main = getMainDb();
  const now = Number(p.now);
  const marker = findPauseMarker(conn, row.id, now);

  if (marker) {
    // 业务库事务（考核结算 + 界标）已生效 → 收敛到操作后：仅补主库翻转。
    // 不再触碰业务库（不会重复记账/重复写界标）。
    main.prepare(
      `UPDATE yards SET status='paused', paused_by=?, paused_at=?,
              resumed_by=NULL, resumed_at=NULL WHERE id=?`
    ).run(p.pausedBy == null ? null : String(p.pausedBy), now, row.id);
    clearOp(row.id, 'pause');
    return { converged: 'after', yard: row.id };
  }

  // 界标不存在：业务库变更未生效（旧版跨库事务撕裂也可能只留下部分变更，
  // 但结算与界标在同一事务内，无界标即结算必然未提交）。
  if (row.status === 'paused') {
    // 罕见撕裂：主库翻转了、业务库没翻。业务库无法安全补算（live_since
    // 起始信息已由意图携带，used_ms 可幂等重算），故在单库事务内补齐
    // 与原暂停完全相同的结算并补写界标——仍只写一次。
    settlePauseInYardTxn(conn, row, p);
    clearOp(row.id, 'pause');
    return { converged: 'after', yard: row.id };
  }
  // 操作前：什么都没发生，删除意图即可
  clearOp(row.id, 'pause');
  return { converged: 'before', yard: row.id };
}

/** 恢复意图收敛。 */
function reconcileResume(conn, row, p) {
  const main = getMainDb();
  const now = Number(p.now);
  const pausedAt = Number(p.pausedAt);
  const shiftMs = Math.max(0, Number(p.shiftMs) || 0);
  const marker = findResumeMarker(conn, row.id, now);

  if (marker) {
    // 业务库事务（平移 + 考核重设 + 界标）已生效 → 仅补主库翻转。
    main.prepare(
      `UPDATE yards SET status='active', resumed_by=?, resumed_at=?,
              paused_by=NULL, paused_at=NULL WHERE id=?`
    ).run(p.resumedBy == null ? null : String(p.resumedBy), now, row.id);
    clearOp(row.id, 'resume');
    return { converged: 'after', yard: row.id };
  }

  // 界标不存在：平移/记账均未提交，按意图参数在业务库单库事务内执行一次。
  // 对"主库已翻 active、业务库未翻"的撕裂同样适用：平移只做一次，幂等。
  settleResumeInYardTxn(conn, row, p);
  main.prepare(
    `UPDATE yards SET status='active', resumed_by=?, resumed_at=?,
            paused_by=NULL, paused_at=NULL WHERE id=?`
  ).run(p.resumedBy == null ? null : String(p.resumedBy), now, row.id);
  clearOp(row.id, 'resume');
  return { converged: 'after', yard: row.id };
}

/* --------- 暂停/恢复的业务库单库事务体（pause.js 与收敛共用） --------- */

/**
 * 暂停业务库事务：考核有效用时结算 + yard_paused 界标，同成同败。
 * 可在独立连接（恢复收敛）或缓存连接（pause.js）上执行。
 */
function settlePauseInYardTxn(conn, row, p) {
  const now = Number(p.now);
  const audit = require('./audit');
  conn.transaction(() => {
    conn.prepare(
      `UPDATE exams SET used_ms = used_ms + MAX(0, ? - COALESCE(live_since, ?)),
              live_since = NULL
        WHERE status='in_progress'`
    ).run(now, now);
    audit.insertEntryInTxn(conn, 'audit_entries', {
      yardId: row.id,
      type: 'yard_paused',
      refType: 'yard', refId: row.id,
      actor: p.pausedBy == null ? null : String(p.pausedBy),
      before: { status: 'active', paused: false },
      after: { status: 'paused', paused: true,
               pausedBy: p.pausedBy == null ? null : String(p.pausedBy), pausedAt: now },
      detail: { pausedAt: now },
      occurredAt: now
    });
  })();
}

/**
 * 恢复业务库事务：平移到期时间（仅暂停时刻仍未到期者）、考核 live_since
 * 重设、yard_resumed 界标，同成同败。返回受影响条目数。
 */
function settleResumeInYardTxn(conn, row, p) {
  const now = Number(p.now);
  const pausedAt = Number(p.pausedAt);
  const shiftMs = Math.max(0, Number(p.shiftMs) || 0);
  const audit = require('./audit');
  let adjusted = { movementPlanSteps: 0, cancellations: 0 };
  conn.transaction(() => {
    const planResult = conn.prepare(
      `UPDATE movement_plan_steps
          SET due_at = due_at + @shiftMs
        WHERE status='pending'
          AND due_at IS NOT NULL
          AND due_at > @pausedAt
          AND plan_id IN (SELECT id FROM movement_plans WHERE status='active')`
    ).run({ shiftMs, pausedAt });
    const cancelResult = conn.prepare(
      `UPDATE cancellation_applications
          SET release_at = release_at + @shiftMs
        WHERE status='pending' AND release_at > @pausedAt`
    ).run({ shiftMs, pausedAt });
    conn.prepare(
      `UPDATE exams SET live_since = @now
        WHERE status='in_progress' AND live_since IS NULL`
    ).run({ now });
    adjusted = { movementPlanSteps: planResult.changes, cancellations: cancelResult.changes };
    audit.insertEntryInTxn(conn, 'audit_entries', {
      yardId: row.id,
      type: 'yard_resumed',
      refType: 'yard', refId: row.id,
      actor: p.resumedBy == null ? null : String(p.resumedBy),
      before: { status: 'paused', paused: true,
                pausedBy: row.paused_by || null, pausedAt },
      after: { status: 'active', paused: false,
               resumedBy: p.resumedBy == null ? null : String(p.resumedBy), resumedAt: now },
      detail: { resumedAt: now, shiftMs, adjusted },
      occurredAt: now
    });
  })();
  return adjusted;
}

/* ------------------------------ 创建副本收敛 ------------------------------ */

/**
 * 收敛 status='creating' 的副本注册行。
 * @returns {'activated'|'aborted'} 激活为可用副本 / 回滚到操作前
 */
function reconcileCreatingYard(row) {
  const main = getMainDb();
  const finalPath = yardDbPath(row.id);
  const tmpPath = path.join(yardsDir(), `yard-${row.id}.copying.tmp`);
  const op = getPendingOp(row.id, 'create_copy');

  // 正式文件完整且清单匹配：创建实际已完成，只需把注册行翻转 active。
  if (fs.existsSync(finalPath)) {
    let complete = false;
    let conn = null;
    try {
      conn = new Database(finalPath, { fileMustExist: true });
      if (conn.pragma('quick_check', { simple: true }) === 'ok') {
        const m = conn.prepare(`SELECT * FROM yard_copy_manifest WHERE yard_id=?`).get(row.id);
        complete = !!m && m.source_yard_id === ORIGINAL_YARD_ID;
      }
    } catch (_) {
      complete = false;
    } finally {
      if (conn) try { conn.close(); } catch (_) {}
    }
    if (complete) {
      main.prepare(`UPDATE yards SET status='active' WHERE id=? AND status='creating'`)
        .run(row.id);
      if (op) clearOp(row.id, 'create_copy');
      for (const f of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
      return 'activated';
    }
    // 正式文件存在但不完整/损坏：无法自动修复，但注册行可能已被外界观察到。
    // 按"操作前"处理：删除残缺文件与注册行（名称释放），由管理员重新创建。
    removeYardFiles(row.id);
    main.prepare(`DELETE FROM yards WHERE id=? AND status='creating'`).run(row.id);
    if (op) clearOp(row.id, 'create_copy');
    return 'aborted';
  }

  // 正式文件不存在：复制未到改名步骤。临时文件完整（极罕见：改名前进程中断）
  // 则改名激活；否则连同注册行一起回到操作前。
  if (fs.existsSync(tmpPath)) {
    let complete = false;
    let conn = null;
    try {
      conn = new Database(tmpPath, { fileMustExist: true });
      if (conn.pragma('quick_check', { simple: true }) === 'ok') {
        const m = conn.prepare(`SELECT * FROM yard_copy_manifest WHERE yard_id=?`).get(row.id);
        complete = !!m && m.source_yard_id === ORIGINAL_YARD_ID;
      }
    } catch (_) {
      complete = false;
    } finally {
      if (conn) try { conn.close(); } catch (_) {}
    }
    if (complete) {
      dropYardConnection(row.id);
      fs.renameSync(tmpPath, finalPath);
      for (const f of [tmpPath + '-wal', tmpPath + '-shm']) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
      main.prepare(`UPDATE yards SET status='active' WHERE id=? AND status='creating'`)
        .run(row.id);
      if (op) clearOp(row.id, 'create_copy');
      return 'activated';
    }
  }

  removeYardFiles(row.id);
  main.prepare(`DELETE FROM yards WHERE id=? AND status='creating'`).run(row.id);
  if (op) clearOp(row.id, 'create_copy');
  return 'aborted';
}

/* ------------------------------ 启动总收敛 ------------------------------ */

let reconciled = false;

/**
 * 服务启动收敛（在建表/迁移之后、seed 与各站场复核之前执行一次）：
 *  1. 清理中断残留的副本创建（creating）；
 *  2. 收敛中断残留的暂停/恢复意图；
 *  3. 校验全部已注册站场业务库，损坏者隔离为 broken，其他站场照常；
 *  4. 清理无注册行的孤儿业务库/临时文件。
 * 返回新激活（创建中断后补完成）的副本编号列表，供启动方做"首次复核"。
 */
function reconcileOnStartup() {
  const main = getMainDb();
  const log = [];

  // 1) 副本创建中断
  const creating = main.prepare(`SELECT * FROM yards WHERE status='creating' ORDER BY id`).all();
  for (const row of creating) {
    try {
      const r = reconcileCreatingYard(row);
      log.push(`站场 #${row.id} ${row.name} 创建中断收敛：${r === 'activated' ? '文件完整，已激活' : '复制未完成，已回滚（注册行与残留文件已清理，可重新创建）'}`);
    } catch (e) {
      console.error(`[recovery] 站场 ${row.id} 创建收敛失败:`, e);
      markBroken(row.id, `创建中断收敛失败：${e.message}`);
    }
  }

  // 2) 暂停/恢复中断（收敛过程中可能把损坏库隔离）
  const ops = main.prepare(
    `SELECT * FROM yard_ops WHERE status='pending' ORDER BY id`
  ).all();
  for (const op of ops) {
    try {
      const r = reconcilePauseResumeOp(op);
      log.push(`站场 #${op.yard_id} ${op.op === 'pause' ? '暂停' : '恢复'}` +
        `中断收敛：已收敛到${r.converged === 'after' ? '操作后完整状态' : '操作前状态'}`);
    } catch (e) {
      console.error(`[recovery] 站场 ${op.yard_id} ${op.op} 收敛失败:`, e);
    }
  }

  // 3) 校验已注册站场业务库完整性
  const readyYards = [];
  for (const row of main.prepare(`SELECT * FROM yards ORDER BY id`).all()) {
    if (row.status === 'broken') { readyYards.push(row); continue; }
    if (row.status === 'creating') continue; // 理论已被步骤 1 处理
    try {
      validateRegisteredYard(row);
      readyYards.push(row);
    } catch (e) {
      markBroken(row.id, e.message);
      row.status = 'broken';
      readyYards.push(row);
    }
  }

  // 4) 孤儿临时文件清理（.copying.tmp；正式业务库在无注册行时保留以免误删）
  try {
    const dir = yardsDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/^yard-\d+\.copying\.tmp(-wal|-shm)?$/.test(f)) {
          const m = f.match(/^yard-(\d+)\./);
          const id = m ? Number(m[1]) : 0;
          const registered = main.prepare(`SELECT 1 FROM yards WHERE id=?`).get(id);
          if (!registered || registered.status === 'broken') {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
          }
        }
      }
    }
  } catch (e) {
    console.error('[recovery] 孤儿临时文件清理失败:', e);
  }

  reconciled = true;
  for (const line of log) console.log('[recovery] ' + line);
  return readyYards;
}

/**
 * 运行时重试前先收敛该站场的中断意图（同一操作被再次调用时执行）。
 * 同步执行，返回收敛结果数组。
 */
function reconcileYardOps(yardId) {
  const out = [];
  for (const opName of ['pause', 'resume', 'create_copy']) {
    const op = getPendingOp(yardId, opName);
    if (!op) continue;
    if (opName === 'create_copy') {
      const row = getMainDb().prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
      if (row && row.status === 'creating') out.push(reconcileCreatingYard(row));
      else clearOp(yardId, 'create_copy');
    } else {
      out.push(reconcilePauseResumeOp(op));
    }
  }
  return out;
}

/**
 * 扫描/请求过程中发现业务库损坏时隔离该站场，返回是否已隔离。
 * 其他站场的调用方据此跳过该站场、继续处理其余站场。
 */
function quarantineIfCorrupt(yardId, e) {
  if (!isCorruptionError(e)) return false;
  markBroken(yardId, String((e && e.message) || e));
  return true;
}

module.exports = {
  insertOp,
  getPendingOp,
  clearOp,
  parseParams,
  markBroken,
  isCorruptionError,
  quarantineIfCorrupt,
  validateRegisteredYard,
  removeYardFiles,
  openAux,
  findPauseMarker,
  findResumeMarker,
  settlePauseInYardTxn,
  settleResumeInYardTxn,
  reconcileCreatingYard,
  reconcilePauseResumeOp,
  reconcileOnStartup,
  reconcileYardOps
};
