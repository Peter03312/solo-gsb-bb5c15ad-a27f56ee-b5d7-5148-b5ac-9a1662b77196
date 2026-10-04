'use strict';

/**
 * 站场注册与命名演练副本。
 *
 * 存储模型见 db.js：主库保存 yards 注册表与 sessions；每个站场（原站场 +
 * 各命名副本）各自拥有一份业务库文件，结构为 schema-yard.sql。
 *
 * 管理员可从【原站场】创建命名演练副本。为保证"进程中断后重启自动收敛到
 * 操作前或操作后的完整状态"，创建流程不再依赖跨多个 WAL 库的 ATTACH 大事务，
 * 而是拆成各自原子的单库步骤，并由 recovery 模块在启动/重试时收敛：
 *
 *   1. 主库事务：同名校验后写注册行 status='creating' + yard_ops 意图
 *      （此时即占用编号与名称；编号因 AUTOINCREMENT 不回收复用）；
 *   2. 临时业务库 yard-<id>.copying.tmp 内【单库事务】完成全部复制：
 *      定义/状态/开放实例与锁和事件/等待/延时取消/封锁/meta/自增序列，
 *      以及 yard_created 审计界标与 yard_copy_manifest 复制清单；
 *   3. 临时文件原子改名为正式业务库文件；
 *   4. 主库事务：注册行翻转为 active、删除意图行；
 *   5. 按"服务重启后复核"的同一套流程做新副本首次复核（幂等，可在启动时
 *      由调度器补做，因此中断在 5 不影响一致性）。
 *
 * 中断恢复（recovery.reconcileOnStartup / reconcileCreatingYard）：
 *  - 中断在 1~3（无正式文件或临时文件无完整清单）：删除注册行与残留文件，
 *    回到操作前，释放同名，不会留下"已注册却打不开/只复制部分数据"的副本；
 *  - 中断在 4（正式文件完整、清单在）：注册行翻转 active，收敛到操作后。
 *
 * 复制范围（需求逐项对应）：
 *  - 站场定义：sections / switches / signals / routes / route_steps /
 *    route_switch_reqs（含区段占用状态 occ_state、道岔实际位置 position）；
 *  - 开放进路的锁与事件进度：仅 status='open' 的 route_instances 及其
 *    route_locks、section_events（已解除的历史实例不复制）；
 *  - 未兑现等待申请：waiting_applications 中 status='waiting'；
 *  - 未完结延时取消：cancellation_applications 中 status='pending'，
 *    requested_at / release_at 原样保留（沿用原到期时刻，重启后按各站场
 *    分别复核，不重新计时、不重复兑现）；
 *  - 未结束临时封锁：blockade_applications 中 status IN ('pending','active')；
 *  - meta（含延时取消保护时长快照）；
 *  - 历史交接单 handover_documents 留在原站场，不复制。
 *
 * 所有行的自增主键（进路实例、等待/取消/封锁申请编号等）保持不变，
 * 副本编号与状态在响应中返回。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  ORIGINAL_YARD_ID, ORIGINAL_YARD_NAME,
  getMainDb, dropYardConnection,
  withYard, withMainDb, yardsDir, yardDbFile, yardDbPath, readSql
} = require('./db');
const recovery = require('./recovery');

const NAME_RE = /^\S(?:.*\S)?$/;
const MAX_NAME_LEN = 30;
// "原站场"为原站场保留名，副本不允许占用（同名拒绝也会拦截，此处给出更明确的报错）
const RESERVED_NAMES = new Set([ORIGINAL_YARD_NAME]);

/** 自动编号的业务表：复制行时同步复制 sqlite_sequence，避免副本后续编号撞车 */
const AUTOINCR_TABLES = [
  'route_steps', 'route_switch_reqs', 'route_instances', 'route_locks',
  'section_events', 'waiting_applications', 'cancellation_applications',
  'blockade_applications', 'handover_documents'
];

/** 站场定义表（整表复制） */
const DEFINITION_TABLES = [
  'sections', 'switches', 'signals', 'routes', 'route_steps', 'route_switch_reqs'
];

/* ------------------------------ 初始化 / 迁移 ------------------------------ */

