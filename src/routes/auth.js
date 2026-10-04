'use strict';

const express = require('express');
const { adminPassword, createSession, getSession, destroySession, tokenOf } = require('../auth');
const waiting = require('../waiting');
const yards = require('../yards');
const { withYard, ORIGINAL_YARD_ID } = require('../db');

const router = express.Router();

/** 登录响应公共字段：令牌 + 当前站场（新登录默认原站场） */
function sessionPayload(role, name, token) {
  return {
    token, role, name,
    yardId: ORIGINAL_YARD_ID,
    yardName: yards.ORIGINAL_YARD_NAME
  };
}

// 值班员登录：输入姓名即可（新会话默认使用原站场）
router.post('/login/dispatcher', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 1 || name.length > 30) {
    return res.status(400).json({ ok: false, error: '请输入值班员姓名（1~30 字）' });
  }
  const token = createSession('dispatcher', name);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, ...sessionPayload('dispatcher', name, token) });
});

// 管理员登录：固定口令（新会话默认使用原站场）
router.post('/login/admin', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== adminPassword()) {
    return res.status(401).json({ ok: false, error: '管理员口令不正确' });
  }
  const token = createSession('admin', '管理员');
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, ...sessionPayload('admin', '管理员', token) });
});

// 站场列表（登录会话可用；返回全部站场及当前选择）。
// 每个登录会话都可查看并选择当前站场；未选择时使用原站场。
router.get('/yards', (req, res) => {
  const session = getSession(tokenOf(req));
  if (!session) return res.status(401).json({ ok: false, error: '未登录或会话已失效，请重新登录' });
  res.json({
    ok: true,
    yards: yards.listYards(),
    currentYardId: session.currentYardId || ORIGINAL_YARD_ID
  });
});

// 选择当前站场（body: {yardId}；缺省/1 表示回到原站场；未知副本 404 拒绝）
router.put('/yard', (req, res, next) => {
  try {
    const session = getSession(tokenOf(req));
    if (!session) return res.status(401).json({ ok: false, error: '未登录或会话已失效，请重新登录' });
    const raw = (req.body || {}).yardId;
    // 缺省 / null / 1 均表示原站场
    const targetId = raw == null || raw === '' ? ORIGINAL_YARD_ID : Number(raw);
    const yard = yards.resolveSessionYard(targetId); // 未知副本抛错（错误处理中间件转 404）
    require('../db').getMainDb()
      .prepare(`UPDATE sessions SET current_yard_id=? WHERE token=?`)
      .run(yard.id, session.token);
    res.json({
      ok: true,
      yardId: yard.id,
      yardName: yard.name,
      isOriginal: yard.id === ORIGINAL_YARD_ID
    });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  const token = tokenOf(req);
  const session = getSession(token);
  // 值班员退出：撤销其【在各站场】的全部未兑现等待申请（站场各自事务内处理，
  // 单个站场失败不影响退出）。每个站场分别扫描兑现，互不串用。
  if (session && session.role === 'dispatcher') {
    for (const y of yards.listYards()) {
      try {
        withYard(y.id, () => waiting.cancelByApplicant(
          session.name, '申请人退出登录，等待申请撤销',
          { skipSweep: y.paused }));
      } catch (e) { console.error(`[waiting] 退出撤销失败（站场 ${y.id}）:`, e); }
    }
  }
  destroySession(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

module.exports = router;
