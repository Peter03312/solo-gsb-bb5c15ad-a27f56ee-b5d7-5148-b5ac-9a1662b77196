'use strict';

const path = require('path');
const express = require('express');

const { getMainDb, withYard } = require('./db');
const yards = require('./yards');
const recovery = require('./recovery');
const { seedDemo } = require('./seed');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const auditRoutes = require('./routes/audit');
const { InterlockError } = require('./interlocking');
const waiting = require('./waiting');
const cancellation = require('./cancellation');
const blockade = require('./blockade');
const movementPlan = require('./movement-plan');
const pause = require('./pause');

const PORT = Number(process.env.PORT || 3000);

// 打开主库（yards 注册表 + sessions；旧版业务库在 ensureRegistry 时迁移）
getMainDb();
const original = yards.ensureRegistry();

// 进程中断后的故障收敛：创建中断的副本回滚到操作前或激活为操作后完整状态；
// 暂停/恢复中断按业务库审计界标补齐（不重复平移、记账或写界标）；
// 业务库损坏的站场标记 broken 隔离——该副本拒绝访问并说明原因，其他站场照常。
const registeredYards = recovery.reconcileOnStartup();
const brokenYards = registeredYards.filter((y) => y.status === 'broken');
console.log(`[startup] 当前站场注册：${yards.listYards()
  .map((y) => `#${y.id} ${y.name}${y.isOriginal ? '（原站场）' : ''}` +
    (y.status === 'broken' ? '【已损坏隔离】' : y.status === 'paused' ? '（已暂停）' : ''))
  .join('；')}`);
if (brokenYards.length) {
  console.warn(`[startup] ${brokenYards.length} 个站场业务库损坏已隔离（不影响其他站场）：` +
    brokenYards.map((y) => `#${y.id} ${y.name}（${y.broken_reason || '未知原因'}）`).join('；'));
}

// 原站场首次且库为空时写入示例数据（SEED_DEMO=0 可关闭）；原站场损坏则跳过
withYard(original.id, () => {
  const row = yards.yardRow(original.id);
  if (row && row.status === 'broken') {
    console.error('[startup] 原站场业务库损坏，跳过示例数据初始化');
    return;
  }
  if (process.env.SEED_DEMO !== '0') {
    const seeded = seedDemo(require('./db').getYardConnection(original.id));
    if (seeded) console.log('[startup] 已初始化示例站场（R1/R2/R3）');
  }
});

// 服务重启后按各站场分别复核：待生效封锁转已生效、等待申请自动兑现、
// 延时取消按原 release_at 复核（副本不重新计时、不重复兑现）。
// 创建中断后被激活的副本也在此列（等价于其"首次复核"）；broken 站场跳过。
for (const y of yards.listYards()) {
  if (y.broken) continue;
  if (pause.isPaused(y.id)) continue;
  withYard(y.id, () => {
    try {
      const activated = blockade.refreshBlockadeStates('server_start');
      if (activated.length) {
        console.log(`[startup] 站场 #${y.id} ${y.name}：封锁申请转为已生效 #${activated.join('、#')}`);
      }
    } catch (e) {
      console.error(`[startup] 站场 ${y.id} 封锁状态复核失败:`, e);
      quarantineIfCorrupt(y.id, e);
    }
    try {
      const r = waiting.sweepFulfillments('server_start');
      if (r.fulfilled.length) {
        console.log(`[startup] 站场 #${y.id} ${y.name}：重启后自动兑现等待申请 #${r.fulfilled.join('、#')}`);
      }
    } catch (e) {
      console.error(`[startup] 站场 ${y.id} 等待申请兑现扫描失败:`, e);
      quarantineIfCorrupt(y.id, e);
    }
  });
}

/**
 * 扫描/复核过程中若判定为业务库损坏（文件丢失、无法打开、完整性失败等），
 * 隔离该站场：标记 broken，后续请求得到 503 YARD_BROKEN；其他站场不受影响。
 */
function quarantineIfCorrupt(yardId, e) {
  return recovery.quarantineIfCorrupt(yardId, e);
}

// 启动定时走行计划处理：立即扫描一次（重启后继续未完成计划，逾期步骤依序处理；
// 放在延时取消扫描之前，保证"重启即刻"两个启动扫描不会在同一毫秒内先后注入
// 计划的相邻步骤——后续步骤一律按"上一步成功时刻 + 等待"计时，只在 0.5s
// 定时周期里到期），之后每 0.5s 全站场扫描；副本不复制活动计划，各站场互不串用。
movementPlan.startScheduler();

// 启动延时取消到期处理：立即扫描一次（处理重启期间已到期的申请，逐站场），
// 之后每 0.5s 全站场扫描
cancellation.startScheduler();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', auditRoutes);
app.use('/api', apiRoutes);

// 兜底：未匹配的 /api 路径返回 JSON
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// 统一错误处理
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof InterlockError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...err.extra });
  }
  // 管理员/站场路由里手动抛出的带 status 错误
  if (err && err.status) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
  }
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

const httpServer = app.listen(PORT, () => {
  console.log(`[startup] 进路联锁推演台已启动: http://localhost:${PORT}/`);
});
httpServer.on('error', (e) => {
  console.error('[startup] HTTP 服务监听失败:', e);
  process.exit(1);
});
