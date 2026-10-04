-- 小型铁路站场进路联锁推演台 —— 单个站场的业务表结构
-- 原站场（yards.id=1）与每个命名演练副本各自拥有一份完全相同的业务库，
-- 彼此独立的文件天然隔离：站场编辑、预检、开放、走行、区段/道岔调整、
-- 等待、延时取消、封锁、交接单与重置都只作用于当前站场。
-- 全部业务状态保存在本地 SQLite，刷新/重启后恢复。

PRAGMA foreign_keys = ON;

-- 键值元数据（初始化标记、每客户端事件序号由各自表维护）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 副本创建清单（故障收敛用）：
--  - 仅命名演练副本拥有唯一一行（yard_id=1 的原站场无此表行）；
--  - 与复制数据在【同一个业务库事务】内写入：进程在复制中途中断时，
--    临时库要么不存在、要么没有完整清单——启动收敛据此判定"复制未完成"，
--    删除注册行与残留文件，回到操作前；
--  - 清单记录复制时的源站场、创建人/时刻与各类复制行数，也用于启动时
--    校验副本业务库的完整性（与注册表不符则隔离为 broken）。
CREATE TABLE IF NOT EXISTS yard_copy_manifest (
  yard_id     INTEGER PRIMARY KEY,   -- 恒为本副本编号（注册表 yards.id）
  source_yard_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,      -- 创建时刻（epoch 毫秒）
  copied_json TEXT NOT NULL DEFAULT '{}'
);

-- 轨道区段
CREATE TABLE IF NOT EXISTS sections (
  id     TEXT PRIMARY KEY,            -- 区段编号，如 1、3DG
  label  TEXT NOT NULL,
  x1     REAL NOT NULL,               -- SVG 端点坐标（画图用）
  y1     REAL NOT NULL,
  x2     REAL NOT NULL,
  y2     REAL NOT NULL,
  -- 占用状态: unknown 未知(按占用处理) / free 空闲 / occupied 占用
  occ_state TEXT NOT NULL DEFAULT 'unknown'
     CHECK (occ_state IN ('unknown','free','occupied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 道岔：position N=定位(直股) R=反位(弯股)；实际位置以本表为准
CREATE TABLE IF NOT EXISTS switches (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  x        REAL NOT NULL,             -- 岔心坐标
  y        REAL NOT NULL,
  position TEXT NOT NULL DEFAULT 'N' CHECK (position IN ('N','R')),
  -- 三组连接端点坐标，用于画直股/弯股两条线路
  nx1 REAL, ny1 REAL, nx2 REAL, ny2 REAL,   -- 定位(直股) 两端
  rx1 REAL, ry1 REAL, rx2 REAL, ry2 REAL,   -- 反位(弯股) 两端
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 信号机
CREATE TABLE IF NOT EXISTS signals (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  x         REAL NOT NULL,
  y         REAL NOT NULL,
  direction TEXT NOT NULL DEFAULT 'right'   -- 朝向，仅画图用
     CHECK (direction IN ('right','left','up','down')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路定义（起终点）
CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  origin      TEXT NOT NULL,          -- 起点(信号机/站场端部)编号或名称
  destination TEXT NOT NULL,
  entry_signal_id TEXT REFERENCES signals(id) ON DELETE SET NULL, -- 入口信号机
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路顺序步：依次经过的区段，以及该进路要求的道岔位置
CREATE TABLE IF NOT EXISTS route_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,        -- 从 1 开始
  section_id TEXT NOT NULL REFERENCES sections(id),
  UNIQUE (route_id, step_order)
);

CREATE TABLE IF NOT EXISTS route_switch_reqs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  switch_id  TEXT NOT NULL REFERENCES switches(id),
  req_position TEXT NOT NULL CHECK (req_position IN ('N','R')),
  UNIQUE (route_id, switch_id)
);

-- 已开放（锁闭中）的进路实例
CREATE TABLE IF NOT EXISTS route_instances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id    TEXT NOT NULL REFERENCES routes(id),
  opened_by   TEXT NOT NULL,          -- 值班员姓名
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','released')),
  -- 信号状态：red 红灯(关闭/停车) green 绿灯(允许)
  signal_state TEXT NOT NULL DEFAULT 'green' CHECK (signal_state IN ('red','green')),
  -- 下一个允许的事件序号（严格递增，从 1 开始）
  next_seq    INTEGER NOT NULL DEFAULT 1,
  -- 当前可进入(占用)的步号，从 1 起
  head_step   INTEGER NOT NULL DEFAULT 1,
  -- 当前可出清(清空)的最早步号，从 1 起；越过末步则整条进路解除
  tail_step   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);

-- 进路实例锁：开放时写入，逐段解锁/整条解除时删除对应行。
-- 唯一约束保证同一区段/道岔同一时刻只被一条进路锁定（争用仲裁核心）。
-- 每个站场各持一份本表，跨站场绝不争用、也绝不串锁。
CREATE TABLE IF NOT EXISTS route_locks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('section','switch')),
  resource_id   TEXT NOT NULL,
  step_order INTEGER,                 -- 区段锁对应的进路步号（道岔锁为空）
  UNIQUE (resource_type, resource_id)
);

-- 占用/清空事件流水（幂等与序号审计依据）
CREATE TABLE IF NOT EXISTS section_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,       -- 进路实例内递增序号
  section_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('occupy','clear')),
  client      TEXT,                   -- 提交人
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, seq)
);

