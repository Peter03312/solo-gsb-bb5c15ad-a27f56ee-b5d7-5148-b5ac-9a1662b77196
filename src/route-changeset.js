'use strict';

/**
 * 进路定义批量变更集（创建 / 修改 / 删除，一次提交、先预览后发布）。
 *
 * 流程（与需求逐项对应）：
 *  1. previewChangeset：管理员一次提交多条 create/update/delete，服务端逐条
 *     校验并返回：每条结果（合法与否及原因）、受影响的等待申请（含其当前
 *     阻断原因）、整批阻断原因（有开放进路 / 副本已暂停 / 存在非法项）以及
 *     【当前站场修订标识】。预览是只读操作，不写任何业务数据；暂停副本也
 *     可预览。
 *  2. publishChangeset：发布只携带预览返回的修订标识，服务端在【同一事务内】
 *     重验整批：
 *       - 修订标识对应的站场快照必须与当前完全一致（进路定义、引用的区段/
 *         道岔/信号机、等待申请任一变化即拒绝并列明变化类别）；
 *       - 不得存在已开放进路（开放进路使用的线路不允许改定义）；
 *       - 重新逐条校验：批内编号不重复、创建不重名、修改/删除指向现有进路、
 *         区段顺序不重复、引用的区段/道岔/信号机存在。
 *     任一项不满足：整批不落地（事务回滚），等待申请保持原状。
 *     全部满足：仅变更所列进路，并【沿用现有单条编辑规则】——修改使该进路
 *     等待申请失效、删除使相关等待申请失效并删除已解除历史实例；提交后按
 *     现有规则重试等待兑现。不改变区段占用、锁闭及其他站场资源。
 *
 * 修订标识实现：对"进路定义（含步骤/道岔要求）、区段、道岔、信号机、
 * 等待申请"的规范化内容做 SHA-256。开放进路与暂停状态不属于修订标识
 * （它们是发布时的独立阻断项），这样"预览后出现开放进路"与"预览后定义/
 * 资源/等待变化"两类拒绝原因可以明确区分。预览内容保存在本进程内存中，
 * 服务重启后旧标识失效，须重新预览。
 */

const crypto = require('crypto');
const { getDb, currentYardId } = require('./db');
const { InterlockError } = require('./interlocking');
const waiting = require('./waiting');
const blockade = require('./blockade');
const pause = require('./pause');

const ID_RE = /^[A-Za-z0-9_一-龥-]{1,20}$/;
const MAX_CHANGES = 200;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 50;

/**
 * 已提交的预览：每次预览一个一次性令牌 previewId -> 预览内容。
 * 令牌只在本进程内存中有效——批量编辑是一次连续的管理操作，服务重启后要求
 * 重新预览（旧令牌按 REVISION_STALE 拒绝）。注意内容哈希 revision 相同的
 * 多次预览（不同管理员/多次点击）各自持有独立令牌，互不顶替。
 * @type {Map<string, {yardId:number, hash:string, snapshot:Object, changes:Array, createdAt:number}>}
 */
const previews = new Map();

/* ============================== 修订标识 / 快照 ============================== */

/**
 * 当前站场修订快照：进路定义、区段、道岔、信号机、等待申请（不含开放进路与
 * 暂停状态——它们是发布时的独立阻断条件）。各数组按主键排序、对象键顺序
 * 固定，JSON.stringify 结果稳定，可直接做内容哈希。
 */
