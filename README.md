# 小型铁路站场培训 —— Web 进路联锁推演台

一个用于教学/培训的铁路站场进路联锁推演系统：管理员绘制轨道区段、道岔、信号机并
定义起终点进路；值班员选择进路与道岔位置，系统依据联锁规则判定能否开放、给出阻断
原因，开放时原子锁定沿途资源，并按带序号的占用/清空事件模拟列车走行、逐段解锁。
当资源暂不具备时，值班员也可提交**等待申请**（不预锁资源），系统在条件具备时
按提交顺序自动兑现为进路实例。

对**已开放且尚无走行占用记录**的进路，值班员还可申请**延时取消**：申请立即令入口
信号回红、区段与道岔锁继续保留，等待申请不提前兑现；管理员设置的保护期满后，系统在
同一事务内重查"进路仍开放、无走行占用、沿途区段均空闲"才解除进路并触发等待兑现，
条件不符则终止取消、保留锁闭并说明原因。

对**已开放且尚未走行**的进路，值班员还可提交**定时走行计划**：按进路区段顺序交替
列出 占用、清空 步骤并为每步填写正整数秒等待时长，首步从提交时刻、后续每步从上一步
成功时刻计时；系统校验步骤覆盖完整进路、实例状态及同一实例没有其他活动计划，非法计划
整体拒绝。到期时沿用现有事件序号与走行校验，在同一事务内提交事件并推进计划——信号
回红、逐段解锁、等待兑现都走现有规则。人工事件抢先改变进度、提交延时取消或实例解除使
前提失效时，计划停止并说明原因，不覆盖人工结果、不重复发事件；末步成功后计划完成；
本人终止仅停止后续注入、不解除进路。重启后继续未完成计划、逾期步骤依序处理；活动计划
不随演练副本复制。

管理员还可按区段发起**临时封锁**：申请提交后立即阻止该区段参与新的进路预检、直接
开放与等待兑现（等待申请保留顺位并显示封锁原因）；已开放进路的锁闭、走行与延时取消
规则不受影响。区段空闲且无进路锁时申请自动由"待生效"转为"已生效"，否则持续复核；
管理员可随时结束封锁，结束后按现有联锁规则重试等待兑现。

值班员交班时还可生成**交接班交接单**：对当时的区段占用、道岔位置、开放进路的信号
与走行进度、等待申请、延时取消申请及未结束封锁做同一时刻的原子快照，并记录生成时间
与交班人。接班值班员在页面查看并签收（姓名须与交班人不同）；生成后任一快照状态发生
变化，签收即被拒绝、列出变化类别并将该单标记过期，由交班人重新生成。交接单只读快照、
不阻塞任何既有操作；站场重置使未签收单过期，已签收单保留供复盘。

管理员还可从**原站场**一键创建**命名演练副本**：在副本业务库的单个数据库事务内
复制站场定义、区段与道岔状态、开放进路的锁与事件进度、未兑现等待申请、未完结延时
取消（沿用原到期时刻）及未结束临时封锁，返回副本编号与状态（同名拒绝）；创建流程
带意图台账与复制清单，**进程中断后重启自动收敛到操作前（无残留/同名释放）或操作后
（完整可用）**。每个登录会话都可选择"当前站场"，
未选择时仍使用原站场；副本与原站场独立运行——编辑、预检、开放、走行、区段/道岔
调整、等待、延时取消、封锁、交接单与重置均只作用于当前站场，锁闭与申请顺位物理
隔离、绝不串用；历史交接单留在原站场。服务重启后按各站场分别复核延时取消，不重新
计时、不重复兑现；未知副本与越权操作一律拒绝；业务库损坏的副本明确拒绝访问
（503 YARD_BROKEN，说明原因），其他站场照常使用。

管理员还可暂停当前选中的**命名演练副本**（原站场始终运行、不可暂停）：暂停期间该副本
只允许只读查询、预检与会话切换，排路、走行、等待、取消、封锁、交接单、站场编辑与重置
等手工变更一律以 `409 YARD_PAUSED` 拒绝并说明原因；活动定时走行计划的下一步与待处理
延时取消的剩余等待会冻结，定时走行、延时取消、封锁复核和等待自动兑现均不推进暂停副本，
其他站场照常运行。恢复时按暂停时长继续计时；暂停前已到期而未处理的事项恢复后立即按原
规则复核。暂停状态、暂停人/时间与最近恢复信息持久化，跨服务重启有效，重复暂停或恢复
幂等且不会重复调整到期时间。

在**已暂停的命名演练副本**中，管理员还可创建**具名检查点**：在同一事务内快照该副本的
站场定义、区段与道岔状态、进路实例及锁闭和事件、等待申请、延时取消、封锁、定时走行
计划与设置（同一副本内重名拒绝）。管理员可查看检查点编号、名称、创建时间与状态摘要，
并将当前副本**整体回退**到指定检查点：回退在单个事务内完成，失败时原状态不变；成功后
检查点保留可再次使用，副本保持暂停，其他站场与各会话的站场选择不受影响。回退时未签收
交接单过期、已签收历史保留；检查点中的申请顺位、实例与事件序号原样保留，自增序列恢复
到检查点水位，后续编号不冲突；待处理取消与计划步骤按检查点当时的剩余时间继续冻结，
检查点当时已到期的事项在恢复副本后立即按现有规则复核、不重复执行。原站场或运行中副本
的创建、回退，以及未知检查点的查看、回退均拒绝。

管理员整理多条进路定义时，还可一次提交**进路定义批量变更集**（创建 / 修改 / 删除混合）：
先调用预览（或在管理台"进路定义 → 📋 批量变更集"中编辑后点"预览"）逐条查看校验结果、
**受影响的等待申请（含其当前阻断原因）**与整批阻断原因，预览同时返回**当前站场修订标识**；
确认后再携带该标识发布。发布在**同一事务内重验整批**：批内编号不得重复、创建不得重名、
修改或删除须指向现有进路、区段顺序不得重复、引用的区段/道岔/信号机须存在；预览后相关
定义、引用资源或等待申请发生变化（修订标识不符），或发布时存在开放进路、当前副本已暂停，
一律拒绝发布并**列明变化类别与原因**。任一项不合法时整批不落地、等待申请保持原状；成功时
**仅变更所列进路**，并沿用现有单条编辑的规则——修改/删除使相关等待申请失效并写明原因、
删除进路时清理已解除历史实例、提交后按现有规则重试等待兑现，不改变区段占用、锁闭及其他
站场。现有单条进路编辑与排路接口继续可用。

管理员还可为**运行中的命名演练副本**组织**学员考核**：指定一名学员与一组**按顺序完成**的
进路目标后开考，开考时刻固定目标序列与起始状态（原站场不能开考，同一副本只允许一场进行中
的考核，重复开考拒绝）。系统只统计**开考后归属该学员的新进路实例**：成功开放并**逐段走行
正常解除**时，若进路与当前待达成目标相符则推进该目标，等待申请自动兑现与定时走行同样计入；
走行事件的**幂等重传不重复计数**，人工释放（走行未完成时本就被联锁拒绝）与**延时取消解除
不算完成**。学员在当前目标之外成功开放的进路记为**偏差**，之后走完也不补算；其他人的操作
一律不计入，联锁规则不因考核改变。副本**暂停期间冻结有效用时**；**检查点回退或站场重置**
终止进行中的考核并记录原因，**已交卷成绩保留**。学员在值班台交卷（或调用交卷 API）返回
**逐项目标状态、偏差与有效用时**，成绩刷新与服务重启后仍可查询；未知进路、非指定学员、
已终止考核交卷与重复开考均被拒绝。管理台与值班台分别显示考核进度/成绩。

## 功能概览

- **管理员页面**：在 SVG 站场图上绘制轨道区段、道岔、信号机，定义起终点进路
  （依次点选沿途区段和道岔位置），也可用**批量变更集**一次编排多条进路的创建/修改/删除、
  先预览逐条结果与受影响等待申请再携带修订标识发布；可一键清空推演状态恢复到初始空场。
- **值班员页面**：选择进路及道岔位置 → 系统预检可否开放（信号状态、阻断原因）→
  开放进路（原子锁定区段/道岔）→ 按区段提交带**递增序号**的占用/清空事件 →
  列车进入首段信号自动回红 → 已清空区段逐段解锁 → 末段清空后整条进路解除。
  也可对已开放且尚未走行的进路提交**定时走行计划**（按区段顺序交替编排占用/清空步骤、
  每步正整数秒等待），由系统到期自动按序注入事件，或在值班台查看计划状态/下一步倒计时
  并由本人终止；人工抢先走行、延时取消、进路解除会使计划停止且不覆盖人工结果。
  也可对所选进路提交**等待申请**：
  - 申请只校验进路与道岔选择是否符合定义（未知进路、缺失/不符定义的道岔选择直接
    拒绝），**不预锁任何资源**，可查看申请编号、当前顺位、阻断原因与兑现后的进路实例。
  - 提交时，以及区段状态变化、道岔扳动、进路解除、服务重启后，系统自动尝试兑现；
    兑现时在**同一事务内重新执行现有开放校验与锁闭**——未知/占用区段、道岔实际
    位置不符、他路锁闭则继续等待并刷新阻断原因；重复触发**不会产生多个实例**。
  - 共享区段或道岔的等待申请严格按提交顺序排队，仍有效的前项未兑现时后项不得越过；
    资源互不相交的申请可以先兑现。
  - 本人可撤销自己尚未兑现的申请（非本人撤销拒绝）；申请人退出登录、管理员重置
    推演会撤销未兑现申请；进路定义被修改/删除会使相关申请失效并写明原因。
  - 等待状态与结果全部持久化在 SQLite，页面刷新、服务重启后仍可见。
- **延时取消（保护期后取消）**
  - 值班员可对**已开放且尚无走行占用记录**的进路申请延时取消，返回申请状态与最早
    解除时间；申请立即令**入口信号回红**，原区段锁与道岔锁继续保留；保护期内
    等待申请**不得提前兑现**。
  - 保护时长由管理员设置为**正整数秒**；申请落库即快照时长与最早解除时刻，之后
    修改设置**不追改**已有申请。
  - 到期后在**同一事务内重查**：实例仍开放、无走行占用记录、沿途区段均空闲，才
    解除进路并触发等待兑现；条件不符则**终止取消申请、保留锁闭并说明原因**。
  - 保护期内收到该实例的**首段占用事件**：按现有走行规则照常受理，并终止取消申请；
    **重复申请**返回原申请，不缩短期限、不产生第二笔申请。
  - 服务重启后继续处理未到期/已到期申请；管理员重置推演时申请与进路实例一并清除。
  - 现有人工解除、走行事件接口约定保持不变；值班台显示取消状态与实时剩余时间。
- **临时封锁（管理员按区段发起）**
  - 管理员按**区段编号 + 封锁原因**发起，返回申请编号、状态（待生效/已生效）与原因；
    未知区段、空白原因一律拒绝；同一区段已有未结束封锁时重复申请返回原申请，
    不产生第二笔。
  - 申请提交后**立即**阻止该区段参与新的进路预检、直接开放与等待兑现；等待申请
    保留顺位并显示封锁原因。**已开放进路保持原锁闭、走行与延时取消规则**，不因
    封锁申请强制解除。
  - 区段**空闲且无进路锁**时待生效申请自动转为已生效；占用、未知或仍锁闭时维持
    待生效。走行出清、独立区段状态变化、延时取消到期、进路解除及服务重启后持续
    复核，状态转换与开放校验读取同一份区段占用/锁闭状态。
  - 管理员可结束待生效或已生效封锁；结束后按现有联锁规则重试等待兑现，**不改写
    区段占用状态**。管理员与值班员页面均显示封锁状态；管理员重置推演时清除封锁
    记录。
- **交接班交接单**
  - 交班值班员一键生成：在**同一时刻、同一事务**内快照六类状态——区段占用、
    道岔位置、开放进路的信号与走行进度（锁闭、事件序号/头尾步）、等待申请、
    延时取消申请、未结束封锁，并记录**生成时间与交班人**。
  - 接班值班员在值班台"交接班交接单"面板查看完整快照并**签收**；接班人姓名
    **必须与交班人不同**（本人签收自己的单直接拒绝）。
  - 签收时在**同一时刻的状态上原子判定**：若生成后上述任一状态发生变化，签收
    **拒绝**、列出**变化类别与明细**，并把该单标记为**已过期**，由交班人重新
    生成；即使状态事后复原，旧单也不再有效。生成与签收均经单连接同步事务串行
    执行，并发操作不可能使过时交接单签收成功。
  - **同一接班人重复签收**幂等返回原结果（HTTP 200，`repeated:true`）；**其他
    人**对已签收单重复签收拒绝（409）。同一交班人生成新单时，其此前未签收单
    自动标记过期（被新单替换）。
  - 交接单只写自身快照、**不阻塞**任何现有进路/事件/等待/取消/封锁操作；
    **站场重置**（清空推演状态/培训重开）使全部未签收单过期，**已签收单保留**
    供复盘。记录全部持久化，刷新页面或服务重启后仍可查询；未签收单重启后仍可
    签收。