-- 等待申请（值班员排路等待，不预锁资源）
-- 注意：route_id / instance_id 均不设外键级联：
--  - 进路被删除/修改时，相关等待申请要保留下来并写明失效原因（status=invalid）；
--  - 管理员重置会删除进路实例，已兑现申请保留 instance_id 作为溯源编号。
-- 兑现与否完全由提交顺序 + 现有开放校验在同一事务内重新判定。
CREATE TABLE IF NOT EXISTS waiting_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id    TEXT NOT NULL,
  applicant   TEXT NOT NULL,           -- 申请人（值班员姓名）
  -- 申请时选择并校验通过的道岔位置快照（JSON，键=道岔号 值=N/R）
  switch_positions TEXT NOT NULL DEFAULT '{}',
  -- waiting 等待中 / fulfilled 已兑现 / cancelled 已撤销 / invalid 因定义变更失效
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting','fulfilled','cancelled','invalid')),
  instance_id INTEGER,                 -- 兑现后产生的进路实例编号
  -- 最近一次自动兑现尝试的阻断原因（JSON 字符串数组）
  block_reasons TEXT NOT NULL DEFAULT '[]',
  -- 因"前项未兑现"被拦截时，挡在前面的等待申请编号（逗号分隔，展示用）
  blocked_by  TEXT,
  end_reason  TEXT,                    -- 撤销/失效说明
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT
);

