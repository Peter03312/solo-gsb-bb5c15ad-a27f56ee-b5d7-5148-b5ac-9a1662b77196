'use strict';

/**
 * 交接班交接单。
 *
 * 语义（与需求一一对应）：
 *  - 交班值班员可生成交接单：生成事务在【同一时刻、同一事务】内快照六类状态——
 *    ① 区段占用（sections.occ_state）
 *    ② 道岔位置（switches.position）
 *    ③ 开放进路的信号与走行进度（route_instances + route_locks + section_events）
 *    ④ 等待申请（waiting_applications，全部状态）
 *    ⑤ 延时取消申请（cancellation_applications，全部状态）
 *    ⑥ 未结束封锁（blockade_applications 中 pending/active）
 *    并记录生成时刻（epoch 毫秒）与交班人。
 *  - 接班值班员签收：签收事务内按【同一时刻】重新取快照逐类比对，任一类别已变化即
 *    拒绝签收、列出变化类别与明细，并把该单标记为 expired（过期），由交班人重新生成。
 *  - 接班人姓名必须与交班人不同（同一人不能既是交班人又是接班人）。
 *  - 原子性：生成/签收的全部读写都在单个 better-sqlite3 同步事务内；本系统所有业务
 *    写操作也都经同一连接的事务串行执行，因此签收比对与状态变更不可能交错，并发操作
 *    不会使已过时的交接单签收成功。
 *  - 重复签收：同一接班人重复签收幂等返回原结果（signed 状态 + repeated 标记）；
 *    其他人对已签收单重复签收拒绝（HANDOVER_ALREADY_SIGNED）。
 *  - 同一交班人生成新单时，其此前未签收（active）的单标记过期（被新单替换）。
 *  - 交接单只写自身快照、不锁任何业务资源，不阻塞现有进路/事件等任何操作。
 *  - 站场重置（管理员清空推演状态/培训重开）使全部未签收单过期；已签收单保留供复盘。
 *  - 全部记录持久化在 SQLite，刷新/重启后仍可查询。
 */

const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

/* ------------------------------ 状态类别定义 ------------------------------ */

/**
 * 六类被快照/比对的状态。code 为快照键与接口返回码，label 为变化类别中文名。
 */
const CATEGORIES = [
  { code: 'sections', label: '区段占用' },
  { code: 'switches', label: '道岔位置' },
  { code: 'openInstances', label: '开放进路的信号与走行进度' },
  { code: 'waiting', label: '等待申请' },
  { code: 'cancellations', label: '延时取消申请' },
  { code: 'blockades', label: '未结束封锁' }
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.code, c.label]));

/* ------------------------------ 快照构建 ------------------------------ */

/**
 * 在当前事务内读取六类状态，生成可 JSON 序列化的快照。
 * 必须在 db.transaction 包裹中调用（生成与签收共用同一份读取逻辑，保证口径一致）。
 */
