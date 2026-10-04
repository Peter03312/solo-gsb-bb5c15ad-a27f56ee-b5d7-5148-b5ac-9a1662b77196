'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const inter = require('../interlocking');
const waiting = require('../waiting');
const cancellation = require('../cancellation');
const blockade = require('../blockade');
const handover = require('../handover');
const movementPlan = require('../movement-plan');
const pause = require('../pause');
const { InterlockError } = require('../interlocking');

const router = express.Router();
router.use(requireAuth('dispatcher'));

// 暂停副本：值班台只读查询与会话切换照常，所有手工业务变更拒绝。
// 预检 /routes/:id/check 是只读校验，也照常返回。
router.use((req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || /^\/routes\/[^/]+\/check$/.test(req.path)) {
    return next();
  }
  try {
    pause.assertActive(req.yard.id);
    next();
  } catch (e) { next(e); }
});

function wrap(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

// 全量状态（刷新页面后恢复已提交状态；仅当前会话所选站场的数据）
router.get('/state', (req, res) => {
  res.json({ ok: true, state: inter.getState(), me: req.session.name, yard: req.yard });
});

// 预检：不产生任何锁
router.post('/routes/:id/check', wrap((req, res) => {
  const result = inter.checkOpen(req.params.id, req.body.switchPositions || {});
  res.json({ ok: true, check: result });
}));

// 开放进路（原子锁定）
router.post('/routes/:id/open', wrap((req, res) => {
  const detail = inter.openRoute(req.params.id, req.body.switchPositions || {}, req.session.name);
  res.json({ ok: true, instance: detail });
}));

// 扳动道岔（锁闭中拒绝）
router.post('/switches/:id/move', wrap((req, res) => {
  const position = String(req.body.position || '').toUpperCase();
  const result = inter.moveSwitch(req.params.id, position, req.session.name);
  res.json({ ok: true, result });
}));

// 排路前独立设置区段占用/清空（主要用于把"未知"核实为空闲）
router.post('/sections/:id/state', wrap((req, res) => {
  const action = String(req.body.action || '');
  if (!['occupy', 'clear'].includes(action)) {
    throw new InterlockError(400, 'BAD_ACTION', 'action 只能是 occupy 或 clear');
  }
  const result = inter.setSectionState(req.params.id, action, req.session.name);
  res.json({ ok: true, result });
}));

// 进路走行：按序号提交占用/清空事件
router.post('/instances/:id/events', wrap((req, res) => {
  const seq = Number(req.body.seq);
  const sectionId = String(req.body.sectionId || '');
  const action = String(req.body.action || '');
  if (!Number.isInteger(seq)) {
    throw new InterlockError(400, 'BAD_SEQ', `事件序号必须是整数（收到 ${req.body.seq}）`);
  }
  const result = inter.submitSectionEvent(
    Number(req.params.id), seq, sectionId, action, req.session.name
  );
  res.json({ ok: true, result });
}));

// 人工解除进路（末段未清空前拒绝）
router.post('/instances/:id/release', wrap((req, res) => {
  const detail = inter.releaseInstance(Number(req.params.id), req.session.name);
  res.json({ ok: true, instance: detail });
}));

/* ------------------------------ 定时走行计划 ------------------------------ */

// 提交定时走行计划（仅已开放且尚未走行的实例；步骤须覆盖完整进路、
// 占用/清空交替、每步正整数秒；非法计划整体拒绝）
router.post('/instances/:id/movement-plans', wrap((req, res) => {
  const plan = movementPlan.submitPlan(
    Number(req.params.id), (req.body || {}).steps, req.session.name);
  res.status(201).json({ ok: true, plan });
}));

// 查看定时走行计划：默认本人全部；?scope=all 全员（值班台仲裁展示）；
// 可选 ?status=active|completed|aborted|terminated
router.get('/movement-plans', wrap((req, res) => {
  const scope = String(req.query.scope || 'mine');
  const status = ['active', 'completed', 'aborted', 'terminated'].includes(req.query.status)
    ? req.query.status : null;
  const list = movementPlan.listPlans({
    applicant: scope === 'all' ? undefined : req.session.name,
    status
  });
  res.json({ ok: true, plans: list, me: req.session.name });
}));

// 查看单张定时走行计划（含全部步骤与到期时刻）
router.get('/movement-plans/:id', wrap((req, res) => {
  const plan = movementPlan.getPlan(Number(req.params.id));
  if (!plan) throw new InterlockError(404, 'MOVEMENT_PLAN_NOT_FOUND',
    `定时走行计划 ${req.params.id} 不存在`);
  res.json({ ok: true, plan, me: req.session.name });
}));

// 本人终止计划：仅停止后续定时注入，不解除进路、不改动已注入走行结果
router.post('/movement-plans/:id/terminate', wrap((req, res) => {
  const plan = movementPlan.terminatePlan(Number(req.params.id), req.session.name);
  res.json({ ok: true, plan });
}));

/* ------------------------------ 延时取消 ------------------------------ */

// 申请延时取消（仅已开放且尚无走行占用记录的进路）；重复申请返回原 pending
router.post('/instances/:id/cancel-delayed', wrap((req, res) => {
  const result = cancellation.requestCancellation(Number(req.params.id), req.session.name);
  res.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    cancellation: result.request
  });
}));

