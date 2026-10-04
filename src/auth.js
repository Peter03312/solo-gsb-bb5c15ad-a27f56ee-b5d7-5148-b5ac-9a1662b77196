'use strict';

const crypto = require('crypto');
const { getMainDb, withYard } = require('./db');
const yards = require('./yards');

/** 管理员口令：默认 admin123，可由 ADMIN_PASSWORD 覆盖 */
function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

/**
 * 创建会话。currentYardId 缺省为 NULL（=原站场）；登录后可用
 * PUT /api/auth/yard 切换当前站场。
 */
function createSession(role, name, currentYardId = null) {
  const token = crypto.randomBytes(24).toString('hex');
  getMainDb()
    .prepare(`INSERT INTO sessions(token,role,name,current_yard_id) VALUES(?,?,?,?)`)
    .run(token, role, name, currentYardId);
  return token;
}

function getSession(token) {
  if (!token) return null;
  return getMainDb()
    .prepare(`SELECT token, role, name, current_yard_id AS currentYardId
                FROM sessions WHERE token=?`)
    .get(token) || null;
}

function destroySession(token) {
  if (token) getMainDb().prepare(`DELETE FROM sessions WHERE token=?`).run(token);
}

/** 从 Authorization: Bearer 或 cookie sid 中取令牌 */
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 鉴权中间件：
 *  1. 校验令牌与角色；
 *  2. 解析会话当前站场（未选择=原站场；未知副本 404 拒绝）；
 *  3. 把整个下游处理包在 withYard(yardId) 上下文中——业务模块调用 getDb()
 *     即作用于当前站场，跨站场不会串用锁闭/申请顺位。
 */
function requireAuth(role) {
  return (req, res, next) => {
    const session = getSession(tokenOf(req));
    if (!session) return res.status(401).json({ ok: false, error: '未登录或会话已失效，请重新登录' });
    if (role && session.role !== role) {
      return res.status(403).json({ ok: false, error: `需要 ${role === 'admin' ? '管理员' : '值班员'} 身份` });
    }
    let yard;
    try {
      yard = yards.resolveSessionYard(session.currentYardId);
    } catch (e) {
      const status = e.status || 404;
      return res.status(status).json({ ok: false, error: e.message, code: e.code });
    }
    req.session = session;
    req.yard = yards.serializeYard(yard);
    withYard(yard.id, () => next());
  };
}

module.exports = {
  adminPassword,
  createSession,
  getSession,
  destroySession,
  tokenOf,
  requireAuth
};
