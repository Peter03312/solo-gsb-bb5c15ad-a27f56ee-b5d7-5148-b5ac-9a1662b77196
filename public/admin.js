'use strict';

/* 管理员工作台：绘制站场图、定义进路、重置推演状态 */
let STATE = null;
let CHECKPOINTS = null;    // 当前副本的检查点列表（原站场为 null）
let EXAMS = null;          // 当前副本的考核列表（原站场为 null）
let tool = 'select';
let drawFirst = null;        // 画区段时的第一个端点
let routeBuilder = null;     // {steps:[sectionId], switches:[{switchId,position}]}
let editing = null;          // 当前右键/点击编辑对象
let changeset = null;        // 批量变更集弹窗状态 {entries, preview, awaitingRevision}

const svg = document.getElementById('yard');
const side = document.getElementById('side');
const { el, html, api, toast, OCC_TEXT, syncYard, renderYardBar } = App;

async function boot() {
  document.getElementById('meName').textContent = '管理员';
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('refreshBtn').addEventListener('click', () => load(true));
  if (!App.token() || App.role() !== 'admin') {
    location.href = '/index.html';
    return;
  }
  renderYardBar();
  await load(true);
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  App.clearSession();
  location.href = '/index.html';
}

async function load(manual) {
  try {
    const data = await api('/api/admin/state');
    STATE = data.state;
    syncYard(data.yard || (STATE && STATE.yard));
    // 命名演练副本：一并加载检查点列表（原站场不加载）
    if (STATE.yard && !STATE.yard.isOriginal) {
      try {
        const cp = await api('/api/admin/yards/current/checkpoints');
        CHECKPOINTS = cp.checkpoints || [];
      } catch (_) { CHECKPOINTS = []; }
      try {
        const ex = await api('/api/admin/exams');
        EXAMS = ex.exams || [];
      } catch (_) { EXAMS = []; }
    } else {
      CHECKPOINTS = null;
      EXAMS = null;
    }
    drawFirst = null;
    renderYard();
    renderSide();
  } catch (e) { if (manual) toast(e.message, 'err'); }
}

/* ============================== 站场图绘制 ============================== */

function renderYard() {
  svg.innerHTML = '';
  svg.onclick = onSvgClick;

  // 道岔股道线
  for (const sw of STATE.switches) {
    if ([sw.nx1, sw.ny1, sw.nx2, sw.ny2].every((v) => v != null)) {
      svg.appendChild(el('line', { x1: sw.nx1, y1: sw.ny1, x2: sw.nx2, y2: sw.ny2, class: 'sw-line' }));
    }
    if ([sw.rx1, sw.ry1, sw.rx2, sw.ry2].every((v) => v != null)) {
      svg.appendChild(el('line', { x1: sw.rx1, y1: sw.ry1, x2: sw.rx2, y2: sw.ry2, class: 'sw-line' }));
    }
  }

  // 区段
  for (const sec of STATE.sections) {
    const line = el('line', {
      x1: sec.x1, y1: sec.y1, x2: sec.x2, y2: sec.y2,
      class: `sec-line state-${sec.occ_state}`,
      'data-id': sec.id
    });
    line.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('section', sec.id); });
    svg.appendChild(line);
    svg.appendChild(el('text', {
      x: (sec.x1 + sec.x2) / 2, y: (sec.y1 + sec.y2) / 2 - 14, class: 'tag-label'
    }, sec.id));
    // 临时封锁标记
    const blk = (STATE.blockadesBySection || {})[sec.id];
    if (blk) {
      const t = el('text', {
        x: (sec.x1 + sec.x2) / 2, y: (sec.y1 + sec.y2) / 2 + 16, class: 'blk-tag'
      }, blk.status === 'active' ? '⊘封锁中' : '⊘封锁待生效');
      t.appendChild(el('title', {}, `临时封锁申请 #${blk.id}：${blk.reason}`));
      svg.appendChild(t);
    }
  }

  // 道岔
  for (const sw of STATE.switches) {
    const c = el('circle', { cx: sw.x, cy: sw.y, r: 8, class: 'sw-core' });
    c.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('switch', sw.id); });
    c.appendChild(el('title', {}, `道岔 ${sw.id}，点击编辑/删除`));
    svg.appendChild(c);
    svg.appendChild(el('text', { x: sw.x, y: sw.y - 14, class: 'sw-label' }, `${sw.label}${sw.position}`));
  }

  // 信号机
  for (const sig of STATE.signals) {
    const g = el('g', {});
    g.appendChild(el('rect', {
      x: sig.x - 6, y: sig.y - 10, width: 12, height: 20, rx: 3, class: 'sig-body'
    }));
    g.appendChild(el('circle', { cx: sig.x, cy: sig.y - 4, r: 2.8, fill: '#d64545' }));
    g.appendChild(el('circle', { cx: sig.x, cy: sig.y + 4, r: 2.8, fill: '#20503a' }));
    g.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('signal', sig.id); });
    g.appendChild(el('title', {}, `信号机 ${sig.id}，点击编辑/删除`));
    svg.appendChild(g);
    svg.appendChild(el('text', { x: sig.x, y: sig.y + 28, class: 'sig-label' }, sig.label));
  }

  // 画区段时的第一个端点标记
  if (drawFirst) {
    svg.appendChild(el('circle', {
      cx: drawFirst.x, cy: drawFirst.y, r: 6, fill: '#1d5fd1', 'pointer-events': 'none'
    }));
  }

  // 进路构建高亮
  if (routeBuilder) {
    for (const sid of routeBuilder.steps) {
      const sec = STATE.sections.find((s) => s.id === sid);
      if (sec) svg.appendChild(el('line', {
        x1: sec.x1, y1: sec.y1, x2: sec.x2, y2: sec.y2,
        class: 'sec-line route-hi', style: 'pointer-events:none;'
      }));
    }
  }
}