function buildSnapshot() {
  const db = getDb();
  const routes = db.prepare(`SELECT id,label,origin,destination,entry_signal_id
                              FROM routes ORDER BY id`).all().map((r) => ({
    id: r.id, label: r.label, origin: r.origin, destination: r.destination,
    entrySignalId: r.entry_signal_id || null,
    steps: db.prepare(
      `SELECT step_order, section_id FROM route_steps WHERE route_id=? ORDER BY step_order`
    ).all(r.id).map((s) => ({ order: s.step_order, sectionId: s.section_id })),
    switchReqs: db.prepare(
      `SELECT switch_id, req_position FROM route_switch_reqs WHERE route_id=? ORDER BY switch_id`
    ).all(r.id).map((q) => ({ switchId: q.switch_id, position: q.req_position }))
  }));

  const sections = db.prepare(
    `SELECT id,label,x1,y1,x2,y2,occ_state FROM sections ORDER BY id`
  ).all().map((s) => ({
    id: s.id, label: s.label,
    x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, occState: s.occ_state
  }));

  const switches = db.prepare(
    `SELECT id,label,x,y,position,nx1,ny1,nx2,ny2,rx1,ry1,rx2,ry2
       FROM switches ORDER BY id`
  ).all().map((s) => ({
    id: s.id, label: s.label, x: s.x, y: s.y, position: s.position,
    nx1: s.nx1, ny1: s.ny1, nx2: s.nx2, ny2: s.ny2,
    rx1: s.rx1, ry1: s.ry1, rx2: s.rx2, ry2: s.ry2
  }));

  const signals = db.prepare(
    `SELECT id,label,x,y,direction FROM signals ORDER BY id`
  ).all().map((s) => ({ id: s.id, label: s.label, x: s.x, y: s.y, direction: s.direction }));

  // 等待申请只取决定"是否受影响"的核心字段；block_reasons 的文案刷新不使
  // 修订标识变化（它不影响将被失效的申请集合）。
  const waitingApps = db.prepare(
    `SELECT id,route_id,applicant,switch_positions,status,instance_id
       FROM waiting_applications ORDER BY id`
  ).all().map((w) => ({
    id: w.id, routeId: w.route_id, applicant: w.applicant,
    switchPositions: w.switch_positions, status: w.status, instanceId: w.instance_id
  }));

  return { routes, sections, switches, signals, waiting: waitingApps };
}

function hashSnapshot(snapshot) {
  return 'rev1-' + crypto.createHash('sha256')
    .update(JSON.stringify(snapshot)).digest('hex');
}

/** 预览条目清理：超时或超量时剔除最旧预览 */
function prunePreviews() {
  const now = Date.now();
  for (const [token, entry] of previews) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) previews.delete(token);
  }
  while (previews.size >= PREVIEW_MAX_ENTRIES) {
    const oldestKey = previews.keys().next().value;
    previews.delete(oldestKey);
  }
}

/* ============================== 变更解析与校验 ============================== */

/**
 * 解析并规范化单条变更。结构性（与数据库无关的）错误写入 errors。
 * @returns {{index:number, op:string, routeId:string, route:Object|null, errors:string[]}}
 */
function normalizeChange(raw, index) {
  const result = {
    index,
    op: null,
    routeId: '',
    route: null,
    errors: []
  };
  if (!raw || typeof raw !== 'object') {
    result.errors.push('变更项必须是对象 {op,id,...}');
    return result;
  }
  const op = String(raw.op == null ? '' : raw.op).toLowerCase();
  if (!['create', 'update', 'delete'].includes(op)) {
    result.errors.push(`操作类型 op 必须是 create / update / delete（收到 ${JSON.stringify(raw.op)}）`);
  }
  result.op = op;

  const routeId = String(raw.id == null ? (raw.routeId == null ? '' : raw.routeId) : raw.id).trim();
  result.routeId = routeId;
  if (!routeId) {
    result.errors.push('缺少进路编号 id');
  } else if (!ID_RE.test(routeId)) {
    result.errors.push(`进路编号 ${routeId} 不合法（需为 1~20 位字母数字/下划线/中文）`);
  }

  if (op !== 'create' && op !== 'update') return result;

  const label = String(raw.label == null || raw.label === '' ? routeId : raw.label).trim();
  const origin = String(raw.origin || '').trim();
  const destination = String(raw.destination || '').trim();
  const entrySignalId = raw.entrySignalId ? String(raw.entrySignalId).trim() : null;

  if (!origin) result.errors.push('进路必须填写起点 origin');
  if (!destination) result.errors.push('进路必须填写终点 destination');

  let steps = [];
  if (!Array.isArray(raw.steps)) {
    result.errors.push('进路区段 steps 必须是数组');
  } else {
    steps = raw.steps.map((s) => String(s == null ? '' : s).trim());
    if (steps.length === 0) {
      result.errors.push('进路至少包含一个区段');
    } else if (new Set(steps).size !== steps.length) {
      result.errors.push(`进路区段顺序重复：${steps.filter((s, i) => steps.indexOf(s) !== i).join('、')}`);
    }
    if (steps.some((s) => !s)) result.errors.push('进路区段编号不能为空');
  }

  const switchReqs = [];
  if (raw.switchReqs != null && !Array.isArray(raw.switchReqs)) {
    result.errors.push('道岔位置要求 switchReqs 必须是数组');
  } else {
    const seenSwitch = new Set();
    for (const r of Array.isArray(raw.switchReqs) ? raw.switchReqs : []) {
      if (!r || typeof r !== 'object') {
        result.errors.push('道岔位置要求格式为 {switchId, position: N|R}');
        continue;
      }
      const switchId = String(r.switchId == null ? '' : r.switchId).trim();
      const position = String(r.position == null ? '' : r.position).toUpperCase();
      if (!switchId || !['N', 'R'].includes(position)) {
        result.errors.push(`道岔位置要求格式为 {switchId, position: N|R}（收到 ${JSON.stringify(r)}）`);
        continue;
      }
      if (seenSwitch.has(switchId)) {
        result.errors.push(`进路中道岔 ${switchId} 的位置要求重复`);
        continue;
      }
      seenSwitch.add(switchId);
      switchReqs.push({ switchId, position });
    }
  }

  if (result.errors.length) return result;
  result.route = {
    id: routeId, label, origin, destination, entrySignalId, steps, switchReqs
  };
  return result;
}

