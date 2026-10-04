'use strict';

const express = require('express');
const { getDb, getMainDb } = require('../db');
const { requireAuth } = require('../auth');
const { getState, triggerWaitingSweep } = require('../interlocking');
const waiting = require('../waiting');
const cancellation = require('../cancellation');
const blockade = require('../blockade');
const handover = require('../handover');
const yards = require('../yards');
const movementPlan = require('../movement-plan');
const pause = require('../pause');
const checkpoint = require('../checkpoint');
const routeChangeset = require('../route-changeset');
const exam = require('../exam');
const { withYard } = require('../db');

const router = express.Router();
router.use(requireAuth('admin'));

// 暂停副本：除暂停/恢复自身、从原站场创建副本与检查点（创建/回退要求副本
// 已暂停，路由内自行校验）外，管理台所有写操作均拒绝。
// 进路批量变更集的"预览"是只读操作（不写业务数据），暂停副本也允许预览；
// 发布仍按写操作拒绝（409 YARD_PAUSED）。
router.use((req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (['/yards', '/yards/current/pause', '/yards/current/resume'].includes(req.path)) return next();
  if (req.path === '/yards/current/checkpoints' || req.path.startsWith('/yards/current/checkpoints/')) {
    return next();
  }
  if (req.path === '/route-changeset/preview') return next();
  try {
    pause.assertActive(req.yard.id);
    next();
  } catch (e) { next(e); }
});

const ID_RE = /^[A-Za-z0-9_一-龥-]{1,20}$/;
const NUM = (v) => typeof v === 'number' && Number.isFinite(v);

function badId(kind, id) {
  return !id || !ID_RE.test(String(id));
}