function svgPoint(ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** 吸附到既有区段端点（方便把区段接起来） */
function snapEndpoint(p) {
  for (const sec of STATE.sections) {
    for (const [x, y] of [[sec.x1, sec.y1], [sec.x2, sec.y2]]) {
      if (Math.hypot(x - p.x, y - p.y) <= 24) return { x, y, snapped: true };
    }
  }
  return { ...p, snapped: false };
}

function onSvgClick(ev) {
  if (tool === 'select') return;
  const raw = svgPoint(ev);

  if (tool === 'draw-section') {
    if (!drawFirst) {
      drawFirst = snapEndpoint(raw);
      toast(drawFirst.snapped ? '已吸附到既有端点，再点一下确定区段终点'
                              : '已确定起点，再点一下确定区段终点', 'info', 2600);
      renderYard();
      return;
    }
    const end = snapEndpoint(raw);
    openSectionModal(null, { x1: drawFirst.x, y1: drawFirst.y, x2: end.x, y2: end.y });
    drawFirst = null;
    renderYard();
    return;
  }

  if (tool === 'draw-switch') { openSwitchModal(null, { x: raw.x, y: raw.y }); return; }
  if (tool === 'draw-signal') { openSignalModal(null, { x: raw.x, y: raw.y }); return; }

  // 进路构建模式：点击区段加入/移除路径（只做局部刷新，避免输入框失焦）
  if (tool === 'build-route' && routeBuilder) {
    // 找到点击位置附近的区段
    const hit = nearestSection(raw, 16);
    if (hit) {
      const idx = routeBuilder.steps.indexOf(hit.id);
      if (idx >= 0) {
        // 只允许移除最后一段
        if (idx === routeBuilder.steps.length - 1) routeBuilder.steps.pop();
        else toast('只能从末尾移除区段', 'err');
      } else {
        routeBuilder.steps.push(hit.id);
      }
      renderYard();
      refreshBuilderSteps();
    }
  }
}

function nearestSection(p, maxDist) {
  let best = null, bestD = maxDist;
  for (const sec of STATE.sections) {
    const d = distToSegment(p, sec);
    if (d < bestD) { bestD = d; best = sec; }
  }
  return best;
}

function distToSegment(p, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = s.x1 + t * dx, y = s.y1 + t * dy;
  return Math.hypot(p.x - x, p.y - y);
}

function onEntityClick(kind, id) {
  if (tool === 'select') {
    if (kind === 'section') {
      openSectionModal(STATE.sections.find((s) => s.id === id));
    } else if (kind === 'switch') {
      openSwitchModal(STATE.switches.find((s) => s.id === id));
    } else if (kind === 'signal') {
      openSignalModal(STATE.signals.find((s) => s.id === id));
    }
  } else if (tool === 'build-route' && routeBuilder) {
    if (kind === 'section') {
      const idx = routeBuilder.steps.indexOf(id);
      if (idx >= 0) {
        if (idx === routeBuilder.steps.length - 1) routeBuilder.steps.pop();
      } else routeBuilder.steps.push(id);
      renderYard();
      refreshBuilderSteps();
    }
  }
}

/* ============================== 通用弹窗 ============================== */

function modal(title, contentNode, onOk, opts = {}) {
  if (typeof opts === 'string') opts = { okText: opts };
  const okText = opts.okText || '保存';
  const mask = html('div', { class: 'modal-mask' });
  const box = html('div', { class: 'modal' });
  box.appendChild(html('h3', {}, title));
  box.appendChild(contentNode);
  const actions = html('div', { class: 'actions' });
  const cancel = html('button', { class: 'ghost' }, '取消');
  const ok = html('button', { class: 'primary' }, okText);
  function close() { mask.remove(); }
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  ok.addEventListener('click', async () => {
    try {
      const keep = await onOk();
      if (keep === false) return; // 校验失败，保留弹窗
      close();
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  if (opts.onDelete) {
    const del = html('button', { class: 'danger', style: 'margin-right:auto;' }, opts.deleteText || '删除');
    del.addEventListener('click', async () => {
      try {
        const keep = await opts.onDelete(close);
        if (keep === false) return;
        close();
      } catch (e) { toast(e.message, 'err', 6000); }
    });
    actions.appendChild(del);
  }
  actions.appendChild(cancel); actions.appendChild(ok);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  return { close };
}

function fld(labelText, input, hint) {
  const f = html('div', { class: 'fld' });
  f.appendChild(html('label', {}, labelText));
  f.appendChild(input);
  if (hint) f.appendChild(html('div', { class: 'hint' }, hint));
  return f;
}

function suggestedId(prefix) {
  let n = 1;
  const existing = new Set();
  if (prefix === 'sec') STATE.sections.forEach((s) => existing.add(s.id));
  if (prefix === 'sw') STATE.switches.forEach((s) => existing.add(s.id));
  if (prefix === 'sig') STATE.signals.forEach((s) => existing.add(s.id));
  const map = { sec: '', sw: 'SW', sig: 'S' };
  while (existing.has(map[prefix] + n)) n++;
  return map[prefix] + n;
}

/* ============================== 区段弹窗 ============================== */

function openSectionModal(sec, coords) {
  const isEdit = !!sec;
  const idIn = html('input', { type: 'text', value: sec ? sec.id : suggestedId('sec') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sec ? sec.label : '' });
  const c = sec || coords;
  const x1 = html('input', { type: 'number', value: c.x1 });
  const y1 = html('input', { type: 'number', value: c.y1 });
  const x2 = html('input', { type: 'number', value: c.x2 });
  const y2 = html('input', { type: 'number', value: c.y2 });

  const content = html('div', {});
  content.appendChild(fld('区段编号', idIn, '进路中通过此编号引用区段'));
  content.appendChild(fld('显示名称（可空）', labelIn));
  const coordRow = html('div', { class: 'row' });
  [['起点X', x1], ['起点Y', y1], ['终点X', x2], ['终点Y', y2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp);
    inp.style.width = '86px';
    coordRow.appendChild(w);
  });
  content.appendChild(coordRow);
  if (isEdit) {
    content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
      `当前占用状态：${OCC_TEXT[sec.occ_state]}`));
  } else {
    content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
      '新建区段初始占用状态为"未知"（按占用处理），需值班员核实清空。'));
  }

  modal(isEdit ? `编辑区段 ${sec.id}` : '新建区段', content, async () => {
    const body = {
      id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
      x1: Number(x1.value), y1: Number(y1.value), x2: Number(x2.value), y2: Number(y2.value)
    };
    if (isEdit) await api(`/api/admin/sections/${sec.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/sections', { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '区段已更新' : '区段已创建', 'ok');
    await load(true);
  }, isEdit ? '保存' : '创建');
}

/* ============================== 道岔弹窗 ============================== */

function openSwitchModal(sw, point) {
  const isEdit = !!sw;
  const cur = sw || {
    x: point.x, y: point.y,
    nx1: point.x - 40, ny1: point.y, nx2: point.x + 40, ny2: point.y,
    rx1: point.x, ry1: point.y + 10, rx2: point.x, ry2: point.y + 60
  };
  const idIn = html('input', { type: 'text', value: sw ? sw.id : suggestedId('sw') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sw ? sw.label : '' });
  const num = (v) => html('input', { type: 'number', value: v });
  const x = num(cur.x), y = num(cur.y);
  const nx1 = num(cur.nx1), ny1 = num(cur.ny1), nx2 = num(cur.nx2), ny2 = num(cur.ny2);
  const rx1 = num(cur.rx1), ry1 = num(cur.ry1), rx2 = num(cur.rx2), ry2 = num(cur.ry2);

  const content = html('div', {});
  content.appendChild(fld('道岔编号', idIn));
  content.appendChild(fld('显示名称（可空）', labelIn));
  const center = html('div', { class: 'row' });
  [['岔心X', x], ['岔心Y', y]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '100px'; center.appendChild(w);
  });
  content.appendChild(center);
  content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '定位 N=直股 两端点（用于画直股连线，可留空）'));
  const nRow = html('div', { class: 'row' });
  [['NX1', nx1], ['NY1', ny1], ['NX2', nx2], ['NY2', ny2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '80px'; nRow.appendChild(w);
  });
  content.appendChild(nRow);
  content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '反位 R=弯股 两端点（可留空）'));
  const rRow = html('div', { class: 'row' });
  [['RX1', rx1], ['RY1', ry1], ['RX2', rx2], ['RY2', ry2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '80px'; rRow.appendChild(w);
  });
  content.appendChild(rRow);

  const v = () => ({
    id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
    x: Number(x.value), y: Number(y.value),
    nx1: valOrNull(nx1), ny1: valOrNull(ny1), nx2: valOrNull(nx2), ny2: valOrNull(ny2),
    rx1: valOrNull(rx1), ry1: valOrNull(ry1), rx2: valOrNull(rx2), ry2: valOrNull(ry2)
  });

  modal(isEdit ? `编辑道岔 ${sw.id}` : '新建道岔', content, async () => {
    const body = v();
    if (isEdit) await api(`/api/admin/switches/${sw.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/switches', { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '道岔已更新' : '道岔已创建（初始位置 N 定位）', 'ok');
    await load(true);
  }, {
    okText: isEdit ? '保存' : '创建',
    deleteText: '删除该道岔',
    onDelete: isEdit ? async () => {
      if (!confirm(`确定删除道岔 ${sw.id}？被进路引用时会被拒绝。`)) return false;
      await api(`/api/admin/switches/${sw.id}`, { method: 'DELETE' });
      toast('道岔已删除', 'ok'); await load(true);
    } : null
  });
}

function valOrNull(inp) {
  const v = inp.value.trim();
  return v === '' ? null : Number(v);
}

/* ============================== 信号机弹窗 ============================== */

function openSignalModal(sig, point) {
  const isEdit = !!sig;
  const cur = sig || { x: point.x, y: point.y, direction: 'right' };
  const idIn = html('input', { type: 'text', value: sig ? sig.id : suggestedId('sig') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sig ? sig.label : '' });
  const dirSel = html('select', {});
  [['right', '朝右'], ['left', '朝左'], ['up', '朝上'], ['down', '朝下']].forEach(([v, t]) => {
    const o = html('option', { value: v }, t);
    if (cur.direction === v) o.selected = true;
    dirSel.appendChild(o);
  });
  const x = html('input', { type: 'number', value: cur.x });
  const y = html('input', { type: 'number', value: cur.y });

  const content = html('div', {});
  content.appendChild(fld('信号机编号', idIn));
  content.appendChild(fld('显示名称（可空，建议带端部名，如 S1/X1）', labelIn));
  const row = html('div', { class: 'row' });
  [['X', x], ['Y', y]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '100px'; row.appendChild(w);
  });
  const wd = html('div', {}, html('label', {}, '朝向（画图用）'), dirSel);
  row.appendChild(wd);
  content.appendChild(row);

  modal(isEdit ? `编辑信号机 ${sig.id}` : '新建信号机', content, async () => {
    const body = {
      id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
      x: Number(x.value), y: Number(y.value), direction: dirSel.value
    };
    if (isEdit) await api(`/api/admin/signals/${sig.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api(`/api/admin/signals`, { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '信号机已更新' : '信号机已创建（未开放时显示红灯）', 'ok');
    await load(true);
  }, {
    okText: isEdit ? '保存' : '创建',
    deleteText: '删除该信号机',
    onDelete: isEdit ? async () => {
      if (!confirm(`确定删除信号机 ${sig.id}？`)) return false;
      await api(`/api/admin/signals/${sig.id}`, { method: 'DELETE' });
      toast('信号机已删除', 'ok'); await load(true);
    } : null
  });
}

/* ============================== 右侧面板 ============================== */

function setTool(t) {
  tool = t;
  drawFirst = null;
  if (t !== 'build-route') routeBuilder = null;
  renderYard();
  renderSide();
}

function renderSide() {
  side.innerHTML = '';

  const locked = STATE.openInstances.length > 0;
  if (locked) {
    const warn = html('div', { class: 'reasons' });
    warn.appendChild(html('li', {},
      `⚠ 当前有 ${STATE.openInstances.length} 条已开放进路，站场图与进路定义已锁定，解除后方可编辑`));
    side.appendChild(warn);
  }

  // 工具
  side.appendChild(html('div', { class: 'section-title' }, '绘制工具'));
  const tools = html('div', { class: 'tools' });
  const defs = [
    ['select', '选择/编辑'],
    ['draw-section', '＋ 画区段'],
    ['draw-switch', '＋ 放道岔'],
    ['draw-signal', '＋ 放信号机'],
    ['build-route', '⛓ 定义进路']
  ];
  defs.forEach(([t, label]) => {
    const b = html('button', { class: `tool-btn ${tool === t ? 'active' : ''}` }, label);
    b.disabled = locked && t !== 'select';
    b.addEventListener('click', () => {
      if (t === 'build-route') startRouteBuilder();
      else setTool(t);
    });
    tools.appendChild(b);
  });
  side.appendChild(tools);
  side.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    tool === 'draw-section'
      ? '在图上依次点击两个端点画区段（靠近既有端点会自动吸附）。'
      : tool === 'draw-switch'
      ? '在图上点击放置道岔，弹窗中可编辑直股/弯股端点坐标。'
      : tool === 'draw-signal'
      ? '在图上点击放置信号机。'
      : tool === 'build-route'
      ? '在图上按走行顺序依次点击区段构建进路路径；再在下方选择道岔位置与入口信号。'
      : '点击图上的区段/道岔/信号机可编辑或删除。'));

  if (tool === 'build-route' && routeBuilder) side.appendChild(renderRouteBuilder());

  // 实体清单
  side.appendChild(html('div', { class: 'section-title' }, `区段（${STATE.sections.length}）`));
  const secList = html('div', { class: 'entity-list' });
  for (const s of STATE.sections) {
    const blk = (STATE.blockadesBySection || {})[s.id];
    secList.appendChild(html('div', { class: 'ent' },
      html('b', { class: 'grow' }, `${s.id} ${s.label !== s.id ? s.label : ''}`),
      blk ? html('span', { class: `badge ${blk.status === 'active' ? 'red' : 'amber'}` },
        blk.status === 'active' ? '封锁中' : '封锁待生效') : null,
      html('span', { class: `badge ${s.occ_state === 'free' ? 'green' : s.occ_state === 'occupied' ? 'red' : 'unknown'}` },
        OCC_TEXT[s.occ_state])));
  }
  if (STATE.sections.length === 0) secList.appendChild(html('div', { class: 'hint' }, '尚无区段'));
  side.appendChild(secList);

  side.appendChild(html('div', { class: 'section-title' },
    `道岔（${STATE.switches.length}） / 信号机（${STATE.signals.length}）`));
  const swList = html('div', { class: 'entity-list' });
  for (const s of STATE.switches) {
    swList.appendChild(html('div', { class: 'ent' },
      html('span', { class: 'grow' }, `${s.id} ${s.label}　位置 ${s.position}`)));
  }
  for (const s of STATE.signals) {
    swList.appendChild(html('div', { class: 'ent' },
      html('span', { class: 'grow' }, `${s.id} ${s.label}`)));
  }
  if (!STATE.switches.length && !STATE.signals.length) {
    swList.appendChild(html('div', { class: 'hint' }, '尚无道岔/信号机'));
  }
  side.appendChild(swList);

  // 进路清单
  const routesTitle = html('div', { style: 'display:flex;align-items:center;gap:8px;margin:14px 0 8px;' });
  routesTitle.appendChild(html('div', { class: 'section-title', style: 'margin:0;' },
    `进路定义（${STATE.routes.length}）`));
  routesTitle.appendChild(html('span', { class: 'spacer', style: 'flex:1;' }));
  const csBtn = html('button', { class: 'ghost small' }, '📋 批量变更集（预览后发布）');
  csBtn.addEventListener('click', openChangesetModal);
  routesTitle.appendChild(csBtn);
  side.appendChild(routesTitle);
  const rtList = html('div', { class: 'entity-list' });
  for (const r of STATE.routes) {
    const ent = html('div', { class: 'ent', style: 'align-items:flex-start;flex-direction:column;gap:3px;' });
    const editBtn = html('button', { class: 'ghost small' }, '编辑');
    if (locked) editBtn.disabled = true;
    editBtn.addEventListener('click', () => startRouteBuilder(r));
    ent.appendChild(html('div', { style: 'width:100%;display:flex;gap:8px;align-items:center;' },
      html('b', { class: 'grow' }, `${r.id} ${r.label}`), editBtn));
    const info = html('div', { class: 'hint' },
      `${r.origin} → ${r.destination}｜区段: ${r.steps.map((s) => s.section_id).join(',') || '(空)'}` +
      `｜道岔: ${r.switchReqs.map((q) => `${q.switch_id}=${q.req_position}`).join(',') || '无'}` +
      `｜入口信号: ${r.entry_signal_id || '无'}`);
    ent.appendChild(info);
    rtList.appendChild(ent);
  }
  if (STATE.routes.length === 0) rtList.appendChild(html('div', { class: 'hint' }, '尚无进路'));
  side.appendChild(rtList);

  // 学员考核（仅命名演练副本；原站场不能开考）
  if (STATE.yard && !STATE.yard.isOriginal) side.appendChild(renderExamPanel());

  // 临时封锁
  side.appendChild(renderBlockadePanel());

  // 检查点（仅命名演练副本显示；创建/回退要求副本已暂停）
  if (STATE.yard && !STATE.yard.isOriginal) side.appendChild(renderCheckpointPanel());

  // 推演管理
  side.appendChild(html('div', { class: 'section-title' }, '推演管理'));

  // 延时取消保护时长设置（正整数秒；只对之后新申请生效）
  const secNow = STATE.cancelProtectionSeconds || 60;
  const secBox = html('div', { style: 'margin-bottom:10px;' });
  const secRow = html('div', { class: 'row' });
  const secIn = html('input', { type: 'number', min: '1', max: '604800', value: String(secNow), style: 'width:110px;' });
  const secBtn = html('button', { class: 'ghost small' }, '保存保护时长');
  secRow.appendChild(html('span', {}, '延时取消保护时长（秒，正整数）：'));
  secRow.appendChild(secIn);
  secRow.appendChild(secBtn);
  secBox.appendChild(secRow);
  secBox.appendChild(html('div', { class: 'hint' },
    '值班员对"已开放且尚无走行占用"的进路申请延时取消后，信号立即回红、锁闭保留；' +
    '保护期满且重查满足条件才解除。修改只对之后新申请生效，不追改已有申请。'));
  secBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/settings/cancel-protection', {
        method: 'PUT', body: JSON.stringify({ protectionSeconds: Number(secIn.value) })
      });
      toast(`保护时长已设为 ${data.protectionSeconds} 秒（仅影响新申请）`, 'ok', 5000);
      STATE.cancelProtectionSeconds = data.protectionSeconds;
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  side.appendChild(secBox);

  const mgmt = html('div', {});
  const b1 = html('button', { class: 'ghost' }, '清空推演状态（区段→未知，道岔→N）');
  const b2 = html('button', { class: 'ghost' }, '培训重开（区段→空闲，道岔→N）');
  b1.addEventListener('click', () => resetState('/api/admin/reset/state',
    '将删除全部进路实例与事件、撤销等待与延时取消申请、清除临时封锁记录，区段恢复"未知"，确定？'));
  b2.addEventListener('click', () => resetState('/api/admin/reset/training',
    '将删除全部进路实例与事件、撤销等待与延时取消申请、清除临时封锁记录，区段全部置为空闲，确定重新开始一轮演练？'));
  mgmt.appendChild(html('div', { class: 'row' }, b1));
  mgmt.appendChild(html('div', { class: 'row', style: 'margin-top:8px;' }, b2));
  side.appendChild(mgmt);
}

async function resetState(url, msg) {
  if (!confirm(msg)) return;
  try {
    await api(url, { method: 'POST' });
    toast('推演状态已重置', 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 6000); }
}

/* ============================== 临时封锁 ============================== */

const BLOCKADE_STATUS = {
  pending: ['amber', '待生效'],
  active: ['red', '已生效'],
  ended: ['unknown', '已结束']
};

function renderBlockadePanel() {
  const box = html('div', {});
  const all = STATE.blockades || [];
  const unfinished = all.filter((b) => b.status !== 'ended');
  box.appendChild(html('div', { class: 'section-title' }, `临时封锁（${unfinished.length} 未结束）`));

  // 发表单：区段 + 原因
  const form = html('div', { class: 'row' });
  const secSel = html('select', { style: 'width:96px;' });
  for (const s of STATE.sections) {
    const blk = (STATE.blockadesBySection || {})[s.id];
    secSel.appendChild(html('option', { value: s.id }, `${s.id}${blk ? '（已封锁）' : ''}`));
  }
  const reasonIn = html('input', { type: 'text', placeholder: '封锁原因（必填）',
    style: 'flex:1;min-width:120px;' });
  const submitBtn = html('button', { class: 'primary small' }, '发起封锁');
  submitBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/blockades', {
        method: 'POST',
        body: JSON.stringify({ sectionId: secSel.value, reason: reasonIn.value })
      });
      const b = data.blockade;
      toast(data.created
        ? `封锁申请 #${b.id} 已提交（${b.status === 'active' ? '已生效' : '待生效'}）：` +
          `区段 ${b.sectionId} 立即禁止排新进路`
        : `区段 ${b.sectionId} 已有未结束封锁申请 #${b.id}，返回原申请`,
        data.created ? 'ok' : 'info', 5200);
      reasonIn.value = '';
      await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  form.appendChild(secSel);
  form.appendChild(reasonIn);
  form.appendChild(submitBtn);
  box.appendChild(form);
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '提交后立即阻止该区段参与新的预检/开放/等待兑现；已开放进路不受影响。' +
    '区段空闲且无进路锁时自动转为"已生效"，否则保持"待生效"并持续复核。'));

  if (!all.length) {
    box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' }, '暂无封锁记录'));
    return box;
  }
  for (const b of all.slice(0, 12)) {
    const [cls, txt] = BLOCKADE_STATUS[b.status] || ['unknown', b.status];
    const card = html('div', { class: 'instance-card', id: 'blockade-' + b.id,
      style: 'margin-top:8px;' });
    const head = html('div', { class: 'row' });
    head.appendChild(html('b', {}, `封锁#${b.id}`));
    head.appendChild(html('span', { class: 'muted' }, `区段 ${b.sectionId}`));
    head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
    head.appendChild(html('span', { class: `badge ${cls}` }, txt));
    card.appendChild(head);
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
      `原因：${b.reason}（${b.applicant}，${b.createdAt}）`));
    if (b.status === 'ended' && b.endReason) {
      card.appendChild(html('div', { class: 'hint', style: 'margin-top:2px;' }, b.endReason));
    }
    if (b.status !== 'ended') {
      const row = html('div', { class: 'row', style: 'margin-top:6px;' });
      const endBtn = html('button', { class: 'danger small' }, '结束封锁');
      endBtn.addEventListener('click', async () => {
        if (!confirm(`结束封锁申请 #${b.id}（区段 ${b.sectionId}）？\n` +
          '结束后将按现有联锁规则重试等待兑现，区段占用状态保持不变。')) return;
        try {
          await api(`/api/admin/blockades/${b.id}/end`, { method: 'POST' });
          toast(`封锁申请 #${b.id} 已结束`, 'ok');
          await load(true);
        } catch (e) { toast(e.message, 'err', 6000); }
      });
      row.appendChild(endBtn);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
  return box;
}

