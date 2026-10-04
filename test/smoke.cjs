'use strict';

/**
 * 联锁核心冒烟/并发测试（不经过 HTTP、无需登录）：
 *   DB_PATH 指向临时库 → seed 示例站场 → 逐条验证联锁规则。
 * 运行：npm run smoke
 */
process.env.SEED_DEMO = '1';
process.env.DB_PATH = process.env.SMOKE_DB || './data/smoke-test.db';

const fs = require('fs');
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + ext); } catch (_) {}
}

const assert = require('assert');
const { getDb } = require('../src/db');
const { seedDemo } = require('../src/seed');
const inter = require('../src/interlocking');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
}
async function expectThrow(name, fn, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, `${name}：应当被拒绝，但没有抛错`);
  if (code) assert.strictEqual(threw.code, code,
    `${name}：错误码应为 ${code}，实际 ${threw.code}（${threw.message}）`);
  console.log('  ✓', name, '→', threw.message);
  passed++;
}

async function main() {
  seedDemo(getDb());

  console.log('\n[1] 未知占用状态按占用处理');
  getDb().prepare(`UPDATE sections SET occ_state='unknown' WHERE id='5'`).run();
  await expectThrow('未知区段阻断开放 R1',
    () => inter.openRoute('R1', { SW7: 'N', SW8: 'N' }, '测试'), 'SECTION_UNKNOWN');
  // 无部分锁定残留
  const nLocks = getDb().prepare(`SELECT COUNT(*) n FROM route_locks`).get().n;
  const nInst = getDb().prepare(`SELECT COUNT(*) n FROM route_instances`).get().n;
  ok('失败后无实例、无部分锁定', nLocks === 0 && nInst === 0);
  inter.setSectionState('5', 'clear', '测试');

  console.log('\n[2] 道岔位置不符 / 未选择 拒绝');
  await expectThrow('道岔选择位置与进路要求不符 (R1 选 R)',
    () => inter.openRoute('R1', { SW7: 'R', SW8: 'N' }, '测试'), 'SWITCH_POSITION_MISMATCH');
  getDb().prepare(`UPDATE switches SET position='R' WHERE id='SW7'`).run();
  await expectThrow('道岔实际位置不符 (SW7 实际 R，R1 要求 N)',
    () => inter.openRoute('R1', { SW7: 'N', SW8: 'N' }, '测试'), 'SWITCH_ACTUAL_MISMATCH');
  await expectThrow('未选择道岔位置',
    () => inter.openRoute('R1', { SW8: 'N' }, '测试'), 'SWITCH_NOT_CHOSEN');
  getDb().prepare(`UPDATE switches SET position='N' WHERE id='SW7'`).run();

  console.log('\n[3] 正常开放，信号初始绿灯并锁定资源');
  const r1 = inter.openRoute('R1', { SW7: 'N', SW8: 'N' }, '值班员甲');
  ok('R1 开放成功', r1.status === 'open');
  ok('R1 信号绿灯', r1.signalState === 'green');
  ok('R1 锁定区段 1/3/5',
    ['1', '3', '5'].every((s) => r1.lockedSections.includes(s)));
  ok('R1 锁定道岔 SW7/SW8',
    r1.lockedSwitches.includes('SW7') && r1.lockedSwitches.includes('SW8'));

  console.log('\n[4] 争用：顺序申请冲突进路被拒绝且无部分锁定');
  const before = getDb().prepare(`SELECT COUNT(*) n FROM route_locks`).get().n;
  await expectThrow('冲突进路 R2 被拒（区段1/3、道岔争用）',
    () => inter.openRoute('R2', { SW7: 'N', SW8: 'R' }, '值班员乙'), 'RESOURCE_LOCKED');
  const after = getDb().prepare(`SELECT COUNT(*) n FROM route_locks`).get().n;
  ok('R2 失败后锁数量不变（无部分锁定）', before === after);

  console.log('\n[5] 锁闭道岔不能扳动');
  await expectThrow('扳动锁闭道岔 SW8 被拒',
    () => inter.moveSwitch('SW8', 'R', '值班员乙'), 'SWITCH_LOCKED');

  console.log('\n[6] 争用：释放后交替申请，资源仲裁只允许一条持有');
  // 先让 R1 走完解除
  walkThrough(r1.id, ['1', '3', '5'], '值班员甲');
  // 模拟两名值班员"同时"（同一轮里先后）提交冲突申请：
  let a, bErr = null;
  a = inter.openRoute('R1', { SW7: 'N', SW8: 'N' }, '并发甲');
  try { inter.openRoute('R2', { SW7: 'N', SW8: 'R' }, '并发乙'); }
  catch (e) { bErr = e; }
  ok('甲持锁成功，乙冲突失败（恰一条成功）', !!a && bErr && bErr.code === 'RESOURCE_LOCKED');
  const winnerRoute = getDb().prepare(`SELECT route_id FROM route_instances WHERE id=?`).get(a.id).route_id;
  const winnerSteps = winnerRoute === 'R1' ? ['1', '3', '5'] : ['1', '3', '4'];
  walkThrough(a.id, winnerSteps, '清理');

  console.log('\n[7] 序号事件：进入首段信号回红；幂等/异内容/跳号/顺序');
  inter.moveSwitch('SW8', 'R', '值班员甲');
  const r2inst = inter.openRoute('R2', { SW7: 'N', SW8: 'R' }, '值班员甲');
  ok('R2 开放信号绿', r2inst.signalState === 'green');
  const e1 = inter.submitSectionEvent(r2inst.id, 1, '1', 'occupy', '值班员甲');
  ok('#1 占用首段后信号回红', e1.signalTurnedRed === true
    && inter.getInstanceDetail(r2inst.id).signalState === 'red');

  const dup = inter.submitSectionEvent(r2inst.id, 1, '1', 'occupy', '值班员甲');
  ok('同号同内容重传幂等，不重复生效', dup.idempotent === true);
  await expectThrow('同号异内容拒绝',
    () => inter.submitSectionEvent(r2inst.id, 1, '3', 'occupy', '值班员甲'), 'SEQ_CONFLICT');
  await expectThrow('跳号拒绝（期望2收到3）',
    () => inter.submitSectionEvent(r2inst.id, 3, '3', 'occupy', '值班员甲'), 'SEQ_GAP');
  await expectThrow('未进入区段3前提前清空区段3被拒（须按出清顺序）',
    () => inter.submitSectionEvent(r2inst.id, 2, '3', 'clear', '值班员甲'), 'OUT_OF_ORDER');

  inter.submitSectionEvent(r2inst.id, 2, '3', 'occupy', '值班员甲');
  const clr1 = inter.submitSectionEvent(r2inst.id, 3, '1', 'clear', '值班员甲');
  ok('#3 清空区段1 → 区段1锁逐段解除', clr1.sectionUnlocked === true
    && !inter.getInstanceDetail(r2inst.id).lockedSections.includes('1'));
  await expectThrow('不能跳过区段3提前清空区段4（逐段解锁）',
    () => inter.submitSectionEvent(r2inst.id, 4, '4', 'clear', '值班员甲'), 'OUT_OF_ORDER');

  console.log('\n[8] 末段未清空前不能解除整条进路');
  // 当前 head=3(待占4), tail=2(待清3)：推进到末段占用
  inter.submitSectionEvent(r2inst.id, 4, '4', 'occupy', '值班员甲');
  inter.submitSectionEvent(r2inst.id, 5, '3', 'clear', '值班员甲');
  await expectThrow('末段4占用中，人工解除被拒',
    () => inter.releaseInstance(r2inst.id, '值班员甲'), 'LAST_SECTION_NOT_CLEARED');

  const fin = inter.submitSectionEvent(r2inst.id, 6, '4', 'clear', '值班员甲');
  ok('#6 清空末段 → 整条进路自动解除', fin.routeReleased === true);
  const detail = inter.getInstanceDetail(r2inst.id, true);
  ok('实例状态 released 且锁全部释放',
    detail.status === 'released' && detail.lockedSections.length === 0
    && detail.lockedSwitches.length === 0);

  console.log('\n[9] 刷新恢复：状态全部来自数据库');
  const state = inter.getState();
  ok('快照含区段/道岔/信号/进路/实例历史',
    state.sections.length === 5 && state.switches.length === 2
    && state.signals.length === 4 && state.routes.length === 3
    && state.recentReleased.length >= 3);
  ok('走行完毕区段全部恢复空闲',
    state.sections.every((s) => s.occ_state === 'free'));

  console.log(`\n全部 ${passed} 项断言通过 ✅`);
  getDb().close();
}

/**
 * 按"占1, 占2, 清1, 占3, 清2, …, 清末"的交错序列走完整条进路。
 * 联锁模型允许占用(head)领先出清(tail)若干步，但序号必须严格递增、
 * 占用按 head 顺序、清空按 tail 顺序。
 */
function walkThrough(instanceId, sections, client) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    inter.submitSectionEvent(instanceId, seq++, sections[i], 'occupy', client);
    if (i >= 1) inter.submitSectionEvent(instanceId, seq++, sections[i - 1], 'clear', client);
  }
  inter.submitSectionEvent(instanceId, seq++, sections[sections.length - 1], 'clear', client);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