/** 有开放进路时禁止改动拓扑（防止改动正在使用的线路） */
function assertNoOpenInstances() {
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`).get().n;
  if (n > 0) {
    const err = new Error(`存在 ${n} 条已开放进路，锁闭期间不能修改站场图或进路定义，请待进路解除后再操作`);
    err.status = 409;
    throw err;
  }
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* --------------------------------- 状态 --------------------------------- */

router.get('/state', (req, res) => {
  res.json({ ok: true, state: getState(), yard: req.yard });
});

/* ----------------------------- 命名演练副本 ----------------------------- */

// 站场/副本列表（管理员视角；含当前选择）
router.get('/yards', (req, res) => {
  res.json({ ok: true, yards: yards.listYards(), currentYardId: req.yard.id });
});

// 从原站场创建命名演练副本（同事务复制定义/状态/锁与事件进度/未兑现等待/
// 未完结延时取消与临时封锁；历史交接单留在原站场）。同名 409 拒绝。
// 创建操作始终以原站场为来源，与会话当前选择的站场无关。
router.post('/yards', wrap((req, res) => {
  const result = yards.createCopyFromOriginal((req.body || {}).name, req.session.name);
  res.status(201).json({
    ok: true,
    yard: result.yard,                 // 副本编号（yard.id）与状态 status
    detail: result.detail
  });
}));

// 暂停当前选中的命名演练副本；原站场拒绝。重复暂停幂等，不改变暂停时间。
router.post('/yards/current/pause', wrap((req, res) => {
  const result = pause.pauseCurrentYard(req.yard.id, req.session.name);
  res.json({ ok: true, ...result });
}));

// 恢复当前副本：平移活动走行计划下一步与待处理延时取消的剩余等待；
// 已在暂停期间到期的事项平移后立即到期，由本接口事务外按原规则复核。
router.post('/yards/current/resume', wrap((req, res) => {
  const result = pause.resumeCurrentYard(req.yard.id, req.session.name);
  if (result.changed) {
    try { withYard(req.yard.id, () => blockade.refreshBlockadeStates('yard_resumed')); } catch (e) {
      console.error('[pause] 恢复后封锁复核失败:', e);
    }
    try { withYard(req.yard.id, () => movementPlan.processDue('yard_resumed')); } catch (e) {
      console.error('[pause] 恢复后定时走行扫描失败:', e);
    }
    try { withYard(req.yard.id, () => cancellation.processDue('yard_resumed')); } catch (e) {
      console.error('[pause] 恢复后延时取消扫描失败:', e);
    }
    // 前面的走行/取消处理可能释放资源；最后统一兑现等待申请
    try { withYard(req.yard.id, () => waiting.sweepFulfillments('yard_resumed')); } catch (e) {
      console.error('[pause] 恢复后等待兑现扫描失败:', e);
    }
    result.yard = yards.getYard(req.yard.id);
  }
  res.json({ ok: true, ...result });
}));

/* ----------------------------- 检查点（已暂停副本） ----------------------------- */

// 在当前已暂停副本中创建具名检查点：同事务快照站场定义、区段/道岔状态、
// 进路实例与锁闭和事件、等待申请、延时取消、封锁、定时走行计划与设置。
// 同一副本内重名 409；原站场 400；运行中副本 409。
router.post('/yards/current/checkpoints', wrap((req, res) => {
  const cp = checkpoint.createCheckpoint(req.yard.id, (req.body || {}).name, req.session.name);
  res.status(201).json({ ok: true, checkpoint: cp });
}));

// 检查点列表（编号/名称/创建时间/状态摘要；原站场恒为空表）
router.get('/yards/current/checkpoints', wrap((req, res) => {
  res.json({ ok: true, checkpoints: checkpoint.listCheckpoints() });
}));

// 查看单个检查点（未知检查点 404）
router.get('/yards/current/checkpoints/:id', wrap((req, res) => {
  res.json({ ok: true, checkpoint: checkpoint.getCheckpoint(req.yard.id, Number(req.params.id)) });
}));

// 把当前已暂停副本整体回退到指定检查点：单事务替换业务表，失败原状态不变；
// 未签收交接单过期、已签收保留；检查点保留可再次使用；副本保持暂停。
router.post('/yards/current/checkpoints/:id/rollback', wrap((req, res) => {
  const result = checkpoint.rollbackToCheckpoint(
    req.yard.id, Number(req.params.id), req.session.name);
  res.json({ ok: true, ...result });
}));

/* ----------------------------- 学员考核 ----------------------------- */

// 考核列表（进行中在前；含逐项目标状态、偏差与有效用时；原站场恒为空）
router.get('/exams', wrap((req, res) => {
  res.json({ ok: true, exams: exam.listExams(), currentYardId: req.yard.id });
}));

// 查看单场考核（未知考核 404）
router.get('/exams/:id', wrap((req, res) => {
  const detail = exam.getExam(Number(req.params.id));
  if (!detail) throw new InterlockError(404, 'EXAM_NOT_FOUND',
    `考核 ${req.params.id} 不存在`);
  res.json({ ok: true, exam: detail });
}));

// 开考：为当前选中的【运行中命名演练副本】指定学员与按顺序完成的进路目标，
// 开考时刻固定目标与起始状态。原站场/已暂停副本/重复开考均拒绝。
router.post('/exams/start', wrap((req, res) => {
  const body = req.body || {};
  const detail = exam.startExam(
    req.yard.id, body.student, body.targets, req.session.name);
  res.status(201).json({ ok: true, exam: detail });
}));

/* ----------------------------- 延时取消设置 ----------------------------- */

// 查询延时取消保护时长（秒）
router.get('/settings/cancel-protection', (req, res) => {
  res.json({
    ok: true,
    protectionSeconds: cancellation.getProtectionSeconds(),
    defaultSeconds: cancellation.DEFAULT_DURATION_SECONDS,
    maxSeconds: cancellation.MAX_DURATION_SECONDS
  });
});

// 修改保护时长（正整数秒；仅影响之后新申请，不追改已有申请）
router.put('/settings/cancel-protection', wrap((req, res) => {
  const seconds = cancellation.setProtectionSeconds((req.body || {}).protectionSeconds);
  res.json({
    ok: true,
    protectionSeconds: seconds,
    note: '已更新；仅对之后提交的延时取消申请生效，已有申请的解除时刻保持不变'
  });
}));

/* -------------------------------- 区段 ---------------------------------- */

function validateSection(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  if (badId('区段', id)) return { error: '区段编号需为 1~20 位字母数字/下划线/中文' };
  for (const k of ['x1', 'y1', 'x2', 'y2']) {
    if (!NUM(body[k])) return { error: `区段 ${id} 坐标 ${k} 必须是数字` };
  }
  return { value: { id, label, x1: body.x1, y1: body.y1, x2: body.x2, y2: body.y2 } };
}

router.post('/sections', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSection(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    // 新建区段占用状态未知（按占用处理），需值班员核实清空后方可排路
    db.prepare(`INSERT INTO sections(id,label,x1,y1,x2,y2,occ_state)
                VALUES(@id,@label,@x1,@y1,@x2,@y2,'unknown')`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `区段 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, section: db.prepare(`SELECT * FROM sections WHERE id=?`).get(value.id) });
}));