/* ============================== 学员考核 ============================== */

const EXAM_STATUS_TEXT = { in_progress: '进行中', submitted: '已交卷', terminated: '已终止' };
const EXAM_STATUS_CLS = { in_progress: 'green', submitted: 'lock', terminated: 'unknown' };

function formatExamElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function renderExamPanel() {
  const box = html('div', {});
  const list = EXAMS || [];
  const active = list.find((e) => e.status === 'in_progress');
  box.appendChild(html('div', { class: 'section-title' },
    active ? `🎓 学员考核（#${active.id} 进行中）` : '🎓 学员考核'));

  if (!active) {
    // 开考表单：学员姓名 + 按顺序的进路目标
    const form = html('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
    const studentIn = html('input', { type: 'text', maxlength: '30',
      placeholder: '学员姓名（值班员姓名，1~30 字）', style: 'width:100%;box-sizing:border-box;' });
    form.appendChild(studentIn);
    const targetRow = html('div', { class: 'row' });
    const targetSel = html('select', { style: 'flex:1;' });
    targetSel.appendChild(html('option', { value: '' }, '— 选择进路追加到目标序列 —'));
    for (const r of STATE.routes) {
      targetSel.appendChild(html('option', { value: r.id }, `${r.id} ${r.label}`));
    }
    const seqBox = html('div', { class: 'hint', style: 'margin:2px 0;' }, '目标序列（按顺序完成）：（空）');
    let targets = [];
    const renderSeq = () => {
      seqBox.textContent = '目标序列（按顺序完成）：' +
        (targets.length ? targets.map((t, i) => `${i + 1}.${t}`).join(' → ') : '（空）');
    };
    const addBtn = html('button', { class: 'ghost small', type: 'button' }, '追加');
    addBtn.addEventListener('click', () => {
      if (!targetSel.value) return toast('请先选择进路', 'err');
      if (targets.length >= 50) return toast('进路目标至多 50 项', 'err');
      targets.push(targetSel.value);
      renderSeq();
      targetSel.value = '';
    });
    const undoBtn = html('button', { class: 'ghost small', type: 'button' }, '撤销末项');
    undoBtn.addEventListener('click', () => { targets.pop(); renderSeq(); });
    targetRow.appendChild(targetSel);
    targetRow.appendChild(addBtn);
    targetRow.appendChild(undoBtn);
    form.appendChild(targetRow);
    form.appendChild(seqBox);
    const startBtn = html('button', { class: 'primary small', type: 'button' }, '开考（固定目标与起始状态）');
    form.appendChild(startBtn);
    box.appendChild(form);
    box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
      '开考后仅统计该学员的新进路实例：与当前待达成目标相符的开放并逐段走行解除才推进；' +
      '顺序外开放记为偏差，等待自动兑现与定时走行也计入；暂停冻结有效用时，' +
      '检查点回退或站场重置终止考核（已交卷成绩保留）。'));
    startBtn.addEventListener('click', async () => {
      const student = studentIn.value.trim();
      if (!student) return toast('请填写学员姓名', 'err');
      if (!targets.length) return toast('请至少追加 1 个进路目标', 'err');
      startBtn.disabled = true;
      try {
        const data = await api('/api/admin/exams/start', {
          method: 'POST',
          body: JSON.stringify({ student, targets })
        });
        toast(`考核 #${data.exam.id} 已开考：学员 ${data.exam.student}，` +
          `${data.exam.totalTargetCount} 项目标，开考状态已固定`, 'ok', 5600);
        await load(true);
      } catch (e) {
        startBtn.disabled = false;
        toast(e.message, 'err', 6000);
      }
    });
  } else {
    box.appendChild(html('div', { class: 'hint', style: 'margin-bottom:6px;' },
      '同一副本只允许一场进行中的考核；学员在值班台交卷，或由检查点回退 / 站场重置终止后才能再开考。'));
    box.appendChild(renderExamCard(active));
  }

  const past = list.filter((e) => e.status !== 'in_progress').slice(0, 5);
  if (past.length) {
    box.appendChild(html('div', { class: 'section-title', style: 'margin-top:12px;' }, '历史成绩（最近 5 场）'));
    for (const e of past) box.appendChild(renderExamCard(e));
  }
  if (!list.length) box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' }, '本副本尚无考核记录'));
  return box;
}

