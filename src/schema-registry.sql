-- 小型铁路站场进路联锁推演台 —— 注册表结构（主库 DB_PATH）
-- 主库只保存"站场注册"与"登录会话"两类跨站场数据；
-- 每个站场（原站场及其命名演练副本）的业务数据各自保存在独立的业务库
-- （yards/yard-<id>.db，表结构见 schema-yard.sql），物理隔离保证
-- 锁闭、等待顺位、延时取消、封锁、交接单等绝不串用。

PRAGMA foreign_keys = ON;

-- 站场注册：id=1 固定为"原站场"；管理员可从原站场创建命名演练副本
CREATE TABLE IF NOT EXISTS yards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,        -- 站场/副本名称；同名拒绝
  kind       TEXT NOT NULL DEFAULT 'copy'
             CHECK (kind IN ('original','copy')),
  -- 来源：副本固定从原站场复制；原站场为 NULL
  source_yard_id INTEGER REFERENCES yards(id),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','paused')),
  db_file    TEXT NOT NULL,               -- 业务库文件名（相对主库目录的 yards/ 子目录）
  created_by TEXT,                        -- 创建人（副本=管理员姓名）
  paused_by TEXT,                         -- 暂停操作人（仅副本可暂停）
  paused_at INTEGER,                      -- 暂停时刻（epoch 毫秒）
  resumed_by TEXT,                        -- 最近恢复操作人
  resumed_at INTEGER,                     -- 最近恢复时刻（epoch 毫秒）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 值班员/管理员会话（姓名 + 登录令牌）。
-- current_yard_id：该会话当前选择的站场；NULL 视为原站场（id=1）。
-- 不设外键级联，未知副本在鉴权层按 404 拒绝并回落到原站场处理。
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('admin','dispatcher')),
  name        TEXT NOT NULL,
  current_yard_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