router.put('/sections/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSection(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(`UPDATE sections SET label=@label,x1=@x1,y1=@y1,x2=@x2,y2=@y2 WHERE id=@id`).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `区段 ${value.id} 不存在` });
  res.json({ ok: true, section: db.prepare(`SELECT * FROM sections WHERE id=?`).get(value.id) });
}));

router.delete('/sections/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const used = db.prepare(`SELECT route_id FROM route_steps WHERE section_id=?`).all(req.params.id);
  if (used.length) {
    return res.status(409).json({ ok: false,
      error: `区段 ${req.params.id} 仍被进路 ${used.map((u) => u.route_id).join('、')} 引用，请先修改这些进路` });
  }
  db.transaction(() => {
    const r = db.prepare(`DELETE FROM sections WHERE id=?`).run(req.params.id);
    if (r.changes === 0) {
      const err = new Error(`区段 ${req.params.id} 不存在`);
      err.status = 404;
      throw err;
    }
    // 区段删除：其未结束封锁同事务标记结束（保留记录与原因，并写审计流水）
    blockade.endBySectionDelete(req.params.id, req.session.name);
  })();
  res.json({ ok: true });
}));

/* -------------------------------- 道岔 ---------------------------------- */

function validateSwitch(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  if (badId('道岔', id)) return { error: '道岔编号需为 1~20 位字母数字/下划线/中文' };
  for (const k of ['x', 'y']) {
    if (!NUM(body[k])) return { error: `道岔 ${id} 坐标 ${k} 必须是数字` };
  }
  // 直股/弯股端点为可选项（画图用）
  const coords = {};
  for (const k of ['nx1', 'ny1', 'nx2', 'ny2', 'rx1', 'ry1', 'rx2', 'ry2']) {
    coords[k] = NUM(body[k]) ? body[k] : null;
  }
  return { value: { id, label, x: body.x, y: body.y, ...coords } };
}

router.post('/switches', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSwitch(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    db.prepare(`INSERT INTO switches(id,label,x,y,position,nx1,ny1,nx2,ny2,rx1,ry1,rx2,ry2)
                VALUES(@id,@label,@x,@y,'N',@nx1,@ny1,@nx2,@ny2,@rx1,@ry1,@rx2,@ry2)`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `道岔 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, switch: db.prepare(`SELECT * FROM switches WHERE id=?`).get(value.id) });
}));

router.put('/switches/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSwitch(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(
    `UPDATE switches SET label=@label,x=@x,y=@y,nx1=@nx1,ny1=@ny1,nx2=@nx2,ny2=@ny2,
            rx1=@rx1,ry1=@ry1,rx2=@rx2,ry2=@ry2 WHERE id=@id`
  ).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `道岔 ${value.id} 不存在` });
  res.json({ ok: true, switch: db.prepare(`SELECT * FROM switches WHERE id=?`).get(value.id) });
}));

router.delete('/switches/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const used = db.prepare(`SELECT route_id FROM route_switch_reqs WHERE switch_id=?`).all(req.params.id);
  if (used.length) {
    return res.status(409).json({ ok: false,
      error: `道岔 ${req.params.id} 仍被进路 ${[...new Set(used.map((u) => u.route_id))].join('、')} 引用，请先修改这些进路` });
  }
  const r = db.prepare(`DELETE FROM switches WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `道岔 ${req.params.id} 不存在` });
  res.json({ ok: true });
}));

/* -------------------------------- 信号机 -------------------------------- */

function validateSignal(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  const dir = ['right', 'left', 'up', 'down'].includes(body.direction) ? body.direction : 'right';
  if (badId('信号机', id)) return { error: '信号机编号需为 1~20 位字母数字/下划线/中文' };
  if (!NUM(body.x) || !NUM(body.y)) return { error: `信号机 ${id} 坐标必须是数字` };
  return { value: { id, label, x: body.x, y: body.y, direction: dir } };
}