- **联锁规则**
  - 开放时在单个 SQLite 事务内检查并锁定资源：区段被占用（含**未知状态按占用处理**）、
    道岔实际位置与要求不符、资源已被其他开放进路锁定时一律拒绝，**回滚且不留下
    部分锁定**。
  - 两名值班员同时申请冲突进路，借助数据库唯一约束 + 事务，只可能成功一条。
  - 事件序号必须严格递增：同号同内容重传幂等不重复生效；同号异内容、跳号一律拒绝，
    并指出涉及区段。
  - 已开放进路锁定的道岔不得扳动；错误操作均返回涉及的区段/道岔/信号编号与原因。
  - 所有状态保存在本地 SQLite，刷新页面后完全恢复。
- **角色**：管理员（口令登录，默认 `admin` / `admin123`，可通过环境变量修改）；
  值班员输入姓名即可登录，支持两名及以上值班员同时操作，冲突在服务端仲裁。
- **站场追溯推演审计流水**：管理员与值班员按当前站场追溯进路开放、走行事件与解除、
  等待申请兑现、延时取消解除、封锁状态变更、暂停/恢复、检查点回退与站场重置；
  每条含发生时刻、人工操作者或系统来源、关联编号、变更类型与前后状态摘要，
  与业务变更**同事务同成同败**；失败操作、幂等重传与未改变状态的扫描不产生条目；
  回退/重置保留旧流水并写明界标，副本创建后只记录自身的新变化（旧数据不补造历史）；
  按序号分页、按类型与关联编号筛选，非法筛选明确拒绝，各站场物理隔离不能串看。

## 技术栈

- Node.js + Express（REST API）
- SQLite（[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)，同步事务）
- 原生 HTML/CSS/JavaScript + SVG 站场图，无前端构建步骤
- Docker / Docker Compose 一键启动

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `DB_PATH` | `/data/interlock.db`（容器内） | SQLite 数据库文件路径，父目录不存在会自动创建 |
| `ADMIN_PASSWORD` | `admin123` | 管理员登录口令 |
| `SEED_DEMO` | `1` | 首次启动且库为空时是否写入示例站场（1 写入 / 0 不写入） |

## 一键启动（推荐 Docker Compose）

```bash
docker compose up -d --build
```

容器启动时会自动完成：npm 依赖安装（已构建进镜像）、建表、以及（首次）写入一套
示例站场数据。数据通过命名卷 `interlock-data` 持久化到宿主机。

停止并保留数据：

```bash
docker compose down
```

清除全部本地数据重新开始：

```bash
docker compose down -v
docker compose up -d --build
```

## 本地直接运行（需要 Node.js ≥ 18）

```bash
npm install
DB_PATH=./data/interlock.db npm run init-db   # 建表 + 初始化示例数据（可选，start 也会自动建表）
DB_PATH=./data/interlock.db npm start
```

## 网页地址与端口

启动后浏览器访问：

| 页面 | 地址 |
| --- | --- |
| 登录入口 | http://localhost:3000/ |
| 管理员工作台 | http://localhost:3000/admin.html |
| 值班员工作台 | http://localhost:3000/dispatcher.html |

如修改了 `PORT`（例如 `PORT=8080`），请相应改为 `http://localhost:8080/`。

## 示例站场

首次启动写入的示例站场（见 `src/seed.js`）：

```
  X1 ●──── S1 ──[ 1 ]─[ 3 ]──[ 5 ]────● X3   正线（直股）
                    ╲       ╱
                   [2]─[4]╱         侧线（弯股）
                    SW7    SW8
```

- 区段：`1`～`5`；道岔：`SW7`（位置 N 直股 / R 弯股）、`SW8`（N 直股 / R 弯股）
- 信号机：`S1`（下行入口，防护进路 R1/R3）、`S3`（上行出口）、`S2`（侧线入口，
  防护进路 R2）、`S4`（侧线出口）
- 进路：
  - **R1 正线通过** X1→X3：区段 1,3,5，道岔 SW7=N、SW8=N
  - **R2 正线至侧线** X1→X4：区段 1,3,4,2，道岔 SW7=R、SW8=R
  - **R3 侧线至正线** X2→X3：区段 2,4,3,5，道岔 SW7=R、SW8=R
  - R1 与 R2/R3 争用区段 1/3 与道岔；R2 与 R3 争用 2/3/4 与道岔 —— 可用于验证
    "两人同时申请冲突进路只成功一条"。

> 示例区段初始状态为"空闲"，便于开箱即用。**管理员之后新建的区段初始状态为
> "未知（按占用处理）"**，需要由值班员先提交"清空"事件（序号 1）后才可用于进路。
> 道岔初始位置一律为 N（定位/直股）。

## 典型操作流程（值班员）

1. 登录后选择进路（如 R1），核对道岔要求位置（与实际不符时先在"道岔操作"区扳动，
   未锁定的道岔才允许扳动）。
2. 点击"预检"查看能否开放及阻断原因；点击"开放进路"，沿途区段与道岔被原子锁定，
   信号机转绿（允许）。
3. 在"事件提交"区按列车走行顺序逐段提交事件，序号从 1 开始递增：
   `1 占用 区段1` → 信号立即回红；`2 清空 区段1`（区段1自动解锁）→
   `3 占用 区段3` → `4 清空 区段3` → …… 末段（区段5）清空后整条进路自动解除。
4. 已清空的经过区段会逐段解锁；**末段未清空前，整条进路保持锁闭、信号保持红灯**。
5. 同号同内容重传返回成功但不会重复生效（幂等）；同号异内容、跳号会被拒绝并提示
   涉及区段与正确序号。
6. 若进路已开放但列车尚未进入（无走行占用事件），需要延时取消：在进路卡片点
   "申请延时取消"，入口信号立即回红、锁闭保留，保护期满且沿途区段均空闲才解除；
   保护期内一旦收到首段占用事件即自动终止取消，继续按走行处理。
7. 也可在进路卡片展开"定时走行计划"，按 占用/清空 交替填好每步等待秒数后提交：
   系统到期自动按序提交事件，首步从提交时刻、后续从上一步成功时刻计时；人工抢先走行、
   申请延时取消或进路解除会令计划停止，本人可随时终止计划（不解除进路）。

## 等待申请（排路等待）用法

当进路暂时不能开放（区段占用/未知、道岔实际位置不符、他路锁闭），值班员不必反复
手工重试：在值班台选择进路并核对道岔选择后，点**"提交等待申请（不预锁）"**即可。

- 等待期间不会锁定任何资源，直接开放与正常走行不受影响；申请面板中可看到每条申请的
  **编号、顺位、当前阻断原因**，已兑现的会显示对应的**进路实例编号**。
- 下列任一事件发生时系统自动重新尝试兑现：提交申请时、区段状态变化（占用/清空）、
  道岔扳动、进路逐段解锁或整条解除、管理员变更定义（可能导致失效）、**临时封锁结束**、
  服务重启。
- 排队规则：与仍在等待的前项申请**共享区段或道岔**时按提交顺序等待，不得越过；
  与前项**资源互不相交**的申请可以先行兑现（顺位只统计共享资源的前项数）。
- 本人申请在未兑现前可随时撤销；前项撤销后后项顺位自动前移。
- 进路定义被修改或删除时，相关未兑现申请标记为"已失效"并说明原因；退出登录或
  管理员"清空推演状态/恢复示例初始状态"会撤销全部未兑现申请。

### 等待申请 HTTP API（含调用示例）

所有接口均需值班员 Bearer 令牌（登录接口见下）；令牌也可通过登录时下发的
`sid` Cookie 传递。

先登录获取令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/dispatcher \
  -H 'Content-Type: application/json' \
  -d '{"name":"值班员甲"}'
# -> {"ok":true,"token":"abcd1234…","role":"dispatcher","name":"值班员甲"}
TOKEN=abcd1234…
```

**1) 提交等待申请**（按进路编号 + 所选道岔位置；不预锁资源，提交后立即尝试兑现）

```bash
curl -s -X POST http://localhost:3000/api/routes/R1/waiting \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
```

立即兑现成功：

```json
{"ok":true,"waiting":{"id":7,"seq":7,"routeId":"R1","applicant":"值班员甲",
 "switchPositions":{"SW7":"N","SW8":"N"},"status":"fulfilled","instanceId":12,
 "instance":{"id":12,"routeId":"R1","status":"open","signalState":"green"},
 "blockReasons":[],"position":null}}
```

暂不具备条件时进入等待（HTTP 201，`status:"waiting"`），字段含义：

| 字段 | 说明 |
| --- | --- |
| `id` / `seq` | 申请编号（自增，即提交顺序号） |
| `position` | 当前顺位：提交更早且共享区段/道岔、仍在等待的申请数 + 1 |
| `blockReasons` | 最近一次兑现尝试的阻断原因（占用/未知区段、临时封锁、道岔实际位置不符、他路锁闭、前项未兑现等） |
| `blockedBy` | 因"前项未兑现"被拦截时，挡在前面的申请编号列表 |
| `instanceId` / `instance` | 兑现后产生的进路实例编号与摘要（等待中为 `null`） |
| `status` | `waiting` 等待中 / `fulfilled` 已兑现 / `cancelled` 已撤销 / `invalid` 已失效 |
| `endReason` | 撤销或失效说明 |

提交被拒的情形：未知进路 `404 ROUTE_NOT_FOUND`；缺少道岔选择
`400 SWITCH_NOT_CHOSEN`；选择与进路定义不符 `409 SWITCH_POSITION_MISMATCH`；
选择了进路不要求的道岔 `400 SWITCH_NOT_IN_ROUTE`；位置非 N/R `400 BAD_POSITION`。

**2) 查看等待申请**（默认只返回本人的；加 `scope=all` 可查看全员用于仲裁展示；
等待与结果随 `/api/state` 一并下发，页面刷新/重启后同样可见）

```bash
curl -s "http://localhost:3000/api/waiting" -H "Authorization: Bearer $TOKEN"          # 本人
curl -s "http://localhost:3000/api/waiting?scope=all" -H "Authorization: Bearer $TOKEN" # 全员
curl -s "http://localhost:3000/api/waiting?status=waiting" -H "Authorization: Bearer $TOKEN"
```

**3) 撤销本人未兑现申请**（非本人 403 `NOT_OWNER`；已结束 409 `WAITING_NOT_ACTIVE`；
不存在 404 `WAITING_NOT_FOUND`；撤销后系统立即尝试兑现后续申请）

```bash
curl -s -X POST http://localhost:3000/api/waiting/7/cancel \
  -H "Authorization: Bearer $TOKEN"
```

兑现成功的进路实例与普通开放完全一致：可通过
`POST /api/instances/:id/events` 提交带序号的走行事件，末段清空后自动解除，
解除瞬间会自动触发其他等待申请兑现。

## 延时取消（保护期后取消）用法

当一条已开放进路暂无列车进入（**无任何走行占用事件**），值班员希望在给现场留出一段
防护时间后自动取消它，可在值班台该进路卡片上点**"申请延时取消"**（或调用下面的
HTTP API）。

- 申请**立即令入口信号回红**，原区段锁与道岔锁**继续保留**；保护期内已排队的等待
  申请因锁仍在**不会提前兑现**。值班台显示"延时取消中"徽标与实时倒计时（剩余时间 +
  最早解除时刻）。
- 保护时长由管理员在"推演管理 → 延时取消保护时长"中设置（**正整数秒**，默认 60 秒）；
  申请时把时长快照入库，**之后修改设置不追改已有申请**，只对新申请生效。
- 保护期内收到该实例**首段占用事件**：走行事件照常受理，取消申请立即终止（信号红、
  锁闭保留，按正常走行逐段解锁）。
- 到期时系统在**同一事务内重查**：① 实例仍开放；② 无走行占用记录；③ 沿途区段均
  空闲。三者满足才解除进路（删全部锁、信号红）并触发等待申请兑现；任一不满足则
  **终止取消申请、保留锁闭并写明原因**（如"沿途区段 5 当前被占用"），值班员可继续
  走行处理，条件恢复后重新申请。
- **重复申请**：同一实例已有待处理申请时，接口返回原申请（`created:false`），不缩短
  期限、不产生第二笔。
- 服务重启后定时器继续运行：未到期申请继续等待，重启期间已到期的启动即处理；
  管理员"清空推演状态/培训重开"会把申请与进路实例一并清除。

### 延时取消 HTTP API（含调用示例）

需值班员 Bearer 令牌（登录方式同上一节）。

**1) 申请延时取消**（仅已开放且无走行占用记录的实例）

```bash
curl -s -X POST http://localhost:3000/api/instances/12/cancel-delayed \
  -H "Authorization: Bearer $TOKEN"