-- 同一等待申请最多兑现出一个进路实例（重复触发不得产生多个实例）
CREATE UNIQUE INDEX IF NOT EXISTS idx_waiting_instance
  ON waiting_applications(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_waiting_status ON waiting_applications(status, id);
CREATE INDEX IF NOT EXISTS idx_waiting_applicant ON waiting_applications(applicant);

-- 延时取消申请：值班员对"已开放且尚无走行占用记录"的进路申请保护期后取消。
--  - 申请立即令入口信号回红，原区段/道岔锁（route_locks）继续保留；
--  - 最早解除时刻 = 申请时刻 + 申请时保护时长快照（管理员之后改设置不追改）；
--  - 到期在同一事务内重查：实例仍开放、无走行占用记录、沿途区段均空闲才解除；
--    条件不符则终止申请（aborted），锁闭保留并写明原因；
--  - 保护期内收到首段走行占用事件：事件照常受理，本申请同步终止；
--  - 同一实例同时至多一笔 pending（部分唯一索引兜底重复申请）。
-- instance_id 设外键级联：管理员重置删除进路实例时申请记录一并清除。
CREATE TABLE IF NOT EXISTS cancellation_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  applicant   TEXT NOT NULL,           -- 申请人（值班员姓名）
  -- pending 保护期等待中 / released 到期核验通过已解除进路 / aborted 条件不符或已走行，终止（锁闭保留）
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','released','aborted')),
  duration_seconds INTEGER NOT NULL,   -- 申请时的保护时长快照（秒，正整数）
  requested_at INTEGER NOT NULL,       -- 申请时刻（epoch 毫秒）
  release_at   INTEGER NOT NULL,       -- 最早解除时刻（epoch 毫秒；副本沿用原时刻）
  processed_at INTEGER,                -- 进入终态的时刻（epoch 毫秒）
  end_reason  TEXT,                    -- 终止/解除说明
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一进路实例同时至多一笔待处理的延时取消申请（重复申请幂等，不得产生第二笔/缩短期限）
CREATE UNIQUE INDEX IF NOT EXISTS idx_cancel_pending_instance
  ON cancellation_applications(instance_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_cancel_status ON cancellation_applications(status, release_at);
CREATE INDEX IF NOT EXISTS idx_cancel_applicant ON cancellation_applications(applicant);

-- 临时封锁申请（管理员按区段发起）：
--  - 提交即阻止该区段参与新的进路预检/直接开放/等待兑现（pending 与 active 均阻止）；
--  - 区段空闲且无进路锁时 pending 自动转 active；占用/未知/仍锁闭时维持 pending；
--  - 已开放进路的锁闭、走行与延时取消规则不受封锁影响（不强制解除）；
--  - 管理员可结束 pending/active 封锁；结束后按现有联锁规则重试等待兑现，
--    不改写区段占用状态；管理员重置推演时清除全部封锁记录。
-- section_id 不设外键：区段被删除时封锁记录保留（由管理端同事务标记结束）。
CREATE TABLE IF NOT EXISTS blockade_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id  TEXT NOT NULL,             -- 被封锁的区段编号
  applicant   TEXT NOT NULL,             -- 发起人（管理员）
  reason      TEXT NOT NULL,             -- 封锁原因（非空白）
  -- pending 待生效 / active 已生效 / ended 已结束
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','ended')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,                     -- 转为已生效的时刻（pending→active）
  ended_at    TEXT,
  end_reason  TEXT                       -- 结束说明
);

-- 同一区段同时至多一笔未结束（待生效/已生效）的封锁申请（重复申请返回原申请）
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockade_unfinished_section
  ON blockade_applications(section_id) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS idx_blockade_status ON blockade_applications(status, id);

-- 交接班交接单（历史交接单只留在原站场，不随副本复制）：
--  - 交班值班员生成时，在同一事务内快照六类状态：区段占用、道岔位置、
--    开放进路（信号与走行进度）、等待申请、延时取消申请、未结束封锁，
--    并记录生成时刻（epoch 毫秒）与交班人；
--  - 接班值班员签收时在同一事务内按同一时刻的状态重新取快照比对：
--    任一类别已变化即拒绝签收、列出变化类别并把该单标记为 expired，
--    由交班人重新生成；签收成功后他人不可再签收；
--  - 同一接班人重复签收幂等返回原结果；交班人本人签收直接拒绝；
--  - 同一交班人生成新单时，其此前未签收的单标记过期（被新单替换）；
--  - 站场重置使全部未签收（active）单过期，已签收（signed）单保留供复盘；
--    交接单只读快照、不写业务资源，不阻塞任何既有操作。
CREATE TABLE IF NOT EXISTS handover_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_name     TEXT NOT NULL,             -- 交班人（生成者）
  to_name       TEXT,                      -- 接班人（签收时写入）
  -- active 待签收 / signed 已签收 / expired 已过期（状态变化/被新单替换/站场重置）
  status        TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','signed','expired')),
  generated_at  INTEGER NOT NULL,          -- 生成时刻（epoch 毫秒）
  signed_at     INTEGER,                   -- 签收时刻（epoch 毫秒）
  snapshot      TEXT NOT NULL,             -- 六类状态快照（JSON）
  expire_reason TEXT,                      -- 过期说明（JSON：类别/明细/原因）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handover_status ON handover_documents(status, id);

-- 定时走行计划（值班员对已开放且尚未走行的进路提交的自动走行编排）：
--  - 步骤按进路区段顺序交替列出 占用(odd)/清空(even)，每步等待正整数秒；
--  - 首步从提交时刻计时，后续每步从上一步【成功】时刻计时（due_at 在进入
--    pending 时写入）；到期在同一事务内沿用现有事件序号与走行校验提交事件，
--    成功才推进计划，信号回红、逐段解锁、等待兑现均走现有规则；
--  - 人工事件抢先改变进度、延时取消申请、实例解除等前提失效时计划停止
--    （aborted，人工结果原样保留，不覆盖、不重发事件）；末步成功后 completed；
--    本人终止（terminated）只停止后续注入，不解除进路；
--  - 同一实例同时至多一笔活动计划（active/paused 部分唯一索引兜底）；
--  - 管理员重置删除进路实例时经外键级联一并清除；创建副本时不复制活动计划。
CREATE TABLE IF NOT EXISTS movement_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  applicant   TEXT NOT NULL,             -- 提交人（值班员姓名）
  route_id    TEXT NOT NULL,             -- 提交时进路编号快照（展示用）
  -- active 执行中（有下一步等待到期）/ completed 末步成功，整条走行完成 /
  -- aborted 前提失效（人工抢先/延时取消/实例解除/到期走行校验未通过）/
  -- terminated 提交人主动终止（仅停止后续注入，不解除进路）
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','completed','aborted','terminated')),
  total_steps INTEGER NOT NULL,          -- 计划总步数（= 进路区段数 × 2）
  current_step INTEGER NOT NULL DEFAULT 1, -- 下一步待执行步号；全部完成后为 total_steps+1
  created_at  INTEGER NOT NULL,          -- 提交时刻（epoch 毫秒，首步计时起点）
  ended_at    INTEGER,                   -- 进入终态时刻（epoch 毫秒）
  end_reason  TEXT                       -- 停止/完成说明
);