function buildSnapshotInTxn() {
  const db = getDb();

  const sections = {};
  for (const s of db.prepare(`SELECT id, occ_state FROM sections ORDER BY id`).all()) {
    sections[s.id] = s.occ_state;
  }

  const switches = {};
  for (const s of db.prepare(`SELECT id, position FROM switches ORDER BY id`).all()) {
    switches[s.id] = s.position;
  }

  const openInstances = {};
  const instRows = db.prepare(
    `SELECT id, route_id, signal_state, next_seq, head_step, tail_step
       FROM route_instances WHERE status='open' ORDER BY id`
  ).all();
  for (const inst of instRows) {
    const lockedSections = db.prepare(
      `SELECT resource_id FROM route_locks
        WHERE instance_id=? AND resource_type='section' ORDER BY resource_id`
    ).all(inst.id).map((r) => r.resource_id);
    const lockedSwitches = db.prepare(
      `SELECT resource_id FROM route_locks
        WHERE instance_id=? AND resource_type='switch' ORDER BY resource_id`
    ).all(inst.id).map((r) => r.resource_id);
    const events = db.prepare(
      `SELECT seq, section_id, action FROM section_events
        WHERE instance_id=? ORDER BY seq`
    ).all(inst.id).map((e) => ({ seq: e.seq, sectionId: e.section_id, action: e.action }));
    openInstances[inst.id] = {
      routeId: inst.route_id,
      status: 'open',
      signalState: inst.signal_state,
      nextSeq: inst.next_seq,
      headStep: inst.head_step,
      tailStep: inst.tail_step,
      lockedSections,
      lockedSwitches,
      events
    };
  }

  // 等待申请：全部状态都纳入（新提交、状态流转 waiting→fulfilled/cancelled/invalid 均可检出）
  const waiting = {};
  for (const w of db.prepare(
    `SELECT id, route_id, applicant, status, instance_id, switch_positions
       FROM waiting_applications ORDER BY id`).all()) {
    waiting[w.id] = {
      routeId: w.route_id,
      applicant: w.applicant,
      status: w.status,
      instanceId: w.instance_id,
      switchPositions: safeParse(w.switch_positions, {})
    };
  }

  // 延时取消申请：全部状态纳入（新申请、pending→released/aborted 均可检出）
  const cancellations = {};
  for (const c of db.prepare(
    `SELECT id, instance_id, applicant, status, duration_seconds, requested_at, release_at
       FROM cancellation_applications ORDER BY id`).all()) {
    cancellations[c.id] = {
      instanceId: c.instance_id,
      applicant: c.applicant,
      status: c.status,
      durationSeconds: c.duration_seconds,
      requestedAt: c.requested_at,
      releaseAt: c.release_at
    };
  }

  // 封锁：仅未结束（pending/active）纳入——新发起或结束都构成变化
  const blockades = {};
  for (const b of db.prepare(
    `SELECT id, section_id, applicant, reason, status
       FROM blockade_applications WHERE status IN ('pending','active') ORDER BY id`).all()) {
    blockades[b.id] = {
      sectionId: b.section_id,
      applicant: b.applicant,
      reason: b.reason,
      status: b.status
    };
  }

  return { sections, switches, openInstances, waiting, cancellations, blockades };
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/* -------------------------------- 生成 -------------------------------- */

/**
 * 交班人生成交接单：原子快照六类状态并入库。
 * 同一交班人此前未签收（active）的单在同一事务内标记过期（被新单替换）。
 * @returns {Object} 交接单详情
 */
function generateHandover(fromName) {
  const db = getDb();
  const now = Date.now();

  const id = db.transaction(() => {
    // 先把本人此前待签收的单替换为过期（不影响他人的单、也不影响已签收/已过期单）
    db.prepare(
      `UPDATE handover_documents SET status='expired',
              expire_reason=?
        WHERE from_name=? AND status='active'`
    ).run(JSON.stringify({
      reason: '交班人生成了新的交接单，本原单被替换过期',
      categories: [],
      changes: [],
      superseded: true
    }), fromName);

    const snapshot = buildSnapshotInTxn();
    const info = db.prepare(
      `INSERT INTO handover_documents(from_name, status, generated_at, snapshot)
       VALUES(?, 'active', ?, ?)`
    ).run(fromName, now, JSON.stringify(snapshot));
    return info.lastInsertRowid;
  })();

  return getHandover(id);
}

/* -------------------------------- 签收 -------------------------------- */

/**
 * 接班人签收交接单（整个判定在单个事务内原子完成）。
 *
 * 结果：
 *  - 成功：{handover, repeated:false}
 *  - 同一接班人重复签收已签收单：{handover, repeated:true}（幂等返回原结果）
 * 异常（InterlockError）：
 *  - 404 HANDOVER_NOT_FOUND
 *  - 409 HANDOVER_SAME_PERSON      接班人姓名与交班人相同
 *  - 409 HANDOVER_EXPIRED          单子已过期（被替换/站场重置/此前签收时发现变化）
 *  - 409 HANDOVER_ALREADY_SIGNED   已被他人签收
 *  - 409 HANDOVER_STALE            快照后状态发生变化：本事务内已标记过期，
 *                                  extra.changedCategories / extra.changes 列出明细
 */
function signHandover(handoverId, toName) {
  const db = getDb();
  const now = Date.now();

  const run = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM handover_documents WHERE id=?`).get(handoverId);
    if (!row) {
      throw new InterlockError(404, 'HANDOVER_NOT_FOUND',
        `交接单 ${handoverId} 不存在`);
    }

    // 已签收：同一接班人重复签收幂等返回原结果；其他人重复签收拒绝
    if (row.status === 'signed') {
      if (row.to_name === toName) {
        return { kind: 'repeated', handoverId: row.id };
      }
      throw new InterlockError(409, 'HANDOVER_ALREADY_SIGNED',
        `交接单 #${row.id} 已由 ${row.to_name} 签收，其他人不能重复签收`,
        { signedBy: row.to_name });
    }

    // 已过期（被新单替换 / 站场重置 / 此前签收检出变化）
    if (row.status === 'expired') {
      const meta = safeParse(row.expire_reason, null);
      throw new InterlockError(409, 'HANDOVER_EXPIRED',
        `交接单 #${row.id} 已过期，请由交班人重新生成后再签收`,
        { changedCategories: meta && Array.isArray(meta.categories) ? meta.categories : [],
          changes: meta && Array.isArray(meta.changes) ? meta.changes : [],
          reason: meta && meta.reason ? meta.reason : null });
    }

    // 接班人必须与交班人不同
    if (toName === row.from_name) {
      throw new InterlockError(409, 'HANDOVER_SAME_PERSON',
        '接班人姓名必须与交班人不同，不能由交班人本人签收自己的交接单',
        { fromName: row.from_name });
    }

    // 核心：同一时刻、同一事务内重新取快照并与生成时快照逐类比对
    const oldSnapshot = safeParse(row.snapshot, null);
    const current = buildSnapshotInTxn();
    const changes = diffSnapshots(oldSnapshot || {}, current);

    if (changes.length) {
      const categories = [...new Set(changes.map((c) => c.category))];
      const reasonText = '生成交接单后以下状态已发生变化：' +
        categories.map((c) => CATEGORY_LABEL[c]).join('、') + '；交接单标记过期，请重新生成';
      // 同事务内标记过期并随事务提交（better-sqlite3 事务 throw 会回滚，故错误在事务外抛）
      db.prepare(
        `UPDATE handover_documents SET status='expired', expire_reason=? WHERE id=?`
      ).run(JSON.stringify({ reason: reasonText, categories, changes }), row.id);
      return { kind: 'stale', handoverId: row.id, categories, changes, reasonText };
    }

    db.prepare(
      `UPDATE handover_documents SET status='signed', to_name=?, signed_at=? WHERE id=?`
    ).run(toName, now, row.id);
    return { kind: 'signed', handoverId: row.id };
  });

  // 判定与写入已原子提交；检出变化时在事务提交后再抛拒绝错误
  const result = run();
  if (result.kind === 'stale') {
    throw new InterlockError(409, 'HANDOVER_STALE',
      `签收拒绝：${result.reasonText}`,
      { changedCategories: result.categories, changes: result.changes, reason: result.reasonText });
  }
  return {
    handover: getHandover(result.handoverId),
    repeated: result.kind === 'repeated'
  };
}