```

新申请返回 **201**（重复申请命中同一条 pending 时返回 **200** 且 `created:false`）：

```json
{"ok":true,"created":true,
 "cancellation":{"id":3,"instanceId":12,"applicant":"值班员甲","status":"pending",
  "durationSeconds":60,"requestedAt":1790820000000,"releaseAt":1790820060000,
  "processedAt":null,"remainingMs":59982,"overDue":false,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `pending` 保护期等待中 / `released` 到期核验通过已解除 / `aborted` 条件不符或已走行，终止（锁闭保留） |
| `durationSeconds` | 申请时的保护时长快照（秒）；管理员之后改设置不影响它 |
| `requestedAt` / `releaseAt` | 申请时刻 / 最早解除时刻（epoch 毫秒） |
| `remainingMs` | 剩余毫秒（pending 时有效，到期为 0；前端按服务器时钟校准倒计时） |
| `endReason` | 解除说明，或终止原因（首段占用、区段占用/未知等） |

被拒情形：实例不存在或已解除 `404 INSTANCE_NOT_FOUND`；已有走行占用记录
`409 CANCEL_OCCUPANCY_EXISTS`；未登录 `401`；管理员身份 `403`。

**2) 查看延时取消申请**（默认本人全部；`scope=all` 全员；可加
`?status=pending|released|aborted`；待处理申请也随 `/api/state` 的
`pendingCancellations`、`cancellationRequests`、`cancelProtectionSeconds` 下发）

```bash
curl -s "http://localhost:3000/api/cancellations" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/cancellations?scope=all&status=pending" \
  -H "Authorization: Bearer $TOKEN"
```

**3) 管理员设置保护时长**（需管理员令牌；正整数秒，1~604800；只影响之后新申请）

```bash
# 查询
curl -s http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"protectionSeconds":60,"defaultSeconds":60,"maxSeconds":604800}

# 修改
curl -s -X PUT http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"protectionSeconds":120}'
# -> {"ok":true,"protectionSeconds":120,"note":"已更新；仅对之后提交的延时取消申请生效…"}
```

非法值（0、负数、小数、非数字）返回 `400 BAD_PROTECTION_SECONDS`。

## 定时走行计划用法

当一条进路已经开放但车列尚未进入（**无任何走行事件，下一序号为 1**），值班员可把整条
走行编排成一个**定时走行计划**，由系统按时刻表自动提交占用/清空事件，无需人工逐步点击。
在值班台该进路卡片中展开**"定时走行计划"**即可编排（或调用下面的 HTTP API）。

- 计划必须**按进路区段顺序交替**列出全部步骤：`占用区段1 → 清空区段1 → 占用区段3 →
  清空区段3 → …`，共"区段数 × 2"步；每步填写一个**正整数秒**等待时长。
- **计时规则**：首步从**提交时刻**开始计时；后续每一步都从上一步**成功**时刻重新计时
  （下一步的到期时刻在本步成功时才确定）。
- **到期处理**：系统在**同一事务**内沿用现有走行事件序号（步号即序号）与走行校验提交
  事件并推进计划——进入首段信号自动回红、区段清空后逐段解锁、**末步清空后整条进路解除**
  并触发等待申请兑现，全部与人工提交走完全相同的代码路径。
- **前提失效即停止**（状态 `aborted`，写明原因、不覆盖人工结果）：
  - 任何人通过现有人工走行接口**抢先提交了事件**、改变了走行进度；
  - 该进路提交了**延时取消申请**（申请立即令信号回红，计划不再注入）；
  - 实例被人工解除或到期处理时已不存在。
  - 到期注入时若走行校验未通过（状态已被外部改变等），同样停止并说明原因；
    步骤更新与事件在同一事务内，**重复触发不会重发事件**。
- **本人终止**（状态 `terminated`）只停止后续自动注入，**不解除进路**、不改动已注入的
  走行结果；非本人不能终止。
- 末步成功后计划**完成**（`completed`）。计划与步骤全部持久化：服务**重启后继续**未完成
  计划，重启期间已逾期的步骤启动即依序补注入，后续步骤仍按"上一步成功时刻 + 等待"计时。
- **同一进路实例同时至多一笔活动计划**；活动计划**不随命名演练副本复制**
  （副本里复制来的开放实例没有计划）；管理员重置推演时活动计划随实例一并清除。
- 现有人工走行、人工解除、延时取消、等待等接口约定**保持不变**。

### 定时走行计划 HTTP API（含调用示例）

需值班员 Bearer 令牌（登录方式见"等待申请 HTTP API"一节）。

**1) 提交定时走行计划**（仅已开放且尚未走行的实例；非法计划整体拒绝）

```bash
curl -s -X POST http://localhost:3000/api/instances/12/movement-plans \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"steps":[
    {"sectionId":"1","action":"occupy","waitSeconds":5},
    {"sectionId":"1","action":"clear","waitSeconds":8},
    {"sectionId":"3","action":"occupy","waitSeconds":3},
    {"sectionId":"3","action":"clear","waitSeconds":6},
    {"sectionId":"5","action":"occupy","waitSeconds":4},
    {"sectionId":"5","action":"clear","waitSeconds":10}
  ]}'
```

返回 **201**：

```json
{"ok":true,"plan":{
  "id":1,"instanceId":12,"routeId":"R1","applicant":"值班员甲","status":"active",
  "totalSteps":6,"currentStep":1,"createdAt":1790930000000,"endedAt":null,"endReason":null,
  "nextStep":{"step":1,"sectionId":"1","action":"occupy","actionText":"占用",
    "waitSeconds":5,"status":"pending","dueAt":1790930005000,
    "remainingMs":5000,"overDue":false,"eventSeq":null},
  "steps":[ /* 全部 6 步：同 nextStep 结构；未排期步骤 dueAt 为 null */ ]}}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `active` 执行中 / `completed` 末步成功已完成 / `aborted` 前提失效停止 / `terminated` 本人终止 |
| `currentStep` | 下一步待执行步号；全部完成后为 `totalSteps+1` |
| `nextStep` | 下一步：步号、动作（occupy/clear）、区段、到期时刻 `dueAt`、剩余毫秒；无下一步为 `null` |
| `steps[]` | 全量步骤；`status` 为 pending/done，成功后 `eventSeq` 为产生的走行事件序号 |

提交被拒（非法计划**整体拒绝**，不留任何数据）：

| HTTP | code | 情形 |
| --- | --- | --- |
| 400 | `PLAN_STEPS_REQUIRED` | 未提供 steps 或为空 |
| 400 | `PLAN_STEPS_MISMATCH` | 步数不等于"区段数×2"（未覆盖完整进路） |
| 400 | `PLAN_STEP_SECTION_MISMATCH` | 某步区段与进路区段顺序不一致 |
| 400 | `PLAN_STEP_ACTION_MISMATCH` | 某步动作不是按顺序交替的 占用/清空 |
| 400 | `BAD_WAIT_SECONDS` | 等待时长不是正整数秒（0、负数、小数、非数字） |
| 409 | `PLAN_PROGRESS_EXISTS` | 实例已有走行记录（只能对已开放且尚未走行的进路提交） |
| 409 | `PLAN_ALREADY_ACTIVE` | 同一实例已有活动计划 |
| 409 | `PLAN_CANCELLATION_PENDING` | 该实例有待处理的延时取消申请（计划与延时取消互斥） |
| 404 | `INSTANCE_NOT_FOUND` | 实例不存在或已解除；未登录 `401`；管理员 `403` |

**2) 查看计划列表 / 查看单张**（默认只返回本人的；`scope=all` 全员；
可加 `?status=active|completed|aborted|terminated`；活动计划也随 `/api/state`
的 `movementPlans`、`activeMovementPlans` 下发，值班台 2 秒轮询自动刷新）

```bash
curl -s "http://localhost:3000/api/movement-plans" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/movement-plans?scope=all&status=active" \
  -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/movement-plans/1" -H "Authorization: Bearer $TOKEN"
```

**3) 本人终止计划**（仅停止后续注入，不解除进路；非本人 403、已终态 409）

```bash
curl -s -X POST http://localhost:3000/api/movement-plans/1/terminate \
  -H "Authorization: Bearer $TOKEN"
# -> {"ok":true,"plan":{"id":1,"status":"terminated","endReason":"提交人主动终止：仅停止后续定时注入，不解除进路、已注入的走行结果保留",…}}
```

错误码：非本人 `403 NOT_OWNER`；计划已终态
`409 MOVEMENT_PLAN_NOT_ACTIVE`；计划不存在 `404 MOVEMENT_PLAN_NOT_FOUND`。

## 临时封锁用法

管理员因施工、抢修等原因需要临时禁止某区段排进新路时，在管理员页面"临时封锁"区
选择区段、填写原因后点**"发起封锁"**（或调用下面的 HTTP API）。值班员在值班台
"临时封锁"面板、区段选择列表与站场图（区段下方红色 `⊘封锁中/⊘封锁待生效` 标记）
都能看到封锁状态。

- 发起即生效于"新排路"：该区段参与的新**预检**会在阻断原因中列出封锁，**直接开放**
  返回 `409 SECTION_BLOCKADED`，**等待申请**保持等待、顺位不变并把阻断原因刷新为
  封锁原因。**已开放进路不受任何影响**：锁闭、走行事件、延时取消规则原样。
- 状态转换：区段空闲且无进路锁 → 自动**已生效**；占用/未知/仍锁闭 → 保持**待生效**，
  系统在走行出清、独立区段状态变化、延时取消到期、进路解除、服务重启后自动复核。
- 结束：管理员结束待生效/已生效封锁后，系统按现有联锁规则重试等待兑现；区段占用
  状态保持原样（封锁与结束都不改写占用状态）。

### 临时封锁 HTTP API（含调用示例）

先登录获取管理员令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/admin \
  -H 'Content-Type: application/json' \
  -d '{"password":"admin123"}'
# -> {"ok":true,"token":"cafe1234…","role":"admin","name":"管理员"}
ADMIN_TOKEN=cafe1234…
```

**1) 发起临时封锁**（按区段编号 + 封锁原因）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sectionId":"3","reason":"道岔检修施工"}'
```

新申请返回 **201**；同一区段已有未结束（待生效/已生效）封锁时返回 **200** 且
`created:false`，内容为原申请（不因为重复申请产生第二笔）：

```json
{"ok":true,"created":true,
 "blockade":{"id":2,"sectionId":"3","applicant":"管理员","reason":"道岔检修施工",
  "status":"pending","createdAt":"2026-10-01 06:30:00",
  "activatedAt":null,"endedAt":null,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 封锁申请编号（自增） |
| `status` | `pending` 待生效 / `active` 已生效 / `ended` 已结束 |
| `reason` | 封锁原因（首尾空白自动去除，空白原因拒绝） |
| `activatedAt` | 转为已生效的时刻（区段空闲且无进路锁时） |

被拒情形：未知区段 `404 SECTION_NOT_FOUND`；空白/缺失原因
`400 BLOCKADE_REASON_REQUIRED`；未登录 `401`；值班员身份 `403`。

**2) 查看封锁列表**（管理员；未结束在前，可加 `?status=pending|active|ended`）

```bash
curl -s "http://localhost:3000/api/admin/blockades" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s "http://localhost:3000/api/admin/blockades?status=active" -H "Authorization: Bearer $ADMIN_TOKEN"
```

值班员只读查看（未结束封锁也随 `/api/state` 的 `blockades` 与
`blockadesBySection` 一并下发，页面据此显示）：

```bash
curl -s "http://localhost:3000/api/blockades" -H "Authorization: Bearer $TOKEN"
```

**3) 结束封锁**（待生效/已生效均可结束；结束后自动按现有联锁规则重试等待兑现）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades/2/end \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"blockade":{"id":2,"status":"ended","endedAt":"2026-10-01 06:41:12",…}}
```

被拒情形：申请不存在 `404 BLOCKADE_NOT_FOUND`；已结束 `409 BLOCKADE_NOT_ACTIVE`。

封锁期间值班员既有接口行为：预检 `POST /api/routes/:id/check` 的 `reasons` 会包含
"区段 X 已被临时封锁（申请 #N，…，原因：…）"；直接开放
`POST /api/routes/:id/open` 返回 `409 SECTION_BLOCKADED`；走行事件
`POST /api/instances/:id/events`、延时取消等既有接口约定不变。

## 交接班交接单用法

值班员交班时，在值班台右侧"交接班交接单"面板点**"生成交接单（交班）"**（或调用
下面的 HTTP API）。系统在**同一时刻、同一事务**内快照六类盘面状态并记录交班人与
生成时间，不锁定任何业务资源，排路、走行、等待、取消、封锁等操作**一切照常**。

接班人（须用**与交班人不同的姓名**登录）在面板查看交接单内容并点**"签收（接班）"**，
系统按签收时刻的状态原子比对：

- 六类快照均无变化 → 签收成功（HTTP 201），写入接班人与签收时间；
- 任一类别变化 → 签收拒绝（HTTP 409 `HANDOVER_STALE`），返回**变化类别
  `changedCategories` 与逐条明细 `changes`**，该单同时被标记为**已过期**；
  交班人核对现场后**重新生成**，接班人再签收。即使状态后来复原，旧过期单也不再有效；
- 交班人本人签收拒绝（`HANDOVER_SAME_PERSON`）；
- 同一接班人对已签收单重复签收 → 幂等返回原结果（HTTP 200，`repeated:true`）；
  其他人重复签收 → 409 `HANDOVER_ALREADY_SIGNED`；
- 同一交班人再次生成 → 本人此前未签收单自动标记过期（被新单替换）；
- 管理员"清空推演状态/培训重开"→ 全部未签收单过期，**已签收单保留供复盘**；
- 刷新页面、服务重启后交接单记录仍在；未签收单重启后仍可签收。

被快照与比对的六类状态（变化类别 `changedCategories` 取值）：

| 类别 code | 含义 | 典型变化明细 |
| --- | --- | --- |
| `sections` | 区段占用 | `区段 2：占用状态由 空闲 变为 占用` |
| `switches` | 道岔位置 | `道岔 SW7：位置由 N 变为 R` |
| `openInstances` | 开放进路的信号与走行进度 | 新开放/已解除、信号绿↔红、下一序号与头尾步、走行事件、区段逐段解锁 |
| `waiting` | 等待申请 | 新提交；等待中→已兑现/已撤销/已失效 |
| `cancellations` | 延时取消申请 | 新提交；待处理→到期已解除/已终止 |
| `blockades` | 未结束封锁 | 新发起封锁；封锁已结束 |

### 交接班 HTTP API（含调用示例）

需值班员 Bearer 令牌（管理员令牌不可用，返回 403；登录方式见"等待申请"一节）。

**1) 交班人生成交接单**（同一事务快照六类状态；本人此前未签收单被新单替换过期）

```bash
curl -s -X POST http://localhost:3000/api/handovers \
  -H "Authorization: Bearer $TOKEN"