function yardRow(yardId) {
  return getMainDb().prepare(`SELECT * FROM yards WHERE id=?`).get(yardId) || null;
}

function yardByName(name) {
  return getMainDb().prepare(`SELECT * FROM yards WHERE name=?`).get(name) || null;
}

function listYards() {
  return getMainDb()
    .prepare(`SELECT id, name, kind, source_yard_id AS sourceYardId, status,
                     created_by AS createdBy, paused_by AS pausedBy,
                     paused_at AS pausedAt, resumed_by AS resumedBy,
                     resumed_at AS resumedAt, broken_reason AS brokenReason,
                     broken_at AS brokenAt, created_at AS createdAt
                FROM yards ORDER BY id`)
    .all()
    .map((y) => ({
      ...y,
      isOriginal: y.id === ORIGINAL_YARD_ID,
      paused: y.status === 'paused',
      broken: y.status === 'broken'
    }));
}

/**
 * 确保原站场（id=1）注册存在、业务库就绪。服务启动与 init-db 时调用一次：
 *  - 全新主库（无任何业务表数据）：创建空的 yard-1.db（由启动流程 seed）；
 *  - 旧版主库（业务数据直接在主库）：在主库事务内把全部业务表整体复制到
 *    yard-1.db（含历史交接单），主库业务表原样保留（不再被业务路径读写）。
 *  - yards 已注册：幂等返回。
 * 注：启动故障收敛（recovery.reconcileOnStartup）在本函数【之后】执行；
 * 原站场文件缺失的恢复路径（注册存在、文件缺失）由其标记 broken 或
 * 重新建空库（全新环境首启时 targetPath 尚不存在，见下）。
 */
function ensureRegistry() {
  const db = getMainDb();
  const existing = yardRow(ORIGINAL_YARD_ID);
  if (existing) return existing;

  const dir = yardsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const targetPath = yardDbPath(ORIGINAL_YARD_ID);

  let migrated = false;
  try {
    db.transaction(() => {
      if (fs.existsSync(targetPath)) {
        // 文件已存在（注册表缺失的异常恢复路径）：直接注册，不覆盖数据
        db.prepare(
          `INSERT INTO yards(id,name,kind,source_yard_id,status,db_file,created_by)
           VALUES(?,?, 'original',NULL,'active',?,NULL)`
        ).run(ORIGINAL_YARD_ID, ORIGINAL_YARD_NAME, yardDbFile(ORIGINAL_YARD_ID));
        return;
      }

      const legacy = db.prepare(`SELECT COUNT(*) AS n FROM sections`).get().n > 0;
      // 准备业务库文件（含表结构）；全新安装为空库，旧版库随后复制数据
      initBlankYardFile(targetPath);

      db.prepare(
        `INSERT INTO yards(id,name,kind,source_yard_id,status,db_file,created_by)
         VALUES(?,?, 'original',NULL,'active',?,NULL)`
      ).run(ORIGINAL_YARD_ID, ORIGINAL_YARD_NAME, yardDbFile(ORIGINAL_YARD_ID));

      if (legacy) {
        // 旧版库业务数据整体迁移为原站场（含全部历史与交接单）。
        // 在同一注册事务内 ATTACH 刚建好的空业务库复制；DETACH 放到事务结束后。
        db.prepare(`ATTACH DATABASE ? AS migdst`).run(targetPath);
        copyLegacyDataInTxn(db, 'migdst');
        migrated = true;
      }
    })();
  } catch (e) {
    try { db.exec(`DETACH DATABASE migdst`); } catch (_) {}
    throw e;
  }
  if (migrated) {
    try { db.exec(`DETACH DATABASE migdst`); } catch (_) {}
  }

  return yardRow(ORIGINAL_YARD_ID);
}

/**
 * 旧版主库业务表整体复制到已 ATTACH 的空业务库（在注册事务内调用）。
 * 全量复制（含历史交接单）；自增序列一并对齐，迁移后继续沿旧编号递增。
 */