router.post('/signals', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSignal(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    db.prepare(`INSERT INTO signals(id,label,x,y,direction) VALUES(@id,@label,@x,@y,@direction)`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `信号机 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, signal: db.prepare(`SELECT * FROM signals WHERE id=?`).get(value.id) });
}));

router.put('/signals/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSignal(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(`UPDATE signals SET label=@label,x=@x,y=@y,direction=@direction WHERE id=@id`).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `信号机 ${value.id} 不存在` });
  res.json({ ok: true, signal: db.prepare(`SELECT * FROM signals WHERE id=?`).get(value.id) });
}));

router.delete('/signals/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const r = db.prepare(`DELETE FROM signals WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `信号机 ${req.params.id} 不存在` });
  res.json({ ok: true });
}));

/* --------------------------------- 进路 --------------------------------- */

function validateRoute(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  const origin = String(body.origin || '').trim();
  const destination = String(body.destination || '').trim();
  if (badId('进路', id)) return { error: '进路编号需为 1~20 位字母数字/下划线/中文' };
  if (!origin || !destination) return { error: '进路必须填写起点和终点' };
  const steps = Array.isArray(body.steps) ? body.steps.map(String) : [];
  if (steps.length === 0) return { error: '进路至少包含一个区段' };
  if (new Set(steps).size !== steps.length) return { error: '进路区段不能重复' };
  const switchReqs = Array.isArray(body.switchReqs) ? body.switchReqs : [];
  for (const r of switchReqs) {
    if (!r.switchId || !['N', 'R'].includes(r.position)) {
      return { error: '道岔位置要求格式为 {switchId, position: N|R}' };
    }
  }
  const entrySignalId = body.entrySignalId || null;
  return { value: { id, label, origin, destination, entrySignalId, steps,
    switchReqs: [...new Map(switchReqs.map((r) => [String(r.switchId), r.position])).entries()]
      .map(([switchId, position]) => ({ switchId, position })) } };
}

function assertRouteRefs(value) {
  const db = getDb();
  for (const sid of value.steps) {
    if (!db.prepare(`SELECT 1 FROM sections WHERE id=?`).get(sid)) {
      return `进路引用了不存在的区段 ${sid}`;
    }
  }
  for (const r of value.switchReqs) {
    if (!db.prepare(`SELECT 1 FROM switches WHERE id=?`).get(r.switchId)) {
      return `进路引用了不存在的道岔 ${r.switchId}`;
    }
  }
  if (value.entrySignalId &&
      !db.prepare(`SELECT 1 FROM signals WHERE id=?`).get(value.entrySignalId)) {
    return `进路入口信号机 ${value.entrySignalId} 不存在`;
  }
  return null;
}

router.post('/routes', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateRoute(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const refError = assertRouteRefs(value);
  if (refError) return res.status(400).json({ ok: false, error: refError });
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO routes(id,label,origin,destination,entry_signal_id)
                VALUES(@id,@label,@origin,@destination,@entrySignalId)`).run(value);
    value.steps.forEach((sid, i) =>
      db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`).run(value.id, i + 1, sid));
    value.switchReqs.forEach((r) =>
      db.prepare(`INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`)
        .run(value.id, r.switchId, r.position));
  });
  try {
    tx();
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `进路 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true });
}));

router.put('/routes/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateRoute(body);
  if (error) return res.status(400).json({ ok: false, error });
  const refError = assertRouteRefs(value);
  if (refError) return res.status(400).json({ ok: false, error: refError });
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM routes WHERE id=?`).get(value.id);
  if (!exists) return res.status(404).json({ ok: false, error: `进路 ${value.id} 不存在` });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE routes SET label=@label,origin=@origin,destination=@destination,
                entry_signal_id=@entrySignalId WHERE id=@id`).run(value);
    db.prepare(`DELETE FROM route_steps WHERE route_id=?`).run(value.id);
    db.prepare(`DELETE FROM route_switch_reqs WHERE route_id=?`).run(value.id);
    value.steps.forEach((sid, i) =>
      db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`).run(value.id, i + 1, sid));
    value.switchReqs.forEach((r) =>
      db.prepare(`INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`)
        .run(value.id, r.switchId, r.position));
    // 定义变更：该进路既有等待申请全部失效（与新定义可能不符）
    waiting.invalidateByRouteChange(value.id,
      `管理员修改了进路 ${value.id} 的定义，原等待申请失效`);
  });
  tx();
  // 失效的是前项时后项可能因此可以兑现
  triggerWaitingSweep('route_changed');
  res.json({ ok: true });
}));