```

返回 **201**：

```json
{"ok":true,"handover":{"id":12,"fromName":"值班员甲","toName":null,
 "status":"active","generatedAt":1790853565744,"generatedAtText":"2026/10/1 11:19:25",
 "signedAt":null,"signedAtText":null,
 "snapshot":{"sections":{"1":"free","2":"free","3":"occupied","4":"unknown","5":"free"},
  "switches":{"SW7":"N","SW8":"R"},
  "openInstances":{"11":{"routeId":"R1","status":"open","signalState":"red",
    "nextSeq":3,"headStep":2,"tailStep":1,
    "lockedSections":["1","3","5"],"lockedSwitches":["SW7","SW8"],
    "events":[{"seq":1,"sectionId":"1","action":"occupy"}]}},
  "waiting":{"7":{"routeId":"R1","applicant":"值班员乙","status":"waiting","instanceId":null,"switchPositions":{"SW7":"N","SW8":"N"}}},
  "cancellations":{"3":{"instanceId":11,"applicant":"值班员甲","status":"pending",
    "durationSeconds":60,"requestedAt":1790853500000,"releaseAt":1790853560000}},
  "blockades":{"2":{"sectionId":"3","applicant":"管理员","reason":"道岔检修施工","status":"active"}},
 "changedCategories":[],"changes":[],"expireReason":null}}
```

**2) 接班人签收**（姓名须与交班人不同；状态无变化才成功）

```bash
curl -s -X POST http://localhost:3000/api/handovers/12/sign \
  -H "Authorization: Bearer $TOKEN_B"
```

成功返回 **201**；同一接班人重复签收返回 **200** 且 `repeated:true`（内容为原签收结果）。
生成后状态变化返回 **409 `HANDOVER_STALE`**（该单已同事务标记过期）：

```json
{"ok":false,
 "error":"签收拒绝：生成交接单后以下状态已发生变化：区段占用、道岔位置；交接单标记过期，请重新生成",
 "code":"HANDOVER_STALE",
 "changedCategories":["sections","switches"],
 "changes":[
   {"category":"sections","label":"区段占用","details":["区段 2：占用状态由 空闲 变为 占用"]},
   {"category":"switches","label":"道岔位置","details":["道岔 SW7：位置由 N 变为 R"]}],
 "reason":"…"}
```

签收相关错误码：

| HTTP | code | 情形 |
| --- | --- | --- |
| 409 | `HANDOVER_SAME_PERSON` | 接班人姓名与交班人相同（本人签收自己的单） |
| 409 | `HANDOVER_STALE` | 生成后快照状态发生变化（响应含 `changedCategories`/`changes`，单已标记过期） |
| 409 | `HANDOVER_EXPIRED` | 单子已过期（被新单替换/站场重置/此前签收已检出变化），须重新生成 |
| 409 | `HANDOVER_ALREADY_SIGNED` | 已被他人签收；同一人重复签收则为幂等 200 |
| 404 | `HANDOVER_NOT_FOUND` | 交接单不存在 |

**3) 查看列表 / 查看单张**（列表也随 `GET /api/state` 的 `handovers` 一并下发）

```bash
# 全员（默认）；?status=active|signed|expired 可按状态过滤
curl -s "http://localhost:3000/api/handovers" -H "Authorization: Bearer $TOKEN"
# 只看与本人相关（本人交班或接班）
curl -s "http://localhost:3000/api/handovers?scope=mine" -H "Authorization: Bearer $TOKEN"
# 单张完整内容（含六类快照与过期变化明细）
curl -s "http://localhost:3000/api/handovers/12" -H "Authorization: Bearer $TOKEN"
```

列表顺序：待签收在前，其次已签收、已过期；同组内新单在前。交接单**不改变任何既有
接口契约**：进路预检/开放、走行事件、等待、延时取消、临时封锁接口的请求与响应均与
此前一致。

## 命名演练副本（从原站场复制，独立运行）

培训中常需要在不打断原站场推演的情况下，另开一套"快照式"演练。管理员可在管理台顶栏
点**"＋ 从原站场创建演练副本"**（或调用下面的 HTTP API），给副本起一个名字：

- 复制在服务端**副本业务库的单个数据库事务**内完成（复制过程写临时文件，成功后
  原子改名并翻转注册表；进程中断由启动收敛回滚或激活，不会留下注册了却打不开/只
  复制部分数据的副本，详见"故障恢复用法"一节），复制范围：
  - **站场定义**：区段、道岔、信号机、进路定义（步骤与道岔要求）；
  - **区段占用状态与道岔实际位置**；
  - **开放进路的锁与事件进度**：仅复制仍在开放（`open`）的进路实例及其
    区段/道岔锁、已提交的占用/清空事件与信号、序号、头尾步等进度；
  - **未兑现等待申请**（`waiting`，含申请人、道岔位置快照与当前顺位状态）；
  - **未完结延时取消**（`pending`）：`release_at` **原样沿用原到期时刻**，
    不重新计时；
  - **未结束临时封锁**（`pending`/`active`）；
  - 保护时长等元数据设置。
- **不复制**：已解除（`released`）的历史进路实例、已结束的等待/取消/封锁记录、
  **活动定时走行计划（计划不随副本复制）**、**历史交接班交接单（交接单留在原站场）**。
- 自增主键（进路实例号、等待/取消/封锁申请号）在副本中保持一致，便于对照。
- **同名拒绝**（另保留"原站场"这个名字）；空白名拒绝；只有管理员能创建，值班员
  返回 403、未登录返回 401。创建成功返回**副本编号**（`yard.id`，原站场固定为 1）、
状态（`active`）与各类复制数量。

### 选择当前站场（每个登录会话各自选择）

顶栏有**当前站场下拉框**，管理员与值班员都可切换：

- **未选择时仍使用原站场**（登录后的默认值）；选择副本后，该会话的所有请求都
  作用于所选站场，切换互不影响（每个会话在服务端各自保存选择）。
- `GET /api/state`、`GET /api/admin/state` 的响应顶层与 `state.yard` 都带当前站场
  `{id,name,kind,isOriginal,status,paused,pausedBy,pausedAt,resumedBy,resumedAt}`，
  管理台和值班台据此显示“运行中/已暂停”以及暂停人、暂停时间；页面顶栏也可查看所有
  副本的暂停状态。
- 选择**未知副本**返回 `404 YARD_NOT_FOUND`，会话当前选择保持不变。

### 副本与原站场完全独立

副本一经创建即与原站场**物理隔离（各用一个 SQLite 业务库文件）**，因此：

- 站场编辑（区段/道岔/信号机/进路定义）、预检、开放、走行事件、区段与道岔
  调整、等待申请与顺位、延时取消、临时封锁、交接单生成/签收、推演重置 **均只作用于
  当前站场**；
- **锁闭与等待申请顺位绝不串用**：副本里开放/解除进路、兑现等待，完全不影响
  原站场正在锁闭的资源与排队顺序（反之亦然）；同编号的进路实例在不同站场中互不可见；
- 对副本的**重置**只清空副本；原站场的实例、等待、封锁、占用状态一概不变；
- 交接单按站场隔离：副本里看不到原站场历史单，副本里新生成/签收的单也不出现在
  原站场。

### 暂停与恢复命名演练副本

只有管理员可暂停/恢复**当前会话选中的命名演练副本**；原站场不可暂停。暂停不是删除或
重置，副本的盘面、锁、申请与计划全部保留。

- **允许**：所有只读查询、进路预检（`POST /routes/:id/check`）、登录会话切换、管理员
  从原站场创建其他副本。
- **拒绝并说明原因**：排路/开放、走行、区段与道岔手工调整、人工解除、等待提交/撤销、
  延时取消、定时走行计划提交/终止、封锁发起/结束、交接单生成/签收、站场图/进路编辑、
  保护时长修改与站场重置等；统一返回 `409 YARD_PAUSED`。
- 值班员退出登录仍按原规则撤销其在各站场的等待申请；若该副本暂停，只撤销申请，**不
  在暂停副本触发后项兑现**。
- 暂停期间该副本的**定时走行、延时取消到期、封锁状态复核、等待自动兑现**全部停止；
  其他副本和原站场继续运行。
- 暂停时冻结活动计划当前下一步（仅这一步已有 `dueAt`）和待处理延时取消的
  `releaseAt`；恢复时按暂停时长平移仍未到期的事项，随后继续计时。活动计划后续步骤
  仍按现有规则在“上一步成功时刻 + 等待”后排期。
- **暂停前已经到期但尚未处理**的事项（例如暂停请求与 0.5 秒扫描交错）不做平移；恢复
  后立即按原规则复核，满足则走行/解除，不满足则停止/终止，避免重复。
- 重复暂停或重复恢复幂等返回，不重复平移到期时间；暂停记录持久化，服务重启期间继续
  保持暂停。恢复与到期扫描并发时，先在同一跨库事务内把站场状态改为 `active` 并完成
  时间平移，再执行复核，状态行的条件更新保证只有一个执行路径进入复核。

#### 进程中断后的自动收敛（副本创建 / 暂停 / 恢复）

副本创建、暂停、恢复同时涉及主库站场注册表与该副本独立业务库（SQLite 跨库
ATTACH 事务在多个 WAL 文件之间不提供崩溃原子性），因此这三类操作在服务端均按
**"意图台账 + 若干个单库事务"** 执行，每个步骤只原子写一个数据库文件；操作期间
进程被杀死/断电后，下次启动（或同一操作被再次调用时）由内置收敛流程自动收敛到
**操作前或操作后的完整状态**，无需人工修库：

- **副本创建**：注册行先以 `creating` 落库占用编号与同名，业务库在临时文件内
  **单库事务**完成全部复制并写入 `yard_created` 界标与复制清单，再原子改名落位、
  翻转注册行。中断在复制/改名前 → 删除注册行与残留临时文件，**回到操作前**（同名
  立即释放，可重新创建），绝不留下"已注册却打不开"或"只复制部分数据"的副本；
  中断在改名后 → 凭业务库中的复制清单校验文件完整后翻转激活，**回到操作后**，
  再由既有启动扫描补齐新副本首次复核。副本编号因 AUTOINCREMENT 不回收复用。
- **暂停**：业务库在单库事务内完成考核有效用时结算（`used_ms` 结算、`live_since`
  清空）并写 `yard_paused` 审计界标，随后主库单库事务翻转 `paused`。中断后重启以
  业务库界标为准：界标已在 → 只补主库翻转（**不重复记账、不重复写界标**）；界标
  不在 → 业务库变更未提交，保持操作前。
- **恢复**：业务库在单库事务内平移活动计划当前步 `due_at` 与待处理延时取消
  `release_at`（仅平移暂停时刻仍未到期者）、重设考核 `live_since`、写
  `yard_resumed` 界标（含平移时长与受影响条目数），随后主库翻转 `active`。中断后
  重启：界标已在 → 只补主库翻转（**不重复平移、不重复记账、不重复写界标**）；界标
  不在 → 按意图台账中记录的参数恰好平移一次。
- 主库中的 `yard_ops` 意图台账正常完成后立即清除；重启收敛结果会以
  `[recovery] …` 日志输出。重复暂停/恢复接口的幂等行为与中断收敛无关，始终保持
  （重复操作不产生任何第二次平移/记账/界标）。

**无法自动修复的损坏（明确拒绝，其他站场照常）**：启动时对每个已注册站场做
业务库完整性校验（文件存在、可打开、`quick_check=ok`、结构完整、副本复制清单
匹配）。文件丢失/损坏/被替换为非数据库文件等无法自动修复的情况，该站场被标记为
`broken` 并隔离：

- 选择该站场返回 **503 `YARD_BROKEN`**，响应与站场列表都带具体损坏原因
  （`brokenReason`）；该副本的所有读写、定时走行/延时取消/封锁/等待扫描一律跳过；
- **其他站场（含原站场与其余副本）完全不受影响，照常使用**；运行中扫描若发现某
  站场库损坏也会立即隔离该站场而不拖垮其他站场；
- 损坏隔离属于人工介入情形：核查/修复该副本业务库文件后可重新创建同名副本
  （原站场损坏需由管理员恢复备份或删除主库注册与业务库后重新初始化）。

```bash
# 1) 管理员先选择要暂停的副本
ADMIN_TOKEN=...
curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":2}'

# 2) 暂停当前副本
curl -s -X POST http://localhost:3000/api/admin/yards/current/pause \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"changed":true,
#     "yard":{"id":2,"name":"国庆演练A组","status":"paused","paused":true,
#             "pausedBy":"管理员","pausedAt":1790900000000,...}}

# 3) 暂停期间值班员尝试变更
curl -s -X POST http://localhost:3000/api/routes/R1/open \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
# -> 409 {"ok":false,"code":"YARD_PAUSED",
#         "error":"该命名演练副本已暂停，暂停期间拒绝手工业务变更；只读查询和会话切换不受影响，请由管理员恢复后再操作"}

# 4) 恢复；adjusted 显示被继续计时的活动计划步骤和 pending 取消数量
curl -s -X POST http://localhost:3000/api/admin/yards/current/resume \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"changed":true,"shiftMs":12345,
#     "adjusted":{"movementPlanSteps":1,"cancellations":1},
#     "yard":{"id":2,"status":"active","paused":false,
#             "resumedBy":"管理员","resumedAt":1790900123456,...}}
```

错误：对原站场暂停返回 `400 YARD_ORIGINAL_NOT_PAUSABLE`；原站场恢复返回
`400 YARD_ORIGINAL_NOT_RESUMABLE`；未知副本 `404 YARD_NOT_FOUND`；值班员调用返回 403。
已暂停再次暂停返回 200 且 `alreadyPaused:true`；已运行再次恢复返回 200 且
`alreadyResumed:true,shiftMs:0`。

### 重启后逐站场复核（副本延时取消不重新计时）

复制的 pending 延时取消**沿用原 `release_at`**。服务重启后：

- 启动扫描**按各站场分别复核**：副本里已到期的取消，按该副本自己的进路/区段状态
  在同一事务内核验——满足则解除该副本的进路，不满足则终止；**不会因为复制而重新计时，
  也不会在原站场与副本之间重复兑现**；
- 各站场的待生效封锁复核、等待申请自动兑现同样分别进行，互不干扰；
- 站场注册表（副本编号、名称）持久化，重启后仍在；未知副本依旧 404。

### 命名演练副本 HTTP API（含调用示例）

**1) 管理员从原站场创建命名副本**（无论该管理员会话当前选在哪个站场，来源始终是
原站场；同名 409）

```bash
curl -s -X POST http://localhost:3000/api/admin/yards \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"国庆演练A组"}'
```

返回 **201**：

```json
{"ok":true,
 "yard":{"id":2,"name":"国庆演练A组","kind":"copy","isOriginal":false,
  "sourceYardId":1,"status":"active","createdBy":"管理员","createdAt":"2026-10-01 23:31:13"},
 "detail":{"copied":{"sections":5,"switches":2,"signals":4,"routes":3,
   "openInstances":1,"waiting":1,"pendingCancellations":1,"unfinishedBlockades":1},
  "blockadesActivated":[],"cancellationsReleased":[],"cancellationsAborted":[],
  "waitingFulfilled":[]}}
```

| 字段 | 说明 |
| --- | --- |
| `yard.id` | **副本编号**（原站场固定为 1） |
| `yard.status` | 副本状态（`active`） |
| `yard.sourceYardId` | 来源站场，固定为 1（原站场） |
| `detail.copied` | 各类复制行数：定义、开放实例、等待、pending 取消、未结束封锁 |
| `detail.cancellationsReleased/Aborted`、`waitingFulfilled` | 创建后按副本自身状态立即复核的结果（到期取消解除/终止、等待兑现） |

错误：同名 `409 YARD_NAME_DUPLICATE`；名称为"原站场" `409 YARD_NAME_RESERVED`；
空白/超长 `400 YARD_NAME_INVALID`；值班员 `403`；未登录 `401`。

**2) 查看站场列表**（管理员、值班员均可；带当前选择）

```bash
curl -s http://localhost:3000/api/admin/yards -H "Authorization: Bearer $ADMIN_TOKEN"   # 管理员
curl -s http://localhost:3000/api/auth/yards  -H "Authorization: Bearer $TOKEN"        # 任意登录会话
# -> {"ok":true,"yards":[{"id":1,"name":"原站场","kind":"original","isOriginal":true,…},
#                           {"id":2,"name":"国庆演练A组","kind":"copy",…}],
#     "currentYardId":1}
```

**3) 选择当前站场**（每个会话各自生效；缺省 / 传 1 即回到原站场；未知副本 404）

```bash
curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":2}'
# -> {"ok":true,"yardId":2,"yardName":"国庆演练A组","isOriginal":false}

curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'   # 回到原站场
```

切换后，所有既有接口（预检/开放/走行/等待/取消/封锁/交接/重置与管理员编辑）的**请求与
响应约定保持不变**，只是数据作用于所选站场；例如副本里开放进路仍用
`POST /api/routes/R1/open`，返回的实例只存在于该副本。

## 命名演练副本检查点（暂停中快照与整体回退）

演练中常需要"先存档、再放手推演、随时回到存档点"。管理员可在**已暂停**的命名演练副本
中创建**具名检查点**，之后在管理台"检查点"面板（或下面的 HTTP API）把副本整体回退到
任一检查点。检查点保存在该副本自己的业务库 `checkpoints` 表中，随副本持久化，跨服务
重启有效；其他站场与各会话的"当前站场"选择完全不受影响。

- **创建**：仅当前会话选中的、**已暂停**的命名演练副本可创建（先暂停再创建）。同一
  事务内快照：站场定义（区段/道岔/信号机/进路定义）、区段占用与道岔位置、全部进路
  实例及其锁闭与走行事件、等待申请、延时取消、临时封锁、定时走行计划与步骤、以及
  保护时长等设置（meta），并记录各自增表的序列水位与基准时刻。**同一副本内重名拒绝**
  （409）；空白/超长名称拒绝（400）。
- **查看**：管理员可查看检查点**编号、名称、创建时间与状态摘要**（区段/道岔/信号机/
  进路定义数量、开放进路、等待、待处理延时取消、未结束封锁、活动计划数）。运行中的
  副本也可查看已有检查点（只读）；原站场没有检查点，查看任何编号都返回 404。
- **回退**：仅**已暂停**副本可回退。全部替换写库在**单个事务**内完成——任何失败整体
  回滚、**副本原状态不变**；成功后：
  - 检查点**保留不删**，可反复回退到同一检查点；副本**保持暂停**；
  - **未签收交接单过期**（写明回退原因），**已签收单保留**供复盘；交接单编号延续
    历史水位，不复用；
  - 检查点中的**申请顺位、进路实例与事件序号原样保留**，自增序列恢复到检查点水位，
    回退后新提交的等待/取消/封锁/实例编号从检查点水位继续，**不会与恢复的数据冲突**；
  - 待处理延时取消的 `releaseAt` 与活动计划待执行步的 `dueAt` 按"当前暂停基准时刻 −
    检查点基准时刻"平移，即**按检查点当时的剩余时间继续冻结**；检查点当时**已到期**
    的事项平移后仍已到期，**恢复副本后立即按现有规则复核**（满足则走行/解除，不满足
    则停止/终止），终态记录原样恢复、**不会重复执行**。
- **拒绝情形**：原站场创建/回退 `400 CHECKPOINT_ORIGINAL_FORBIDDEN`；运行中（未暂停）
  副本创建/回退 `409 CHECKPOINT_YARD_NOT_PAUSED`；未知检查点的查看/回退
  `404 CHECKPOINT_NOT_FOUND`；值班员调用 `403`；未登录 `401`。

### 检查点 HTTP API（含调用示例）

需管理员令牌（登录方式见"临时封锁 HTTP API"一节），并先把会话切到目标副本
（`PUT /api/auth/yard`）且暂停该副本（`POST /api/admin/yards/current/pause`）。

**1) 创建具名检查点**（当前副本须已暂停）

```bash
curl -s -X POST http://localhost:3000/api/admin/yards/current/checkpoints \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"基线一"}'
```

返回 **201**：

```json
{"ok":true,"checkpoint":{"id":1,"name":"基线一","createdBy":"管理员",
 "createdAt":1791004883034,"createdAtText":"2026/10/3 05:21:23",
 "summary":{"sections":5,"switches":2,"signals":4,"routes":3,"openInstances":1,
   "waiting":1,"pendingCancellations":1,"unfinishedBlockades":1,"activeMovementPlans":1}}}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 检查点编号（副本内自增） |
| `createdAt` / `createdAtText` | 创建时刻（epoch 毫秒 / 本地时间文本） |
| `summary` | 状态摘要：定义数量与开放进路、等待、待处理取消、未结束封锁、活动计划数 |

错误：重名 `409 CHECKPOINT_NAME_DUPLICATE`；空白/超长名称
`400 CHECKPOINT_NAME_INVALID`；原站场 `400 CHECKPOINT_ORIGINAL_FORBIDDEN`；
副本未暂停 `409 CHECKPOINT_YARD_NOT_PAUSED`。

**2) 查看列表 / 查看单个**（运行中副本也可查看；原站场列表恒为空）