/* ------------------------------ 快照比对 ------------------------------ */

/**
 * 比对生成时快照与签收时当前快照，返回变化明细（按类别顺序）。
 * @returns {Array<{category:string,label:string,details:string[]}>}
 */
function diffSnapshots(before, after) {
  const out = [];
  for (const { code, label } of CATEGORIES) {
    const details = diffCategory(code, before[code] || {}, after[code] || {});
    if (details.length) out.push({ category: code, label, details });
  }
  return out;
}

/** 单类比对：按条目（区段/道岔/进路实例/各类申请编号）给出人类可读明细。 */
function diffCategory(code, before, after) {
  const details = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b && !a) { details.push(removedText(code, key, b)); continue; }
    if (a && !b) { details.push(addedText(code, key, a)); continue; }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    details.push(...changedText(code, key, b, a));
  }
  return details;
}

const OCC_TEXT = { free: '空闲', occupied: '占用', unknown: '未知(按占用)' };

function addedText(code, key, v) {
  switch (code) {
    case 'sections': return `区段 ${key}：新增（当前 ${OCC_TEXT[v] || v}）`;
    case 'switches': return `道岔 ${key}：新增（当前位置 ${v}）`;
    case 'openInstances': return `进路实例 #${key}（${v.routeId}）：交接单生成后新开放`;
    case 'waiting': return `等待申请 #${key}（${v.routeId}，${v.applicant}）：交接单生成后新提交`;
    case 'cancellations': return `进路实例 #${v.instanceId} 的延时取消申请 #${key}：交接单生成后新提交`;
    case 'blockades': return `区段 ${v.sectionId} 的临时封锁 #${key}（${v.status === 'active' ? '已生效' : '待生效'}）：交接单生成后新发起`;
    default: return `${key}：新增`;
  }
}