function copyLegacyDataInTxn(db, dstAlias) {
  for (const t of ALL_BUSINESS_TABLES) {
    db.exec(`INSERT INTO ${dstAlias}.${t} SELECT * FROM main.${t}`);
  }
  db.prepare(`DELETE FROM ${dstAlias}.sqlite_sequence
              WHERE name IN (${ALL_BUSINESS_TABLES.map(() => '?').join(',')})`)
    .run(...ALL_BUSINESS_TABLES);
  const seqs = db.prepare(`SELECT name, seq FROM main.sqlite_sequence`).all();
  const upSeq = db.prepare(
    `INSERT OR REPLACE INTO ${dstAlias}.sqlite_sequence(name,seq) VALUES(?,?)`);
  for (const s of seqs) {
    if (ALL_BUSINESS_TABLES.includes(s.name)) upSeq.run(s.name, s.seq);
  }
}

/** 创建一个仅含业务表结构的空业务库文件（DELETE 日志模式收尾，保证可安全改名） */
function initBlankYardFile(filePath) {
  const conn = new Database(filePath);
  try {
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.exec(readSql('schema-yard.sql'));
    // 立即把 WAL 落回主文件并以 DELETE 模式收尾，保证随后可安全改名/单独复制
    conn.pragma('journal_mode = DELETE');
  } finally {
    conn.close();
  }
  cleanupSidecars(filePath);
}

/** 站场业务表全集（旧库整体迁移时使用） */
const ALL_BUSINESS_TABLES = [
  'meta',
  'sections', 'switches', 'signals', 'routes', 'route_steps', 'route_switch_reqs',
  'route_instances', 'route_locks', 'section_events',
  'waiting_applications', 'cancellation_applications', 'blockade_applications',
  'handover_documents',
  // 定时走行计划不随副本复制，但旧单库整体迁移为原站场时随表迁移（保持数据完整）
  'movement_plans', 'movement_plan_steps'
];

/* ------------------------------ 副本创建 ------------------------------ */

/**
 * 从原站场创建命名演练副本（管理员）。
 * @param {string} rawName 副本名称（1~30 字，去首尾空白；同名拒绝）
 * @param {string} createdBy 创建人（管理员姓名）
 * @returns {{yard:Object, detail:Object}} 副本编号、状态与复制明细
 */
function createCopyFromOriginal(rawName, createdBy) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name || !NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    const err = new Error(`副本名称需为 1~${MAX_NAME_LEN} 字非空白字符`);
    err.status = 400;
    err.code = 'YARD_NAME_INVALID';
    throw err;
  }
  if (RESERVED_NAMES.has(name)) {
    const err = new Error(`"${ORIGINAL_YARD_NAME}"为原站场保留名称，副本不能使用`);
    err.status = 409;
    err.code = 'YARD_NAME_RESERVED';
    throw err;
  }
  // 注册表读写与复制流程都在主库无站场上下文中完成（避免事务体内 getDb()
  // 被 ALS 误路由）。
  return withMainDb(() => createCopyFlow(name, createdBy));
}