/**
 * 校验整批变更：批内编号唯一、创建不重名（含批内新建）、修改/删除指向现有
 * 进路、引用的区段/道岔/信号机存在。
 *
 * @returns {{valid:boolean, items:Array, affectedWaiting:Array,
 *            releasedInstancesByDelete:Object, existingRouteIds:Set}}
 */
function validateBatch(changes) {
  const db = getDb();
  const items = changes.map((raw, i) => normalizeChange(raw, i));

  // 1) 批内进路编号不得重复
  const targetCount = new Map();
  for (const it of items) {
    if (it.routeId) targetCount.set(it.routeId, (targetCount.get(it.routeId) || 0) + 1);
  }
  for (const it of items) {
    if (it.routeId && targetCount.get(it.routeId) > 1) {
      const indexes = items.filter((x) => x.routeId === it.routeId).map((x) => x.index + 1);
      it.errors.push(`批内进路编号 ${it.routeId} 重复（第 ${indexes.join('、')} 项指向同一编号）`);
    }
  }

  const existingRouteIds = new Set(db.prepare(`SELECT id FROM routes`).all().map((r) => r.id));
  const sectionIds = new Set(db.prepare(`SELECT id FROM sections`).all().map((r) => r.id));
  const switchIds = new Set(db.prepare(`SELECT id FROM switches`).all().map((r) => r.id));
  const signalIds = new Set(db.prepare(`SELECT id FROM signals`).all().map((r) => r.id));
  const createdInBatch = new Set();

  // 2) 逐条做数据库相关校验（创建/重名/引用资源存在）
  for (const it of items) {
    if (it.op === 'create') {
      if (it.routeId && existingRouteIds.has(it.routeId)) {
        it.errors.push(`进路 ${it.routeId} 已存在，不能重复创建（如要修改请使用 update）`);
      } else if (it.routeId && createdInBatch.has(it.routeId)) {
        it.errors.push(`进路编号 ${it.routeId} 在本批中重复`);
      }
      if (it.routeId && ID_RE.test(it.routeId)) createdInBatch.add(it.routeId);
    } else if (it.op === 'update' || it.op === 'delete') {
      if (it.routeId && !existingRouteIds.has(it.routeId)) {
        it.errors.push(`进路 ${it.routeId} 不存在，${it.op === 'update' ? '修改' : '删除'}必须指向现有进路`);
      }
    }
    if (it.route) {
      for (const sid of it.route.steps) {
        if (sid && !sectionIds.has(sid)) it.errors.push(`进路 ${it.routeId} 引用了不存在的区段 ${sid}`);
      }
      for (const r of it.route.switchReqs) {
        if (!switchIds.has(r.switchId)) it.errors.push(`进路 ${it.routeId} 引用了不存在的道岔 ${r.switchId}`);
      }
      if (it.route.entrySignalId && !signalIds.has(it.route.entrySignalId)) {
        it.errors.push(`进路 ${it.routeId} 的入口信号机 ${it.route.entrySignalId} 不存在`);
      }
    }
  }

  // 3) 受影响的等待申请（修改/删除现有进路 → 该进路全部等待中申请将失效；
  //    创建不影响任何等待申请），附各申请当前阻断原因
  const affectedMap = new Map();
  for (const it of items) {
    if ((it.op === 'update' || it.op === 'delete') && existingRouteIds.has(it.routeId)) {
      const apps = waiting.listApplications({ status: 'waiting' })
        .filter((a) => a.routeId === it.routeId);
      for (const a of apps) {
        if (!affectedMap.has(a.id)) {
          affectedMap.set(a.id, {
            id: a.id, routeId: a.routeId, applicant: a.applicant,
            switchPositions: a.switchPositions,
            currentBlockReasons: a.blockReasons || [],
            effect: 'invalidate',
            reason: it.op === 'delete'
              ? `进路 ${it.routeId} 将被删除，等待申请失效`
              : `管理员将修改进路 ${it.routeId} 的定义，原等待申请失效`
          });
        }
      }
    }
  }

  // 4) 删除进路时将一并删除的已解除历史实例数量（开放实例由整批阻断项拦截）
  const releasedInstancesByDelete = {};
  const countReleased = getDb().prepare(
    `SELECT COUNT(*) AS n FROM route_instances WHERE route_id=? AND status='released'`
  );
  for (const it of items) {
    if (it.op === 'delete' && existingRouteIds.has(it.routeId)) {
      releasedInstancesByDelete[it.routeId] = countReleased.get(it.routeId).n;
    }
  }

  return {
    valid: items.every((it) => it.errors.length === 0),
    items,
    affectedWaiting: [...affectedMap.values()].sort((a, b) => a.id - b.id),
    releasedInstancesByDelete
  };
}