```bash
curl -s http://localhost:3000/api/admin/yards/current/checkpoints \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s http://localhost:3000/api/admin/yards/current/checkpoints/1 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

未知检查点返回 `404 CHECKPOINT_NOT_FOUND`。

**3) 整体回退到指定检查点**（当前副本须已暂停；单事务替换，失败原状态不变）

```bash
curl -s -X POST http://localhost:3000/api/admin/yards/current/checkpoints/1/rollback \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回 **200**：

```json
{"ok":true,
 "checkpoint":{"id":1,"name":"基线一",…},
 "yard":{"id":2,"name":"国庆演练A组","status":"paused","paused":true,…},
 "restored":{"sections":5,"openInstances":1,"waiting":1,…},
 "timeShiftMs":12345,
 "handoversExpired":1,
 "note":"副本已整体回退到检查点并保持暂停；检查点保留可再次使用，恢复副本后按现有规则继续运行"}
```

| 字段 | 说明 |
| --- | --- |
| `yard` | 回退后的副本状态（仍为 `paused`，注册表未改动） |
| `restored` | 检查点状态摘要（即恢复后的各类数量） |
| `timeShiftMs` | 待处理取消/计划步骤到期时间的平移量（两次暂停基准时刻差） |
| `handoversExpired` | 本次回退标记过期的未签收交接单数量（已签收单保留） |

回退后副本保持暂停：值班台只读查询照常，手工变更仍 `409 YARD_PAUSED`；由管理员
`POST /api/admin/yards/current/resume` 恢复后，按检查点状态继续运行——已到期的
延时取消/计划步骤立即按现有规则复核，未到期的按检查点当时的剩余时间继续计时。

## 进路定义批量变更集（创建 / 修改 / 删除，预览后发布）

管理员整理多条进路定义时，不必逐条保存：可把多条**创建 / 修改 / 删除**组成一个变更集，
先在管理台"进路定义 → **📋 批量变更集（预览后发布）**"中编辑并点**预览**（或调用下面的
HTTP API），页面会展示：

- **当前站场修订标识**（`revision`，站场定义/引用资源/等待申请内容的 SHA-256 标识）；
- **逐条结果**：每一项是否合法，非法项逐条给出原因（批内编号重复、创建重名、
  修改/删除指向不存在的进路、区段顺序重复、引用的区段/道岔/信号机不存在等）；
- **受影响的等待申请**：修改/删除现有进路时，将随之失效的等待申请编号、申请人、
  道岔选择与其**当前阻断原因**；创建不影响任何等待申请；
- **整批阻断原因**：非法项汇总、当前是否存在开放进路、当前副本是否已暂停。

预览是**只读**操作，不写任何业务数据（已暂停副本也可预览，结果中会列出暂停阻断）。
确认无误后点**确认发布**（页面自动携带该次预览的一次性令牌 `previewId`；
HTTP 调用见下）。发布规则：

- 服务端在**同一事务内**重新校验修订标识与整批：预览后进路定义、引用的区段/道岔/信号机
  （含区段占用状态、道岔实际位置）或等待申请发生任何变化，返回 `409 REVISION_CHANGED`
  并在 `changedCategories` / `changes` 中**列明变化类别与明细**，须重新预览；
- 发布时存在**已开放进路**（与单条编辑同一限制）返回 `409 CHANGESET_BLOCKED` 并列明
  开放实例；当前副本**已暂停**返回 `409 YARD_PAUSED`；预览令牌无效、已被消费或服务已
  重启返回 `409 REVISION_STALE`；