function createCopyFlow(name, createdBy) {
  const db = getMainDb();
  if (yardByName(name)) {
    throw duplicateName(name);
  }

  const dir = yardsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 步骤 1：注册行先以 creating 落库（占用编号与同名），并登记创建意图。
  // 复制/改名期间进程中断时，启动收敛据此回滚（删行+删残留文件）或激活。
  const newId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO yards(name,kind,source_yard_id,status,db_file,created_by)
       VALUES(?, 'copy', ?, 'creating', ?, ?)`
    ).run(name, ORIGINAL_YARD_ID, '__pending__', createdBy);
    const id = Number(info.lastInsertRowid);
    db.prepare(`UPDATE yards SET db_file=? WHERE id=?`).run(yardDbFile(id), id);
    recovery.insertOp(id, 'create_copy', createdBy, { name });
    return id;
  })();

  const finalFile = yardDbFile(newId);
  const finalPath = yardDbPath(newId);
  const tmpPath = path.join(dir, `yard-${newId}.copying.tmp`);
  for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  if (fs.existsSync(finalPath)) {
    // 极端竞态（同编号正式文件已存在）：回滚注册后按"文件已存在"拒绝
    abortCreating(newId);
    const err = new Error(`站场业务库文件 ${finalFile} 已存在，拒绝覆盖`);
    err.status = 409;
    err.code = 'YARD_DB_EXISTS';
    throw err;
  }

  let detail = null;
  let tmpConn = null;
  try {
    // 步骤 2：临时库中【单库事务】完成全部复制（含清单与创建界标）。
    initBlankYardFile(tmpPath);
    tmpConn = new Database(tmpPath);
    tmpConn.pragma('foreign_keys = ON');
    // 源业务库以只读方式 ATTACH 到临时库连接：复制事务只写临时库这一个文件，
    // 其回滚日志保证中断时临时库整体回到"空库"（无清单=未完成），源库只读
    // 不受影响。
    tmpConn.prepare(`ATTACH DATABASE ? AS src`).run(yardDbPath(ORIGINAL_YARD_ID));
    try {
      detail = tmpConn.transaction(() => {
        const d = copyOriginalData(tmpConn, 'src', 'main', {
          yardId: newId, name, createdBy
        });
        writeCopyManifest(tmpConn, 'main', {
          yardId: newId, name, createdBy, copied: d.copied
        });
        return d;
      })();
    } finally {
      try { tmpConn.exec(`DETACH DATABASE src`); } catch (_) {}
    }
    // 复制事务已提交：把 WAL 落回主文件、切回 DELETE 模式后关闭，
    // 保证随后改名的是自洽的单一文件（无 -wal 残留）。
    tmpConn.pragma('journal_mode = DELETE');
    tmpConn.close();
    tmpConn = null;
    cleanupSidecars(tmpPath);

    // 步骤 3：临时文件原子改名落位
    fs.renameSync(tmpPath, finalPath);
    cleanupSidecars(tmpPath);

    // 步骤 4：注册行翻转 active 并清理意图（单主库事务）。中断在本步骤之后、
    // 进程重启时由 reconcileCreatingYard 凭正式文件+清单补做本翻转。
    db.transaction(() => {
      db.prepare(`UPDATE yards SET status='active' WHERE id=? AND status='creating'`)
        .run(newId);
      recovery.clearOp(newId, 'create_copy');
    })();
  } catch (e) {
    if (tmpConn) { try { tmpConn.close(); } catch (_) {} }
    abortCreating(newId);
    for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE' ||
        String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      if (yardByName(name)) throw duplicateName(name);
    }
    throw e;
  }

  const yard = yardRow(newId);
  // 步骤 5：复制完成后按"服务重启后复核"的同一套流程处理新副本（幂等）：
  // 延时取消沿用原 release_at（不重新计时），到期者按副本自身状态核验；
  // 封锁复核与等待兑现均只作用于本副本。
  let post = { blockadesActivated: [], cancellationsReleased: [],
               cancellationsAborted: [], waitingFulfilled: [] };
  try {
    post = activateCopiedYard(newId);
  } catch (e) {
    // 首次复核失败不影响副本完整性：调度器下轮与重启时会按同一幂等流程重试
    console.error(`[yards] 副本 #${newId} 创建后首次复核失败（将由定时扫描重试）:`, e);
  }
  dropYardConnection(newId); // 关闭复核用连接，下次按正式路径重新打开

  return {
    yard: serializeYard(yard),
    detail: { ...detail, ...post }
  };
}

function duplicateName(name) {
  const err = new Error(`已存在名为"${name}"的站场/副本，同名拒绝，请更换名称`);
  err.status = 409;
  err.code = 'YARD_NAME_DUPLICATE';
  return err;
}

/** 复制失败回滚：删除 creating 注册行（释放同名）与意图行；编号不回收复用。 */
function abortCreating(yardId) {
  try {
    getMainDb().transaction(() => {
      getMainDb().prepare(`DELETE FROM yards WHERE id=? AND status='creating'`).run(yardId);
      recovery.clearOp(yardId, 'create_copy');
    })();
  } catch (e) {
    console.error(`[yards] 清理 creating 注册行 #${yardId} 失败:`, e);
  }
}

/**
 * 在临时业务库的复制事务【内】执行全部 INSERT ... SELECT。
 * @param {Object} conn 临时库连接
 * @param {string} srcAlias 源库（原站场）ATTACH 别名
 * @param {string} dstAlias 目标库别名（临时库自身即 'main'）
 * @param {{yardId:number,name:string,createdBy:string}} meta 新副本信息
 */