// 查看延时取消申请：默认本人全部；?scope=all 全员（值班台仲裁展示）；
// 可选 ?status=pending|released|aborted
router.get('/cancellations', wrap((req, res) => {
  const scope = String(req.query.scope || 'mine');
  const status = ['pending', 'released', 'aborted'].includes(req.query.status)
    ? req.query.status : null;
  const list = cancellation.listRequests({
    applicant: scope === 'all' ? undefined : req.session.name,
    status
  });
  res.json({
    ok: true,
    cancellations: list,
    protectionSeconds: cancellation.getProtectionSeconds(),
    me: req.session.name
  });
}));

/* ------------------------------ 临时封锁（只读） ------------------------------ */

// 查看临时封锁：未结束在前；可选 ?status=pending|active|ended
// （全量状态 /api/state 的 blockades / blockadesBySection 也一并下发）
router.get('/blockades', wrap((req, res) => {
  const status = ['pending', 'active', 'ended'].includes(req.query.status)
    ? req.query.status : null;
  res.json({ ok: true, blockades: blockade.listBlockades({ status }) });
}));

/* ------------------------------ 等待申请 ------------------------------ */

// 提交等待申请（不预锁资源；提交后立即尝试兑现）
router.post('/routes/:id/waiting', wrap((req, res) => {
  const app = waiting.submitApplication(
    req.params.id, req.body.switchPositions || {}, req.session.name
  );
  res.status(201).json({ ok: true, waiting: app });
}));

// 查看等待申请：默认返回本人全部；?scope=all 返回所有人（值班台仲裁展示用）；
// 可选 ?status=waiting|fulfilled|cancelled|invalid
router.get('/waiting', wrap((req, res) => {
  const scope = String(req.query.scope || 'mine');
  const status = ['waiting', 'fulfilled', 'cancelled', 'invalid'].includes(req.query.status)
    ? req.query.status : null;
  const list = waiting.listApplications({
    applicant: scope === 'all' ? undefined : req.session.name,
    status
  });
  res.json({ ok: true, waiting: list, me: req.session.name });
}));

// 撤销本人未兑现的等待申请（非本人 / 已结束均拒绝）
router.post('/waiting/:id/cancel', wrap((req, res) => {
  const app = waiting.cancelApplication(Number(req.params.id), req.session.name);
  res.json({ ok: true, waiting: app });
}));

/* ------------------------------ 交接班交接单 ------------------------------ */

// 交班人生成交接单（原子快照六类状态；本人此前未签收单被新单替换过期）
router.post('/handovers', wrap((req, res) => {
  const doc = handover.generateHandover(req.session.name);
  res.status(201).json({ ok: true, handover: doc });
}));

// 查看交接单列表：默认全员；?scope=mine 只看与本人相关（交班或接班）；
// 可选 ?status=active|signed|expired
router.get('/handovers', wrap((req, res) => {
  const scope = String(req.query.scope || 'all');
  const status = ['active', 'signed', 'expired'].includes(req.query.status)
    ? req.query.status : null;
  if (scope === 'mine') {
    // 与本人相关：本人交班 或 本人接班，合并后按统一顺序不便在 SQL 内过滤，
    // 数据量小，取本人交班 + 本人接班两个集合
    const sent = handover.listHandovers({ fromName: req.session.name, status });
    const received = handover.listHandovers({ toName: req.session.name, status });
    const merged = [...sent, ...received];
    const seen = new Set();
    const list = merged
      .filter((h) => !seen.has(h.id) && seen.add(h.id))
      .sort((a, b) => {
        const rank = { active: 0, signed: 1, expired: 2 };
        return rank[a.status] - rank[b.status] || b.id - a.id;
      });
    return res.json({ ok: true, handovers: list, me: req.session.name });
  }
  res.json({
    ok: true,
    handovers: handover.listHandovers({ status }),
    me: req.session.name
  });
}));

// 查看单张交接单（含完整快照与过期变化明细）
router.get('/handovers/:id', wrap((req, res) => {
  const doc = handover.getHandover(Number(req.params.id));
  if (!doc) throw new InterlockError(404, 'HANDOVER_NOT_FOUND',
    `交接单 ${req.params.id} 不存在`);
  res.json({ ok: true, handover: doc, me: req.session.name });
}));

// 接班人签收：姓名与交班人不同；状态变化即拒绝并把该单标记过期；
// 同一人重复签收幂等返回原结果，其他人重复签收拒绝
router.post('/handovers/:id/sign', wrap((req, res) => {
  const result = handover.signHandover(Number(req.params.id), req.session.name);
  res.status(result.repeated ? 200 : 201).json({
    ok: true,
    repeated: result.repeated,
    handover: result.handover
  });
}));

/* ------------------------------ 学员考核 ------------------------------ */

// 考核列表（进行中在前；值班台显示本人/本场考核进度与历史结果）
router.get('/exams', wrap((req, res) => {
  const list = require('../exam').listExams();
  res.json({ ok: true, exams: list, me: req.session.name });
}));

// 查看单场考核（逐项目标状态、偏差、有效用时；刷新/重启后仍可查询）
router.get('/exams/:id', wrap((req, res) => {
  const detail = require('../exam').getExam(Number(req.params.id));
  if (!detail) throw new InterlockError(404, 'EXAM_NOT_FOUND',
    `考核 ${req.params.id} 不存在`);
  res.json({ ok: true, exam: detail, me: req.session.name });
}));

// 学员本人交卷：返回逐项目标状态、偏差与有效用时。
// 非指定学员 / 已终止 / 已交卷（重复交卷）一律拒绝。
router.post('/exams/:id/submit', wrap((req, res) => {
  const detail = require('../exam').submitExam(Number(req.params.id), req.session.name);
  res.json({ ok: true, exam: detail });
}));

module.exports = router;