function renderExamCard(e) {
  const card = html('div', { class: 'instance-card', id: 'exam-' + e.id, style: 'margin-top:8px;' });
  const head = html('div', { class: 'row' });
  head.appendChild(html('b', {}, `#${e.id} 学员 ${e.student}`));
  head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
  head.appendChild(html('span', { class: `badge ${EXAM_STATUS_CLS[e.status] || 'unknown'}` },
    EXAM_STATUS_TEXT[e.status] || e.status));
  card.appendChild(head);
  card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
    `开考：${e.startedBy || '管理员'} · ${e.startedAtText}｜有效用时 ${formatExamElapsed(e.effectiveElapsedMs)}｜` +
    `达成 ${e.completedTargetCount}/${e.totalTargetCount}｜偏差 ${e.deviationCount}`));

  const list2 = html('div', { style: 'margin-top:4px;display:flex;flex-direction:column;gap:2px;' });
  e.targets.forEach((t) => {
    const row = html('div', { class: 'row' });
    row.appendChild(html('span', { class: `badge ${t.done ? 'green' : 'unknown'}`,
      style: 'min-width:52px;text-align:center;' }, t.done ? '✓ 已达成' : '待达成'));
    row.appendChild(html('b', { style: 'margin:0 6px;' }, `${t.seq}.`));
    row.appendChild(html('span', { class: 'grow' }, `${t.routeId}${t.label ? ' ' + t.label : ''}`));
    if (t.instanceId) row.appendChild(html('span', { class: 'muted' }, `实例 #${t.instanceId}`));
    list2.appendChild(row);
  });
  card.appendChild(list2);

  if (e.deviationCount) {
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;color:var(--amber);' },
      '偏差：' + e.deviations.map((d) =>
        `${d.routeId}#${d.instanceId}（${d.source === 'waiting' ? '等待兑现' : '直接开放'}${d.completed ? '，已走完' : '，未完成'}）`).join('；')));
  }
  if (e.endReason) card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' }, `终止原因：${e.endReason}`));
  return card;
}