function copyOriginalData(conn, srcAlias, dstAlias, meta) {
  // 1) 站场定义（整表）
  for (const t of DEFINITION_TABLES) {
    conn.exec(`INSERT INTO ${dstAlias}.${t} SELECT * FROM ${srcAlias}.${t}`);
  }

  // 2) 仅开放中的进路实例 + 其锁与事件进度（released 历史不复制）
  conn.exec(`INSERT INTO ${dstAlias}.route_instances
           SELECT * FROM ${srcAlias}.route_instances WHERE status='open'`);
  conn.exec(`INSERT INTO ${dstAlias}.route_locks
           SELECT l.* FROM ${srcAlias}.route_locks l
             INNER JOIN ${srcAlias}.route_instances i ON i.id=l.instance_id
            WHERE i.status='open'`);
  conn.exec(`INSERT INTO ${dstAlias}.section_events
           SELECT e.* FROM ${srcAlias}.section_events e
             INNER JOIN ${srcAlias}.route_instances i ON i.id=e.instance_id
            WHERE i.status='open'`);

  // 3) 未兑现等待申请（waiting；其 instance_id 恒为 NULL）
  conn.exec(`INSERT INTO ${dstAlias}.waiting_applications
           SELECT * FROM ${srcAlias}.waiting_applications WHERE status='waiting'`);

  // 4) 未完结延时取消（pending；release_at 原样，沿用原到期时刻）
  conn.exec(`INSERT INTO ${dstAlias}.cancellation_applications
           SELECT * FROM ${srcAlias}.cancellation_applications WHERE status='pending'`);

  // 5) 未结束临时封锁（pending/active）
  conn.exec(`INSERT INTO ${dstAlias}.blockade_applications
           SELECT * FROM ${srcAlias}.blockade_applications
            WHERE status IN ('pending','active')`);

  // 6) 元数据（含 seeded_demo 标记、延时取消保护时长设置）
  conn.exec(`INSERT INTO ${dstAlias}.meta SELECT * FROM ${srcAlias}.meta`);

  // 7) 自增序列对齐到源库水位
  conn.prepare(`DELETE FROM ${dstAlias}.sqlite_sequence
              WHERE name IN (${AUTOINCR_TABLES.map(() => '?').join(',')})`)
    .run(...AUTOINCR_TABLES);
  const seqs = conn.prepare(`SELECT name, seq FROM ${srcAlias}.sqlite_sequence`).all();
  const upsertSeq = conn.prepare(
    `INSERT OR REPLACE INTO ${dstAlias}.sqlite_sequence(name,seq) VALUES(?,?)`);
  for (const s of seqs) {
    if (AUTOINCR_TABLES.includes(s.name)) upsertSeq.run(s.name, s.seq);
  }

  // 8) 复制行数统计（界标与清单共用）
  const count = (table, where = '', params = []) =>
    conn.prepare(`SELECT COUNT(*) AS n FROM ${dstAlias}.${table}${where ? ' ' + where : ''}`)
      .get(...params).n;
  const copied = {
    sections: count('sections'),
    switches: count('switches'),
    signals: count('signals'),
    routes: count('routes'),
    openInstances: count('route_instances'),
    waiting: count('waiting_applications', `WHERE status='waiting'`),
    pendingCancellations: count('cancellation_applications', `WHERE status='pending'`),
    unfinishedBlockades: count('blockade_applications',
      `WHERE status IN ('pending','active')`)
  };

  // 9) 副本创建界标：复制白名单不含 audit_entries，副本流水表为空，
  //    本条成为副本审计流水 seq=1——之后只记录该副本自身的新变化，
  //    不为复制来的旧数据补造历史。与复制数据同一单库事务，同成同败。
  require('./audit').recordYardCreatedInTxn(conn, `${dstAlias}.audit_entries`, {
    yardId: meta.yardId,
    name: meta.name,
    actor: meta.createdBy,
    sourceYardId: ORIGINAL_YARD_ID,
    copied
  });

  return { copied, fromOriginal: true };
}

/**
 * 复制事务内写入副本创建清单（故障恢复据其判定副本是否复制完整）。
 */
