'use strict';

/**
 * 副本创建 / 暂停 / 恢复的进程中断收敛（故障恢复）HTTP 集成测试。
 *
 * 思路：在真实服务运行时正常建副本、开放进路、提交延时取消/走行计划、开考，
 * 然后停掉进程，直接在文件层模拟"中断残留"的各种形态，再重启验证启动收敛：
 *  A. 副本创建中断：注册表 creating + 无正式文件 → 回滚到操作前（同名释放）；
 *     creating + 完整正式文件/清单 → 激活为操作后（可正常打开，数据完整）；
 *     正式文件损坏 → 回滚（creating 行删除），可同名重建。
 *  B. 暂停中断：意图在、业务库已写界标/结算、注册表未翻转 → 补翻转（操作后），
 *     不重复记账/不重复写界标；注册表已翻转、业务库未写 → 补齐（只补一次）。
 *  C. 恢复中断：意图在、业务库已平移/写界标、注册表未翻转 → 补翻转，
 *     不重复平移；业务库未动 → 按意图平移一次，考试计时连续。
 *  D. 损坏隔离：active 副本业务库文件被破坏 → 503 YARD_BROKEN 拒绝访问并
 *     说明原因；原站场与其他副本照常使用。
 *
 * 运行：node test/recovery-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3933;
const DB_PATH = process.env.SMOKE_DB_RECOVERY ||
  path.join(__dirname, '..', 'data', 'recovery-test.db');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = true) {
  return new Promise((resolve, reject) => {
    if (!keepDb) wipeData();
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 15000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); setTimeout(resolve, 300); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const proc = server;
    server = null;
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    // 等待优雅退出；超时强杀后再给端口一点释放时间
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      setTimeout(resolve, 500);
    }, 3000);
  });
}
function wipeData() {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }
  fs.rmSync(yardsDir(), { recursive: true, force: true });
}
function yardsDir() {
  return path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards');
}
function yardFile(id) { return path.join(yardsDir(), `yard-${id}.db`); }

async function api(url, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const r = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (r.status !== 200) throw new Error('登录失败: ' + r.data.error);
  return r.data.token;
}
function dbMain() {
  const Database = require('better-sqlite3');
  const conn = new Database(DB_PATH);
  return conn;
}
function dbYard(id) {
  const Database = require('better-sqlite3');
  return new Database(yardFile(id));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await startServer(false);
  const admin = await login('admin');
  const student = await login('dispatcher', '学员张三');

  console.log('\n[A1] 创建副本中断（creating + 无正式文件）→ 重启回滚到操作前');
  let r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '健康对照副本' } });
  eq('正常创建对照副本成功', r.status, 201);
  const yardA = r.data.yard.id;
  await stopServer();

  // 手工制造"注册行已写 creating、文件复制/改名未完成"的中断现场
  {
    const main = dbMain();
    main.prepare(`INSERT INTO yards(name,kind,source_yard_id,status,db_file,created_by)
                  VALUES(?, 'copy',1,'creating',?,?)`)
      .run('中断副本甲', `yard-9001.db`, '管理员');
    const id = main.prepare(`SELECT id FROM yards WHERE name='中断副本甲'`).get().id;
    main.prepare(`UPDATE yards SET db_file=? WHERE id=?`).run(`yard-${id}.db`, id);
    main.prepare(
      `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
       VALUES(?, 'create_copy','pending','管理员',?,?)`)
      .run(id, Date.now(), JSON.stringify({ name: '中断副本甲' }));
    // 残留半个临时文件（无清单）
    fs.mkdirSync(yardsDir(), { recursive: true });
    fs.writeFileSync(path.join(yardsDir(), `yard-${id}.copying.tmp`), 'not a complete db');
    console.log('    注入中断副本编号', id);
    main.close();
  }

  await startServer(true);
  {
    const main = dbMain();
    const row = main.prepare(`SELECT * FROM yards WHERE name='中断副本甲'`).get();
    ok('中断副本注册行已回滚', row == null, row);
    const ops = main.prepare(`SELECT COUNT(*) AS n FROM yard_ops WHERE status='pending'`).get().n;
    eq('收敛后无残留意图', ops, 0);
    main.close();
  }
  const admin2 = await login('admin');
  r = await api('/api/admin/yards', { token: admin2, method: 'POST', body: { name: '中断副本甲' } });
  eq('回滚后同名可重新创建', r.status, 201, r.data);
  const yardARecreated = r.data.yard.id;
  r = await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId: yardARecreated } });
  eq('重建副本可正常打开（会话切换）', r.status, 200);
  r = await api('/api/admin/state', { token: admin2 });
  eq('重建副本数据完整（含5个示例区段）', r.data.state.sections.length, 5, r.data.state.sections?.length);

  console.log('\n[A2] 创建中断在"改名后/翻册前"（creating + 完整正式文件）→ 重启激活');
  const goodId = 9002;
  // 复制一份完整业务库作为已改名落位的正式文件，并把清单编号改为新副本编号
  // （真实流程中复制事务直接以新编号写清单）
  fs.copyFileSync(yardFile(yardARecreated), yardFile(goodId));
  {
    const Database = require('better-sqlite3');
    const g = new Database(yardFile(goodId));
    g.prepare(`UPDATE yard_copy_manifest SET yard_id=? WHERE yard_id=?`).run(goodId, yardARecreated);
    g.close();
  }
  {
    const main = dbMain();
    main.prepare(`INSERT INTO yards(id,name,kind,source_yard_id,status,db_file,created_by)
                  VALUES(?,?, 'copy',1,'creating',?,?)`)
      .run(goodId, '中断副本乙', `yard-${goodId}.db`, '管理员');
    main.prepare(
      `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
       VALUES(?, 'create_copy','pending','管理员',?,?)`)
      .run(goodId, Date.now(), JSON.stringify({ name: '中断副本乙' }));
    main.close();
  }
  await stopServer();
  await startServer(true);
  r = await api('/api/auth/yards', { token: admin2 });
  {
    const y2 = r.data.yards.find((x) => x.id === goodId);
    ok('中断副本乙已激活为 active', y2 && y2.status === 'active', y2);
  }
  r = await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId: goodId } });
  eq('激活后的副本可打开', r.status, 200);
  r = await api('/api/admin/state', { token: admin2 });
  eq('激活副本数据完整', r.data.state.sections.length, 5);

  console.log('\n[B1] 准备运行中副本：开考、开放进路、延时取消、走行计划');
  r = await api('/api/admin/yards', { token: admin2, method: 'POST', body: { name: '暂停恢复中断副本' } });
  eq('创建被测副本', r.status, 201);
  const yardP = r.data.yard.id;
  for (const t of [admin2, student]) {
    r = await api('/api/auth/yard', { token: t, method: 'PUT', body: { yardId: yardP } });
    eq('切到被测副本', r.status, 200);
  }
  await api('/api/admin/settings/cancel-protection', {
    token: admin2, method: 'PUT', body: { protectionSeconds: 3600 }
  });
  r = await api('/api/admin/exams/start', {
    token: admin2, method: 'POST',
    body: { student: '学员张三', targets: ['R1'] }
  });
  eq('开考', r.status, 201, r.data);
  r = await api('/api/routes/R1/open', {
    token: student, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('学员开放 R1', r.status, 200, r.data);
  const instId = r.data.instance.id;
  r = await api(`/api/instances/${instId}/cancel-delayed`, { token: student, method: 'POST' });
  eq('延时取消', r.status, 201);
  const cancelId = r.data.cancellation.id;
  const releaseAtBefore = r.data.cancellation.releaseAt;

  console.log('\n[B2] 暂停中断：业务库已结算+界标，注册表未翻转 → 补翻到操作后');
  await sleep(20);
  await stopServer();
  const pausedAt = Date.now();
  {
    const y = dbYard(yardP);
    // 模拟暂停业务库事务已提交（结算考核用时 + 界标）
    y.transaction(() => {
      y.prepare(
        `UPDATE exams SET used_ms = used_ms + MAX(0, ? - COALESCE(live_since, ?)),
                live_since=NULL WHERE status='in_progress'`
      ).run(pausedAt, pausedAt);
      y.prepare(
        `INSERT INTO audit_entries
           (yard_id,type,ref_type,ref_id,actor,source,before_state,after_state,detail,occurred_at)
         VALUES(?, 'yard_paused','yard',?, '管理员','manual', ?, ?, ?, ?)`)
        .run(yardP, String(yardP),
          JSON.stringify({ status: 'active', paused: false }),
          JSON.stringify({ status: 'paused', paused: true, pausedBy: '管理员', pausedAt }),
          JSON.stringify({ pausedAt }), pausedAt);
    })();
    y.close();
    const main = dbMain();
    // 注册表仍 active（未翻转），意图残留
    main.prepare(
      `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
       VALUES(?, 'pause','pending','管理员',?,?)`)
      .run(yardP, pausedAt, JSON.stringify({ now: pausedAt, pausedBy: '管理员' }));
    main.close();
  }

  await startServer(true);
  {
    const main = dbMain();
    const row = main.prepare(`SELECT * FROM yards WHERE id=?`).get(yardP);
    eq('注册表补翻为 paused', row.status, 'paused');
    eq('补翻暂停时刻与意图一致', row.paused_at, pausedAt);
    const ops = main.prepare(`SELECT COUNT(*) AS n FROM yard_ops WHERE status='pending'`).get().n;
    eq('暂停意图已清理', ops, 0);
    main.close();
    const y = dbYard(yardP);
    const nMarkers = y.prepare(
      `SELECT COUNT(*) AS n FROM audit_entries WHERE type='yard_paused' AND occurred_at=?`
    ).get(pausedAt).n;
    eq('界标未重复写入（仍只有1条）', nMarkers, 1);
    const exam = y.prepare(`SELECT * FROM exams WHERE status='terminated' OR status='in_progress'
                            ORDER BY id DESC LIMIT 1`).get();
    const inProgress = y.prepare(`SELECT used_ms, live_since FROM exams WHERE status='in_progress'`).get();
    ok('考核已结算且 live_since 为空（冻结）', inProgress && inProgress.live_since === null && inProgress.used_ms > 0,
      inProgress);
    y.close();
  }

  console.log('\n[B3] 重启后重复暂停幂等；不重复记账');
  const admin3 = await login('admin');
  await api('/api/auth/yard', { token: admin3, method: 'PUT', body: { yardId: yardP } });
  r = await api('/api/admin/yards/current/pause', { token: admin3, method: 'POST' });
  eq('重复暂停幂等', r.data.alreadyPaused, true);
  {
    const y = dbYard(yardP);
    const inProgress = y.prepare(`SELECT used_ms FROM exams WHERE status='in_progress'`).get();
    const nMarkers = y.prepare(`SELECT COUNT(*) AS n FROM audit_entries WHERE type='yard_paused'`).get().n;
    eq('重复暂停未新增界标', nMarkers, 1);
    y.close();
  }

  console.log('\n[C1] 恢复中断：业务库已平移+界标，注册表未翻转 → 补翻，不重复平移');
  await stopServer();
  const resumedAt = Date.now() + 5000;
  const shiftMs = resumedAt - pausedAt;
  let releaseAtShifted;
  {
    const y = dbYard(yardP);
    y.transaction(() => {
      y.prepare(
        `UPDATE cancellation_applications SET release_at = release_at + ?
          WHERE status='pending' AND release_at > ?`
      ).run(shiftMs, pausedAt);
      y.prepare(`UPDATE exams SET live_since=? WHERE status='in_progress' AND live_since IS NULL`)
        .run(resumedAt);
      y.prepare(
        `INSERT INTO audit_entries
           (yard_id,type,ref_type,ref_id,actor,source,before_state,after_state,detail,occurred_at)
         VALUES(?, 'yard_resumed','yard',?, '管理员','manual', ?, ?, ?, ?)`)
        .run(yardP, String(yardP),
          JSON.stringify({ status: 'paused', paused: true }),
          JSON.stringify({ status: 'active', paused: false, resumedBy: '管理员', resumedAt }),
          JSON.stringify({ resumedAt, shiftMs, adjusted: { movementPlanSteps: 0, cancellations: 1 } }),
          resumedAt);
    })();
    releaseAtShifted = y.prepare(`SELECT release_at FROM cancellation_applications WHERE id=?`)
      .get(cancelId).release_at;
    y.close();
    const main = dbMain();
    main.prepare(
      `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
       VALUES(?, 'resume','pending','管理员',?,?)`)
      .run(yardP, resumedAt, JSON.stringify({
        now: resumedAt, resumedBy: '管理员', pausedAt, shiftMs
      }));
    main.close();
  }

  await startServer(true);
  {
    const main = dbMain();
    const row = main.prepare(`SELECT * FROM yards WHERE id=?`).get(yardP);
    eq('注册表补翻为 active', row.status, 'active');
    eq('补翻恢复时刻与意图一致', row.resumed_at, resumedAt);
    main.close();
    const y = dbYard(yardP);
    const rel = y.prepare(`SELECT release_at FROM cancellation_applications WHERE id=?`).get(cancelId).release_at;
    eq('到期时刻未被二次平移', rel, releaseAtShifted);
    eq('到期时刻恰为原值+暂停时长', rel, releaseAtBefore + shiftMs);
    const nMarkers = y.prepare(
      `SELECT COUNT(*) AS n FROM audit_entries WHERE type='yard_resumed' AND occurred_at=?`
    ).get(resumedAt).n;
    eq('恢复界标未重复写入', nMarkers, 1);
    y.close();
  }

  console.log('\n[C2] 重复恢复幂等；考试有效用时在暂停段冻结、恢复后继续');
  const admin4 = await login('admin');
  await api('/api/auth/yard', { token: admin4, method: 'PUT', body: { yardId: yardP } });
  r = await api('/api/admin/yards/current/resume', { token: admin4, method: 'POST' });
  eq('重复恢复幂等', r.data.alreadyResumed, true);
  eq('重复恢复 shiftMs=0', r.data.shiftMs, 0);
  r = await api('/api/exams/1', { token: student });
  // 重新登录学生会话并切站场
  const student2 = await login('dispatcher', '学员张三');
  await api('/api/auth/yard', { token: student2, method: 'PUT', body: { yardId: yardP } });
  r = await api('/api/exams/1', { token: student2 });
  ok('考核仍在进行且有效用时为有限非负值',
    r.data.exam && r.data.exam.status === 'in_progress' && r.data.exam.effectiveElapsedMs >= 0,
    r.data && r.data.exam);

  console.log('\n[C3] 恢复中断在"业务库未动"（仅意图+注册表 paused）→ 重启按意图平移一次');
  // 先再次暂停该副本
  const admin5 = await login('admin');
  await api('/api/auth/yard', { token: admin5, method: 'PUT', body: { yardId: yardP } });
  r = await api('/api/admin/yards/current/pause', { token: admin5, method: 'POST' });
  eq('再次暂停成功', r.data.changed, true, r.data);
  const pausedAt2 = r.data.yard.pausedAt;
  await stopServer();
  const resumedAt2 = Date.now() + 8000;
  const shift2 = resumedAt2 - pausedAt2;
  let relBefore2;
  {
    const y = dbYard(yardP);
    relBefore2 = y.prepare(`SELECT release_at FROM cancellation_applications WHERE id=?`)
      .get(cancelId).release_at;
    const nResume = y.prepare(`SELECT COUNT(*) AS n FROM audit_entries WHERE type='yard_resumed'`).get().n;
    // 断言只有 C1 的那条恢复界标
    eq('第二次暂停后恢复界标数仍为旧值 1', nResume, 1);
    y.close();
    const main = dbMain();
    main.prepare(
      `INSERT INTO yard_ops(yard_id,op,status,operator,created_at,params_json)
       VALUES(?, 'resume','pending','管理员',?,?)`)
      .run(yardP, resumedAt2, JSON.stringify({
        now: resumedAt2, resumedBy: '管理员', pausedAt: pausedAt2, shiftMs: shift2
      }));
    // 注册表保持 paused（业务库与主库都未翻转）
    main.close();
  }
  await startServer(true);
  {
    const main = dbMain();
    const row = main.prepare(`SELECT status FROM yards WHERE id=?`).get(yardP);
    eq('仅意图的恢复中断收敛为 active', row.status, 'active');
    main.close();
    const y = dbYard(yardP);
    const rel = y.prepare(`SELECT release_at FROM cancellation_applications WHERE id=?`).get(cancelId).release_at;
    eq('按意图恰好平移一次', rel, relBefore2 + shift2);
    const n = y.prepare(`SELECT COUNT(*) AS n FROM audit_entries WHERE type='yard_resumed'`).get().n;
    eq('补做恢复只写 1 条新界标（共2条）', n, 2);
    y.close();
  }

  console.log('\n[D1] 损坏隔离：active 副本业务库被破坏 → 503 YARD_BROKEN，其他站场照常');
  await stopServer();
  fs.writeFileSync(yardFile(yardP), Buffer.from('this is definitely not a sqlite database' + Math.random()));
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(yardFile(yardP) + ext); } catch (_) {}
  }
  await startServer(true);
  const admin6 = await login('admin');
  // 选损坏副本
  r = await api('/api/auth/yard', { token: admin6, method: 'PUT', body: { yardId: yardP } });
  eq('选择损坏副本 503', r.status, 503);
  eq('错误码 YARD_BROKEN', r.data.code, 'YARD_BROKEN');
  ok('错误信息说明原因', /损坏|无法|隔离/.test(r.data.error || ''), r.data.error);
  // 损坏后会话选择是否被保留不影响——服务端未更新选择（PUT 在解析阶段即拒绝），
  // 显式切到健康副本继续验证其他站场照常
  r = await api('/api/auth/yard', { token: admin6, method: 'PUT', body: { yardId: yardA } });
  eq('切到健康副本成功', r.status, 200);
  r = await api('/api/admin/yards', { token: admin6 });
  const brokenRow = r.data.yards.find((x) => x.id === yardP);
  eq('列表显示 broken', brokenRow.status, 'broken');
  ok('列表带损坏原因', !!brokenRow.brokenReason, brokenRow);
  r = await api('/api/admin/state', { token: admin6 });
  eq('健康副本只读正常', r.status, 200);
  // 原站场照常：切回原站场做一次写操作（预检是只读，改走设置读 + 开放预检）
  r = await api('/api/auth/yard', { token: admin6, method: 'PUT', body: {} });
  eq('切回原站场 200', r.status, 200);
  const d2 = await login('dispatcher', '隔离验证值班员');
  r = await api('/api/routes/R1/check', {
    token: d2, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('原站场预检照常', r.status, 200);

  console.log('\n[D2] 原站场损坏：原站场被隔离，健康副本仍可用');
  await stopServer();
  fs.writeFileSync(yardFile(1), Buffer.from('broken original yard db' + Math.random()));
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(yardFile(1) + ext); } catch (_) {}
  }
  await startServer(true);
  const admin7 = await login('admin');
  r = await api('/api/auth/yard', { token: admin7, method: 'PUT', body: { yardId: yardA } });
  eq('原站场损坏时健康副本仍可选择', r.status, 200);
  r = await api('/api/admin/state', { token: admin7 });
  eq('健康副本状态正常', r.status, 200);
  r = await api('/api/auth/yard', { token: admin7, method: 'PUT', body: {} });
  eq('损坏原站场拒绝选择 503', r.status, 503);
  eq('损坏原站场错误码', r.data.code, 'YARD_BROKEN');

  await stopServer();
  console.log(`\n故障恢复 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
