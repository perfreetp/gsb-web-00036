'use strict';
const $app = document.getElementById('app');
const $modalRoot = document.getElementById('modalRoot');
const state = { me: null, projectId: null };

const STATUS_LABEL = {
  draft: '草稿', pending_design: '待设计审核', pending_tech: '待技术审核',
  pending_pm: '待项目负责人审核', effective: '已生效', obsolete: '已作废', returned: '已退回',
};
const LEVEL_LABEL = { design: '设计审核', tech: '技术审核', pm: '项目负责人终审' };
const LEVEL_ORDER = ['design', 'tech', 'pm'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}
async function api(method, url, data) {
  const opt = { method, headers: {} };
  if (data !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(data); }
  const resp = await fetch(url, opt);
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || ('请求失败 ' + resp.status));
  return j;
}
function tag(status) { return `<span class="tag t-${status}">${STATUS_LABEL[status] || status}</span>`; }
function fmt(t) { return t ? esc(t) : '<span class="muted">—</span>'; }

function openModal(html, wide) {
  $modalRoot.innerHTML = `<div class="modal-mask"><div class="modal${wide ? ' wide' : ''}">${html}</div></div>`;
  const mask = $modalRoot.firstElementChild;
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  return mask.querySelector('.modal');
}
function closeModal() { $modalRoot.innerHTML = ''; }

function formVals(scope) {
  const out = {};
  scope.querySelectorAll('[name]').forEach((n) => {
    if (n.type === 'file') { out[n.name] = n.files; return; }
    out[n.name] = n.value;
  });
  return out;
}
async function filesToDataUrls(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(files.map((f) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, data: r.result });
    r.readAsDataURL(f);
  })));
}
async function singleFile(fileList) {
  const arr = await filesToDataUrls(fileList);
  return arr[0] || null;
}

/* ---------- 路由 / 导航 / 登录 ---------- */