function writeCopyManifest(conn, dstAlias, { yardId, name, createdBy, copied }) {
  conn.prepare(
    `INSERT INTO ${dstAlias}.yard_copy_manifest
       (yard_id,source_yard_id,name,created_by,created_at,copied_json)
     VALUES(?,?,?,?,?,?)`
  ).run(yardId, ORIGINAL_YARD_ID, name, createdBy == null ? null : String(createdBy),
    Date.now(), JSON.stringify(copied || {}));
}

/**
 * 新副本落盘后的首次复核（等价于"该站场自己的服务重启"）：
 *  - 待生效封锁按副本内区段占用/锁状态复核；
 *  - 等待申请按副本自身状态尝试兑现（只与本副本锁闭/顺位交互）；
 *  - 已到期的 pending 延时取消按原 release_at 立即核验（不重新计时），
 *    未到期的继续等待，由全局定时器按各站场分别扫描。
 */
function activateCopiedYard(yardId) {
  return withYard(yardId, () => {
    const blockade = require('./blockade');
    const waiting = require('./waiting');
    const cancellation = require('./cancellation');

    const activated = blockade.refreshBlockadeStates('yard_copied');
    const due = cancellation.processDue('yard_copied');
    const swept = waiting.sweepFulfillments('yard_copied');
    return {
      blockadesActivated: activated,
      cancellationsReleased: due.released,
      cancellationsAborted: due.aborted,
      waitingFulfilled: swept.fulfilled
    };
  });
}

/* ------------------------------ 工具 ------------------------------ */

function cleanupSidecars(filePath) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(filePath + ext); } catch (_) {}
  }
}

function serializeYard(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,                    // original / copy
    isOriginal: row.id === ORIGINAL_YARD_ID,
    sourceYardId: row.source_yard_id,
    status: row.status,
    paused: row.status === 'paused',
    broken: row.status === 'broken',
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
    resumedBy: row.resumed_by,
    resumedAt: row.resumed_at,
    brokenReason: row.broken_reason || null,
    brokenAt: row.broken_at || null,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function getYard(yardId) {
  return serializeYard(yardRow(yardId));
}

/**
 * 校验并解析会话当前站场：编号非法/注册表缺失/正在创建/已损坏均拒绝。
 * null/缺省视为原站场。
 *  - 未知副本：404 YARD_NOT_FOUND；
 *  - 创建中断尚未收敛的副本：404 YARD_NOT_READY（启动收敛通常已将其回滚）；
 *  - 损坏隔离副本：503 YARD_BROKEN，并说明原因；其他站场照常使用。
 */
function resolveSessionYard(yardIdRaw) {
  if (yardIdRaw == null) return assertAccessible(yardRow(ORIGINAL_YARD_ID));
  const yardId = Number(yardIdRaw);
  if (!Number.isInteger(yardId) || yardId < 1) {
    const err = new Error('未知演练副本：该站场不存在');
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  return assertAccessible(yardRow(yardId), yardId);
}

function assertAccessible(row, yardId) {
  const id = row ? row.id : yardId;
  if (!row) {
    const err = new Error(`未知演练副本 #${id == null ? '' : id}：该站场不存在`);
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  if (row.status === 'creating') {
    const err = new Error(
      `演练副本"${row.name}"（#${row.id}）尚在创建中（上次创建可能因进程中断未完成），` +
      '请稍后重试或重新创建');
    err.status = 404;
    err.code = 'YARD_NOT_READY';
    throw err;
  }
  if (row.status === 'broken') {
    const err = new Error(
      `演练副本"${row.name}"（#${row.id}）业务数据已损坏且无法自动修复，已被隔离、拒绝访问` +
      (row.broken_reason ? `：${row.broken_reason}` : '') +
      '；其他站场可正常使用，请联系管理员核查该副本业务库文件后重新创建副本');
    err.status = 503;
    err.code = 'YARD_BROKEN';
    err.extra = { yardId: row.id, reason: row.broken_reason || null };
    throw err;
  }
  // paused 副本仍允许会话切换与只读查询；写操作由路由层统一拒绝。
  return row;
}

module.exports = {
  ORIGINAL_YARD_ID,
  ORIGINAL_YARD_NAME,
  ensureRegistry,
  listYards,
  getYard,
  yardRow,
  createCopyFromOriginal,
  resolveSessionYard,
  activateCopiedYard,
  serializeYard
};