router.delete('/routes/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const tx = db.transaction(() => {
    // 已解除的历史实例对进路有外键引用；删除定义时一并清理其复盘记录
    // （开放中的实例已在上面被 assertNoOpenInstances 拒绝）。
    db.prepare(`DELETE FROM route_instances WHERE route_id=? AND status='released'`)
      .run(req.params.id);
    const r = db.prepare(`DELETE FROM routes WHERE id=?`).run(req.params.id);
    if (r.changes === 0) {
      // 抛错回滚（无其他写入，仅作 404 判定）
      const err = new Error(`进路 ${req.params.id} 不存在`);
      err.status = 404;
      throw err;
    }
    // 进路删除：相关等待申请失效并说明原因
    waiting.invalidateByRouteDelete(req.params.id);
  });
  try {
    tx();
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ ok: false, error: e.message });
    throw e;
  }
  triggerWaitingSweep('route_deleted');
  res.json({ ok: true });
}));

/* --------------------- 进路定义批量变更集（预览/发布） --------------------- */

// 预览批量变更集：一次提交多条 create/update/delete，逐条返回校验结果、
// 受影响等待申请（含当前阻断原因）、整批阻断原因与当前站场修订标识。
// 只读，不写业务数据；暂停副本也可预览（结果中列出暂停阻断）。
router.post('/route-changeset/preview', wrap((req, res) => {
  const preview = routeChangeset.previewChangeset((req.body || {}).changes);
  res.json({ ok: true, preview });
}));

// 发布批量变更集：携带预览返回的一次性令牌 previewId；服务端在同一事务内重验
// 修订标识、开放进路与整批合法性，任一不满足整批不落地、等待申请保持原状。
router.post('/route-changeset/publish', wrap((req, res) => {
  const result = routeChangeset.publishChangeset((req.body || {}).previewId);
  res.json({ ok: true, ...result });
}));

/* ------------------------------ 临时封锁 ------------------------------ */

// 发起临时封锁：按区段编号 + 封锁原因；未知区段/空白原因拒绝；
// 同一区段存在未结束封锁时返回原申请（200，created:false），不产生第二笔
router.post('/blockades', wrap((req, res) => {
  const result = blockade.submitBlockade(
    (req.body || {}).sectionId, (req.body || {}).reason, req.session.name
  );
  res.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    blockade: result.blockade
  });
}));

// 封锁列表：未结束在前；可选 ?status=pending|active|ended
router.get('/blockades', wrap((req, res) => {
  const status = ['pending', 'active', 'ended'].includes(req.query.status)
    ? req.query.status : null;
  res.json({ ok: true, blockades: blockade.listBlockades({ status }) });
}));

// 结束待生效/已生效封锁；结束后按现有联锁规则重试等待兑现（不改写区段占用状态）
router.post('/blockades/:id/end', wrap((req, res) => {
  const b = blockade.endBlockade(Number(req.params.id), req.session.name);
  res.json({ ok: true, blockade: b });
}));

/* ------------------------------ 推演状态重置 ------------------------------ */

