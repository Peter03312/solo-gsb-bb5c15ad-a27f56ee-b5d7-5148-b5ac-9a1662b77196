'use strict';

/**
 * 站场追溯推演审计流水 HTTP API（管理员与值班员均可查询）。
 *
 * 安全边界：
 *  - 复用 requireAuth（任一登录角色），处理过程运行在会话当前站场的 withYard
 *    上下文内，只读当前站场业务库的 audit_entries；接口不接受任何站场编号参数，
 *    物理上不能串看其他站场。
 *  - 仅支持 GET（只读）；暂停副本可照常查询。
 *  - 筛选参数白名单严格校验：类型必须是已知枚举、序号/页大小必须是正整数，
 *    非法筛选一律 400 AUDIT_BAD_FILTER 明确拒绝（不忽略、不兜底）。
 */

const express = require('express');
const { requireAuth } = require('../auth');
const audit = require('../audit');
const { InterlockError } = require('../interlocking');

const router = express.Router();
router.use(requireAuth()); // 管理员与值班员均可

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const INT_RE = /^\d+$/;
// 关联编号允许的字符（与业务编号一致：字母数字/下划线/中文/连字符；重置为 state/training）
const REF_ID_RE = /^[A-Za-z0-9_一-龥-]{1,40}$/;

function badFilter(message) {
  return new InterlockError(400, 'AUDIT_BAD_FILTER', message);
}

/**
 * GET /api/audit-entries
 * 查询参数（全部可选，除白名单外的任何参数名都拒绝）：
 *  - fromSeq  起始序号（正整数，缺省 1），返回 seq >= fromSeq 的条目
 *  - limit    每页条数（1~200 正整数，缺省 50）
 *  - type     变更类型筛选，多个用逗号分隔（须全部在已知枚举内）
 *  - refType  关联编号类型筛选（route_instance/waiting/cancellation/blockade/
 *             checkpoint/yard/reset）
 *  - refId    关联编号精确筛选（通常与 refType 同时给出）
 * 响应按 seq 升序返回当前页，并给出 nextFromSeq / hasMore 供顺序翻页。
 */
router.get('/audit-entries', (req, res, next) => {
  try {
    const allowed = new Set(['fromSeq', 'limit', 'type', 'refType', 'refId']);
    for (const key of Object.keys(req.query)) {
      if (!allowed.has(key)) throw badFilter(`不支持的筛选参数：${key}`);
    }

    const filter = {};

    if (req.query.fromSeq !== undefined) {
      const raw = String(req.query.fromSeq);
      if (!INT_RE.test(raw)) throw badFilter(`fromSeq 必须是正整数（收到 ${req.query.fromSeq}）`);
      filter.fromSeq = Number(raw);
      if (filter.fromSeq < 1) throw badFilter('fromSeq 必须从 1 开始');
    }

    if (req.query.limit !== undefined) {
      const raw = String(req.query.limit);
      if (!INT_RE.test(raw)) throw badFilter(`limit 必须是 1~${MAX_LIMIT} 的正整数（收到 ${req.query.limit}）`);
      filter.limit = Number(raw);
      if (filter.limit < 1 || filter.limit > MAX_LIMIT) {
        throw badFilter(`limit 必须是 1~${MAX_LIMIT} 的正整数（收到 ${raw}）`);
      }
    }

    if (req.query.type !== undefined) {
      const raw = String(req.query.type || '').trim();
      if (!raw) throw badFilter('type 不能为空（多类型请用逗号分隔）');
      const types = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (types.length === 0) throw badFilter('type 不能为空（多类型请用逗号分隔）');
      const unknown = types.filter((t) => !audit.TYPES.includes(t));
      if (unknown.length) {
        throw badFilter(`非法变更类型：${unknown.join('、')}；允许的类型见响应 types`);
      }
      filter.types = [...new Set(types)];
    }

    if (req.query.refType !== undefined) {
      const refType = String(req.query.refType || '').trim();
      if (!audit.REF_TYPES.includes(refType)) {
        throw badFilter(`非法关联编号类型 refType：${req.query.refType}；允许：${audit.REF_TYPES.join('、')}`);
      }
      filter.refType = refType;
    }

    if (req.query.refId !== undefined) {
      const refId = String(req.query.refId == null ? '' : req.query.refId).trim();
      if (!refId) throw badFilter('refId 不能为空');
      if (!REF_ID_RE.test(refId)) throw badFilter(`非法关联编号 refId：${refId}`);
      filter.refId = refId;
    }

    const result = audit.listEntries(filter);
    res.json({
      ok: true,
      me: req.session.name,
      role: req.session.role,
      yard: req.yard,
      ...result
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