-- 同一进路实例同时至多一笔活动（active）定时走行计划
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_active_instance
  ON movement_plans(instance_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_plan_status ON movement_plans(status, id);
CREATE INDEX IF NOT EXISTS idx_plan_applicant ON movement_plans(applicant);

-- 定时走行计划步骤：
--  - step_order 从 1 起；奇数=占用（区段按 step_order 1,2,3…映射），偶数=清空；
--  - wait_seconds 为该步等待时长（正整数秒）；
--  - pending 待到期注入 / done 已成功注入；注入产生的走行事件 seq 记录在 event_seq；
--  - due_at 为到期时刻（epoch 毫秒）：首步=提交时刻+等待，后续=上一步成功时刻+等待。
CREATE TABLE IF NOT EXISTS movement_plan_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL REFERENCES movement_plans(id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL,
  section_id   TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('occupy','clear')),
  wait_seconds INTEGER NOT NULL,
  due_at       INTEGER,                  -- 进入 pending 时写入（epoch 毫秒）
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','done')),
  event_seq    INTEGER,                  -- 成功注入后对应的走行事件序号
  UNIQUE (plan_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_due
  ON movement_plan_steps(status, due_at);

-- 检查点（仅已暂停的命名演练副本可创建/回退；原站场不使用本表）：
--  - 创建时把站场定义、区段/道岔状态、进路实例与锁闭和事件、等待申请、
--    延时取消、临时封锁、定时走行计划与设置（meta）整体快照为 JSON 存入本表，
--    并记录当时的自增序列水位与基准时刻（暂停中的有效时刻）；
--  - 同一副本内检查点名称唯一（重名拒绝）；
--  - 回退在单个事务内用快照整体替换上述业务表（本表与交接单表不参与替换），
--    未签收交接单过期、已签收单保留；自增序列恢复到检查点水位，后续编号不冲突；
--    待处理取消与计划步骤按检查点当时的剩余时间继续冻结；
--  - 回退不删除检查点，同一检查点可反复回退；副本保持暂停。
CREATE TABLE IF NOT EXISTS checkpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,        -- 检查点名称（同一副本内重名拒绝）
  created_by  TEXT,                        -- 创建人（管理员）
  created_at  INTEGER NOT NULL,            -- 创建时刻（epoch 毫秒）
  summary     TEXT NOT NULL DEFAULT '{}',  -- 状态摘要（JSON：各类数量统计）
  snapshot    TEXT NOT NULL                -- 全量业务快照（JSON：业务表 + 序列水位 + 基准时刻）
);

CREATE INDEX IF NOT EXISTS idx_locks_instance ON route_locks(instance_id);
CREATE INDEX IF NOT EXISTS idx_events_instance ON section_events(instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_steps_route ON route_steps(route_id, step_order);

-- 命名演练副本考核（原站场不能开考；每个副本至多一场进行中的考核）：
--  - 管理员为【运行中的命名演练副本】指定一名学员与按顺序完成的进路目标，
--    开考时刻固定目标列表、学员与起始状态（start_state 存起始状态快照）；
--  - 仅考核开考后归属该学员的【新进路实例】：成功开放且通过逐段走行正常解除
--    （末段清空自动解除；人工释放、延时取消解除不算完成）；
--  - 开放时若进路与当前待达成目标相符则挂到该目标序号，否则记为偏差
--    （顺序外完成不补算）；等待申请自动兑现与定时走行同样计入；幂等重传不
--    重复计数；其他人的操作不计入，联锁规则不因考核改变；
--  - 副本暂停期间冻结有效用时（pause 时结算累计、resume 时重设起算点）；
--  - 检查点回退或站场重置终止进行中的考核并记录原因，已交卷成绩保留；
--  - 考核表不参与检查点快照/回退替换，创建副本时也不复制（各副本各自独立）。
CREATE TABLE IF NOT EXISTS exams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student     TEXT NOT NULL,             -- 学员（值班员姓名）
  status      TEXT NOT NULL DEFAULT 'in_progress'
              CHECK (status IN ('in_progress','submitted','terminated')),
  -- 开考时的进路目标序列快照（JSON 数组：[{seq,routeId,label}]，顺序即考核顺序）
  targets_json TEXT NOT NULL,
  started_by  TEXT,                      -- 开考管理员
  started_at  INTEGER NOT NULL,          -- 开考时刻（epoch 毫秒）
  -- 有效用时（毫秒）：暂停期间不计入。运行中=used_ms +(now-live_since)；
  -- 暂停时把本段计入 used_ms 并清空 live_since；恢复/交卷/终止时重设/结算。
  used_ms     INTEGER NOT NULL DEFAULT 0,
  live_since  INTEGER,                   -- 当前连续运行段的起算时刻（暂停中为 NULL）
  start_state TEXT NOT NULL DEFAULT '{}',-- 开考起始状态快照（JSON：目标与起始盘面摘要）
  submitted_at INTEGER,                  -- 学员交卷时刻（epoch 毫秒）
  terminated_at INTEGER,                 -- 被终止时刻（检查点回退/站场重置）
  end_reason  TEXT,                      -- 终止原因
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 同一副本至多一场进行中的考核（重复开考由该部分唯一索引兜底拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_in_progress
  ON exams(status) WHERE status='in_progress';

-- 考核的逐项目标（开考时按顺序写入；仅由目标完成事件推进）
CREATE TABLE IF NOT EXISTS exam_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,          -- 目标序号，从 1 开始（按顺序完成）
  route_id    TEXT NOT NULL,             -- 目标进路编号（开考时快照）
  label       TEXT,                      -- 开考时进路名称快照
  -- pending 待达成 / done 已由匹配实例正常走行解除达成
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','done')),
  instance_id INTEGER,                   -- 达成该目标的进路实例编号（开放时挂接）
  completed_at INTEGER,                  -- 正常解除时刻（epoch 毫秒）
  UNIQUE (exam_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_exam_targets_exam ON exam_targets(exam_id, seq);

-- 考核期间登记的学员进路实例（开考后该学员成功开放的新实例逐行登记）：
--  - target_seq 非空：开放时与当前待达成目标相符，挂接到该目标；
--  - target_seq 为空：顺序外/目标外进路，记为偏差（is_deviation=1），之后
--    完成也不补算；
--  - 正常逐段走行解除时写 completed_at，并在同一事务推进对应目标；
--    人工释放/延时取消解除不写 completed_at，不算完成。
-- 不设对 route_instances 的外键级联：管理员重置删除实例后考核记录仍保留溯源。
CREATE TABLE IF NOT EXISTS exam_instances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL,          -- 进路实例编号
  route_id    TEXT NOT NULL,             -- 开放时进路编号快照
  opened_by   TEXT NOT NULL,             -- 开放人（=学员姓名）
  source      TEXT NOT NULL DEFAULT 'manual'
              CHECK (source IN ('manual','waiting','plan')),
  target_seq  INTEGER,                   -- 挂接的目标序号；偏差为 NULL
  is_deviation INTEGER NOT NULL DEFAULT 0 CHECK (is_deviation IN (0,1)),
  completed_at INTEGER,                  -- 逐段走行正常解除时刻（epoch 毫秒）；未完成为 NULL
  note        TEXT,                      -- 备注（偏差原因等）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 同一实例在同一场考核内只登记一次（幂等重传/重复触发不重复计数）
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_instance_unique
  ON exam_instances(exam_id, instance_id);
CREATE INDEX IF NOT EXISTS idx_exam_instances_exam ON exam_instances(exam_id, id);

-- 站场追溯推演审计流水（每个站场业务库各自一份，天然隔离、不能串看）：
--  - 只记录真正改变推演状态的业务变更：进路开放、走行事件与解除、等待申请兑现、
--    延时取消解除、封锁状态变更、暂停/恢复、检查点回退、站场重置、副本创建界标；
--  - seq 在本站场内严格递增（INTEGER PRIMARY KEY AUTOINCREMENT），检查点回退、
--    站场重置都不删除本表、不回退序号，流水按站场递增、可按 seq 顺序分页；
--  - 每条与对应业务变更在【同一个数据库事务】内写入：业务变更回滚则流水一并回滚，
--    业务成功而流水缺失不可能出现（同成同败）；
--  - 失败操作在业务校验阶段抛错回滚、幂等重传走幂等分支、未改变状态的定时扫描，
--    均不调用写入函数，因此不产生条目；
--  - 本表不参与检查点快照/回退替换（回退后旧流水保留并追加 checkpoint_rollback
--    界标条目），创建副本时不复制旧流水（副本只从自身的 yard_created 界标记起，
--    旧数据不补造历史）。
CREATE TABLE IF NOT EXISTS audit_entries (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 本站场内严格递增的流水序号
  yard_id    INTEGER,                            -- 写入时的站场编号（冗余展示用）
  type       TEXT NOT NULL,                      -- 变更类型（见 CHECK 枚举）
  ref_type   TEXT NOT NULL,                      -- 关联编号类型
  ref_id     TEXT NOT NULL,                      -- 关联编号（实例/申请/区段/检查点等）
  actor      TEXT,                               -- 人工操作者姓名；系统来源为 NULL
  source     TEXT NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual','system')),
  reason     TEXT,                               -- 系统来源或操作原因（人工可空）
  before_state TEXT,                             -- 变更前状态摘要（JSON）
  after_state  TEXT,                             -- 变更后状态摘要（JSON）
  detail     TEXT,                               -- 附加明细（JSON：次要关联编号等）
  occurred_at INTEGER NOT NULL,                  -- 发生时刻（epoch 毫秒）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (type IN (
    'route_opened','route_event','route_released',
    'waiting_fulfilled','cancellation_released',
    'blockade_created','blockade_changed','blockade_ended',
    'yard_paused','yard_resumed',
    'checkpoint_rollback','yard_reset','yard_created'
  )),
  CHECK (ref_type IN (
    'route_instance','waiting','cancellation','blockade',
    'checkpoint','yard','reset'
  ))
);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_entries(type, seq);
CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_entries(ref_type, ref_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_entries(occurred_at);
