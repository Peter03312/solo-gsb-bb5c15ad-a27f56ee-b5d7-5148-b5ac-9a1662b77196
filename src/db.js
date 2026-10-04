'use strict';

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const Database = require('better-sqlite3');

/**
 * 多站场存储模型：
 *  - 主库（DB_PATH，默认 data/interlock.db）：只存 yards（站场注册表）与
 *    sessions（登录会话，含当前选择的站场），结构见 schema-registry.sql。
 *  - 业务库（每个站场一个文件，默认放在与主库同级的 <主库名>.yards/ 目录，
 *    如 data/interlock.yards/yard-1.db）：结构见 schema-yard.sql，保存该站场
 *    全部业务数据。各站场文件物理隔离，锁闭、等待顺位、延时取消、封锁、
 *    交接单等天然不会串用。
 *  - id=1 固定为"原站场"；管理员可从原站场创建命名演练副本。
 *
 * 请求经鉴权中间件用 withYard() 绑定"当前站场"后，业务模块调用 getDb()
 * 即得到当前站场的连接；未绑定上下文（脚本、冒烟测试）时回落到主库，
 * 保持既有启动方式与直调用法兼容。
 *
 * better-sqlite3 为同步驱动：每个 .transaction() 在单个连接上串行执行，
 * 配合 route_locks 的唯一约束即可实现"冲突申请只成功一条、无部分锁定"。
 */

const ORIGINAL_YARD_ID = 1;
const ORIGINAL_YARD_NAME = '原站场';

const yardStorage = new AsyncLocalStorage();

let mainDb = null;

function mainDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'interlock.db');
}

/** 各站场业务库目录：与主库文件同级，名为 "<主库文件名去扩展>.yards" */
function yardsDir() {
  const p = mainDbPath();
  return path.join(path.dirname(p), path.basename(p, path.extname(p)) + '.yards');
}

function yardDbFile(yardId) {
  return `yard-${yardId}.db`;
}

function yardDbPath(yardId) {
  return path.join(yardsDir(), yardDbFile(yardId));
}

function readSql(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

/** 主库（注册表 + 会话） */
function getMainDb() {
  if (mainDb) return mainDb;

  const dbPath = mainDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  mainDb = new Database(dbPath);
  mainDb.pragma('journal_mode = WAL');
  mainDb.pragma('foreign_keys = ON');
  mainDb.pragma('busy_timeout = 5000');

  mainDb.exec(readSql('schema-registry.sql'));
  // 主库同时具备业务表：
  //  - 旧版库保留既有业务数据（启动时整体迁移为"原站场"业务库）；
  //  - 直调 getDb() 的脚本/冒烟测试无需 withYard 上下文即可使用；
  //  - 全新安装的主库业务表保持空置（真实业务读写都在各站场业务库）。
  mainDb.exec(readSql('schema-yard.sql'));

  // 旧库升级：sessions 表补充当前站场列（不设外键级联，未知副本由鉴权层拒绝）
  const sessionCols = mainDb.prepare(`PRAGMA table_info(sessions)`).all();
  if (!sessionCols.some((c) => c.name === 'current_yard_id')) {
    mainDb.exec(`ALTER TABLE sessions ADD COLUMN current_yard_id INTEGER`);
  }
  migrateYardsPauseColumns(mainDb);

  return mainDb;
}

/** 旧库升级：站场注册增加暂停列，并把 status CHECK 扩展为 active/paused。 */
function migrateYardsPauseColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(yards)`).all();
  const addColumn = (name, ddl) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE yards ADD COLUMN ${ddl}`);
  };
  addColumn('paused_by', 'paused_by TEXT');
  addColumn('paused_at', 'paused_at INTEGER');
  addColumn('resumed_by', 'resumed_by TEXT');
  addColumn('resumed_at', 'resumed_at INTEGER');

  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='yards'`).get().sql;
  if (ddl.includes("'paused'")) return;

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const seqRow = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='yards'`).get();
    db.transaction(() => {
      db.exec(`
        CREATE TABLE yards_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          kind       TEXT NOT NULL DEFAULT 'copy'
                     CHECK (kind IN ('original','copy')),
          source_yard_id INTEGER REFERENCES yards(id),
          status     TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused')),
          db_file    TEXT NOT NULL,
          created_by TEXT,
          paused_by TEXT,
          paused_at INTEGER,
          resumed_by TEXT,
          resumed_at INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO yards_new(id,name,kind,source_yard_id,status,db_file,created_by,
                              paused_by,paused_at,resumed_by,resumed_at,created_at)
        SELECT id,name,kind,source_yard_id,status,db_file,created_by,
               paused_by,paused_at,resumed_by,resumed_at,created_at FROM yards;
        DROP TABLE yards;
        ALTER TABLE yards_new RENAME TO yards;
      `);
      if (seqRow) {
        db.prepare(`INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES('yards', ?)`).run(seqRow.seq);
      }
    })();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

/** 打开（带建表）一个站场业务库连接 */
function openYardConnection(yardId) {
  const file = yardDbPath(yardId);
  if (!fs.existsSync(file)) {
    const err = new Error(`站场 ${yardId} 的业务数据文件不存在`);
    err.status = 404;
    err.code = 'YARD_DB_MISSING';
    throw err;
  }
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  // 防御性补建（文件由初始化/复制流程建好，正常情况下全部表已存在）
  conn.exec(readSql('schema-yard.sql'));
  return conn;
}

// 站场连接缓存：yardId -> Database
const yardConns = new Map();

function getYardConnection(yardId) {
  let conn = yardConns.get(yardId);
  if (!conn) {
    conn = openYardConnection(yardId);
    yardConns.set(yardId, conn);
  }
  return conn;
}

/**
 * 取得当前数据库连接：
 *  - withYard 上下文中：当前站场的业务库；
 *  - 无上下文：主库（兼容 init-db/冒烟测试等直调用法；主库也含业务表的旧库）。
 */
function getDb() {
  const store = yardStorage.getStore();
  if (!store) return getMainDb();
  return getYardConnection(store.yardId);
}

/** 在指定站场上下文中同步执行 fn（fn 内 getDb() 指向该站场业务库） */
function withYard(yardId, fn) {
  return yardStorage.run({ yardId }, fn);
}

/**
 * 在无站场上下文中同步执行 fn：fn 内 getDb() 回落到主库。
 * 供跨站场管理操作（创建副本时 ATTACH 主库/源库/目标库的复制事务、
 * 全站场扫描等）使用——避免调用方所处的请求站场上下文把事务里的
 * getDb() 误路由到某个站场业务库。
 */
function withMainDb(fn) {
  return yardStorage.run(undefined, fn);
}

/** 当前上下文站场编号；无上下文时为原站场 */
function currentYardId() {
  const store = yardStorage.getStore();
  return store ? store.yardId : ORIGINAL_YARD_ID;
}

/** 关闭并清空已缓存的站场连接（复制初始化等场景使用） */
function dropYardConnection(yardId) {
  const conn = yardConns.get(yardId);
  if (conn) {
    try { conn.close(); } catch (_) {}
    yardConns.delete(yardId);
  }
}

module.exports = {
  ORIGINAL_YARD_ID,
  ORIGINAL_YARD_NAME,
  getMainDb,
  getDb,
  withYard,
  withMainDb,
  currentYardId,
  getYardConnection,
  dropYardConnection,
  mainDbPath,
  yardsDir,
  yardDbFile,
  yardDbPath,
  readSql
};
