-- 小型铁路站场进路联锁推演台 —— 注册表结构（主库 DB_PATH）
-- 主库只保存"站场注册"与"登录会话"两类跨站场数据；
-- 每个站场（原站场及其命名演练副本）的业务数据各自保存在独立的业务库
-- （yards/yard-<id>.db，表结构见 schema-yard.sql），物理隔离保证
-- 锁闭、等待顺位、延时取消、封锁、交接单等绝不串用。

PRAGMA foreign_keys = ON;

-- 站场注册：id=1 固定为"原站场"；管理员可从原站场创建命名演练副本。
-- lifecycle 状态机（进程中断后由启动收敛流程自动推进）：
--   creating —— 副本创建中：业务库文件尚未完整落位；重启时校验文件，
--               完整可开则原子推进为 active，否则删除注册行与残留文件，
--               回到"操作前"（名称同时释放）。
--   active   —— 运行中
--   paused   —— 已暂停（仅副本）
--   broken   —— 不可自动修复的损坏：该副本拒绝访问并说明原因，其他站场
--               照常使用（原站场损坏同样标记并隔离，不影响其他副本）。
CREATE TABLE IF NOT EXISTS yards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,        -- 站场/副本名称；同名拒绝
  kind       TEXT NOT NULL DEFAULT 'copy'
             CHECK (kind IN ('original','copy')),
  -- 来源：副本固定从原站场复制；原站场为 NULL
  source_yard_id INTEGER REFERENCES yards(id),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','paused','creating','broken')),
  db_file    TEXT NOT NULL,               -- 业务库文件名（相对主库目录的 yards/ 子目录）
  created_by TEXT,                        -- 创建人（副本=管理员姓名）
  paused_by TEXT,                         -- 暂停操作人（仅副本可暂停）
  paused_at INTEGER,                      -- 暂停时刻（epoch 毫秒）
  resumed_by TEXT,                        -- 最近恢复操作人
  resumed_at INTEGER,                     -- 最近恢复时刻（epoch 毫秒）
  -- 损坏隔离（status='broken' 时填写）：原因与发现时刻
  broken_reason TEXT,
  broken_at INTEGER,
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

-- 站场变更操作意图台账（故障收敛用）。
-- 副本创建、暂停、恢复都按"先登记意图 → 执行业务库单库事务 → 翻转注册表
-- → 清理意图"的顺序推进；每个步骤只写【单个】数据库文件，任一步骤后进程
-- 中断，重启时 reconcilePendingOps() 依据本台账与业务库中的操作界标把状态
-- 收敛到操作前或操作后的完整状态——不重复平移到期时间、不重复记账考核
-- 有效用时、不重复写审计界标。正常完成的操作立即删除本台账行。
CREATE TABLE IF NOT EXISTS yard_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  yard_id     INTEGER NOT NULL,
  -- pause 暂停副本 / resume 恢复副本 / create_copy 创建命名演练副本
  op          TEXT NOT NULL CHECK (op IN ('pause','resume','create_copy')),
  -- pending 待收敛（进程中断残留）；正常完成的操作不保留行
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  operator    TEXT,
  created_at  INTEGER NOT NULL,           -- 意图登记时刻（epoch 毫秒）
  -- 操作参数快照（JSON）：
  --  pause: {now, pausedBy, fromStatus}
  --  resume:{now, resumedBy, pausedAt, shiftMs}
  --  create_copy:{name}
  params_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (yard_id, op, status)
);
CREATE INDEX IF NOT EXISTS idx_yard_ops_status ON yard_ops(status, id);