- 整批中**任一项不合法**：事务整体回滚，**一条进路都不落地，等待申请保持原状**；
- 成功时**仅变更所列进路**，未列出的进路与其他站场资源一概不动，并**沿用现有单条编辑
  规则**：修改使该进路等待申请失效、删除使相关等待申请失效并清理已解除历史实例，
  随后按现有规则重试等待兑现；**不改变区段占用、锁闭**及其他站场；
- 预览令牌 `previewId` **一次性有效**：发布成功（或检测到变化被拒）后须重新预览；
  预览在服务进程内短期有效（30 分钟），服务重启后旧令牌失效。同内容多次预览的内容修订
  标识 `revision` 相同，但每次预览各有独立的 `previewId`，互不顶替。

现有单条编辑（`POST/PUT/DELETE /api/admin/routes…`）与值班员排路接口继续可用，约定不变。

### 批量变更集 HTTP API（含调用示例）

需管理员令牌（登录方式见"临时封锁 HTTP API"一节）。

**1) 预览变更集**（只读；请求体 `changes` 为变更项数组，每项含 `op` 与进路编号，
创建/修改项与单条编辑使用相同的进路字段）。响应中的 `revision` 是展示用的**当前站场
修订标识**（内容哈希），`previewId` 是发布时要携带的**一次性预览令牌**。

```bash
curl -s -X POST http://localhost:3000/api/admin/route-changeset/preview \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"changes":[
    {"op":"create","id":"R4","label":"侧线 X2→X4","origin":"X2","destination":"X4",
     "entrySignalId":"S2","steps":["2","4"],
     "switchReqs":[{"switchId":"SW8","position":"R"}]},
    {"op":"update","id":"R1","label":"正线通过 X1→X3","origin":"X1","destination":"X3",
     "entrySignalId":"S1","steps":["1","3","5"],
     "switchReqs":[{"switchId":"SW7","position":"N"},{"switchId":"SW8","position":"N"}]},
    {"op":"delete","id":"R3"}
  ]}'
```

返回 **200**：

```json
{"ok":true,"preview":{
  "revision":"rev1-a1b2c3…（SHA-256 内容修订标识）",
  "previewId":"prev-9f8e7d6c…（一次性预览令牌，发布时携带）",
  "revisionLabel":"rev1-a1b2c3…（SHA-256 内容标识，发布时原样携带）",
  "valid":true,
  "blockReasons":[],
  "openInstances":[],
  "paused":false,
  "summary":{"create":1,"update":1,"delete":1,"total":3,
             "affectedWaiting":1,"releasedInstancesToDelete":0},
  "results":[
    {"index":0,"op":"create","routeId":"R4","valid":true,"errors":[],
     "route":{ "...同请求中的进路定义..." },"affectedWaiting":[],"releasedInstancesToDelete":0},
    {"index":1,"op":"update","routeId":"R1","valid":true,"errors":[],
     "affectedWaiting":[7],"releasedInstancesToDelete":0},
    {"index":2,"op":"delete","routeId":"R3","valid":true,"errors":[],
     "affectedWaiting":[],"releasedInstancesToDelete":0}
  ],
  "affectedWaiting":[
    {"id":7,"routeId":"R1","applicant":"值班员乙","effect":"invalidate",
     "switchPositions":{"SW7":"N","SW8":"N"},
     "currentBlockReasons":["道岔 SW7 实际位置为 R，需先扳至 N"],
     "reason":"管理员将修改进路 R1 的定义，原等待申请失效"}
  ]}}
```

| 字段 | 说明 |
| --- | --- |
| `revision` | **当前站场修订标识**（进路定义/引用资源/等待申请内容的 SHA-256），用于人工核对预览基于的站场版本 |
| `previewId` | **一次性预览令牌**；第 2 步发布时携带（页面自动处理）；同内容多次预览各自不同 |
| `valid` | 整批当前是否可发布（全部项合法、无开放进路、副本未暂停） |
| `results[]` | 逐条结果：`index`（从 0 起）、`op`、`routeId`、`valid`、`errors[]`、该项将失效的等待申请与将删除的历史实例数 |
| `affectedWaiting[]` | 受影响等待申请：编号、进路、申请人、道岔选择、**当前阻断原因**与发布后的处理说明 |
| `blockReasons` | 整批阻断原因（非法项逐条汇总、开放进路、暂停） |
| `openInstances` / `paused` | 当前开放进路列表与副本暂停标记 |

**2) 发布变更集**（携带预览返回的一次性令牌 `previewId`；同一事务内重验整批后落地）

```bash
curl -s -X POST http://localhost:3000/api/admin/route-changeset/publish \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"previewId":"prev-9f8e7d6c…"}'
```

成功返回 **200**：

```json
{"ok":true,
 "revision":"rev1-d4e5f6…（发布后的新修订标识）",
 "summary":{"create":1,"update":1,"delete":1,"releasedInstancesDeleted":0},
 "results":[
   {"op":"create","routeId":"R4","applied":true,"affectedWaiting":[],"releasedInstancesDeleted":0},
   {"op":"update","routeId":"R1","applied":true,"affectedWaiting":[7],"releasedInstancesDeleted":0},
   {"op":"delete","routeId":"R3","applied":true,"affectedWaiting":[],"releasedInstancesDeleted":0}
 ],
 "invalidatedWaiting":[
   {"id":7,"routeId":"R1","applicant":"值班员乙","status":"invalid",
    "endReason":"管理员批量修改了进路 R1 的定义，原等待申请失效"}
 ],
 "waitingFulfilledAfter":[],
 "note":"批量变更已在同一事务内落地：仅所列进路定义发生变化；相关等待申请已按单条编辑规则失效……"}
```

发布被拒的情形：

| HTTP | code | 情形 |
| --- | --- | --- |
| 409 | `REVISION_CHANGED` | 预览后定义/引用资源/等待申请已变化；响应含 `changedCategories`（`routes`/`sections`/`switches`/`signals`/`waiting`）与逐条 `changes` 明细 |
| 409 | `CHANGESET_BLOCKED` | 发布时存在开放进路，或重验发现非法项；响应含 `blockReasons`、`openInstances`、逐条 `results` |
| 409 | `REVISION_STALE` | 预览令牌无效/已被消费/服务已重启；请重新预览 |
| 409 | `YARD_PAUSED` | 当前命名演练副本已暂停（暂停期间预览仍可用） |
| 400 | `BATCH_INVALID` / `BATCH_EMPTY` / `BATCH_TOO_LARGE` | `changes` 非数组 / 空批 / 单批超过 200 条 |
| 403 / 401 | — | 值班员身份 / 未登录 |

**3) 预览后站场被改动的示例**（`REVISION_CHANGED`，整批未落地）：

```bash
curl -s -X POST http://localhost:3000/api/admin/route-changeset/publish \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"previewId":"prev-9f8e7d6c…"}'
# -> 409
```

```json
{"ok":false,"code":"REVISION_CHANGED",
 "error":"发布拒绝：预览后当前站场的进路定义、等待申请已发生变化，请重新预览后再发布（变更尚未落地）",
 "changedCategories":["routes","waiting"],
 "changes":[
   {"category":"routes","label":"进路定义","details":["进路 R2：定义（区段顺序/道岔要求/起终点/入口信号）已变化"]},
   {"category":"waiting","label":"等待申请","details":["等待申请 #7（进路 R1）：状态由 等待中 变为 已撤销"]}
 ]}
```

## 学员考核（命名演练副本，顺序目标）

管理员可在**运行中的命名演练副本**里组织一场学员考核：在管理台"🎓 学员考核"面板（或调用
下面的 HTTP API）填写**学员姓名**并按考核顺序逐条追加进路目标，点"开考"后目标序列与当时的
起始盘面（区段占用、道岔位置、已开放实例）即被**固定快照**。学员随后在值班台正常排路走行，
系统自动按下列规则记录成绩：

- **只统计开考后的新进路实例、且开放人必须是指定学员**：开考前已开放的实例、其他值班员
  开放/走行/等待兑现的实例一律不计入（也不算偏差）；联锁规则不因考核改变。
- **推进规则**：学员成功开放进路时，若该进路与**当前待达成目标**（最靠前的未达成项）相符，
  该实例挂接到该目标；该实例随后**逐段走行、末段清空正常解除**时目标判为达成并推进到下一项。
  **等待申请自动兑现**（实例的开放人为申请人=学员）与**定时走行计划**到期注入走同一套代码
  路径，同样计入。
- **不重复/不计完成的情形**：走行事件序号**幂等重传**不重复计数；走行未完成时"人工解除"
  本就被联锁规则拒绝；**延时取消到期解除**（未走行）不算目标完成，登记实例保持未完成。
- **偏差**：学员在当前待达成目标之外（顺序外或目标外）成功开放的进路立即记为偏差并写明原因，
  即使之后逐段走完也**不补算**、不推进目标；全部目标达成后再开放也记偏差。
- **有效用时**：只累计副本处于运行状态的时间，**暂停期间冻结**（与暂停/恢复同事务结算），
  交卷或终止时定格。
- **终止与保留**：**检查点回退**（回退事务内置）或管理员**站场重置**（清空推演状态/培训
  重开）会把进行中的考核置为"已终止"并记录原因；**已交卷成绩完整保留**。考核记录不参与
  检查点快照替换、创建副本时也不复制（各副本各自独立）。
- **交卷与查询**：学员本人交卷返回逐项目标状态、偏差清单与有效用时；之后刷新页面或重启
  服务仍可查询。**原站场不能开考**（`400 EXAM_ORIGINAL_FORBIDDEN`），**暂停副本不能开考**、
  暂停中不能交卷（`409 YARD_PAUSED`）；同一副本**重复开考**拒绝
  （`409 EXAM_ALREADY_ACTIVE`）；未知进路 `404 EXAM_ROUTE_NOT_FOUND`；
  非指定学员交卷 `403 EXAM_NOT_ASSIGNED`；已终止交卷 `409 EXAM_TERMINATED`；
  重复交卷 `409 EXAM_ALREADY_SUBMITTED`；未知考核 `404 EXAM_NOT_FOUND`。

管理台面板显示：开考表单（学员 + 有序目标）、进行中考核的实时进度（逐项 ✓/待达成、偏差、
有效用时）与最近 5 场历史成绩；值班台面板（仅命名副本显示）显示当前考核或最近成绩、本人
交卷按钮，并在进路下拉框中用"🎓 当前考核目标第 N 项"标注待达成进路。

### 学员考核 HTTP API（含调用示例）

先以管理员创建/选中副本（见"命名演练副本"一节），值班员学员账号用本人姓名登录。

**1) 管理员开考**（仅运行中的命名副本；固定学员、有序目标与起始状态）

```bash
# targets 为进路编号数组，顺序即考核顺序；同一进路允许重复出现（按顺序考两次）
curl -s -X POST http://localhost:3000/api/admin/exams/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"student":"张三","targets":["R1","R2","R3"]}'
```

返回 **201**：

```json
{"ok":true,"exam":{
  "id":1,"student":"张三","status":"in_progress","inProgress":true,
  "targets":[
    {"seq":1,"routeId":"R1","label":"正线通过 X1→X3","status":"pending","done":false,"instanceId":null,"completedAt":null},
    {"seq":2,"routeId":"R2","label":"正线至侧线 X1→X4","status":"pending","done":false,"instanceId":null,"completedAt":null},
    {"seq":3,"routeId":"R3","label":"侧线至正线 X2→X3","status":"pending","done":false,"instanceId":null,"completedAt":null}],
  "currentTarget":{"seq":1,"routeId":"R1",...},
  "completedTargetCount":0,"totalTargetCount":3,"allTargetsDone":false,
  "instances":[],"deviations":[],"deviationCount":0,
  "startedBy":"管理员","startedAt":1791063000000,"startedAtText":"2026/10/3 21:00:00",
  "submittedAt":null,"terminatedAt":null,"endReason":null,
  "effectiveElapsedMs":0,
  "startState":{"time":1791063000000,"sections":[...],"switches":[...],"openInstances":[]}}}
```

| 字段 | 说明 |
| --- | --- |
| `targets[]` | 开考时固定的目标序列（含名称快照）；`status` 为 `pending`/`done`，达成后写入 `instanceId/completedAt` |
| `instances[]` | 开考后该学员全部新实例登记：`source`（`manual` 直接开放 / `waiting` 等待自动兑现）、`targetSeq`（挂接的目标序号，偏差为 null）、`deviation`、`completed`（逐段走行正常解除） |
| `deviations[]` | 顺序外/目标外开放记录（即使未走完也列出；走完不补算） |
| `effectiveElapsedMs` | 有效用时（毫秒；暂停期间冻结，交卷/终止后定格） |
| `startState` | 开考起始状态快照（区段/道岔状态与当时开放实例） |

错误：原站场 `400 EXAM_ORIGINAL_FORBIDDEN`；副本暂停 `409 YARD_PAUSED`；
已有进行中考核 `409 EXAM_ALREADY_ACTIVE`；学员姓名为空 `400 EXAM_STUDENT_INVALID`；
目标为空/超长 `400 EXAM_TARGETS_REQUIRED`/`EXAM_TARGETS_TOO_MANY`；
目标含未知进路 `404 EXAM_ROUTE_NOT_FOUND`；值班员调用 `403`。