/* ============================== 预览 ============================== */

function openInstances() {
  return getDb().prepare(
    `SELECT i.id, i.route_id AS routeId, i.opened_by AS openedBy
       FROM route_instances i WHERE i.status='open' ORDER BY i.id`
  ).all();
}

function summarize(items, affectedWaiting, releasedByDelete) {
  const count = (op) => items.filter((it) => it.op === op).length;
  return {
    create: count('create'),
    update: count('update'),
    delete: count('delete'),
    total: items.length,
    affectedWaiting: affectedWaiting.length,
    releasedInstancesToDelete: Object.values(releasedByDelete).reduce((a, b) => a + b, 0)
  };
}

/**
 * 预览批量变更（只读，不写业务数据）。暂停副本也允许预览（预览结果会把
 * "副本已暂停"列为阻断原因）。
 * @param {Array} rawChanges 原始变更数组
 */
function previewChangeset(rawChanges) {
  if (!Array.isArray(rawChanges)) {
    throw new InterlockError(400, 'BATCH_INVALID', '请求体 changes 必须是创建/修改/删除变更项数组');
  }
  if (rawChanges.length === 0) {
    throw new InterlockError(400, 'BATCH_EMPTY', '变更集不能为空，至少包含一条创建/修改/删除');
  }
  if (rawChanges.length > MAX_CHANGES) {
    throw new InterlockError(400, 'BATCH_TOO_LARGE', `单批变更不得超过 ${MAX_CHANGES} 条（收到 ${rawChanges.length} 条）`);
  }

  const snapshot = buildSnapshot();
  const revision = hashSnapshot(snapshot);
  const v = validateBatch(rawChanges);
  const open = openInstances();
  const paused = pause.isPaused(currentYardId());

  const blockReasons = [];
  if (paused) {
    blockReasons.push('当前命名演练副本已暂停：暂停期间不能发布站场定义变更，请先由管理员恢复');
  }
  if (open.length) {
    blockReasons.push(
      `存在 ${open.length} 条已开放进路（${open.map((i) => `#${i.id} ${i.routeId}`).join('、')}），` +
      '锁闭期间不能修改进路定义，请待进路全部解除后再发布'
    );
  }
  for (const it of v.items) {
    for (const msg of it.errors) {
      blockReasons.push(`第 ${it.index + 1} 项（${opText(it.op)} ${it.routeId || '未填编号'}）：${msg}`);
    }
  }

  const valid = v.valid && open.length === 0 && !paused;

  // 保存预览（无论是否合法——发布时仍会在同一事务内重验并拒绝非法整批）。
  // 每次预览生成独立一次性令牌；revision 是展示与比对用的内容修订标识。
  prunePreviews();
  const previewId = 'prev-' + crypto.randomBytes(16).toString('hex');
  previews.set(previewId, {
    yardId: currentYardId(),
    hash: revision,
    snapshot,
    changes: v.items.map((it) => ({ op: it.op, routeId: it.routeId, route: it.route })),
    createdAt: Date.now()
  });

  return {
    revision,
    previewId,
    revisionLabel: revision.slice(0, 13) + '…（SHA-256 内容标识，发布时原样携带）',
    valid,
    blockReasons,
    openInstances: open,
    paused,
    summary: summarize(v.items, v.affectedWaiting, v.releasedInstancesByDelete),
    results: v.items.map((it) => ({
      index: it.index,
      op: it.op,
      routeId: it.routeId,
      valid: it.errors.length === 0,
      errors: it.errors,
      route: it.route,
      affectedWaiting: v.affectedWaiting
        .filter((a) => a.routeId === it.routeId && (it.op === 'update' || it.op === 'delete'))
        .map((a) => a.id),
      releasedInstancesToDelete: v.releasedInstancesByDelete[it.routeId] || 0
    })),
    affectedWaiting: v.affectedWaiting
  };
}

