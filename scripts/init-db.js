'use strict';

/**
 * 显式初始化脚本：主库建表（yards + sessions）→ 注册原站场/迁移旧库 →
 * 原站场业务库建表并（首次、库为空时）写入示例站场。
 * server.js 启动时也会自动调用同样的逻辑，此脚本供 Dockerfile CMD /
 * 手工 npm run init-db 使用。
 */
const { getMainDb, getYardConnection, withYard } = require('../src/db');
const yards = require('../src/yards');
const { seedDemo } = require('../src/seed');

getMainDb();
const original = yards.ensureRegistry();
const seeded = withYard(original.id, () =>
  process.env.SEED_DEMO === '0' ? false : seedDemo(getYardConnection(original.id)));

console.log('[init-db] 数据库已就绪:', process.env.DB_PATH || '(默认 ./data/interlock.db)');
console.log('[init-db] 已注册站场:', yards.listYards().map((y) => `#${y.id} ${y.name}`).join('；'));
console.log(seeded ? '[init-db] 已写入示例站场数据（R1/R2/R3、区段1~5、SW7/SW8、S1~S4）'
                   : '[init-db] 未写入示例数据（已初始化或 SEED_DEMO=0）');