function removedText(code, key, v) {
  switch (code) {
    case 'sections': return `区段 ${key}：已被删除`;
    case 'switches': return `道岔 ${key}：已被删除`;
    case 'openInstances': return `进路实例 #${key}（${v.routeId}）：已解除（交接单生成时仍开放）`;
    case 'waiting': return `等待申请 #${key}（${v.routeId}）：记录已消失`;
    case 'cancellations': return `进路实例 #${v.instanceId} 的延时取消申请 #${key}：记录已消失`;
    case 'blockades': return `区段 ${v.sectionId} 的临时封锁 #${key}：封锁已结束（交接单生成时 ${v.status === 'active' ? '已生效' : '待生效'}）`;
    default: return `${key}：已消失`;
  }
}

function changedText(code, key, b, a) {
  const lines = [];
  switch (code) {
    case 'sections':
      lines.push(`区段 ${key}：占用状态由 ${OCC_TEXT[b] || b} 变为 ${OCC_TEXT[a] || a}`);
      break;
    case 'switches':
      lines.push(`道岔 ${key}：位置由 ${b} 变为 ${a}`);
      break;
    case 'openInstances': {
      if (b.signalState !== a.signalState) {
        lines.push(`进路实例 #${key}（${a.routeId}）：入口信号由 ${b.signalState === 'green' ? '绿灯' : '红灯'} ` +
          `变为 ${a.signalState === 'green' ? '绿灯' : '红灯'}`);
      }
      const fields = [
        ['nextSeq', '下一事序号'], ['headStep', '走行头部步号'], ['tailStep', '出清尾部步号']
      ];
      for (const [f, label] of fields) {
        if (b[f] !== a[f]) lines.push(`进路实例 #${key}（${a.routeId}）：${label}由 ${b[f]} 变为 ${a[f]}`);
      }
      if (JSON.stringify(b.events) !== JSON.stringify(a.events)) {
        const bN = b.events.length, aN = a.events.length;
        if (aN > bN) {
          for (const e of a.events.slice(bN)) {
            lines.push(`进路实例 #${key}（${a.routeId}）：新走行事件 #${e.seq} ` +
              `${e.action === 'occupy' ? '占用' : '清空'} 区段 ${e.sectionId}`);
          }
        } else {
          lines.push(`进路实例 #${key}（${a.routeId}）：走行事件流水发生变化`);
        }
      }
      const unlock = b.lockedSections.filter((x) => !a.lockedSections.includes(x));
      for (const sid of unlock) lines.push(`进路实例 #${key}（${a.routeId}）：区段 ${sid} 已逐段解锁`);
      const newLock = a.lockedSections.filter((x) => !b.lockedSections.includes(x));
      for (const sid of newLock) lines.push(`进路实例 #${key}（${a.routeId}）：区段 ${sid} 新增锁闭`);
      break;
    }
    case 'waiting':
      if (b.status !== a.status) {
        const map = { waiting: '等待中', fulfilled: '已兑现', cancelled: '已撤销', invalid: '已失效' };
        lines.push(`等待申请 #${key}（${a.routeId}，${a.applicant}）：状态由 ${map[b.status] || b.status} ` +
          `变为 ${map[a.status] || a.status}` +
          (a.status === 'fulfilled' && a.instanceId ? `（兑现为进路实例 #${a.instanceId}）` : ''));
      }
      if (b.instanceId !== a.instanceId && b.status === a.status) {
        lines.push(`等待申请 #${key}：兑现进路实例发生变化`);
      }
      break;
    case 'cancellations': {
      if (b.status !== a.status) {
        const map = { pending: '待处理', released: '到期已解除', aborted: '已终止' };
        lines.push(`进路实例 #${a.instanceId} 的延时取消申请 #${key}：状态由 ${map[b.status] || b.status} ` +
          `变为 ${map[a.status] || a.status}`);
      }
      break;
    }
    case 'blockades':
      if (b.status !== a.status) {
        const map = { pending: '待生效', active: '已生效', ended: '已结束' };
        lines.push(`区段 ${a.sectionId} 的临时封锁 #${key}：状态由 ${map[b.status] || b.status} ` +
          `变为 ${map[a.status] || a.status}`);
      }
      break;
    default:
      break;
  }
  return lines;
}

