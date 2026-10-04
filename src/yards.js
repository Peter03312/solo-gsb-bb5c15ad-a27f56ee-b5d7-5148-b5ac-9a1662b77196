'use strict';

/**
 * 站场注册与命名演练副本。
 *
 * 存储模型见 db.js：主库保存 yards 注册表与 sessions；每个站场（原站场 +
 * 各命名副本）各自拥有一份业务库文件，结构为 schema-yard.sql。
 *
 * 管理员可从【原站场】创建命名演练副本，复制在主库的单个事务内完成
 * （ATTACH 源业务库与目标业务库，INSERT ... SELECT 落库后写注册表），
 * 事务提交前任何失败都整体回滚——不会留下"建了一半"的副本。
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
const {
  ORIGINAL_YARD_ID, ORIGINAL_YARD_NAME,
  getMainDb, getYardConnection, dropYardConnection,
  withYard, withMainDb, yardsDir, yardDbFile, yardDbPath, readSql
} = require('./db');

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
                     resumed_at AS resumedAt, created_at AS createdAt
                FROM yards ORDER BY id`)
    .all()
    .map((y) => ({ ...y, isOriginal: y.id === ORIGINAL_YARD_ID, paused: y.status === 'paused' }));
}

/**
 * 确保原站场（id=1）注册存在、业务库就绪。服务启动与 init-db 时调用一次：
 *  - 全新主库（无任何业务表数据）：创建空的 yard-1.db（由启动流程 seed）；
 *  - 旧版主库（业务数据直接在主库）：在主库事务内把全部业务表整体复制到
 *    yard-1.db（含历史交接单），主库业务表原样保留（不再被业务路径读写）。
 *  - yards 已注册：幂等返回。
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

/** 创建一个仅含业务表结构的空业务库文件（临时文件路径，由调用方改名/注册） */
function initBlankYardFile(filePath) {
  const conn = new (require('better-sqlite3'))(filePath);
  try {
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.exec(readSql('schema-yard.sql'));
    // 立即把 WAL 落回主文件并以 DELETE 模式收尾，保证随后可安全改名
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
  // 注册表读写、ATTACH 复制事务都在主库连接上完成；必须脱离调用方请求的
  // 站场上下文（否则事务体内 getDb() 会被 ALS 误路由到站场业务库）。
  return withMainDb(() => createCopyInMainTxn(name, createdBy));
}

function createCopyInMainTxn(name, createdBy) {
  const db = getMainDb();
  if (yardByName(name)) {
    const err = new Error(`已存在名为"${name}"的站场/副本，同名拒绝，请更换名称`);
    err.status = 409;
    err.code = 'YARD_NAME_DUPLICATE';
    throw err;
  }

  const dir = yardsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 预取下一个副本编号（仅读 sqlite_sequence / 表计数，未落库任何 yards 行）
  const seqRow = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='yards'`).get();
  const newId = (seqRow && Number.isInteger(seqRow.seq) ? seqRow.seq : ORIGINAL_YARD_ID) + 1;
  const finalFile = yardDbFile(newId);
  const finalPath = yardDbPath(newId);
  const tmpPath = path.join(dir, `yard-${newId}.copying.tmp`);
  for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  if (fs.existsSync(finalPath)) {
    const err = new Error(`站场业务库文件 ${finalFile} 已存在，拒绝覆盖`);
    err.status = 409;
    err.code = 'YARD_DB_EXISTS';
    throw err;
  }

  let detail = null;
  const srcAlias = `src_y${newId}`;
  const dstAlias = `dst_y${newId}`;
  const detachQuiet = () => {
    try { db.exec(`DETACH DATABASE ${dstAlias}`); } catch (_) {}
    try { db.exec(`DETACH DATABASE ${srcAlias}`); } catch (_) {}
  };
  try {
    // 1) 临时文件中建好业务表结构
    initBlankYardFile(tmpPath);
    // 2) 挂载原站场库与临时库（在主库长连接上、事务外完成）
    db.prepare(`ATTACH DATABASE ? AS ${srcAlias}`).run(yardDbPath(ORIGINAL_YARD_ID));
    db.prepare(`ATTACH DATABASE ? AS ${dstAlias}`).run(tmpPath);
    // 3) 单个主库事务内：INSERT ... SELECT 复制全部要求的数据 + 写 yards
    //    注册行。任何失败整体回滚，不留"复制了一半"的副本。
    detail = db.transaction(() => {
      const d = copyOriginalData(db, srcAlias, dstAlias);
      db.prepare(
        `INSERT INTO yards(id,name,kind,source_yard_id,status,db_file,created_by)
         VALUES(?,?, 'copy', ?, 'active', ?, ?)`
      ).run(newId, name, ORIGINAL_YARD_ID, finalFile, createdBy);
      // 副本创建界标：复制白名单不含 audit_entries，副本流水表为空，
      // 本条成为副本审计流水 seq=1——之后只记录该副本自身的新变化，
      // 不为复制来的旧数据补造历史。与复制/注册同一跨库事务，同成同败。
      require('./audit').recordYardCreatedInTxn(db, `${dstAlias}.audit_entries`, {
        yardId: newId,
        name,
        actor: createdBy,
        sourceYardId: ORIGINAL_YARD_ID,
        copied: d.copied
      });
      return d;
    })();
    detachQuiet();
    // 4) 事务已提交（副本此刻起可见）。同一同步代码块内立即：
    //    关闭该编号可能缓存的连接（此刻不存在，防御）→ 临时文件原子改名落位。
    //    Node 单线程 + better-sqlite3 同步语义保证其间不会插入其它请求处理。
    dropYardConnection(newId);
    fs.renameSync(tmpPath, finalPath);
    cleanupSidecars(tmpPath);
  } catch (e) {
    detachQuiet();
    for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    // 唯一约束冲突（与并发创建同名）按同名拒绝返回
    if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE' ||
        String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      if (yardByName(name)) {
        const dup = new Error(`已存在名为"${name}"的站场/副本，同名拒绝，请更换名称`);
        dup.status = 409;
        dup.code = 'YARD_NAME_DUPLICATE';
        throw dup;
      }
    }
    throw e;
  }

  const yard = yardRow(newId);
  // 复制完成后按"服务重启后复核"的同一套流程处理新副本：
  // 延时取消沿用原 release_at（不重新计时），到期者按副本自身状态核验；
  // 封锁复核与等待兑现均只作用于本副本。
  const post = activateCopiedYard(newId);
  dropYardConnection(newId); // 关闭刚复核用的连接，下次按正式路径重新打开

  return {
    yard: serializeYard(yard),
    detail: { ...detail, ...post }
  };
}

/**
 * 在主库复制事务【内】执行全部 INSERT ... SELECT（调用方已在事务外
 * ATTACH 好 srcAlias/dstAlias 并开启事务）。返回复制明细。
 * 跨库事务任一语句失败由外层事务整体回滚，目标文件不会留下部分数据。
 */
function copyOriginalData(db, srcAlias, dstAlias) {
  // 1) 站场定义（整表）
  for (const t of DEFINITION_TABLES) {
    db.exec(`INSERT INTO ${dstAlias}.${t} SELECT * FROM ${srcAlias}.${t}`);
  }

  // 2) 仅开放中的进路实例 + 其锁与事件进度（released 历史不复制）
  db.exec(`INSERT INTO ${dstAlias}.route_instances
           SELECT * FROM ${srcAlias}.route_instances WHERE status='open'`);
  db.exec(`INSERT INTO ${dstAlias}.route_locks
           SELECT l.* FROM ${srcAlias}.route_locks l
             INNER JOIN ${srcAlias}.route_instances i ON i.id=l.instance_id
            WHERE i.status='open'`);
  db.exec(`INSERT INTO ${dstAlias}.section_events
           SELECT e.* FROM ${srcAlias}.section_events e
             INNER JOIN ${srcAlias}.route_instances i ON i.id=e.instance_id
            WHERE i.status='open'`);

  // 3) 未兑现等待申请（waiting；其 instance_id 恒为 NULL）
  db.exec(`INSERT INTO ${dstAlias}.waiting_applications
           SELECT * FROM ${srcAlias}.waiting_applications WHERE status='waiting'`);

  // 4) 未完结延时取消（pending；release_at 原样，沿用原到期时刻）
  db.exec(`INSERT INTO ${dstAlias}.cancellation_applications
           SELECT * FROM ${srcAlias}.cancellation_applications WHERE status='pending'`);

  // 5) 未结束临时封锁（pending/active）
  db.exec(`INSERT INTO ${dstAlias}.blockade_applications
           SELECT * FROM ${srcAlias}.blockade_applications
            WHERE status IN ('pending','active')`);

  // 6) 元数据（含 seeded_demo 标记、延时取消保护时长设置）
  db.exec(`INSERT INTO ${dstAlias}.meta SELECT * FROM ${srcAlias}.meta`);

  // 7) 自增序列对齐到源库水位：DELETE+INSERT OR REPLACE 重写 sqlite_sequence
  //    中的相关行（跨库事务内直接 INSERT 该内部表会被 SQLite 拒绝）。
  db.prepare(`DELETE FROM ${dstAlias}.sqlite_sequence
              WHERE name IN (${AUTOINCR_TABLES.map(() => '?').join(',')})`)
    .run(...AUTOINCR_TABLES);
  const seqs = db.prepare(`SELECT name, seq FROM ${srcAlias}.sqlite_sequence`).all();
  const upsertSeq = db.prepare(
    `INSERT OR REPLACE INTO ${dstAlias}.sqlite_sequence(name,seq) VALUES(?,?)`);
  for (const s of seqs) {
    if (AUTOINCR_TABLES.includes(s.name)) upsertSeq.run(s.name, s.seq);
  }

  const count = (table, where = '', params = []) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${dstAlias}.${table}${where ? ' ' + where : ''}`)
      .get(...params).n;
  return {
    copied: {
      sections: count('sections'),
      switches: count('switches'),
      signals: count('signals'),
      routes: count('routes'),
      openInstances: count('route_instances'),
      waiting: count('waiting_applications', `WHERE status='waiting'`),
      pendingCancellations: count('cancellation_applications', `WHERE status='pending'`),
      unfinishedBlockades: count('blockade_applications',
        `WHERE status IN ('pending','active')`)
    },
    fromOriginal: true
  };
}