/** 重置前后盘面统计（审计摘要用；在重置事务内调用） */
function resetSummary() {
  const db = getDb();
  const count = (sql) => db.prepare(sql).get().n;
  return {
    sections: count(`SELECT COUNT(*) AS n FROM sections`),
    sectionsOccupied: count(`SELECT COUNT(*) AS n FROM sections WHERE occ_state='occupied'`),
    sectionsUnknown: count(`SELECT COUNT(*) AS n FROM sections WHERE occ_state='unknown'`),
    switches: count(`SELECT COUNT(*) AS n FROM switches`),
    switchesReverse: count(`SELECT COUNT(*) AS n FROM switches WHERE position='R'`),
    openInstances: count(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`),
    sectionEvents: count(`SELECT COUNT(*) AS n FROM section_events`),
    waiting: count(`SELECT COUNT(*) AS n FROM waiting_applications WHERE status='waiting'`),
    pendingCancellations: count(`SELECT COUNT(*) AS n FROM cancellation_applications WHERE status='pending'`),
    unfinishedBlockades: count(
      `SELECT COUNT(*) AS n FROM blockade_applications WHERE status IN ('pending','active')`),
    activeMovementPlans: count(`SELECT COUNT(*) AS n FROM movement_plans WHERE status='active'`),
    activeHandovers: count(`SELECT COUNT(*) AS n FROM handover_documents WHERE status='active'`),
    activeExams: count(`SELECT COUNT(*) AS n FROM exams WHERE status='in_progress'`)
  };
}

/**
 * 清空推演状态：删除全部进路实例/事件/锁，区段恢复未知（按占用），道岔回定位 N。
 * 拓扑（区段/道岔/信号机/进路定义）保留。
 */
router.post('/reset/state', wrap((req, res) => {
  const db = getDb();
  let expiredHandovers = 0;
  let terminatedExamId = null;
  const before = resetSummary();
  db.transaction(() => {
    // 先清除待处理的延时取消申请（随后删除实例也会级联清除，这里显式清理语义清晰）
    cancellation.clearAllByReset();
    // 清除活动定时走行计划（随后删除实例也会级联清除，这里显式清理语义清晰）
    movementPlan.clearAllByReset();
    db.prepare(`DELETE FROM route_instances`).run(); // 级联删除锁与事件
    db.prepare(`UPDATE sections SET occ_state='unknown'`).run();
    db.prepare(`UPDATE switches SET position='N'`).run();
    // 管理员重置推演：撤销全部等待申请
    waiting.cancelAllByReset('管理员清空推演状态，全部等待申请撤销');
    // 管理员重置推演：清除全部临时封锁记录
    blockade.clearAllByReset();
    // 站场重置：全部未签收交接单过期（已签收单保留供复盘）
    handover.expireAllActiveByReset('state');
    // 站场重置：进行中的考核终止并记录原因（已交卷成绩保留可查）
    terminatedExamId = exam.terminateActiveInTxn('管理员清空推演状态（重置），进行中的考核终止；已交卷成绩保留');
    expiredHandovers = before.activeHandovers;
    // 审计界标（与重置同事务；审计表自身不在清除范围内，此前流水保留）
    require('../audit').recordYardResetInTxn({
      kind: 'state',
      actor: req.session.name,
      before,
      after: resetSummary(),
      extra: { expiredHandovers, terminatedExamId }
    });
  })();
  res.json({ ok: true, state: getState() });
}));

/**
 * 培训重开：在清空推演状态基础上，把全部区段置为空闲、道岔回定位，
 * 得到"线路空闲、信号关闭"的初始盘面（适合重新开始一轮演练）。
 */
router.post('/reset/training', wrap((req, res) => {
  const db = getDb();
  let terminatedExamId = null;
  const before = resetSummary();
  db.transaction(() => {
    cancellation.clearAllByReset();
    movementPlan.clearAllByReset();
    db.prepare(`DELETE FROM route_instances`).run();
    db.prepare(`UPDATE sections SET occ_state='free'`).run();
    db.prepare(`UPDATE switches SET position='N'`).run();
    // 管理员重置推演：撤销全部等待申请
    waiting.cancelAllByReset('管理员恢复示例初始状态（培训重开），全部等待申请撤销');
    // 管理员重置推演：清除全部临时封锁记录
    blockade.clearAllByReset();
    // 站场重置：全部未签收交接单过期（已签收单保留供复盘）
    handover.expireAllActiveByReset('training');
    // 培训重开（站场重置）：进行中的考核终止并记录原因（已交卷成绩保留）
    terminatedExamId = exam.terminateActiveInTxn('管理员执行培训重开（站场重置），进行中的考核终止；已交卷成绩保留');
    // 审计界标（与重置同事务；此前流水保留，自本条起记录重置后的新变化）
    require('../audit').recordYardResetInTxn({
      kind: 'training',
      actor: req.session.name,
      before,
      after: resetSummary(),
      extra: { expiredHandovers: before.activeHandovers, terminatedExamId }
    });
  })();
  res.json({ ok: true, state: getState() });
}));
module.exports = router;