/* --------------------------- 站场重置：未签收过期 --------------------------- */

/**
 * 管理员重置推演：全部未签收（active）交接单标记过期；已签收单保留供复盘。
 * 必须在管理员重置事务内调用（与实例/申请/封锁清除同一事务）。
 */
function expireAllActiveByReset(resetKind) {
  const reason = resetKind === 'training'
    ? '管理员执行培训重开（恢复示例初始状态），未签收交接单过期；已签收单保留供复盘'
    : '管理员清空推演状态（站场重置），未签收交接单过期；已签收单保留供复盘';
  getDb().prepare(
    `UPDATE handover_documents SET status='expired', expire_reason=? WHERE status='active'`
  ).run(JSON.stringify({ reason, categories: [], changes: [], reset: true }));
}

/* ------------------------------ 查询 / 序列化 ------------------------------ */

function rowToHandover(row) {
  if (!row) return null;
  const snapshot = safeParse(row.snapshot, null);
  const expireMeta = safeParse(row.expire_reason, null);
  return {
    id: row.id,
    fromName: row.from_name,
    toName: row.to_name,
    status: row.status,                 // active 待签收 / signed 已签收 / expired 已过期
    generatedAt: row.generated_at,
    generatedAtText: new Date(row.generated_at).toLocaleString('zh-CN', { hour12: false }),
    signedAt: row.signed_at,
    signedAtText: row.signed_at
      ? new Date(row.signed_at).toLocaleString('zh-CN', { hour12: false }) : null,
    snapshot,
    changedCategories: expireMeta && Array.isArray(expireMeta.categories) ? expireMeta.categories : [],
    changes: expireMeta && Array.isArray(expireMeta.changes) ? expireMeta.changes : [],
    expireReason: expireMeta && expireMeta.reason ? expireMeta.reason : null
  };
}

function getHandover(id) {
  return rowToHandover(getDb().prepare(`SELECT * FROM handover_documents WHERE id=?`).get(id));
}

/**
 * 交接单列表：待签收在前，其次已签收、已过期；同组内按编号倒序（新单在前）。
 * @param {{fromName?:string, toName?:string, status?:string, limit?:number}} filter
 */
function listHandovers(filter = {}) {
  const db = getDb();
  const where = [];
  const params = {};
  if (filter.fromName) { where.push('from_name=@fromName'); params.fromName = filter.fromName; }
  if (filter.toName) { where.push('to_name=@toName'); params.toName = filter.toName; }
  if (filter.status) { where.push('status=@status'); params.status = filter.status; }
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
  const rows = db.prepare(
    `SELECT * FROM handover_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'signed' THEN 1 ELSE 2 END,
               -id LIMIT ${limit}`
  ).all(params);
  return rows.map(rowToHandover);
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABEL,
  buildSnapshotInTxn,
  generateHandover,
  signHandover,
  expireAllActiveByReset,
  getHandover,
  listHandovers
};