/* ============================== 检查点（已暂停副本） ============================== */

function renderCheckpointPanel() {
  const box = html('div', {});
  const paused = !!(STATE.yard && STATE.yard.paused);
  const list = CHECKPOINTS || [];
  box.appendChild(html('div', { class: 'section-title' }, `检查点（${list.length}）`));

  if (paused) {
    // 创建表单：仅已暂停副本可创建
    const form = html('div', { class: 'row' });
    const nameIn = html('input', { type: 'text', maxlength: '30',
      placeholder: '检查点名称（本副本内唯一）', style: 'flex:1;min-width:120px;' });
    const createBtn = html('button', { class: 'primary small' }, '创建检查点');
    createBtn.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      if (!name) return toast('请填写检查点名称', 'err');
      try {
        const data = await api('/api/admin/yards/current/checkpoints', {
          method: 'POST', body: JSON.stringify({ name })
        });
        const s = data.checkpoint.summary || {};
        toast(`检查点 #${data.checkpoint.id}「${data.checkpoint.name}」已创建：` +
          `开放进路 ${s.openInstances}、等待 ${s.waiting}、延时取消 ${s.pendingCancellations}、` +
          `封锁 ${s.unfinishedBlockades}、活动计划 ${s.activeMovementPlans}`, 'ok', 5600);
        await load(true);
      } catch (e) { toast(e.message, 'err', 6000); }
    });
    form.appendChild(nameIn);
    form.appendChild(createBtn);
    box.appendChild(form);
  }
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    paused
      ? '检查点保存当前副本的站场定义、区段/道岔状态、进路实例与锁闭和事件、等待申请、' +
        '延时取消、封锁、定时走行计划与设置；回退后副本保持暂停，未签收交接单过期、已签收保留。'
      : '仅已暂停的命名演练副本可创建/回退检查点；请先在顶栏"暂停演练"，运行中仅可查看。'));

  if (!list.length) {
    box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' }, '暂无检查点'));
    return box;
  }
  for (const cp of list) {
    const s = cp.summary || {};
    const card = html('div', { class: 'instance-card', style: 'margin-top:8px;' });
    const head = html('div', { class: 'row' });
    head.appendChild(html('b', {}, `#${cp.id} ${cp.name}`));
    head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
    head.appendChild(html('span', { class: 'badge green' }, '可用'));
    card.appendChild(head);
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
      `创建：${cp.createdBy || '管理员'} · ${cp.createdAtText || ''}`));
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:2px;' },
      `摘要：区段 ${s.sections ?? 0}／道岔 ${s.switches ?? 0}／进路定义 ${s.routes ?? 0}｜` +
      `开放进路 ${s.openInstances ?? 0}｜等待 ${s.waiting ?? 0}｜延时取消 ${s.pendingCancellations ?? 0}｜` +
      `封锁 ${s.unfinishedBlockades ?? 0}｜活动计划 ${s.activeMovementPlans ?? 0}`));
    if (paused) {
      const row = html('div', { class: 'row', style: 'margin-top:6px;' });
      const rb = html('button', { class: 'danger small' }, '回退到此检查点');
      rb.addEventListener('click', async () => {
        if (!confirm(`把当前副本整体回退到检查点 #${cp.id}「${cp.name}」？\n` +
          '回退后副本保持暂停：盘面与各类申请恢复到检查点时刻，未签收交接单过期（已签收保留），' +
          '检查点本身保留可再次使用。')) return;
        try {
          const data = await api(`/api/admin/yards/current/checkpoints/${cp.id}/rollback`,
            { method: 'POST' });
          toast(`已回退到检查点 #${cp.id}「${cp.name}」：` +
            `未签收交接单过期 ${data.handoversExpired} 张，副本保持暂停`, 'ok', 5600);
          await load(true);
        } catch (e) { toast(e.message, 'err', 6000); }
      });
      row.appendChild(rb);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
  return box;
}