**2) 开考后沿用既有接口操作**（接口约定完全不变；系统在后台自动记录）

```bash
# 学员直接开放（source=manual）
curl -s -X POST http://localhost:3000/api/routes/R1/open \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
# 逐段走行：占用1/清空1/占用3/…，末段清空即正常解除并推进目标
curl -s -X POST http://localhost:3000/api/instances/12/events \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"seq":1,"sectionId":"1","action":"occupy"}'
# 或提交等待申请（自动兑现时 source=waiting，同样计入）、定时走行计划（到期走行计入）
```

**3) 查询考核进度 / 列表**（管理台与值班台均可用；`/api/state` 也附带 `exams.current/recent`）

```bash
curl -s http://localhost:3000/api/exams        -H "Authorization: Bearer $STUDENT_TOKEN"
curl -s http://localhost:3000/api/exams/1      -H "Authorization: Bearer $STUDENT_TOKEN"
curl -s http://localhost:3000/api/admin/exams -H "Authorization: Bearer $ADMIN_TOKEN"
```

**4) 学员本人交卷**（返回逐项目标状态、偏差与有效用时；非本人/已终止/重复交卷拒绝）

```bash
curl -s -X POST http://localhost:3000/api/exams/1/submit \
  -H "Authorization: Bearer $STUDENT_TOKEN"
```

返回 **200**（`exam` 结构同开考响应，此时 `status:"submitted"`，并含
`submittedAt`、累计后的 `effectiveElapsedMs`、每个目标的 `done/instanceId`）：

```json
{"ok":true,"exam":{"id":1,"status":"submitted",
  "completedTargetCount":3,"totalTargetCount":3,"allTargetsDone":true,
  "deviationCount":1,"effectiveElapsedMs":482000, ...}}
```

错误：非指定学员 `403 EXAM_NOT_ASSIGNED`；已终止 `409 EXAM_TERMINATED`；
重复交卷 `409 EXAM_ALREADY_SUBMITTED`；暂停中交卷 `409 YARD_PAUSED`；
未知考核 `404 EXAM_NOT_FOUND`。

**5) 暂停冻结 / 回退与重置终止（均为既有接口）**

```bash
# 暂停：有效用时停止累计（与暂停同事务）；恢复后继续
curl -s -X POST http://localhost:3000/api/admin/yards/current/pause    -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -X POST http://localhost:3000/api/admin/yards/current/resume   -H "Authorization: Bearer $ADMIN_TOKEN"
# 检查点回退：响应里 terminatedExamId 为被终止的考核编号（已交卷成绩保留）
curl -s -X POST http://localhost:3000/api/admin/yards/current/checkpoints/1/rollback \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,...,"terminatedExamId":2,...}
# 站场重置（清空推演状态 / 培训重开）同样终止进行中考核并写明原因
curl -s -X POST http://localhost:3000/api/admin/reset/training -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 站场追溯推演审计流水

管理员和值班员可按**当前所选站场**追溯推演状态变化。每个站场业务库各有一份
`audit_entries` 审计表，条目在该站场内按 `seq` 严格递增；审计写入与业务变更在
**同一个数据库事务**内完成——业务回滚则流水回滚，业务成功则流水必在（同成同败）。

**记录的变更类型（只记录真正改变推演状态的业务变更）**

| type | 含义 | refType / refId | 来源 |
| --- | --- | --- | --- |
| `route_opened` | 进路开放（人工直接开放） | `route_instance` / 实例号 | 人工 |
| `route_event` | 走行占用/清空事件（含定时计划注入） | `route_instance` / 实例号 | 人工 / 系统 |
| `route_released` | 进路解除（末段走行自动解除/人工解除） | `route_instance` / 实例号 | 人工 / 系统 |
| `waiting_fulfilled` | 等待申请兑现并产生进路实例 | `waiting` / 申请号 | 系统（actor=申请人） |
| `cancellation_released` | 延时取消核验通过并解除进路 | `cancellation` / 申请号 | 系统 |
| `blockade_created` | 封锁发起（待生效/已生效） | `blockade` / 申请号 | 人工 |
| `blockade_changed` | 封锁待生效→已生效 | `blockade` / 申请号 | 系统 |
| `blockade_ended` | 封锁结束（管理员结束/区段删除自动结束） | `blockade` / 申请号 | 人工 / 系统 |
| `yard_paused` / `yard_resumed` | 副本暂停 / 恢复 | `yard` / 站场号 | 人工 |
| `checkpoint_rollback` | 检查点回退（界标） | `checkpoint` / 检查点号 | 人工 |
| `yard_reset` | 站场重置（清空/培训重开，界标） | `reset` / `state`·`training` | 人工 |
| `yard_created` | 副本创建界标（仅副本有，恒为该副本 seq=1） | `yard` / 站场号 | 人工 |

每条含：`seq`、`occurredAt` 发生时刻（epoch 毫秒）、`actor` 人工操作者（系统来源为
`null`）、`source`（`manual`/`system`）、`reason` 系统来源或原因、`refType`+`refId`
关联编号、`type` 变更类型、`before`/`after` 前后状态摘要、`detail` 附加明细。

**不产生条目的情况**：失败的操作（校验拒绝、争用仲裁失败，事务整体回滚）、
幂等重传（同号同内容走事件、重复申请封锁/取消、重复暂停/恢复）、以及未改变任何
状态的定时扫描（等待扫描无人兑现、封锁复核无转换、取消扫描无到期）。

**回退、重置与副本的流水规则**

- 检查点回退：`audit_entries` 不参与快照替换，**此前流水全部保留**，追加一条
  `checkpoint_rollback` 界标（含检查点编号/名称、平移时长、过期交接单与终止考核），
  回退后新业务的流水序号在旧序号之上继续递增、不重号。
- 站场重置：此前流水保留，追加一条 `yard_reset` 界标（`before`/`after` 为重置前后
  盘面统计）。
- 创建副本：**不复制**原站场审计流水，新副本流水从 `yard_created` 界标（seq=1）
  开始，只记录该副本创建后自身的新变化，旧数据不补造历史。
- 各站场流水物理隔离，接口只作用于会话当前站场，**不能串看其他站场**。

### 审计流水 HTTP API（含调用示例）

**1) 登录**（管理员或值班员均可查询；先选择站场）

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login/admin \
  -H 'Content-Type: application/json' -d '{"password":"admin123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
DISPATCHER_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login/dispatcher \
  -H 'Content-Type: application/json' -d '{"name":"值班员甲"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# 选择要追溯的站场（缺省/1=原站场）；流水查询始终只针对当前站场
curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":2}'
```

**2) 按序号分页查询**（`seq` 递增；默认 `fromSeq=1`、`limit=50`，最大 200）

```bash
curl -s "http://localhost:3000/api/audit-entries?fromSeq=1&limit=50" \
  -H "Authorization: Bearer $DISPATCHER_TOKEN"
```

```json
{"ok":true,"me":"值班员甲","role":"dispatcher",
 "yard":{"id":1,"name":"原站场","isOriginal":true,...},
 "entries":[
   {"seq":12,"yardId":1,"type":"route_opened","typeLabel":"进路开放",
    "refType":"route_instance","refTypeLabel":"进路实例","refId":"7",
    "actor":"值班员甲","source":"manual","reason":null,
    "before":{"routeId":"R1","status":"none","signalState":"red"},
    "after":{"routeId":"R1","status":"open","signalState":"green",
             "lockedSections":["1","3","5"],"lockedSwitches":["SW7","SW8"]},
    "detail":{"routeId":"R1"},
    "occurredAt":1790900123456,"createdAt":"2026-10-04 06:41:12"}],
 "pagination":{"fromSeq":1,"limit":50,"returned":12,
               "nextFromSeq":13,"hasMore":false},
 "types":["route_opened","route_event","route_released","waiting_fulfilled",
          "cancellation_released","blockade_created","blockade_changed",
          "blockade_ended","yard_paused","yard_resumed","checkpoint_rollback",
          "yard_reset","yard_created"],
 "refTypes":["route_instance","waiting","cancellation","blockade",
             "checkpoint","yard","reset"]}
```

翻页：用上一页的 `pagination.nextFromSeq` 作为下一页的 `fromSeq`。

**3) 按类型与关联编号筛选**（类型可逗号分隔多选；关联编号精确匹配）

```bash
# 只看走行事件
curl -s "http://localhost:3000/api/audit-entries?type=route_event" -H "Authorization: Bearer $ADMIN_TOKEN"
# 同时看进路开放与等待兑现
curl -s "http://localhost:3000/api/audit-entries?type=route_opened,waiting_fulfilled" -H "Authorization: Bearer $ADMIN_TOKEN"
# 追溯某条进路实例（开放+全部走行+解除）
curl -s "http://localhost:3000/api/audit-entries?refType=route_instance&refId=7" -H "Authorization: Bearer $ADMIN_TOKEN"
# 追溯某笔封锁的完整生命周期（发起→转换→结束）
curl -s "http://localhost:3000/api/audit-entries?refType=blockade&refId=3" -H "Authorization: Bearer $ADMIN_TOKEN"
# 组合：只看某实例的走行事件
curl -s "http://localhost:3000/api/audit-entries?type=route_event&refType=route_instance&refId=7" -H "Authorization: Bearer $ADMIN_TOKEN"
```

**4) 非法筛选明确拒绝**：未知类型、非法 `refType`、`fromSeq`/`limit` 非正整数、
`limit>200`、`refId` 含非法字符，或任何白名单外参数（如 `yardId`）一律
`400 AUDIT_BAD_FILTER`，不会被静默忽略：

```bash
curl -s "http://localhost:3000/api/audit-entries?type=not_a_type" -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 400 {"ok":false,"code":"AUDIT_BAD_FILTER","error":"非法变更类型：not_a_type；允许的类型见响应 types"}
```

错误：未登录 `401`；暂停的副本仍可查询（只读）。

## 故障恢复用法（进程中断 / 业务库损坏）

副本创建、暂停、恢复都覆盖"主库注册表 + 副本独立业务库 + 审计流水"三处状态。
服务端把它们实现为**带意图台账（主库 `yard_ops` 表）的多个单库原子步骤**，因此
进程在任意一步被杀死（SIGKILL / OOM / 断电 / `docker kill`）后，**重启即自动
收敛**，不需要任何修复命令——直接按现有方式启动即可：

```bash
# 现有启动方式保持可用（Docker Compose / npm start / init-db 均不变）
docker compose up -d          # 或：DB_PATH=./data/interlock.db npm start
```

启动日志会逐条输出收敛结果，例如：

```text
[recovery] 站场 #3 恢复中断收敛：已收敛到操作后完整状态
[startup] 当前站场注册：#1 原站场（原站场）；#2 演练A（已暂停）；#3 演练B
```

### 三类操作中断后的预期结果

| 中断发生在 | 重启后结果 | 依据 |
| --- | --- | --- |
| 副本创建：复制/原子改名完成前 | 回到**操作前**：注册行与残留临时文件被清除，同名立即可再创建；不会出现"已注册却打不开/只复制部分数据"的副本 | 无正式业务库或临时库缺复制清单 |
| 副本创建：改名完成、注册行翻转前 | 到**操作后**：校验正式文件完整后激活副本，再按既有启动扫描复核到期取消/封锁/等待 | 正式文件 + `yard_copy_manifest` 清单 |
| 暂停：业务库结算/界标已写、注册表翻转前 | 到**操作后**：只补注册表翻转；考核用时不重复结算、界标不重复写 | 业务库 `yard_paused` 界标（时刻精确匹配） |
| 暂停：业务库事务前 | 回到**操作前**：副本仍运行，意图台账清除 | 业务库无匹配界标 |
| 恢复：平移/界标已写、注册表翻转前 | 到**操作后**：只补注册表翻转；到期时间不二次平移、考核不重复记账 | 业务库 `yard_resumed` 界标 |
| 恢复：业务库事务前 | 按意图台账参数恰好**平移一次**并翻转 | 意图参数（pausedAt/shiftMs）+ 无界标 |

### HTTP 调用示例（正常 + 中断重试，全部幂等）

```bash
# 登录（管理员）
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login/admin \
  -H 'Content-Type: application/json' -d '{"password":"admin123"}' \
  | sed 's/.*"token":"\([^"]*\)".*/\1/')

# 创建副本：若上一次创建在中途被杀死，重启后该名称已自动释放，直接重试即可
curl -s -X POST http://localhost:3000/api/admin/yards \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"国庆演练A组"}'

# 选中副本 → 暂停 →（任何时刻进程崩溃并重启都安全）→ 恢复
curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":2}'
curl -s -X POST http://localhost:3000/api/admin/yards/current/pause \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 重启后再次调用暂停：幂等（alreadyPaused:true），不会重复结算考核用时
curl -s -X POST http://localhost:3000/api/admin/yards/current/pause \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"changed":false,"alreadyPaused":true,"yard":{…"status":"paused"…}}

# 恢复：中断重启后若恢复已收敛完成，返回幂等结果（alreadyResumed:true,shiftMs:0）；
# 若收敛到操作前，则正常恢复一次。任何情况下定时走行/延时取消都只平移一次。
curl -s -X POST http://localhost:3000/api/admin/yards/current/resume \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"changed":true,"shiftMs":12345,
#     "adjusted":{"movementPlanSteps":1,"cancellations":1}, …}
```

