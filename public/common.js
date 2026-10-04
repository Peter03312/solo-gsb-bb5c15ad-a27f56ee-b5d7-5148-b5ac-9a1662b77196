'use strict';

// 通用前端工具：API 调用、令牌、Toast、SVG 构造、当前站场（原站场/演练副本）
const App = (() => {
  function token() { return localStorage.getItem('token'); }
  function setSession(data) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('role', data.role);
    localStorage.setItem('name', data.name);
    // 登录响应附带的当前站场（新登录默认原站场）
    if (data.yardId != null) {
      localStorage.setItem('yardId', String(data.yardId));
      localStorage.setItem('yardName', data.yardName || '原站场');
    }
  }
  function clearSession() {
    ['token', 'role', 'name'].forEach((k) => localStorage.removeItem(k));
  }
  function role() { return localStorage.getItem('role'); }
  function name() { return localStorage.getItem('name'); }

  // 当前站场（按会话在服务端保存；本地仅缓存名称用于即时显示）
  function yardId() {
    const v = Number(localStorage.getItem('yardId'));
    return Number.isInteger(v) && v > 0 ? v : 1;
  }
  function yardName() { return localStorage.getItem('yardName') || '原站场'; }
  function setYard(id, name) {
    localStorage.setItem('yardId', String(id));
    localStorage.setItem('yardName', name || '原站场');
  }
  /** 切换当前会话站场；成功后刷新页面以重新加载该站场全部数据 */
  async function chooseYard(id) {
    await api('/api/auth/yard', { method: 'PUT', body: JSON.stringify({ yardId: id }) });
    location.reload();
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const resp = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (resp.status === 401) {
      clearSession();
      if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = '/index.html';
      }
      throw new Error(data.error || '未登录');
    }
    if (!resp.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败 (${resp.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') node.setAttribute('class', v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function html(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function toast(msg, kind = 'info', ms = 4200) {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = html('div', { class: 'toast-host' });
      document.body.appendChild(host);
    }
    const t = html('div', { class: `toast ${kind}` }, msg);
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, ms - 400);
    setTimeout(() => t.remove(), ms);
  }

  const OCC_TEXT = { free: '空闲', occupied: '占用', unknown: '未知(按占用)' };
  const SIG_TEXT = { green: '绿灯(允许)', red: '红灯(停车)' };
  const POS_TEXT = { N: 'N 定位/直股', R: 'R 反位/弯股' };

  /**
   * 用 /api/state 或 /api/admin/state 返回的 yard 同步本地缓存的当前站场名。
   * 由两个工作台每次加载状态后调用。
   */
  function syncYard(yard) {
    if (yard && yard.id != null) setYard(yard.id, yard.name);
  }

  /**
   * 渲染顶栏"当前站场"选择条（挂到 #yardBar 容器）。
   * 每个登录会话都可选择当前站场；未选择时使用原站场。
   * 管理员另显示"＋ 创建演练副本"。
   */
  async function renderYardBar(activeContainer) {
    const host = document.getElementById('yardBar');
    if (!host) return;
    host.innerHTML = '';
    let yards = [];
    try {
      const data = await api('/api/auth/yards');
      yards = data.yards || [];
    } catch (e) { return; } // 401 等由全局逻辑跳转登录

    const label = html('span', { class: 'yard-label' }, '当前站场：');
    host.appendChild(label);
    const sel = html('select', { class: 'yard-select', title: '选择当前站场（原站场或命名演练副本）' });
    for (const y of yards) {
      const text = y.isOriginal ? '① 原站场' : `${y.paused ? '⏸' : '🧪'} ${y.name}`;
      const o = html('option', { value: String(y.id) }, text);
      if (y.id === yardId()) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const id = Number(sel.value);
      if (id !== yardId()) chooseYard(id).catch((e) => toast(e.message, 'err'));
    });
    host.appendChild(sel);

    const cur = yards.find((y) => y.id === yardId());
    if (cur && !cur.isOriginal) {
      host.appendChild(html('span', {
        class: `yard-badge ${cur.paused ? 'paused' : ''}`,
        title: cur.paused
          ? `暂停人：${cur.pausedBy || '未知'}；暂停时间：${formatTime(cur.pausedAt)}`
          : '命名演练副本'
      }, cur.paused ? '已暂停' : '演练副本'));
      if (role() === 'admin') {
        const btn = html('button', { class: 'ghost small', style: 'margin-left:6px;' },
          cur.paused ? '恢复演练' : '暂停演练');
        btn.addEventListener('click', () => togglePause(cur, btn));
        host.appendChild(btn);
      }
      if (cur.paused) {
        host.appendChild(html('span', { class: 'pause-info' },
          `暂停：${cur.pausedBy || '未知'} · ${formatTime(cur.pausedAt)}`));
      }
    }

    if (role() === 'admin') {
      const createBtn = html('button', { class: 'ghost small', style: 'margin-left:10px;' }, '＋ 从原站场创建演练副本');
      createBtn.addEventListener('click', () => openCreateYardModal());
      host.appendChild(createBtn);
    }
    host.appendChild(html('span', { class: 'muted', style: 'margin-left:10px;font-size:12px;' },
      '所有操作（编辑/排路/走行/等待/取消/封锁/交接/重置）仅作用于当前站场'));
  }

  /** 管理员创建命名演练副本弹窗 */
  function openCreateYardModal() {
    const nameIn = html('input', { type: 'text', maxlength: '30',
      placeholder: '副本名称，如 国庆演练A组（同名拒绝）', style: 'width:100%;' });
    const content = html('div', {});
    content.appendChild(html('div', { class: 'hint', style: 'margin-bottom:8px;' },
      '将在同一事务内复制原站场的站场定义、区段与道岔状态、开放进路的锁与事件进度、' +
      '未兑现等待申请、未完结延时取消（沿用原到期时刻）及未结束临时封锁；' +
      '历史交接单留在原站场。'));
    const f = html('div', { class: 'fld' });
    f.appendChild(html('label', {}, '副本名称'));
    f.appendChild(nameIn);
    content.appendChild(f);

    const mask = html('div', { class: 'modal-mask' });
    const box = html('div', { class: 'modal' });
    box.appendChild(html('h3', {}, '创建命名演练副本'));
    box.appendChild(content);
    const actions = html('div', { class: 'actions' });
    const cancel = html('button', { class: 'ghost' }, '取消');
    const ok = html('button', { class: 'primary' }, '创建副本');
    function close() { mask.remove(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    ok.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      if (!name) return toast('请填写副本名称', 'err');
      ok.disabled = true;
      try {
        const data = await api('/api/admin/yards', {
          method: 'POST', body: JSON.stringify({ name })
        });
        const c = data.detail.copied;
        toast(`副本 #${data.yard.id}「${data.yard.name}」已创建：` +
          `开放进路 ${c.openInstances}、等待 ${c.waiting}、延时取消 ${c.pendingCancellations}、` +
          `封锁 ${c.unfinishedBlockades}；是否立即切换到该副本？`, 'ok', 6000);
        close();
        if (confirm(`副本「${data.yard.name}」已创建。是否立即切换到该副本？`)) {
          await chooseYard(data.yard.id);
        } else {
          renderYardBar();
        }
      } catch (e) {
        ok.disabled = false;
        toast(e.message, 'err', 6000);
      }
    });
    actions.appendChild(cancel); actions.appendChild(ok);
    box.appendChild(actions);
    mask.appendChild(box);
    document.body.appendChild(mask);
    setTimeout(() => nameIn.focus(), 0);
  }

  function formatTime(ms) {
    if (!ms) return '—';
    return new Date(Number(ms)).toLocaleString();
  }

  async function togglePause(yard, btn) {
    const action = yard.paused ? 'resume' : 'pause';
    const label = yard.paused ? '恢复' : '暂停';
    if (!confirm(`确认${label}命名演练副本「${yard.name}」？`)) return;
    btn.disabled = true;
    try {
      const data = await api(`/api/admin/yards/current/${action}`, { method: 'POST' });
      if (data.alreadyPaused) toast('该副本已处于暂停状态', 'info');
      else if (data.alreadyResumed) toast('该副本已处于运行状态', 'info');
      else toast(`副本「${yard.name}」已${label}`, 'ok');
      location.reload();
    } catch (e) {
      btn.disabled = false;
      toast(e.message, 'err', 6000);
    }
  }

  return {
    api, el, html, toast, token, setSession, clearSession, role, name,
    yardId, yardName, setYard, chooseYard, syncYard, renderYardBar, formatTime,
    OCC_TEXT, SIG_TEXT, POS_TEXT
  };
})();