/* ============================== 进路构建器 ============================== */

function refreshBuilderSteps() {
  if (typeof window.__refreshBuilderSteps === 'function') window.__refreshBuilderSteps();
}

function startRouteBuilder(existing) {
  tool = 'build-route';
  if (existing) {
    routeBuilder = {
      editId: existing.id,
      id: existing.id,
      label: existing.label,
      origin: existing.origin,
      destination: existing.destination,
      entrySignalId: existing.entry_signal_id || '',
      steps: existing.steps.map((s) => s.section_id),
      switches: existing.switchReqs.map((q) => ({ switchId: q.switch_id, position: q.req_position }))
    };
  } else {
    routeBuilder = {
      editId: null, id: '', label: '', origin: '', destination: '',
      entrySignalId: '', steps: [], switches: []
    };
  }
  drawFirst = null;
  renderYard();
  renderSide();
}

function renderRouteBuilder() {
  const rb = routeBuilder;
  const box = html('div', {
    style: 'border:1px solid #b9cdf5;background:#f3f7ff;border-radius:9px;padding:10px;margin-top:10px;'
  });
  box.appendChild(html('div', { class: 'section-title', style: 'margin-top:0;' },
    rb.editId ? `编辑进路 ${rb.editId}` : '新建进路'));

  const idIn = html('input', { type: 'text', value: rb.id || '', placeholder: '如 R4', style: 'width:100%;' });
  const labelIn = html('input', { type: 'text', value: rb.label, placeholder: '如 正线通过 X1→X3', style: 'width:100%;' });
  const originIn = html('input', { type: 'text', value: rb.origin, placeholder: '起点 如 X1', style: 'width:100%;' });
  const destIn = html('input', { type: 'text', value: rb.destination, placeholder: '终点 如 X3', style: 'width:100%;' });
  if (rb.editId) idIn.disabled = true;
  box.appendChild(fld('进路编号', idIn));
  box.appendChild(fld('名称', labelIn));
  box.appendChild(fld('起点', originIn));
  box.appendChild(fld('终点', destIn));

  const sigSel = html('select', { style: 'width:100%;' });
  sigSel.appendChild(html('option', { value: '' }, '（无入口信号机）'));
  for (const s of STATE.signals) {
    const o = html('option', { value: s.id }, `${s.id} ${s.label}`);
    if (s.id === rb.entrySignalId) o.selected = true;
    sigSel.appendChild(o);
  }
  box.appendChild(fld('入口信号机（开放时转绿，进入首段后回红）', sigSel));

  box.appendChild(html('div', { class: 'hint' },
    '路径（在图上按走行顺序点击区段，再点可从末尾移除）：'));
  const pathBox = html('div', { class: 'picked-list', id: 'rb-steps' });
  box.appendChild(pathBox);
  window.__refreshBuilderSteps = () => {
    if (!document.body.contains(pathBox) || routeBuilder !== rb) return;
    pathBox.innerHTML = '';
    if (rb.steps.length === 0) pathBox.textContent = '尚未选择区段';
    rb.steps.forEach((sid, i) => {
      pathBox.appendChild(html('span', { class: 'pick-chip' }, `${i + 1}. ${sid}`));
    });
  };
  window.__refreshBuilderSteps();

  // 道岔要求
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '道岔位置要求（仅需列入本进路涉及的道岔）：'));
  const swBox = html('div', { id: 'rb-switches' });
  box.appendChild(swBox);
  const renderSwitches = () => {
    swBox.innerHTML = '';
    for (const sw of STATE.switches) {
      const cur = rb.switches.find((x) => x.switchId === sw.id);
      const row = html('div', { class: 'row', style: 'padding:3px 0;' });
      const chk = html('input', { type: 'checkbox' });
      chk.checked = !!cur;
      const sel = html('select', {});
      ['N', 'R'].forEach((p) => {
        const o = html('option', { value: p }, p === 'N' ? 'N 定位/直股' : 'R 反位/弯股');
        if ((cur ? cur.position : 'N') === p) o.selected = true;
        sel.appendChild(o);
      });
      chk.addEventListener('change', () => {
        if (chk.checked) rb.switches.push({ switchId: sw.id, position: sel.value });
        else rb.switches = rb.switches.filter((x) => x.switchId !== sw.id);
      });
      sel.addEventListener('change', () => {
        const item = rb.switches.find((x) => x.switchId === sw.id);
        if (item) item.position = sel.value;
      });
      row.appendChild(chk);
      row.appendChild(html('b', { style: 'width:52px;' }, sw.id));
      row.appendChild(sel);
      swBox.appendChild(row);
    }
    if (!STATE.switches.length) swBox.appendChild(html('div', { class: 'hint' }, '（站场无道岔）'));
  };
  renderSwitches();

  // 每次 renderSide 会重建 builder 面板，需把输入即时同步回 rb
  idIn.addEventListener('input', () => { rb.id = idIn.value.trim(); });
  labelIn.addEventListener('input', () => { rb.label = labelIn.value.trim(); });
  originIn.addEventListener('input', () => { rb.origin = originIn.value.trim(); });
  destIn.addEventListener('input', () => { rb.destination = destIn.value.trim(); });
  sigSel.addEventListener('change', () => { rb.entrySignalId = sigSel.value; });


  const actions = html('div', { class: 'row', style: 'margin-top:10px;' });
  const save = html('button', { class: 'primary small' }, rb.editId ? '保存进路' : '创建进路');
  const cancel = html('button', { class: 'ghost small' }, '取消');
  const del = rb.editId ? html('button', { class: 'danger small' }, '删除') : null;
  save.addEventListener('click', async () => {
    const body = {
      id: rb.id || idIn.value.trim(),
      label: rb.label || labelIn.value.trim() || rb.id || idIn.value.trim(),
      origin: rb.origin || originIn.value.trim(),
      destination: rb.destination || destIn.value.trim(),
      entrySignalId: rb.entrySignalId || sigSel.value || null,
      steps: rb.steps,
      switchReqs: rb.switches
    };
    if (!body.id) return toast('请填写进路编号', 'err');
    if (!body.origin || !body.destination) return toast('请填写起点和终点', 'err');
    if (!body.steps.length) return toast('请在图上点击区段，至少选择一个途经区段', 'err');
    try {
      if (rb.editId) await api(`/api/admin/routes/${rb.editId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/admin/routes', { method: 'POST', body: JSON.stringify(body) });
      toast(rb.editId ? '进路已更新' : '进路已创建', 'ok');
      routeBuilder = null; tool = 'select';
      await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  cancel.addEventListener('click', () => { routeBuilder = null; tool = 'select'; renderYard(); renderSide(); });
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`确定删除进路 ${rb.editId}？`)) return;
    try {
      await api(`/api/admin/routes/${rb.editId}`, { method: 'DELETE' });
      toast('进路已删除', 'ok');
      routeBuilder = null; tool = 'select'; await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  actions.appendChild(save); actions.appendChild(cancel);
  if (del) actions.appendChild(del);
  box.appendChild(actions);

  return box;
}

/* ====================== 进路批量变更集（预览 → 发布） ====================== */

const CS_OP = { create: '创建', update: '修改', delete: '删除' };

/**
 * 打开批量变更集弹窗。entries 为本地编辑中的变更项：
 * {key, op, id, label, origin, destination, entrySignalId, stepsText, sw:{SW7:'N'}}
 */
function openChangesetModal() {
  if (changeset && changeset.entries && changeset.entries.length) {
    // 保留已编辑内容（一般不会并存多个弹窗）
  } else {
    changeset = { entries: [], preview: null };
  }

  const mask = html('div', { class: 'modal-mask' });
  const box = html('div', { class: 'modal', style: 'width:min(920px,94vw);max-height:92vh;display:flex;flex-direction:column;' });
  box.appendChild(html('h3', {}, '进路定义批量变更集（创建 / 修改 / 删除）'));
  box.appendChild(html('div', { class: 'hint', style: 'margin-bottom:8px;' },
    '一次提交多条进路变更：先点“预览”查看每条结果、受影响的等待申请与阻断原因，再携带当前站场修订标识“确认发布”。' +
    '任一项不合法或预览后定义/引用资源/等待申请变化，整批不落地，等待申请保持原状。'));

  const body = html('div', { style: 'overflow:auto;flex:1;padding-right:4px;' });
  box.appendChild(body);

  const quickRow = html('div', { class: 'row' });
  const qCreate = html('button', { class: 'ghost small' }, '＋ 新建进路');
  const qUpdate = html('button', { class: 'ghost small' }, '✎ 加入修改');
  const qDelete = html('button', { class: 'ghost small' }, '✕ 加入删除');
  qCreate.addEventListener('click', () => addCsEntry('create'));
  qUpdate.addEventListener('click', () => { const r = pickExistingRoute(); if (r) addCsEntry('update', r); });
  qDelete.addEventListener('click', () => { const r = pickExistingRoute(); if (r) addCsEntry('delete', r); });
  quickRow.appendChild(qCreate);
  quickRow.appendChild(qUpdate);
  quickRow.appendChild(qDelete);
  body.appendChild(quickRow);

  const listBox = html('div', { style: 'margin-top:8px;' });
  body.appendChild(listBox);

  const previewBox = html('div', { style: 'margin-top:10px;' });
  body.appendChild(previewBox);

  function pickExistingRoute() {
    const id = prompt('输入要加入变更集的现有进路编号（如 R1）：');
    if (id == null) return null;
    const r = STATE.routes.find((x) => x.id === id.trim());
    return r || (toast(`进路 ${id.trim()} 在当前站场不存在`, 'err'), null);
  }

  function entryFromRoute(op, r) {
    return {
      key: 'e' + Date.now() + Math.random().toString(36).slice(2, 7),
      op,
      id: r ? r.id : '',
      label: r ? r.label : '',
      origin: r ? r.origin : '',
      destination: r ? r.destination : '',
      entrySignalId: r ? (r.entry_signal_id || '') : '',
      stepsText: r ? r.steps.map((s) => s.section_id).join(',') : '',
      sw: r ? Object.fromEntries(r.switchReqs.map((q) => [q.switch_id, q.req_position])) : {}
    };
  }

  function addCsEntry(op, r) {
    if (op !== 'create' && !r) return;
    changeset.entries.push(entryFromRoute(op, r || null));
    invalidatePreview();
    renderEntries();
  }

  function invalidatePreview() {
    if (changeset.preview) {
      changeset.preview = null;
      renderPreview();
    }
  }

  function renderEntries() {
    listBox.innerHTML = '';
    if (!changeset.entries.length) {
      listBox.appendChild(html('div', { class: 'hint' },
        '尚无变更项。可用上方按钮新建进路，或把现有进路加入修改/删除。'));
      return;
    }
    changeset.entries.forEach((e, idx) => listBox.appendChild(renderCsEntry(e, idx)));
  }

  function renderCsEntry(e, idx) {
    const card = html('div', { class: 'instance-card' });
    const head = html('div', { class: 'row' });
    const opSel = html('select', { style: 'width:90px;' });
    [['create', '创建'], ['update', '修改'], ['delete', '删除']].forEach(([v, t]) => {
      const o = html('option', { value: v }, t);
      if (e.op === v) o.selected = true;
      opSel.appendChild(o);
    });
    opSel.addEventListener('change', () => {
      e.op = opSel.value;
      invalidatePreview();
      renderEntries();
    });
    head.appendChild(opSel);
    const idIn = html('input', { type: 'text', value: e.id, placeholder: '进路编号，如 R4',
      style: 'width:110px;' + (e.op === 'delete' ? 'background:#f4f4f4;' : '') });
    if (e.op === 'delete') idIn.disabled = true;
    idIn.addEventListener('input', () => { e.id = idIn.value.trim(); invalidatePreview(); });
    head.appendChild(html('b', {}, '#'));
    head.appendChild(idIn);
    head.appendChild(html('span', { style: 'flex:1;' }));
    const rm = html('button', { class: 'danger small' }, '移出');
    rm.addEventListener('click', () => {
      changeset.entries.splice(idx, 1);
      invalidatePreview();
      renderEntries();
    });
    head.appendChild(rm);
    card.appendChild(head);

    if (e.op === 'delete') {
      const r = STATE.routes.find((x) => x.id === e.id);
      card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
        r ? `将删除：${r.origin} → ${r.destination}｜区段 ${r.steps.map((s) => s.section_id).join(',')}`
          : '该进路当前不存在（发布将被拒绝）。'));
      return card;
    }

    const grid = html('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px;' });
    const mk = (labelText, val, oninput) => {
      const w = html('div', {}, html('label', { class: 'hint' }, labelText),
        html('input', { type: 'text', value: val, style: 'width:100%;box-sizing:border-box;' }));
      w.lastChild.addEventListener('input', () => { oninput(w.lastChild.value); invalidatePreview(); });
      return w;
    };
    grid.appendChild(mk('名称（可空）', e.label, (v) => { e.label = v; }));
    grid.appendChild(mk('起点', e.origin, (v) => { e.origin = v; }));
    grid.appendChild(mk('终点', e.destination, (v) => { e.destination = v; }));
    const sigSel = html('select', { style: 'width:100%;box-sizing:border-box;' });
    sigSel.appendChild(html('option', { value: '' }, '（无入口信号机）'));
    for (const s of STATE.signals) {
      const o = html('option', { value: s.id }, `${s.id} ${s.label}`);
      if (s.id === e.entrySignalId) o.selected = true;
      sigSel.appendChild(o);
    }
    sigSel.addEventListener('change', () => { e.entrySignalId = sigSel.value; invalidatePreview(); });
    grid.appendChild(html('div', {}, html('label', { class: 'hint' }, '入口信号机'), sigSel));
    card.appendChild(grid);

    const stepsIn = html('input', { type: 'text', value: e.stepsText,
      placeholder: '区段顺序，逗号分隔，如 1,3,5（不得重复）', style: 'width:100%;box-sizing:border-box;margin-top:6px;' });
    stepsIn.addEventListener('input', () => { e.stepsText = stepsIn.value; invalidatePreview(); });
    card.appendChild(html('div', {}, html('label', { class: 'hint' }, '经过区段（按走行顺序）'), stepsIn));

    if (STATE.switches.length) {
      const swRow = html('div', { class: 'row', style: 'margin-top:4px;flex-wrap:wrap;' });
      for (const sw of STATE.switches) {
        const chk = html('input', { type: 'checkbox' });
        chk.checked = Object.prototype.hasOwnProperty.call(e.sw, sw.id);
        const sel = html('select', {});
        ['N', 'R'].forEach((p) => {
          const o = html('option', { value: p }, p);
          if ((e.sw[sw.id] || 'N') === p) o.selected = true;
          sel.appendChild(o);
        });
        chk.addEventListener('change', () => {
          if (chk.checked) e.sw[sw.id] = sel.value;
          else delete e.sw[sw.id];
          invalidatePreview();
        });
        sel.addEventListener('change', () => {
          if (chk.checked) { e.sw[sw.id] = sel.value; invalidatePreview(); }
        });
        swRow.appendChild(chk);
        swRow.appendChild(html('b', { style: 'margin-right:4px;' }, sw.id));
        swRow.appendChild(sel);
      }
      card.appendChild(swRow);
    }
    return card;
  }

  function buildPayload() {
    return changeset.entries.map((e) => {
      if (e.op === 'delete') return { op: 'delete', id: e.id };
      return {
        op: e.op,
        id: e.id,
        label: e.label.trim() || e.id,
        origin: e.origin.trim(),
        destination: e.destination.trim(),
        entrySignalId: e.entrySignalId || null,
        steps: e.stepsText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
        switchReqs: Object.entries(e.sw).map(([switchId, position]) => ({ switchId, position }))
      };
    });
  }

  function renderPreview() {
    previewBox.innerHTML = '';
    const p = changeset.preview;
    if (!p) {
      previewBox.appendChild(html('div', { class: 'hint' },
        '编辑好变更项后点“预览”：服务端只读校验整批并返回当前站场修订标识，不会改动任何数据。'));
      return;
    }

    // 修订标识
    const revRow = html('div', { class: 'row', style: 'align-items:center;' });
    revRow.appendChild(html('span', { class: 'hint' }, '当前站场修订标识：'));
    revRow.appendChild(html('code', {
      style: 'background:#eef;padding:2px 6px;border-radius:4px;font-size:12px;user-select:all;'
    }, p.revision));
    previewBox.appendChild(revRow);
    previewBox.appendChild(html('div', { class: 'hint' },
      '修订标识为站场定义/引用资源/等待申请的内容哈希；本次预览的一次性发布令牌已由页面保存，' +
      '点“确认发布”时自动携带（发布成功或站场变化后须重新预览）。'));

    if (p.valid) {
      previewBox.appendChild(html('div', { class: 'badge green', style: 'display:inline-block;margin:6px 0;' },
        '整批校验通过，可发布'));
    } else {
      previewBox.appendChild(html('div', { class: 'badge red', style: 'display:inline-block;margin:6px 0;' },
        '整批当前不可发布（任一项不合法发布时整批不落地）'));
    }

    // 逐条结果
    const resTitle = html('div', { class: 'section-title', style: 'font-size:13px;margin:6px 0;' },
      `逐条结果（创建 ${p.summary.create} / 修改 ${p.summary.update} / 删除 ${p.summary.delete}）`);
    previewBox.appendChild(resTitle);
    const resList = html('div', {});
    for (const r of p.results) {
      const line = html('div', { class: 'hint', style: 'margin:2px 0;' });
      line.appendChild(html('b', { class: `badge ${r.valid ? 'green' : 'red'}` },
        `第${r.index + 1}项 ${CS_OP[r.op] || r.op} ${r.routeId}`));
      if (r.valid) {
        const extras = [];
        if (r.affectedWaiting && r.affectedWaiting.length) {
          extras.push(`将使等待申请 #${r.affectedWaiting.join('、#')} 失效`);
        }
        if (r.releasedInstancesToDelete) extras.push(`删除 ${r.releasedInstancesToDelete} 条已解除历史实例`);
        if (extras.length) line.appendChild(document.createTextNode('　' + extras.join('；')));
      } else {
        line.appendChild(html('div', { style: 'color:#b00020;margin-top:2px;' },
          r.errors.map((m) => '✗ ' + m).join('　')));
      }
      resList.appendChild(line);
    }
    previewBox.appendChild(resList);

    // 整批阻断原因
    if (p.blockReasons.length) {
      previewBox.appendChild(html('div', { class: 'section-title',
        style: 'font-size:13px;margin:8px 0 4px;' }, '阻断原因'));
      const ul = html('ul', { class: 'reasons', style: 'margin:0;' });
      for (const reason of p.blockReasons) ul.appendChild(html('li', { style: 'color:#b00020;' }, reason));
      previewBox.appendChild(ul);
    }

    // 受影响等待申请（含当前阻断原因）
    if (p.affectedWaiting.length) {
      previewBox.appendChild(html('div', { class: 'section-title',
        style: 'font-size:13px;margin:8px 0 4px;' },
        `受影响的等待申请（${p.affectedWaiting.length} 条，发布后失效）`));
      const wl = html('div', {});
      for (const w of p.affectedWaiting) {
        const row = html('div', { class: 'hint', style: 'margin:2px 0;' });
        row.appendChild(html('b', {}, `#${w.id} `));
        row.appendChild(document.createTextNode(
          `进路 ${w.routeId}｜申请人 ${w.applicant}｜道岔 ${Object.entries(w.switchPositions).map(([k, v]) => `${k}=${v}`).join(',') || '无'}`));
        if (w.currentBlockReasons.length) {
          row.appendChild(html('div', { class: 'muted', style: 'padding-left:10px;' },
            '当前阻断：' + w.currentBlockReasons.join('；')));
        }
        wl.appendChild(row);
      }
      previewBox.appendChild(wl);
    }
  }

  const actions = html('div', { class: 'actions' });
  const previewBtn = html('button', { class: 'ghost' }, '预览');
  const publishBtn = html('button', { class: 'primary' }, '确认发布');
  const closeBtn = html('button', { class: 'ghost' }, '关闭');
  publishBtn.disabled = true;
  previewBtn.addEventListener('click', async () => {
    const changes = buildPayload();
    if (!changes.length) return toast('变更集为空，请先添加变更项', 'err');
    previewBtn.disabled = true;
    try {
      const data = await api('/api/admin/route-changeset/preview', {
        method: 'POST', body: JSON.stringify({ changes })
      });
      changeset.preview = data.preview;
      renderPreview();
      publishBtn.disabled = !data.preview.valid;
      if (!data.preview.valid) toast('预览完成：当前存在阻断项，已列出原因', 'info', 5000);
      else toast('预览完成：整批校验通过，可确认发布', 'ok', 4000);
    } catch (e) { toast(e.message, 'err', 6000); } finally { previewBtn.disabled = false; }
  });
  publishBtn.addEventListener('click', async () => {
    const p = changeset.preview;
    if (!p) return toast('请先预览', 'err');
    if (!confirm('确认发布整批进路变更？\n' +
      '发布在同一事务内重新校验：预览后定义/引用资源/等待申请变化、存在开放进路或副本已暂停都会拒绝；' +
      '任一项不合法整批不落地，等待申请保持原状。')) return;
    publishBtn.disabled = true;
    try {
      const data = await api('/api/admin/route-changeset/publish', {
        method: 'POST', body: JSON.stringify({ previewId: p.previewId })
      });
      const s = data.summary;
      toast(`已发布：创建 ${s.create}、修改 ${s.update}、删除 ${s.delete} 条进路；` +
        `失效等待申请 ${data.invalidatedWaiting.length} 条，发布后兑现 #${(data.waitingFulfilledAfter || []).join('、#') || '无'}`,
      'ok', 6000);
      mask.remove();
      changeset = null;
      await load(true);
    } catch (e) {
      publishBtn.disabled = false;
      const d = e.data;
      if (d && d.code === 'REVISION_CHANGED') {
        changeset.preview = null;
        renderPreview();
        publishBtn.disabled = true;
        const cats = (d.changes || []).map((c) => c.label + '：' + c.details.join('；')).join('\n');
        toast(`${d.message}\n${cats}`, 'err', 9000);
      } else {
        toast(e.message, 'err', 8000);
      }
    }
  });
  closeBtn.addEventListener('click', () => { mask.remove(); changeset = null; });
  actions.appendChild(previewBtn);
  actions.appendChild(publishBtn);
  actions.appendChild(closeBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);

  renderEntries();
  renderPreview();
}

boot();