const ROUTES = [
  { re: /^#\/login$/, fn: viewLogin, roles: null },
  { re: /^#\/projects$/, fn: viewProjects, roles: null },
  { re: /^#\/projects\/(\d+)$/, fn: viewProject, roles: null },
  { re: /^#\/drawings\/(\d+)$/, fn: viewDrawing, roles: null, tab: true },
  { re: /^#\/my\/confirmations$/, fn: viewMyConfirmations, roles: ['crew'] },
];

async function router() {
  closeModal();
  const hash = location.hash || '#/projects';
  if (!state.me && hash !== '#/login') {
    try { state.me = await api('GET', '/api/me'); }
    catch { location.hash = '#/login'; return; }
  }
  renderTopbar();
  const route = ROUTES.find((r) => r.re.test(hash)) || ROUTES[1];
  if (route.roles && state.me && !route.roles.includes(state.me.role)) {
    location.hash = '#/projects'; return;
  }
  if (hash === '#/login' && state.me) { location.hash = '#/projects'; return; }
  $app.innerHTML = '<div class="card">加载中…</div>';
  try {
    await route.fn(...route.re.exec(hash).slice(1));
  } catch (e) {
    $app.innerHTML = `<div class="alert alert-red">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

function renderTopbar() {
  const bar = document.getElementById('topbar');
  if (!state.me) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const nav = state.me.role === 'crew'
    ? [{ h: '#/my/confirmations', t: '我的收图确认' }]
    : [{ h: '#/projects', t: '项目与图纸' }];
  document.getElementById('nav').innerHTML = nav.map((n) =>
    `<a href="${n.h}" class="${location.hash.startsWith(n.h) ? 'active' : ''}">${n.t}</a>`).join('');
  const roleName = { admin: '管理员', designer: '设计负责人', tech: '技术负责人', pm: '项目负责人', crew: '施工班组' };
  document.getElementById('userLabel').textContent = `${state.me.name}（${roleName[state.me.role]}）`;
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null; location.hash = '#/login';
});

function viewLogin() {
  document.getElementById('topbar').classList.add('hidden');
  $app.innerHTML = `
  <div class="login-wrap">
    <div class="card">
      <h2>📐 图纸变更管理平台</h2>
      <div class="field"><label>用户名</label><input id="liUser" value="designer"></div>
      <div class="field"><label>密码</label><input id="liPw" type="password" value="design123"></div>
      <button class="btn" style="width:100%;margin-top:14px" id="liBtn">登 录</button>
      <div class="demo muted">
        演示账号（点击可填充）：<br>
        <code data-u="designer" data-p="design123">designer / design123 设计</code><br>
        <code data-u="tech" data-p="tech123">tech / tech123 技术</code><br>
        <code data-u="pm" data-p="pm123">pm / pm123 项目负责人</code><br>
        <code data-u="admin" data-p="admin123">admin / admin123 管理员</code><br>
        <code data-u="crew1" data-p="crew123">crew1 / crew123 施工班组</code>
      </div>
    </div>
  </div>`;
  $app.querySelectorAll('code').forEach((c) => c.addEventListener('click', () => {
    $app.querySelector('#liUser').value = c.dataset.u;
    $app.querySelector('#liPw').value = c.dataset.p;
  }));
  $app.querySelector('#liBtn').addEventListener('click', doLogin);
  $app.querySelector('#liPw').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
}
async function doLogin() {
  try {
    state.me = await api('POST', '/api/login', {
      username: document.getElementById('liUser').value.trim(),
      password: document.getElementById('liPw').value,
    });
    location.hash = state.me.role === 'crew' ? '#/my/confirmations' : '#/projects';
  } catch (e) { toast(e.message, true); }
}

function canEdit() { return ['admin', 'designer'].includes(state.me.role); }
function canReview() { return ['admin', 'designer', 'tech', 'pm'].includes(state.me.role); }

/* ---------- 项目列表 ---------- */

async function viewProjects() {
  const projects = await api('GET', '/api/projects');
  $app.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h2>项目列表</h2>
        ${state.me.role === 'admin' ? '<button class="btn btn-sm" id="newProject">+ 新建项目</button>' : ''}
      </div>
      <table><thead><tr><th>项目编号</th><th>项目名称</th><th>说明</th><th>图纸数</th><th></th></tr></thead>
      <tbody>${projects.map((p) => `<tr>
        <td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td>
        <td class="muted">${esc(p.description)}</td><td>${p.drawing_count}</td>
        <td><a href="#/projects/${p.id}">进入项目 →</a></td></tr>`).join('')}</tbody></table>
    </div>`;
  const btn = $app.querySelector('#newProject');
  if (btn) btn.addEventListener('click', () => {
    const m = openModal(`<h3>新建项目</h3>
      <div class="field"><label>项目编号</label><input name="code" placeholder="如 PRJ-002"></div>
      <div class="field"><label>项目名称</label><input name="name"></div>
      <div class="field"><label>说明</label><textarea name="description"></textarea></div>
      <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
      <button class="btn" id="mOk">创建</button></div>`);
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mOk').onclick = async () => {
      const v = formVals(m);
      try { await api('POST', '/api/projects', v); closeModal(); toast('项目已创建'); router(); }
      catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------- 项目详情 ---------- */

async function viewProject(pid) {
  state.projectId = Number(pid);
  const [disciplines, areas, crews, drawings, tasks] = await Promise.all([
    api('GET', `/api/projects/${pid}/disciplines`),
    api('GET', `/api/projects/${pid}/areas`),
    api('GET', `/api/projects/${pid}/crews`),
    api('GET', `/api/projects/${pid}/drawings`),
    api('GET', `/api/projects/${pid}/tasks`),
  ]);
  state.lookups = { disciplines, areas, crews };

  $app.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h2>图纸台账 ${drawings.some((d) => d.pending_confirms) ? '' : ''}</h2>
        <div class="row">
          <button class="btn btn-sm" id="tabDrawings">图纸</button>
          <button class="btn btn-sm btn-plain" id="tabTasks">施工任务</button>
          <button class="btn btn-sm btn-plain" id="tabBase">专业 / 区域 / 班组</button>
          ${canEdit() ? '<button class="btn btn-sm" id="newDrawing">+ 新建图纸</button>' : ''}
        </div>
      </div>
      <div id="paneDrawings">
        <table><thead><tr><th>图纸编号</th><th>名称</th><th>专业</th><th>区域</th>
          <th>当前版本</th><th>状态</th><th>生效时间</th><th>待确认/旧图任务</th><th></th></tr></thead>
        <tbody>${drawings.map((d) => `<tr>
          <td class="mono">${esc(d.code)}</td><td>${esc(d.name)}</td>
          <td>${esc(d.discipline_name || '—')}</td><td>${esc(d.area_name || '—')}</td>
          <td>${d.version_no ? `<b>${esc(d.version_no)}</b>版` : '<span class="muted">未发布</span>'}</td>
          <td>${d.version_status ? tag(d.version_status) : '—'}</td>
          <td class="muted">${fmt(d.effective_at)}</td>
          <td>
            ${d.pending_confirms ? `<span class="tag t-pending">${d.pending_confirms} 班组待确认</span>` : ''}
            ${d.outdated_tasks ? `<span class="tag t-obsolete">${d.outdated_tasks} 任务关联旧图</span>` : ''}
            ${!d.pending_confirms && !d.outdated_tasks ? '<span class="muted">正常</span>' : ''}
          </td>
          <td><a href="#/drawings/${d.id}">版本管理 →</a></td></tr>`).join('')}</tbody></table>
      </div>
      <div id="paneTasks" class="hidden"></div>
      <div id="paneBase" class="hidden"></div>
    </div>`;

  renderTasksPane(tasks);
  renderBasePane(disciplines, areas, crews);
  bindProjectTabs();
  const nd = $app.querySelector('#newDrawing');
  if (nd) nd.addEventListener('click', () => drawingFormModal(disciplines, areas, pid));
}

function bindProjectTabs() {
  const panes = { Drawings: $app.querySelector('#paneDrawings'), Tasks: $app.querySelector('#paneTasks'), Base: $app.querySelector('#paneBase') };
  const btns = { Drawings: $app.querySelector('#tabDrawings'), Tasks: $app.querySelector('#tabTasks'), Base: $app.querySelector('#tabBase') };
  Object.entries(btns).forEach(([k, b]) => b.addEventListener('click', () => {
    Object.values(panes).forEach((p) => p.classList.add('hidden'));
    panes[k].classList.remove('hidden');
    Object.values(btns).forEach((x) => x.classList.add('btn-plain'));
    b.classList.remove('btn-plain');
  }));
}

function renderTasksPane(tasks) {
  $app.querySelector('#paneTasks').innerHTML = `
    <div class="row spread">
      <h3 style="margin:0">施工任务</h3>
      <button class="btn btn-sm" id="newTask">+ 新建任务</button>
    </div>
    <table><thead><tr><th>任务</th><th>关联图纸 / 版本</th><th>班组</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${tasks.map((t) => `<tr>
      <td>${esc(t.name)}</td>
      <td>${t.drawing_id ? `${esc(t.drawing_code)} ·
        <span class="${t.outdated ? 'tag t-obsolete' : ''}">${esc(t.task_version_no || '?')}版</span>
        ${t.outdated ? ` <span class="muted">当前有效 ${esc(t.current_version_no)}版</span>` : ''}`
        : '<span class="muted">未关联图纸</span>'}</td>
      <td>${esc(t.crew_name || '—')}</td>
      <td>${t.status === 'done' ? '<span class="tag t-confirmed">已完工</span>' : '<span class="tag t-pending_design">施工中</span>'}</td>
      <td class="row">
        ${t.status === 'in_progress' && t.outdated ? `<button class="btn btn-sm btn-plain" data-switch="${t.id}">改用新版本</button>` : ''}
        ${t.status === 'in_progress' ? `<button class="btn btn-sm ${t.outdated ? 'btn-danger' : ''}" data-done="${t.id}">标记完工</button>` : ''}
      </td></tr>`).join('')}</tbody></table>`;
  $app.querySelector('#newTask').addEventListener('click', newTaskModal);
  $app.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('POST', `/api/tasks/${b.dataset.done}/complete`); toast('任务已完工'); router(); }
    catch (e) {
      if (String(e.message).startsWith('【禁止完工】')) blockedCompleteModal(b.dataset.done, e.message);
      else toast(e.message, true);
    }
  }));
  $app.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => switchTaskVersionModal(b.dataset.switch)));
}

function renderBasePane(disciplines, areas, crews) {
  const section = (title, items, kind) => `
    <div class="card" style="margin:0">
      <div class="row spread"><h3 style="margin:0">${title}</h3>
      ${canEdit() ? `<button class="btn btn-sm btn-plain" data-add="${kind}">+ 添加</button>` : ''}</div>
      <div class="pillbar">${items.map((i) =>
        `<span class="approval-step">${esc(i.name)}${i.contact ? ` · ${esc(i.contact)}` : ''}</span>`).join('') || '<span class="muted">暂无</span>'}</div>
    </div>`;
  $app.querySelector('#paneBase').innerHTML = `
    <div class="grid2" style="grid-template-columns:1fr 1fr 1fr">
      ${section('专业', disciplines, 'disciplines')}
      ${section('区域', areas, 'areas')}
      ${section('施工班组', crews, 'crews')}
    </div>`;
  $app.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.add;
    const isCrew = kind === 'crews';
    const m = openModal(`<h3>添加${{ disciplines: '专业', areas: '区域', crews: '班组' }[kind]}</h3>
      <div class="field"><label>名称</label><input name="name"></div>
      ${isCrew ? '<div class="field"><label>联系方式</label><input name="contact"></div>' : ''}
      <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
      <button class="btn" id="mOk">保存</button></div>`);
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mOk').onclick = async () => {
      try { await api('POST', `/api/projects/${state.projectId}/${kind}`, formVals(m)); closeModal(); toast('已添加'); router(); }
      catch (e) { toast(e.message, true); }
    };
  }));
}

function drawingFormModal(disciplines, areas, pid) {
  const m = openModal(`<h3>新建图纸</h3>
    <div class="field"><label>图纸编号（项目内唯一）</label><input name="code" placeholder="如 STR-A-002"></div>
    <div class="field"><label>图纸名称</label><input name="name"></div>
    <div class="field"><label>专业</label><select name="discipline_id"><option value="">—</option>
      ${disciplines.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label>区域</label><select name="area_id"><option value="">—</option>
      ${areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">创建</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const v = formVals(m);
    v.discipline_id = v.discipline_id || null; v.area_id = v.area_id || null;
    try { await api('POST', `/api/projects/${pid}/drawings`, v); closeModal(); toast('图纸已创建'); router(); }
    catch (e) { toast(e.message, true); }
  };
}

async function newTaskModal() {
  const [drawings, crews] = await Promise.all([
    api('GET', `/api/projects/${state.projectId}/drawings`),
    api('GET', `/api/projects/${state.projectId}/crews`),
  ]);
  const m = openModal(`<h3>新建施工任务</h3>
    <div class="field"><label>任务名称</label><input name="name"></div>
    <div class="field"><label>关联图纸（默认关联当前有效版本）</label>
      <select name="drawing_id"><option value="">—</option>
      ${drawings.map((d) => `<option value="${d.id}">${esc(d.code)} ${esc(d.name)}${d.version_no ? `（当前 ${esc(d.version_no)}版）` : ''}</option>`).join('')}</select></div>
    <div class="field"><label>施工班组</label><select name="crew_id"><option value="">—</option>
      ${crews.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">创建</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const v = formVals(m);
    v.drawing_id = v.drawing_id || null; v.crew_id = v.crew_id || null;
    try { await api('POST', `/api/projects/${state.projectId}/tasks`, v); closeModal(); toast('任务已创建'); router(); }
    catch (e) { toast(e.message, true); }
  };
}

function blockedCompleteModal(taskId, message) {
  const m = openModal(`<h3 style="color:var(--red)">⛔ 禁止标记完工</h3>
    <div class="alert alert-red">${esc(message)}</div>
    <p class="muted">系统要求：任务关联的图纸版本已作废时，必须先更新为当前有效版本，确认按新图施工后方可完工。</p>
    <div class="modal-foot">
      <button class="btn btn-plain" id="mCancel">关闭</button>
      <button class="btn" id="mSwitch">改用当前有效版本</button>
    </div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mSwitch').onclick = () => { closeModal(); switchTaskVersionModal(taskId); };
}

async function switchTaskVersionModal(taskId) {
  const tasks = await api('GET', `/api/projects/${state.projectId}/tasks`);
  const t = tasks.find((x) => String(x.id) === String(taskId));
  if (!t) return toast('任务不存在', true);
  const drawing = await api('GET', `/api/drawings/${t.drawing_id}`);
  const effective = drawing.versions.filter((v) => v.status === 'effective');
  const m = openModal(`<h3>更新任务关联版本</h3>
    <p>任务：<b>${esc(t.name)}</b>，图纸 <span class="mono">${esc(t.drawing_code)}</span></p>
    <div class="field"><label>选择生效中的版本</label>
      <select name="version_id">${effective.map((v) =>
        `<option value="${v.id}" ${v.id === drawing.current_version_id ? 'selected' : ''}>${esc(v.version_no)}版（当前有效）</option>`).join('')}</select></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">更新</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    try {
      await api('POST', `/api/tasks/${taskId}/version`, { version_id: Number(formVals(m).version_id) });
      closeModal(); toast('已更新为当前有效版本'); router();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 图纸详情：完整演变 ---------- */

async function viewDrawing(id) {
  const d = await api('GET', `/api/drawings/${id}`);
  state.drawing = d;
  const current = d.versions.find((v) => v.id === d.current_version_id);
  const pendingConfirms = d.confirmations.filter((c) => c.status === 'pending');
  const openIssues = d.issues.filter((i) => i.status === 'open');

  $app.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h2><a href="#/projects/${d.project_id}">← ${esc(d.project_name)}</a>
          <span class="mono">${esc(d.code)}</span> ${esc(d.name)}</h2>
        <div class="row">
          ${canEdit() ? '<button class="btn btn-sm" id="btnNewVersion">+ 上传新版本</button>' : ''}
          ${current ? '<button class="btn btn-sm btn-plain" id="btnReceive">登记领取</button>' : ''}
        </div>
      </div>
      <div class="stat">
        <div class="box"><div class="muted">专业 / 区域</div><b>${esc(d.discipline_name || '—')} / ${esc(d.area_name || '—')}</b></div>
        <div class="box"><div class="muted">当前有效版本</div><div class="num">${current ? esc(current.version_no) + '版' : '未发布'}</div></div>
        <div class="box"><div class="muted">历史版本</div><div class="num">${d.versions.length}</div></div>
        <div class="box"><div class="muted">待班组确认</div><div class="num" style="color:${pendingConfirms.length ? 'var(--amber)' : 'inherit'}">${pendingConfirms.length}</div></div>
        <div class="box"><div class="muted">未关闭问题</div><div class="num" style="color:${openIssues.length ? 'var(--red)' : 'inherit'}">${openIssues.length}</div></div>
      </div>
      ${pendingConfirms.length ? `<div class="alert alert-amber">⚠ 新版本已生效，${pendingConfirms.length} 个曾领取旧图的班组尚未确认收到新版本：${pendingConfirms.map((c) => esc(c.crew_name)).join('、')}</div>` : ''}
    </div>
    <div class="card">
      <div class="tabs">
        <button data-tab="evo" class="active">版本演变</button>
        <button data-tab="issues">现场问题（${d.issues.length}）</button>
        <button data-tab="confirm">班组确认（${d.confirmations.length}）</button>
      </div>
      <div id="tabEvo"></div>
      <div id="tabIssues" class="hidden"></div>
      <div id="tabConfirm" class="hidden"></div>
    </div>`;

  $app.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $app.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    ['Evo', 'Issues', 'Confirm'].forEach((k) => $app.querySelector('#tab' + k).classList.add('hidden'));
    $app.querySelector('#tab' + b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)).classList.remove('hidden');
  }));

  renderEvolution(d);
  renderIssuesTab(d);
  renderConfirmTab(d);

  const nv = $app.querySelector('#btnNewVersion');
  if (nv) nv.addEventListener('click', () => newVersionModal(d));
  const rc = $app.querySelector('#btnReceive');
  if (rc) rc.addEventListener('click', () => receiveModal(d));
}

function approvalStepsHtml(d, v) {
  const recs = d.approvals.filter((a) => a.version_id === v.id);
  return LEVEL_ORDER.map((lv) => {
    const r = recs.filter((a) => a.level === lv).pop();
    if (!r) return `<span class="approval-step wait">○ ${LEVEL_LABEL[lv]}：待审</span>`;
    return `<span class="approval-step ${r.action === 'approved' ? 'ok' : 'no'}">
      ${r.action === 'approved' ? '✓' : '✗'} ${LEVEL_LABEL[lv]}：${esc(r.approver_name)} · ${esc(r.created_at)}
      ${r.comment ? `（${esc(r.comment)}）` : ''}</span>`;
  }).join('');
}

function renderEvolution(d) {
  const pane = $app.querySelector('#tabEvo');
  const versions = [...d.versions].reverse();
  pane.innerHTML = `<div class="timeline">${versions.map((v) => {
    const diff = d.diffs.find((x) => x.version_id === v.id);
    const confs = d.confirmations.filter((c) => c.version_id === v.id);
    const issues = d.issues.filter((i) => i.version_id === v.id);
    const cls = v.status === 'effective' ? 'effective' : v.status === 'obsolete' ? 'obsolete'
      : v.status.startsWith('pending') ? 'pending' : '';
    const isCurrent = v.id === d.current_version_id;
    return `<div class="tl-item ${cls}">
      <div class="row spread">
        <div><b>${esc(v.version_no)}版</b> ${tag(v.status)}
          ${isCurrent ? '<span class="tag t-effective">当前有效</span>' : ''}
          <span class="muted">提交人：${esc(v.submitted_name || '—')} · ${esc(v.created_at)}</span></div>
        <div class="row">
          ${v.file_path ? `<a class="btn btn-sm btn-plain" href="/files/${esc(v.file_path)}" target="_blank">查看图纸文件</a>` : ''}
          ${versionActionsHtml(d, v)}
        </div>
      </div>
      ${v.change_reason ? `<div class="muted" style="margin-top:4px">变更原因：${esc(v.change_reason)}</div>` : ''}
      ${v.submit_note ? `<div class="muted">提交说明：${esc(v.submit_note)}</div>` : ''}
      <div style="margin-top:6px">${approvalStepsHtml(d, v)}</div>
      ${diff ? `<div class="alert ${v.status === 'obsolete' ? 'alert-red' : 'alert-green'}" style="margin-top:8px">
        <b>版本差异记录：</b>${esc(diff.summary)}</div>` : ''}
      ${v.effective_at ? `<div class="muted">生效时间：${esc(v.effective_at)}</div>` : ''}
      ${confs.length ? `<div class="muted" style="margin-top:4px">班组确认：
        ${confs.map((c) => `${esc(c.crew_name)} ${c.status === 'confirmed' ? '✓' + esc(c.confirmed_at) : '<b style="color:var(--amber)">待确认</b>'}`).join('；')}</div>` : ''}
      ${issues.length ? `<div class="muted">关联现场问题 ${issues.length} 条（见“现场问题”页签）</div>` : ''}
    </div>`;
  }).join('')}</div>`;
  bindVersionActions(d);
}

function versionActionsHtml(d, v) {
  const out = [];
  if (canEdit() && ['draft', 'returned'].includes(v.status)) {
    out.push(`<button class="btn btn-sm btn-plain" data-edit-v="${v.id}">修改</button>`);
    out.push(`<button class="btn btn-sm" data-submit-v="${v.id}">${v.status === 'returned' ? '重新提交审核' : '提交审核'}</button>`);
  }
  if (canReview() && v.status.startsWith('pending')) {
    out.push(`<button class="btn btn-sm" data-review-v="${v.id}">审核</button>`);
  }
  return out.join('');
}

function bindVersionActions(d) {
  $app.querySelectorAll('[data-submit-v]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('POST', `/api/versions/${b.dataset.submitV}/submit`); toast('已提交，进入设计审核'); router(); }
    catch (e) { toast(e.message, true); }
  }));
  $app.querySelectorAll('[data-edit-v]').forEach((b) => b.addEventListener('click', () => {
    const v = d.versions.find((x) => x.id === Number(b.dataset.editV));
    editVersionModal(d, v);
  }));
  $app.querySelectorAll('[data-review-v]').forEach((b) => b.addEventListener('click', () => {
    const v = d.versions.find((x) => x.id === Number(b.dataset.reviewV));
    reviewModal(d, v);
  }));
}

/* ---------- 版本表单 / 审核弹窗 ---------- */

const CHANGE_REASONS = ['设计优化', '设计错误修正', '现场条件变化', '业主需求变更', '规范更新', '施工可行性调整', '其他'];

function newVersionModal(d) {
  const candidates = d.versions.filter((v) => ['effective', 'obsolete'].includes(v.status));
  const current = d.versions.find((v) => v.id === d.current_version_id);
  const isFirst = d.versions.length === 0;
  const m = openModal(`<h3>上传新版本</h3>
    <div class="field"><label>版本号（如 B、C、R2）</label><input name="version_no" placeholder="${suggestVersion(current)}"></div>
    ${isFirst ? '<div class="alert alert-green">初版发布，无需关联被替代版本。</div>' : `
    <div class="field"><label>变更原因（必选）</label>
      <select name="reason_sel">${CHANGE_REASONS.map((r) => `<option>${r}</option>`).join('')}</select></div>
    <div class="field"><label>变更原因说明</label><textarea name="reason_text" placeholder="补充说明本次变更内容"></textarea></div>
    <div class="field"><label>被替代版本（必选）</label>
      <select name="supersedes_id">${candidates.map((v) =>
        `<option value="${v.id}" ${v.id === d.current_version_id ? 'selected' : ''}>${esc(v.version_no)}版（${STATUS_LABEL[v.status]}）</option>`).join('')}</select></div>`}
    <div class="field"><label>图纸文件（PDF / 图片）</label><input name="file" type="file" accept=".pdf,image/*"></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">保存草稿</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const v = formVals(m);
    const payload = { version_no: v.version_no.trim() };
    if (!isFirst) {
      payload.change_reason = v.reason_sel + (v.reason_text.trim() ? '：' + v.reason_text.trim() : '');
      payload.supersedes_id = Number(v.supersedes_id);
    }
    const f = await singleFile(v.file);
    if (f) { payload.file_data = f.data; payload.file_name = f.name; }
    try {
      await api('POST', `/api/drawings/${d.id}/versions`, payload);
      closeModal(); toast('新版本草稿已创建，请提交审核'); router();
    } catch (e) { toast(e.message, true); }
  };
}

function suggestVersion(current) {
  if (!current) return 'A';
  const no = current.version_no;
  if (/^[A-Z]$/.test(no)) return String.fromCharCode(no.charCodeAt(0) + 1);
  return no + '+1';
}

function editVersionModal(d, v) {
  const m = openModal(`<h3>修改版本 ${esc(v.version_no)}（${STATUS_LABEL[v.status]}）</h3>
    ${v.status === 'returned' ? '<div class="alert alert-amber">该版本被退回，请根据退回意见修改后重新提交审核。</div>' : ''}
    <div class="field"><label>图纸标题</label><input name="title" value="${esc(v.title)}"></div>
    ${v.supersedes_id ? `<div class="field"><label>变更原因（必填）</label><textarea name="change_reason">${esc(v.change_reason || '')}</textarea></div>` : ''}
    <div class="field"><label>提交说明</label><textarea name="submit_note">${esc(v.submit_note || '')}</textarea></div>
    <div class="field"><label>更换图纸文件（当前：${esc(v.file_name || '无')}）</label><input name="file" type="file" accept=".pdf,image/*"></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">保存</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const vals = formVals(m);
    const payload = { title: vals.title, submit_note: vals.submit_note };
    if (v.supersedes_id) payload.change_reason = vals.change_reason;
    const f = await singleFile(vals.file);
    if (f) { payload.file_data = f.data; payload.file_name = f.name; }
    try { await api('POST', `/api/versions/${v.id}/edit`, payload); closeModal(); toast('已保存'); router(); }
    catch (e) { toast(e.message, true); }
  };
}

function reviewModal(d, v) {
  const levelName = { pending_design: '设计审核', pending_tech: '技术审核', pending_pm: '项目负责人终审' }[v.status];
  const m = openModal(`<h3>${levelName} — ${esc(d.code)} ${esc(v.version_no)}版</h3>
    <div class="muted" style="margin-bottom:8px">变更原因：${esc(v.change_reason || '初版')}</div>
    ${v.file_path ? `<p><a href="/files/${esc(v.file_path)}" target="_blank">查看图纸文件：${esc(v.file_name)}</a></p>` : ''}
    <div class="field"><label>审核意见（退回时必填）</label><textarea name="comment"></textarea></div>
    <div class="modal-foot">
      <button class="btn btn-danger" id="mReject">退回修改</button>
      <button class="btn" id="mApprove">审核通过</button>
    </div>`);
  const act = async (action) => {
    try {
      await api('POST', `/api/versions/${v.id}/review`, { action, comment: m.querySelector('[name=comment]').value });
      closeModal();
      toast(action === 'approved'
        ? (v.status === 'pending_pm' ? '终审通过，新版本已生效，旧版已作废' : '已通过，流转至下一级审核')
        : '已退回，需修改后重新提交');
      router();
    } catch (e) { toast(e.message, true); }
  };
  m.querySelector('#mApprove').onclick = () => act('approved');
  m.querySelector('#mReject').onclick = () => act('rejected');
}

async function receiveModal(d) {
  const crews = await api('GET', `/api/projects/${d.project_id}/crews`);
  const m = openModal(`<h3>登记图纸领取</h3>
    <p class="muted">当前有效版本：${esc((d.versions.find((v) => v.id === d.current_version_id) || {}).version_no)}版。
    领取记录用于版本更新时追踪需要确认的班组。</p>
    <div class="field"><label>领取班组</label><select name="crew_id">
      ${crews.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">登记</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    try {
      await api('POST', `/api/drawings/${d.id}/receive`, { crew_id: Number(formVals(m).crew_id) });
      closeModal(); toast('已登记领取'); router();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 现场问题（图纸定位标注） ---------- */

function renderIssuesTab(d) {
  const pane = $app.querySelector('#tabIssues');
  const current = d.versions.find((v) => v.id === d.current_version_id);
  const shown = current || d.versions[d.versions.length - 1];
  const isImg = shown && /\.(png|jpe?g|gif|webp|svg)$/i.test(shown.file_path || '');
  pane.innerHTML = `
    <div class="alert alert-amber">在下方图纸上<b>点击具体位置</b>即可创建现场问题记录；问题将永久关联到所选版本，图纸再次变更后仍可追溯。</div>
    <div class="row" style="margin-bottom:8px">
      <label style="margin:0">查看版本：</label>
      <select id="issueVersionSel" style="width:auto">
        ${[...d.versions].reverse().map((v) => `<option value="${v.id}" ${shown && v.id === shown.id ? 'selected' : ''}>${esc(v.version_no)}版（${STATUS_LABEL[v.status]}）</option>`).join('')}
      </select>
      <span class="muted">问题创建时绑定当前所选版本</span>
    </div>
    <div class="issue-canvas" id="issueCanvas">
      ${shown && shown.file_path
        ? (isImg ? `<img src="/files/${esc(shown.file_path)}" alt="图纸">`
                 : `<iframe src="/files/${esc(shown.file_path)}" style="width:100%;height:560px;border:0"></iframe>`)
        : '<div style="padding:120px;text-align:center;color:#94a3b8">该版本未上传图纸文件，仍可点击创建问题（记录相对坐标）</div>'}
    </div>
    <h3>问题列表</h3>
    <div id="issueList"></div>`;

  const canvas = pane.querySelector('#issueCanvas');
  const sel = pane.querySelector('#issueVersionSel');
  const drawPins = () => {
    canvas.querySelectorAll('.issue-pin').forEach((p) => p.remove());
    const vid = Number(sel.value);
    d.issues.filter((i) => i.version_id === vid).forEach((i, idx) => {
      const pin = el(`<div class="issue-pin ${i.status === 'closed' ? 'closed' : ''}"
        style="left:${i.x}%;top:${i.y}%" title="${esc(i.title)}"><span>${idx + 1}</span></div>`);
      pin.addEventListener('click', (e) => { e.stopPropagation(); issueDetailModal(d, i); });
      canvas.appendChild(pin);
    });
    renderIssueList(d, vid);
  };
  sel.addEventListener('change', drawPins);
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(2);
    const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(2);
    newIssueModal(d, Number(sel.value), x, y);
  });
  drawPins();
}

function renderIssueList(d, vid) {
  const list = d.issues.filter((i) => i.version_id === vid);
  $app.querySelector('#issueList').innerHTML = list.length ? `
    <table><thead><tr><th>#</th><th>标题</th><th>版本</th><th>责任人</th><th>状态</th><th>创建</th><th></th></tr></thead>
    <tbody>${list.map((i, idx) => `<tr>
      <td>${idx + 1}</td><td>${esc(i.title)}</td><td>${esc(i.version_no)}版</td>
      <td>${esc(i.assignee || '—')}</td>
      <td><span class="tag t-${i.status}">${i.status === 'open' ? '待处理' : '已关闭'}</span></td>
      <td class="muted">${esc(i.created_by_name || '')} · ${esc(i.created_at)}</td>
      <td><a data-issue="${i.id}">详情</a></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">该版本暂无问题记录。</p>';
  $app.querySelectorAll('[data-issue]').forEach((a) => a.addEventListener('click', () => {
    issueDetailModal(d, d.issues.find((x) => x.id === Number(a.dataset.issue)));
  }));
}

function newIssueModal(d, versionId, x, y) {
  const v = d.versions.find((x) => x.id === versionId);
  const m = openModal(`<h3>新建现场问题（${esc(v.version_no)}版 · 位置 ${x}%, ${y}%）</h3>
    <div class="field"><label>问题标题</label><input name="title" placeholder="如：柱脚螺栓孔位与基础不符"></div>
    <div class="field"><label>问题描述</label><textarea name="description"></textarea></div>
    <div class="grid2">
      <div class="field"><label>责任人</label><input name="assignee" placeholder="处理责任人"></div>
      <div class="field"><label>处理意见</label><input name="opinion" placeholder="初步处理意见"></div>
    </div>
    <div class="field"><label>现场照片（可多选，最多6张）</label><input name="photos" type="file" accept="image/*" multiple></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">取消</button>
    <button class="btn" id="mOk">创建问题</button></div>`);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const vals = formVals(m);
    const photos = await filesToDataUrls(vals.photos);
    try {
      await api('POST', `/api/drawings/${d.id}/issues`, {
        version_id: versionId, x: Number(x), y: Number(y),
        title: vals.title, description: vals.description,
        assignee: vals.assignee, opinion: vals.opinion, photos,
      });
      closeModal(); toast('问题已记录'); router();
      setTimeout(() => $app.querySelector('[data-tab="issues"]').click(), 50);
    } catch (e) { toast(e.message, true); }
  };
}

function issueDetailModal(d, i) {
  const photos = JSON.parse(i.photos || '[]');
  const m = openModal(`<h3>问题详情 — ${esc(i.title)}</h3>
    <p class="muted">图纸版本：<b>${esc(i.version_no)}版</b>（该问题永久关联此版本） · 位置 ${i.x}%, ${i.y}% ·
      创建：${esc(i.created_by_name || '—')} ${esc(i.created_at)}</p>
    <p style="margin:8px 0">${esc(i.description || '（无描述）')}</p>
    <div>${photos.map((p) => `<a href="/files/${esc(p)}" target="_blank"><img class="photo-thumb" src="/files/${esc(p)}"></a>`).join('')}</div>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>责任人</label><input name="assignee" value="${esc(i.assignee)}"></div>
      <div class="field"><label>状态</label><select name="status">
        <option value="open" ${i.status === 'open' ? 'selected' : ''}>待处理</option>
        <option value="closed" ${i.status === 'closed' ? 'selected' : ''}>已关闭</option></select></div>
    </div>
    <div class="field"><label>处理意见</label><textarea name="opinion">${esc(i.opinion)}</textarea></div>
    <div class="modal-foot"><button class="btn btn-plain" id="mCancel">关闭</button>
    <button class="btn" id="mOk">保存处理结果</button></div>`, true);
  m.querySelector('#mCancel').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    const vals = formVals(m);
    try {
      await api('POST', `/api/issues/${i.id}`, vals);
      closeModal(); toast('已保存'); router();
      setTimeout(() => $app.querySelector('[data-tab="issues"]').click(), 50);
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 班组确认页签 ---------- */

function renderConfirmTab(d) {
  const pane = $app.querySelector('#tabConfirm');
  const rows = d.confirmations.map((c) => {
    const v = d.versions.find((x) => x.id === c.version_id);
    return `<tr><td>${v ? esc(v.version_no) + '版' : ''}</td><td>${esc(c.crew_name)}</td>
      <td><span class="tag t-${c.status}">${c.status === 'confirmed' ? '已确认' : '待确认'}</span></td>
      <td class="muted">${c.confirmed_at ? esc(c.confirmed_at) + ' · ' + esc(c.confirmed_by_name || '') : '—'}</td></tr>`;
  }).join('');
  pane.innerHTML = `
    <p class="muted" style="margin-bottom:10px">新版本生效后，曾领取旧版图纸的班组自动进入待确认状态，需逐一确认已收到新版本。</p>
    <h3>领取记录</h3>
    <table><thead><tr><th>班组</th><th>联系方式</th><th>领取时间</th></tr></thead>
    <tbody>${d.receipts.map((r) => `<tr><td>${esc(r.crew_name)}</td><td>—</td><td class="muted">${esc(r.received_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无领取记录</td></tr>'}</tbody></table>
    <h3>新版本确认</h3>
    <table><thead><tr><th>版本</th><th>班组</th><th>状态</th><th>确认时间 / 确认人</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">暂无确认任务</td></tr>'}</tbody></table>`;
}

/* ---------- 班组端：我的收图确认 ---------- */

async function viewMyConfirmations() {
  const list = await api('GET', '/api/my/confirmations');
  const pending = list.filter((c) => c.status === 'pending');
  $app.innerHTML = `
    <div class="card">
      <h2>我的收图确认 ${pending.length ? `<span class="tag t-pending">${pending.length} 项待确认</span>` : '<span class="tag t-confirmed">全部已确认</span>'}</h2>
      ${pending.length ? '<div class="alert alert-amber">以下图纸已发布新版本，请核对收到新版图纸后逐一确认。旧版图纸同时作废，不得继续使用。</div>' : ''}
      <table><thead><tr><th>项目</th><th>图纸</th><th>新版本</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${list.map((c) => `<tr>
        <td>${esc(c.project_name)}</td>
        <td><span class="mono">${esc(c.code)}</span> ${esc(c.drawing_name)}</td>
        <td><b>${esc(c.version_no)}版</b></td>
        <td><span class="tag t-${c.status}">${c.status === 'confirmed' ? '已确认 ' + esc(c.confirmed_at) : '待确认'}</span></td>
        <td class="row">
          <a href="#/drawings/${c.drawing_id}">查看图纸</a>
          ${c.status === 'pending' ? `<button class="btn btn-sm" data-confirm="${c.id}">确认已收到新版本</button>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无确认任务</td></tr>'}</tbody></table>
    </div>`;
  $app.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('POST', `/api/confirmations/${b.dataset.confirm}/confirm`); toast('已确认收到新版本'); router(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- 启动 ---------- */
router();