function opText(op) {
  return { create: '创建', update: '修改', delete: '删除' }[op] || '未知操作';
}

/* ============================== 修订变化比对 ============================== */

const CATEGORY_LABEL = {
  routes: '进路定义',
  sections: '区段（含占用状态）',
  switches: '道岔（含实际位置）',
  signals: '信号机',
  waiting: '等待申请'
};

/** 对比预览快照与当前快照，返回变化类别与明细 */
function diffSnapshots(before, after) {
  const changes = [];

  const compareEntities = (category, key, beforeList, afterList, describe) => {
    const details = [];
    const beforeMap = new Map(beforeList.map((x) => [x[key], x]));
    const afterMap = new Map(afterList.map((x) => [x[key], x]));
    for (const id of beforeMap.keys()) {
      if (!afterMap.has(id)) details.push(describe.removed(beforeMap.get(id)));
    }
    for (const [id, cur] of afterMap) {
      const old = beforeMap.get(id);
      if (!old) details.push(describe.added(cur));
      else if (JSON.stringify(old) !== JSON.stringify(cur)) details.push(describe.changed(old, cur));
    }
    if (details.length) changes.push({ category, label: CATEGORY_LABEL[category], details });
  };

  compareEntities('routes', 'id', before.routes, after.routes, {
    added: (r) => `进路 ${r.id}：新增定义`,
    removed: (r) => `进路 ${r.id}：定义已被删除`,
    changed: (a) => `进路 ${a.id}：定义（区段顺序/道岔要求/起终点/入口信号）已变化`
  });
  compareEntities('sections', 'id', before.sections, after.sections, {
    added: (s) => `区段 ${s.id}：新增`,
    removed: (s) => `区段 ${s.id}：已被删除`,
    changed: (a, b) => {
      if (a.occState !== b.occState) {
        return `区段 ${a.id}：占用状态由 ${a.occState} 变为 ${b.occState}`;
      }
      return `区段 ${a.id}：定义（坐标/名称）已变化`;
    }
  });
  compareEntities('switches', 'id', before.switches, after.switches, {
    added: (s) => `道岔 ${s.id}：新增`,
    removed: (s) => `道岔 ${s.id}：已被删除`,
    changed: (a, b) => {
      if (a.position !== b.position) return `道岔 ${a.id}：实际位置由 ${a.position} 变为 ${b.position}`;
      return `道岔 ${a.id}：定义（坐标/名称）已变化`;
    }
  });
  compareEntities('signals', 'id', before.signals, after.signals, {
    added: (s) => `信号机 ${s.id}：新增`,
    removed: (s) => `信号机 ${s.id}：已被删除`,
    changed: (s) => `信号机 ${s.id}：定义已变化`
  });

  // 等待申请
  const details = [];
  const bw = new Map(before.waiting.map((x) => [x.id, x]));
  const aw = new Map(after.waiting.map((x) => [x.id, x]));
  for (const [id, old] of bw) {
    const cur = aw.get(id);
    if (!cur) {
      details.push(`等待申请 #${id}（进路 ${old.routeId}）：记录已不存在`);
    } else if (JSON.stringify(old) !== JSON.stringify(cur)) {
      if (old.status !== cur.status) {
        const st = { waiting: '等待中', fulfilled: '已兑现', cancelled: '已撤销', invalid: '已失效' };
        details.push(`等待申请 #${id}（进路 ${old.routeId}）：状态由 ${st[old.status] || old.status} 变为 ${st[cur.status] || cur.status}`);
      } else {
        details.push(`等待申请 #${id}（进路 ${old.routeId}）：内容已变化`);
      }
    }
  }
  for (const [id, cur] of aw) {
    if (!bw.has(id)) details.push(`等待申请 #${id}（进路 ${cur.routeId}）：新提交的申请`);
  }
  if (details.length) changes.push({ category: 'waiting', label: CATEGORY_LABEL.waiting, details });

  return {
    changedCategories: changes.map((c) => c.category),
    changes
  };
}