/**
 * 新副本落盘后的首次复核（等价于"该站场自己的服务重启"）：
 *  - 待生效封锁按副本内区段占用/锁状态复核；
 *  - 等待申请按副本自身状态尝试兑现（只与本副本锁闭/顺位交互）；
 *  - 已到期的 pending 延时取消按原 release_at 立即核验（不重新计时），
 *    未到期的继续等待，由全局定时器按各站场分别扫描。
 */
function activateCopiedYard(yardId) {
  const { withYard } = require('./db');
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
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
    resumedBy: row.resumed_by,
    resumedAt: row.resumed_at,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function getYard(yardId) {
  return serializeYard(yardRow(yardId));
}

/**
 * 校验并解析会话当前站场：编号非法/注册表缺失均拒绝（404）。
 * null/缺省视为原站场。
 */
function resolveSessionYard(yardIdRaw) {
  if (yardIdRaw == null) return yardRow(ORIGINAL_YARD_ID);
  const yardId = Number(yardIdRaw);
  if (!Number.isInteger(yardId) || yardId < 1) {
    const err = new Error('未知演练副本：该站场不存在');
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
    throw err;
  }
  const row = yardRow(yardId);
  if (!row) {
    const err = new Error(`未知演练副本 #${yardId}：该站场不存在`);
    err.status = 404;
    err.code = 'YARD_NOT_FOUND';
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