同一次暂停/恢复在审计流水中**至多各一条界标**（`yard_paused` /
`yard_resumed`），可用既有审计接口核对：

```bash
curl -s "http://localhost:3000/api/audit-entries?type=yard_paused,yard_resumed" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 损坏隔离（无法自动修复时）

业务库文件丢失、被替换为非数据库文件或 `quick_check` 失败时，服务拒绝访问该
副本并说明原因，其他站场照常：

```bash
curl -s -X PUT http://localhost:3000/api/auth/yard \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":5}'
# -> 503 {"ok":false,"code":"YARD_BROKEN",
#         "error":"演练副本\"演练C\"（#5）业务数据已损坏且无法自动修复，已被隔离、
#                  拒绝访问：file is not a database；其他站场可正常使用，请联系管理员
#                  核查该副本业务库文件后重新创建副本",
#         "yardId":5,"reason":"file is not a database"}

# 站场列表中该副本 status="broken"，并带 brokenReason/brokenAt；其他副本状态正常
curl -s http://localhost:3000/api/admin/yards -H "Authorization: Bearer $ADMIN_TOKEN"
```

处理方式：停服核查 `data/interlock.yards/yard-<id>.db`（有备份则恢复备份后重启，
服务会重新校验并解除隔离；确认废弃时删除该业务库文件并由管理员在主库移除注册行
后重新创建同名副本）。主库 `yards` 表中的 `status` 取值现为
`active / paused / creating（创建中，重启收敛用）/ broken（损坏隔离）`，
`yard_ops` 为收敛意图台账（正常情况下表为空）。

## 数据持久化与重置

- **多站场存储**：主库（默认卷内 `/data/interlock.db`）保存**站场注册表 `yards`
  （含 `status` active/paused/creating/broken、暂停人/暂停时刻、最近恢复人/时刻、
  损坏原因）、登录会话 `sessions`（含每会话当前站场）与故障收敛意图台账 `yard_ops`**；
  每个站场（原站场与各命名演练副本）
  的全部业务数据各自保存在独立业务库文件 `/data/interlock.yards/yard-<id>.db`
  （原站场固定为 `yard-1.db`），副本业务库内另有 `yard_copy_manifest` 复制清单。
  业务库物理隔离保证副本之间、副本与原站场之间
  锁闭/等待顺位/延时取消/封锁/交接单**绝不串用**。
- 首次启动：主库与原站场空业务库自动建好并写入示例数据；从**旧版单库升级**时，
  启动会自动把旧主库中的全部业务数据（含历史交接单）整体迁移为原站场业务库，旧表保留；
  旧库升级时自动补建 `yard_ops`、`broken_reason/broken_at` 与 `yard_copy_manifest`。
- **进程中断收敛**：副本创建/暂停/恢复按"意图台账 + 单库原子步骤"执行，启动时
  自动收敛中断残留到操作前/操作后的完整状态，并校验各站场业务库完整性、隔离损坏库
  （详见上文"故障恢复用法"）。
- 每个站场的拓扑、状态、事件、进路实例、**等待申请、延时取消申请与保护时长设置、
  定时走行计划与步骤、临时封锁申请、交接班交接单、检查点（具名快照与状态摘要）、
  学员考核（场次、逐项目标、实例登记与有效用时）**
  都在对应业务库中，刷新/重启后恢复。
- 管理员页面"推演管理"提供：**清空推演状态**（删除进路实例/事件，区段恢复为未知、
  道岔回 N，保留站场图；同时撤销全部未兑现等待申请、**清除全部延时取消申请、活动定时
  走行计划与临时封锁记录、使未签收交接单过期（已签收单保留供复盘）、终止进行中的学员
  考核并记录原因（已交卷成绩保留）**）；**恢复示例初始
  状态**（额外把示例区段置为空闲；同样撤销/清除/过期/终止）。
  这些重置**只作用于当前会话所选站场**（顶栏"当前站场"）。
  "推演管理"中还可设置延时取消保护时长（正整数秒，仅影响之后新申请）。
- 存在已开放进路期间，当前站场图（拓扑/进路定义）不可编辑，防止改变正在使用的线路。
- 值班员退出登录会撤销其**在各站场的**全部未兑现等待申请；进路定义被修改/删除时，
  相关未兑现申请保留记录并标记失效、写明原因（已兑现产生的进路实例记录不受影响）。
- 服务重启后自动对**每个运行中站场**执行一次等待兑现扫描；暂停副本保持冻结，恢复后再复核；
  满足条件即兑现，不满足继续等待，且任何情况下一条申请至多对应一个进路实例。
- 延时取消的到期处理定时器随服务启动：启动即按**各运行中站场分别**扫描一次（处理重启期间
  已到期的申请；暂停副本跳过；副本复制来的申请沿用原 `release_at`，不重新计时），之后每 0.5
  秒全站场扫描；未到期申请继续倒计时，到期按同一事务重查结果解除或终止，跨站场不重复兑现。
- **定时走行计划**同样持久化并随服务继续：启动即扫描一次运行中站场，重启期间已逾期的步骤依序
  补注入（每步仍沿用事件序号与走行校验），暂停副本跳过，恢复时平移计划下一步后再处理；后续
  步骤按“上一步成功时刻 + 等待”继续计时，每 0.5 秒扫描一次；前提失效（人工抢先、延时取消、
  实例解除）的计划保持停止状态，不重发事件；活动计划不随副本复制，各站场的计划互不串用。
- 临时封锁随服务持久化：重启后**各运行中站场**未结束封锁继续有效并在启动时复核一次；暂停副本
  不复核，恢复后再处理；区段被删除时其未结束封锁自动标记结束并保留记录。

## 目录结构

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── scripts/init-db.js         # 显式建表/初始化脚本（主库注册表 + 原站场业务库）
├── src/
│   ├── server.js              # Express 入口与静态资源（逐站场启动复核/定时扫描）
│   ├── db.js                  # 主库 + 每站场业务库连接；AsyncLocalStorage 按会话路由当前站场
│   ├── schema-registry.sql    # 主库表：yards（站场注册表）/ sessions / yard_ops（故障收敛意图台账）
│   ├── schema-yard.sql         # 每个站场业务库的表结构（原站场与副本各一份，含 yard_copy_manifest 复制清单）
│   ├── recovery.js            # 进程中断收敛：创建回滚/激活、暂停恢复按审计界标补齐、损坏库隔离
│   ├── yards.js               # 命名演练副本：注册表/旧库迁移/单库事务复制（creating→active）/副本复核
│   ├── pause.js               # 副本暂停/恢复（意图台账、考核用时结算、计划与取消到期时间平移、审计界标）
│   ├── checkpoint.js          # 检查点：已暂停副本的具名快照/状态摘要/单事务整体回退（序列水位与时间平移）
│   ├── route-changeset.js     # 进路定义批量变更集：预览（逐条结果/受影响等待/修订标识）与同事务重验发布
│   ├── seed.js                # 示例站场
│   ├── auth.js                # 会话与鉴权（解析当前站场并绑定 withYard 上下文）
│   ├── interlocking.js        # 核心联锁逻辑（开放/事件/解锁/扳岔，含封锁校验）
│   ├── waiting.js             # 等待申请（提交/撤销/顺位/事务内自动兑现）
│   ├── cancellation.js        # 延时取消（申请/保护期/到期同事务核验/逐站场定时与重启复核）
│   ├── movement-plan.js       # 定时走行计划（交替占用/清空步骤/到期沿用序号注入/前提失效停止/重启续跑）
│   ├── blockade.js            # 临时封锁（发起/结束/待生效复核/重置清除）
│   ├── handover.js            # 交接班交接单（生成原子快照/签收同事务比对/过期/重置与重启）
│   ├── exam.js                # 学员考核（开考/开放登记与偏差/正常解除推进/交卷/暂停冻结用时/回退重置终止）
│   ├── audit.js               # 审计流水（与业务同事务写入/界标/按当前站场分页与筛选查询）
│   └── routes/
│       ├── auth.js            # 登录/登出；GET /auth/yards、PUT /auth/yard 选择当前站场
│       ├── admin.js           # 含副本创建/暂停恢复、保护时长、封锁、进路批量变更集（预览/发布）、重置（均作用于当前站场）
│       ├── audit.js           # GET /audit-entries 审计流水查询（管理员与值班员，只读当前站场）
│       └── api.js             # 值班员接口（只读/预检放行；暂停期间写操作统一拒绝）
├── public/                    # 前端页面（顶栏当前站场选择器 + 管理员创建副本入口）
└── test/
    ├── smoke.cjs              # 无需鉴权的联锁冒烟/并发测试脚本
    ├── waiting-http.cjs       # 等待申请 HTTP 端到端测试（含重启场景）
    ├── cancellation-http.cjs  # 延时取消 HTTP 端到端测试（含到期/终止/重启/重置）
    ├── blockade-http.cjs     # 临时封锁 HTTP 端到端测试（含阻断/复核/结束/重启/重置）
    ├── handover-http.cjs     # 交接单 HTTP 端到端测试（含六类变化/重复签收/并发/重置/重启）
    ├── yards-http.cjs        # 命名副本 HTTP 端到端测试（复制/选择/独立运行/隔离/重启逐站场复核）
    ├── recovery-http.cjs     # 进程中断收敛 HTTP 端到端测试（创建中断回滚/激活、暂停恢复中断按界标补齐不重复平移记账、损坏库 503 隔离且其他站场照常）
    ├── movement-plan-http.cjs# 定时走行计划 HTTP 端到端测试（校验/自动走行/人工抢先/终止/取消/重启/副本不复制）
    ├── pause-http.cjs        # 副本暂停/恢复 HTTP 端到端测试（写操作拒绝/冻结计时/退出撤销/重启/幂等）
    ├── checkpoint-http.cjs   # 检查点 HTTP 端到端测试（创建/重名/回退恢复/交接单过期/序列水位/时间冻结/重启）
    ├── route-changeset-http.cjs # 进路批量变更集 HTTP 端到端测试（预览逐条结果/受影响等待/修订标识/同事务重验/变化拒绝/开放与暂停阻断/重启标识失效）
    ├── exam-http.cjs         # 学员考核 HTTP 端到端测试（开考校验/重复开考/目标推进/偏差不补算/他人不计/幂等/等待兑现与定时走行计入/延时取消不算完成/暂停冻结用时/回退与重置终止/成绩保留重启/跨副本隔离）
    └── audit-http.cjs        # 审计流水 HTTP 端到端测试（九类变更条目/同成同败/幂等与失败不记录/分页与筛选/非法筛选拒绝/回退重置界标保留/副本界标独立/跨站场不串看）
```

## 测试

```bash
npm test             # 联锁冒烟 + 等待 + 延时取消 + 临时封锁 + 交接班 + 命名副本 + 中断收敛 + 定时走行计划 + 暂停恢复 + 检查点 + 进路批量变更集 + 学员考核 + 审计流水端到端
npm run smoke        # 联锁核心规则
npm run test:waiting# 等待申请提交/撤销/顺位/自动兑现/失效/重启
npm run test:cancel  # 延时取消申请/重复幂等/到期解除/首段占用终止/区段占用终止/重启/重置
npm run test:blockade# 临时封锁发起/校验/阻断/状态复核/结束/重启/重置
npm run test:handover# 交接单生成/六类快照/签收原子判定/变化过期/重复幂等/并发/站场重置/重启
npm run test:yards  # 副本复制/同名拒绝/会话选择/副本与原站场独立不串用/越权/重启逐站场复核
npm run test:recovery # 创建中断回滚/激活、暂停恢复中断按界标补齐（不重复平移/记账/写界标）、损坏库 503 隔离、其他站场照常
npm run test:plans  # 定时走行计划提交校验/自动依序走行完成/人工抢先停止不重发/本人终止不解除/延时取消停止/重启逾期依序处理/副本不复制活动计划
npm run test:pause  # 原站场不可暂停/写操作拒绝/定时任务冻结/退出撤销不兑现/跨重启/恢复平移与幂等
npm run test:checkpoint # 检查点创建/重名拒绝/查看摘要/整体回退/交接单过期保留/序列水位不冲突/剩余时间冻结/已到期复核/跨重启
npm run test:changeset # 进路批量变更集预览/逐条结果/受影响等待/修订标识变化拒绝/开放与暂停阻断/整批原子性/重启标识失效/单条编辑与排路不受影响
npm run test:exam    # 学员考核：原站场拒考/开考固定/重复开考拒绝/顺序目标推进/偏差不补算/他人不计/幂等重传/等待兑现与定时走行计入/延时取消与人工释放不算完成/暂停冻结有效用时/回退与重置终止/已交卷成绩保留/重启可查/跨副本隔离
npm run test:audit   # 审计流水：九类变更与前后摘要/同事务同成同败/失败与幂等重传不记录/按序号分页/类型与关联编号筛选/非法筛选 400/回退重置界标保留旧流水/副本 yard_created 独立计数/跨站场不串看
```