/* ============================== 发布 ============================== */

/**
 * 携带预览令牌发布变更集：同一事务内重验修订标识、开放进路与整批合法性，
 * 任一不满足整批回滚、等待申请保持原状。
 * @param {string} token 预览返回的 previewId（一次性发布令牌；同内容多次预览各自独立）
 */
function publishChangeset(token) {
  token = String(token || '');
  const entry = previews.get(token);
  if (!entry || entry.yardId !== currentYardId()) {
    throw new InterlockError(409, 'REVISION_STALE',
      '预览已失效或不属于当前站场（预览只在本服务进程内短期有效，重启后须重新预览），请重新预览后再发布');
  }

  const db = getDb();
  let applied = null;

  db.transaction(() => {
    // 1) 修订标识重验：预览后定义/引用资源/等待申请变化 → 拒绝
    const snapshotNow = buildSnapshot();
    if (hashSnapshot(snapshotNow) !== entry.hash) {
      const diff = diffSnapshots(entry.snapshot, snapshotNow);
      previews.delete(token);
      throw new InterlockError(409, 'REVISION_CHANGED',
        '发布拒绝：预览后当前站场的' + diff.changes.map((c) => c.label).join('、') +
        '已发生变化，请重新预览后再发布（变更尚未落地）',
        diff);
    }

    // 2) 开放进路阻断（与 assertNoOpenInstances 同一规则，但在本事务内读取）
    const open = openInstances();
    // 3) 整批重验（必须与预览结果一致）
    const v = validateBatch(entry.changes.map((c) => ({
      op: c.op, id: c.routeId, ...(c.route || {})
    })));

    if (open.length || !v.valid) {
      const blockReasons = [];
      if (open.length) {
        blockReasons.push(
          `存在 ${open.length} 条已开放进路（${open.map((i) => `#${i.id} ${i.routeId}`).join('、')}），` +
          '锁闭期间不能修改进路定义'
        );
      }
      for (const it of v.items) {
        for (const msg of it.errors) {
          blockReasons.push(`第 ${it.index + 1} 项（${opText(it.op)} ${it.routeId || '未填编号'}）：${msg}`);
        }
      }
      throw new InterlockError(409, 'CHANGESET_BLOCKED',
        '发布拒绝：整批变更存在阻断项，未做任何改动、等待申请保持原状——' + blockReasons.join('；'),
        {
          blockReasons,
          openInstances: open,
          results: v.items.map((it) => ({
            index: it.index, op: it.op, routeId: it.routeId,
            valid: it.errors.length === 0, errors: it.errors
          }))
        });
    }

    // 4) 全部合法：在本事务内仅应用所列进路的变更，沿用单条编辑规则
    const invalidated = [];
    const perItem = [];

    const insertRoute = db.prepare(
      `INSERT INTO routes(id,label,origin,destination,entry_signal_id)
       VALUES(@id,@label,@origin,@destination,@entrySignalId)`
    );
    const insertStep = db.prepare(
      `INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`
    );
    const insertReq = db.prepare(
      `INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`
    );
    const updateRoute = db.prepare(
      `UPDATE routes SET label=@label,origin=@origin,destination=@destination,
              entry_signal_id=@entrySignalId WHERE id=@id`
    );
    const deleteSteps = db.prepare(`DELETE FROM route_steps WHERE route_id=?`);
    const deleteReqs = db.prepare(`DELETE FROM route_switch_reqs WHERE route_id=?`);
    const deleteReleased = db.prepare(
      `DELETE FROM route_instances WHERE route_id=? AND status='released'`
    );
    const deleteRoute = db.prepare(`DELETE FROM routes WHERE id=?`);

    for (const change of entry.changes) {
      const r = change.route;
      const itemResult = {
        op: change.op, routeId: change.routeId, applied: true,
        affectedWaiting: [], releasedInstancesDeleted: 0
      };

      if (change.op === 'create') {
        insertRoute.run(r);
        r.steps.forEach((sid, i) => insertStep.run(r.id, i + 1, sid));
        r.switchReqs.forEach((q) => insertReq.run(r.id, q.switchId, q.position));
      } else if (change.op === 'update') {
        updateRoute.run(r);
        deleteSteps.run(r.id);
        deleteReqs.run(r.id);
        r.steps.forEach((sid, i) => insertStep.run(r.id, i + 1, sid));
        r.switchReqs.forEach((q) => insertReq.run(r.id, q.switchId, q.position));
        // 沿用单条编辑规则：该进路既有等待申请全部失效
        const before = waiting.listApplications({ status: 'waiting' })
          .filter((a) => a.routeId === r.id).map((a) => a.id);
        waiting.invalidateByRouteChange(
          r.id, `管理员批量修改了进路 ${r.id} 的定义，原等待申请失效`);
        itemResult.affectedWaiting = before;
        invalidated.push(...before);
      } else if (change.op === 'delete') {
        const cntRow = db.prepare(
          `SELECT COUNT(*) AS n FROM route_instances WHERE route_id=? AND status='released'`
        ).get(change.routeId);
        itemResult.releasedInstancesDeleted = cntRow.n;
        // 沿用单条编辑规则：删除已解除历史实例 → 删除定义 → 等待申请失效
        deleteReleased.run(change.routeId);
        const info = deleteRoute.run(change.routeId);
        if (info.changes === 0) {
          throw new InterlockError(404, 'ROUTE_NOT_FOUND', `进路 ${change.routeId} 不存在`);
        }
        const before = waiting.listApplications({ status: 'waiting' })
          .filter((a) => a.routeId === change.routeId).map((a) => a.id);
        waiting.invalidateByRouteDelete(change.routeId);
        itemResult.affectedWaiting = before;
        invalidated.push(...before);
      }
      perItem.push(itemResult);
    }

    applied = { perItem, invalidated: [...new Set(invalidated)] };
  })();

  // 事务已提交：预览一次性消费；按现有规则复核封锁并重试等待兑现
  previews.delete(token);
  let waitingFulfilled = [];
  try {
    blockade.refreshBlockadeStates('route_changeset');
    waitingFulfilled = waiting.sweepFulfillments('route_changeset').fulfilled;
  } catch (e) {
    console.error('[route-changeset] 发布后等待兑现扫描失败:', e);
  }

  const snapshotAfter = buildSnapshot();
  const invalidatedApps = applied.invalidated.map((id) => waiting.getApplication(id))
    .filter(Boolean).map((a) => ({
      id: a.id, routeId: a.routeId, applicant: a.applicant,
      status: a.status, endReason: a.endReason
    }));

  return {
    revision: hashSnapshot(snapshotAfter),
    summary: applied.perItem.reduce((acc, it) => {
      acc[it.op] = (acc[it.op] || 0) + 1;
      acc.releasedInstancesDeleted += it.releasedInstancesDeleted;
      return acc;
    }, { create: 0, update: 0, delete: 0, releasedInstancesDeleted: 0 }),
    results: applied.perItem,
    invalidatedWaiting: invalidatedApps,
    waitingFulfilledAfter: waitingFulfilled,
    note: '批量变更已在同一事务内落地：仅所列进路定义发生变化；相关等待申请已按单条编辑规则失效，' +
          '并已按现有规则重试等待兑现；区段占用、锁闭与其他站场资源未改动'
  };
}

module.exports = {
  previewChangeset,
  publishChangeset,
  // 导出供测试
  buildSnapshot,
  hashSnapshot
};
