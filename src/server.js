const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hash } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

function json(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
function fail(res, code, msg) { json(res, code, { error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > 40 * 1024 * 1024) { reject(new Error('请求体过大（上限 40MB）')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function userInfo(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, crew_id: u.crew_id };
}

function currentUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dcms_token=([a-f0-9]+)/);
  if (!m) return null;
  return db.prepare(`SELECT u.id,u.username,u.name,u.role,u.crew_id FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(m[1]) || null;
}
function requireAuth(user, res) {
  if (!user) { fail(res, 401, '未登录或会话已过期'); return false; }
  return true;
}
function requireRole(user, res, roles) {
  if (!requireAuth(user, res)) return false;
  if (!roles.includes(user.role)) { fail(res, 403, '当前角色无权执行该操作'); return false; }
  return true;
}

function saveUploaded(dataUrl, originalName) {
  const m = /^data:(.*?);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('文件格式不正确');
  let ext = originalName ? path.extname(originalName).toLowerCase() : '';
  if (!ext) ext = '.' + (m[1].split('/')[1] || 'bin').replace('jpeg', 'jpg');
  const name = crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  return name;
}

function listTasks(pid) {
  return db.prepare(`
    SELECT t.*, d.code AS drawing_code, d.name AS drawing_name, d.current_version_id,
           v.version_no AS task_version_no, cv.version_no AS current_version_no,
           c.name AS crew_name,
           CASE WHEN t.drawing_id IS NOT NULL AND t.version_id != d.current_version_id
                THEN 1 ELSE 0 END AS outdated
    FROM tasks t
    LEFT JOIN drawings d ON d.id=t.drawing_id
    LEFT JOIN drawing_versions v ON v.id=t.version_id
    LEFT JOIN drawing_versions cv ON cv.id=d.current_version_id
    LEFT JOIN crews c ON c.id=t.crew_id
    WHERE t.project_id=? ORDER BY t.id DESC`).all(pid);
}

/* ---------- 核心业务：逐级审核与发布 ---------- */

const LEVEL_LABEL = { design: '设计', tech: '技术', pm: '项目负责人' };

// 设计 → 技术 → 项目负责人 逐级审核；任一级退回则回到 returned，须修改后重新提交
function applyReview(versionId, reviewer, action, comment) {
  const v = db.prepare('SELECT * FROM drawing_versions WHERE id=?').get(versionId);
  if (!v) throw new Error('版本不存在');
  const levelByStatus = { pending_design: 'design', pending_tech: 'tech', pending_pm: 'pm' };
  const roleByLevel = { design: 'designer', tech: 'tech', pm: 'pm' };
  const level = levelByStatus[v.status];
  if (!level) throw new Error('该版本当前不在待审核状态');
  if (reviewer.role !== 'admin' && reviewer.role !== roleByLevel[level])
    throw new Error('当前级别应由' + LEVEL_LABEL[level] + '负责人审核');

  db.prepare('BEGIN').run();
  try {
    db.prepare('INSERT INTO approvals (version_id,level,approver_id,action,comment) VALUES (?,?,?,?,?)')
      .run(versionId, level, reviewer.id, action, comment || '');
    if (action === 'rejected') {
      db.prepare("UPDATE drawing_versions SET status='returned' WHERE id=?").run(versionId);
    } else if (level === 'design') {
      db.prepare("UPDATE drawing_versions SET status='pending_tech' WHERE id=?").run(versionId);
    } else if (level === 'tech') {
      db.prepare("UPDATE drawing_versions SET status='pending_pm' WHERE id=?").run(versionId);
    } else {
      publishVersion(versionId);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return db.prepare('SELECT * FROM drawing_versions WHERE id=?').get(versionId);
}

// 终审通过：旧版作废、自动生成差异记录、更新当前有效版本、已领旧图班组进入待确认
function publishVersion(versionId) {
  const nv = db.prepare('SELECT * FROM drawing_versions WHERE id=?').get(versionId);
  const now = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
  db.prepare("UPDATE drawing_versions SET status='effective', effective_at=? WHERE id=?").run(now, versionId);

  let diffSummary;
  if (nv.supersedes_id) {
    const ov = db.prepare('SELECT * FROM drawing_versions WHERE id=?').get(nv.supersedes_id);
    db.prepare("UPDATE drawing_versions SET status='obsolete' WHERE id=?").run(ov.id);
    const changes = ['版本由 ' + ov.version_no + ' 升级为 ' + nv.version_no];
    if (ov.title !== nv.title) changes.push('图纸标题：「' + ov.title + '」→「' + nv.title + '」');
    changes.push('变更原因：' + (nv.change_reason || '未填写'));
    if (nv.file_name && ov.file_name !== nv.file_name) changes.push('图纸文件已更换：' + nv.file_name);
    diffSummary = '本版本替代 ' + ov.version_no + ' 版。' + changes.join('；') + '。'
      + ov.version_no + ' 版自 ' + now + ' 起作废。';
  } else {
    diffSummary = '初版发布，无前置版本。';
  }
  db.prepare('INSERT INTO version_diffs (version_id,from_version_id,summary) VALUES (?,?,?)')
    .run(versionId, nv.supersedes_id, diffSummary);

  db.prepare('UPDATE drawings SET current_version_id=? WHERE id=?').run(versionId, nv.drawing_id);

  if (nv.supersedes_id) {
    const crews = db.prepare(
      'SELECT DISTINCT crew_id FROM receipts WHERE drawing_id=? AND version_id=?')
      .all(nv.drawing_id, nv.supersedes_id);
    const ins = db.prepare("INSERT OR IGNORE INTO confirmations (version_id,crew_id,status) VALUES (?,?,'pending')");
    for (const c of crews) ins.run(versionId, c.crew_id);
  }
}

/* ---------- API 路由 ---------- */

async function handleApi(req, res, url, user) {
  const body = () => readBody(req);

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const b = await body();
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(b.username || '');
    if (!u || u.password !== hash(b.password || '')) return fail(res, 401, '用户名或密码错误');
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, u.id);
    return json(res, 200, userInfo(u), { 'Set-Cookie': 'dcms_token=' + token + '; Path=/; HttpOnly' });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'dcms_token=; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    return user ? json(res, 200, userInfo(user)) : fail(res, 401, '未登录');
  }

  if (!requireAuth(user, res)) return;

  // 项目列表 / 新建
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return json(res, 200, db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM drawings d WHERE d.project_id=p.id) AS drawing_count
      FROM projects p ORDER BY p.id`).all());
  }
  if (req.method === 'POST' && url.pathname === '/api/projects') {
    if (!requireRole(user, res, ['admin'])) return;
    const b = await body();
    if (!b.name || !b.code) return fail(res, 400, '项目名称与编号必填');
    const r = db.prepare('INSERT INTO projects (name,code,description) VALUES (?,?,?)')
      .run(b.name, b.code, b.description || '');
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }

  // 项目下的 专业/区域/班组/图纸/任务
  const pm = /^\/api\/projects\/(\d+)\/(disciplines|areas|crews|drawings|tasks)$/.exec(url.pathname);
  if (pm) {
    const pid = Number(pm[1]); const kind = pm[2];
    if (req.method === 'GET') {
      if (kind === 'drawings') {
        return json(res, 200, db.prepare(`
          SELECT d.*, di.name AS discipline_name, a.name AS area_name,
                 v.version_no, v.status AS version_status, v.effective_at,
                 (SELECT COUNT(*) FROM confirmations c JOIN drawing_versions vv ON vv.id=c.version_id
                   WHERE vv.drawing_id=d.id AND c.status='pending') AS pending_confirms,
                 (SELECT COUNT(*) FROM tasks t WHERE t.drawing_id=d.id AND t.status='in_progress'
                   AND t.version_id IS NOT NULL AND t.version_id != d.current_version_id) AS outdated_tasks
          FROM drawings d
          LEFT JOIN disciplines di ON di.id=d.discipline_id
          LEFT JOIN areas a ON a.id=d.area_id
          LEFT JOIN drawing_versions v ON v.id=d.current_version_id
          WHERE d.project_id=? ORDER BY d.code`).all(pid));
      }
      if (kind === 'tasks') return json(res, 200, listTasks(pid));
      return json(res, 200, db.prepare(`SELECT * FROM ${kind} WHERE project_id=? ORDER BY id`).all(pid));
    }
    if (req.method === 'POST') {
      if (!requireRole(user, res, ['admin', 'designer'])) return;
      const b = await body();
      if (kind === 'drawings') {
        if (!b.code || !b.name) return fail(res, 400, '图纸编号与名称必填');
        try {
          const r = db.prepare('INSERT INTO drawings (project_id,discipline_id,area_id,code,name) VALUES (?,?,?,?,?)')
            .run(pid, b.discipline_id || null, b.area_id || null, b.code.trim(), b.name.trim());
          return json(res, 200, { id: Number(r.lastInsertRowid) });
        } catch { return fail(res, 400, '图纸编号在本项目中已存在'); }
      }
      if (kind === 'tasks') {
        if (!b.name) return fail(res, 400, '任务名称必填');
        let versionId = b.version_id || null;
        if (b.drawing_id && !versionId) {
          const d = db.prepare('SELECT current_version_id FROM drawings WHERE id=?').get(b.drawing_id);
          versionId = d ? d.current_version_id : null;
        }
        const r = db.prepare('INSERT INTO tasks (project_id,name,drawing_id,version_id,crew_id) VALUES (?,?,?,?,?)')
          .run(pid, b.name, b.drawing_id || null, versionId, b.crew_id || null);
        return json(res, 200, { id: Number(r.lastInsertRowid) });
      }
      if (!b.name) return fail(res, 400, '名称必填');
      const r = kind === 'crews'
        ? db.prepare('INSERT INTO crews (project_id,name,contact) VALUES (?,?,?)').run(pid, b.name, b.contact || '')
        : db.prepare(`INSERT INTO ${kind} (project_id,name) VALUES (?,?)`).run(pid, b.name);
      return json(res, 200, { id: Number(r.lastInsertRowid) });
    }
  }

  // 图纸详情：完整演变（版本 + 审核 + 差异 + 班组确认 + 领取 + 问题）
  const dm = /^\/api\/drawings\/(\d+)$/.exec(url.pathname);
  if (dm && req.method === 'GET') {
    const id = Number(dm[1]);
    const drawing = db.prepare(`
      SELECT d.*, di.name AS discipline_name, a.name AS area_name, p.name AS project_name
      FROM drawings d
      LEFT JOIN disciplines di ON di.id=d.discipline_id
      LEFT JOIN areas a ON a.id=d.area_id
      JOIN projects p ON p.id=d.project_id WHERE d.id=?`).get(id);
    if (!drawing) return fail(res, 404, '图纸不存在');
    drawing.versions = db.prepare(`
      SELECT v.*, u.name AS submitted_name,
        (SELECT COUNT(*) FROM confirmations c WHERE c.version_id=v.id AND c.status='pending') AS pending_count,
        (SELECT COUNT(*) FROM confirmations c WHERE c.version_id=v.id AND c.status='confirmed') AS confirmed_count
      FROM drawing_versions v LEFT JOIN users u ON u.id=v.submitted_by
      WHERE v.drawing_id=? ORDER BY v.id`).all(id);
    const vids = drawing.versions.map(v => v.id);
    const inClause = vids.length ? vids.join(',') : '-1';
    drawing.approvals = db.prepare(`
      SELECT a.*, u.name AS approver_name FROM approvals a
      JOIN users u ON u.id=a.approver_id
      WHERE a.version_id IN (${inClause}) ORDER BY a.id`).all();
    drawing.diffs = db.prepare(`SELECT * FROM version_diffs WHERE version_id IN (${inClause}) ORDER BY id`).all();
    drawing.confirmations = db.prepare(`
      SELECT c.*, cr.name AS crew_name, u.name AS confirmed_by_name
      FROM confirmations c JOIN crews cr ON cr.id=c.crew_id
      LEFT JOIN users u ON u.id=c.confirmed_by
      WHERE c.version_id IN (${inClause}) ORDER BY c.id`).all();
    drawing.receipts = db.prepare(`
      SELECT r.*, cr.name AS crew_name FROM receipts r JOIN crews cr ON cr.id=r.crew_id
      WHERE r.drawing_id=? ORDER BY r.id`).all(id);
    drawing.issues = db.prepare(`
      SELECT i.*, v.version_no, u.name AS created_by_name
      FROM issues i JOIN drawing_versions v ON v.id=i.version_id
      LEFT JOIN users u ON u.id=i.created_by
      WHERE i.drawing_id=? ORDER BY i.id DESC`).all(id);
    return json(res, 200, drawing);
  }

  // 新建版本：必须填写变更原因并关联被替代版本（初版除外）
  const vm = /^\/api\/drawings\/(\d+)\/versions$/.exec(url.pathname);
  if (vm && req.method === 'POST') {
    if (!requireRole(user, res, ['admin', 'designer'])) return;
    const drawingId = Number(vm[1]);
    const drawing = db.prepare('SELECT * FROM drawings WHERE id=?').get(drawingId);
    if (!drawing) return fail(res, 404, '图纸不存在');
    const b = await body();
    if (!b.version_no) return fail(res, 400, '版本号必填');
    const hasVersions = db.prepare('SELECT COUNT(*) c FROM drawing_versions WHERE drawing_id=?').get(drawingId).c > 0;
    if (hasVersions) {
      if (!b.change_reason || !b.change_reason.trim()) return fail(res, 400, '上传新版本必须选择/填写变更原因');
      if (!b.supersedes_id) return fail(res, 400, '必须关联被替代的版本');
      const sup = db.prepare('SELECT * FROM drawing_versions WHERE id=? AND drawing_id=?').get(b.supersedes_id, drawingId);
      if (!sup) return fail(res, 400, '被替代版本不属于该图纸');
    }
    let fileName = '', filePath = '';
    if (b.file_data) {
      try {
        filePath = saveUploaded(b.file_data, b.file_name);
        fileName = b.file_name || filePath;
      } catch (e) { return fail(res, 400, e.message); }
    }
    try {
      const r = db.prepare(`INSERT INTO drawing_versions
        (drawing_id,version_no,title,file_name,file_path,change_reason,supersedes_id,status,submitted_by)
        VALUES (?,?,?,?,?,?,?,'draft',?)`)
        .run(drawingId, b.version_no.trim(), b.title || drawing.name, fileName, filePath,
             b.change_reason || null, b.supersedes_id || null, user.id);
      return json(res, 200, { id: Number(r.lastInsertRowid) });
    } catch { return fail(res, 400, '版本号已存在'); }
  }

  // 版本操作
  const vom = /^\/api\/versions\/(\d+)\/(submit|review|edit)$/.exec(url.pathname);
  if (vom && req.method === 'POST') {
    const vid = Number(vom[1]); const op = vom[2];
    const v = db.prepare('SELECT * FROM drawing_versions WHERE id=?').get(vid);
    if (!v) return fail(res, 404, '版本不存在');
    if (op === 'edit') {
      if (!requireRole(user, res, ['admin', 'designer'])) return;
      if (!['draft', 'returned'].includes(v.status)) return fail(res, 400, '仅草稿或被退回的版本可修改');
      const b = await body();
      if (v.supersedes_id && !(b.change_reason && b.change_reason.trim()))
        return fail(res, 400, '变更原因必填');
      let fileName = v.file_name, filePath = v.file_path;
      if (b.file_data) {
        try { filePath = saveUploaded(b.file_data, b.file_name); fileName = b.file_name || filePath; }
        catch (e) { return fail(res, 400, e.message); }
      }
      db.prepare(`UPDATE drawing_versions SET title=?, change_reason=?, file_name=?, file_path=?,
        submit_note=? WHERE id=?`)
        .run(b.title ?? v.title, b.change_reason ?? v.change_reason, fileName, filePath,
             b.submit_note ?? v.submit_note, vid);
      return json(res, 200, { ok: true });
    }
    if (op === 'submit') {
      if (!requireRole(user, res, ['admin', 'designer'])) return;
      if (!['draft', 'returned'].includes(v.status)) return fail(res, 400, '该版本当前不可提交');
      if (v.supersedes_id && !v.change_reason) return fail(res, 400, '变更原因必填，请先完善版本信息');
      db.prepare("UPDATE drawing_versions SET status='pending_design', submitted_by=? WHERE id=?")
        .run(user.id, vid);
      return json(res, 200, { ok: true });
    }
    if (op === 'review') {
      if (!requireRole(user, res, ['admin', 'designer', 'tech', 'pm'])) return;
      const b = await body();
      if (!['approved', 'rejected'].includes(b.action)) return fail(res, 400, '无效的审核动作');
      if (b.action === 'rejected' && !(b.comment && b.comment.trim()))
        return fail(res, 400, '退回时必须填写退回意见');
      try {
        applyReview(vid, user, b.action, (b.comment || '').trim());
        return json(res, 200, { ok: true });
      } catch (e) { return fail(res, 400, e.message); }
    }
  }

  // 待我确认（班组）
  if (req.method === 'GET' && url.pathname === '/api/my/confirmations') {
    if (!requireRole(user, res, ['crew'])) return;
    return json(res, 200, db.prepare(`
      SELECT c.id, c.status, c.confirmed_at, v.id AS version_id, v.version_no,
             d.id AS drawing_id, d.code, d.name AS drawing_name, p.name AS project_name
      FROM confirmations c
      JOIN drawing_versions v ON v.id=c.version_id
      JOIN drawings d ON d.id=v.drawing_id
      JOIN projects p ON p.id=d.project_id
      WHERE c.crew_id=? ORDER BY c.status, c.id DESC`).all(user.crew_id));
  }

  // 班组确认收到新版本
  const cm = /^\/api\/confirmations\/(\d+)\/confirm$/.exec(url.pathname);
  if (cm && req.method === 'POST') {
    if (!requireRole(user, res, ['crew', 'admin'])) return;
    const c = db.prepare('SELECT * FROM confirmations WHERE id=?').get(Number(cm[1]));
    if (!c) return fail(res, 404, '确认记录不存在');
    if (user.role === 'crew' && c.crew_id !== user.crew_id) return fail(res, 403, '只能确认本班组的记录');
    if (c.status === 'confirmed') return fail(res, 400, '该班组已确认，无需重复确认');
    const t = db.prepare("SELECT datetime('now','localtime') t").get().t;
    db.prepare("UPDATE confirmations SET status='confirmed', confirmed_at=?, confirmed_by=? WHERE id=?")
      .run(t, user.id, c.id);
    // 确认收到新版本即视为持有该版本，后续变更将继续对其生成确认任务
    const ver = db.prepare('SELECT drawing_id FROM drawing_versions WHERE id=?').get(c.version_id);
    if (ver) {
      db.prepare('INSERT OR IGNORE INTO receipts (drawing_id,version_id,crew_id) VALUES (?,?,?)')
        .run(ver.drawing_id, c.version_id, c.crew_id);
    }
    return json(res, 200, { ok: true });
  }

  // 领取图纸（登记哪个班组持有过哪个版本）
  const rm = /^\/api\/drawings\/(\d+)\/receive$/.exec(url.pathname);
  if (rm && req.method === 'POST') {
    if (!requireRole(user, res, ['admin', 'designer', 'crew'])) return;
    const drawingId = Number(rm[1]);
    const b = await body();
    const d = db.prepare('SELECT * FROM drawings WHERE id=?').get(drawingId);
    if (!d || !d.current_version_id) return fail(res, 400, '图纸尚无有效版本，无法领取');
    const crewId = user.role === 'crew' ? user.crew_id : (b.crew_id || null);
    if (!crewId) return fail(res, 400, '请选择领取班组');
    try {
      db.prepare('INSERT INTO receipts (drawing_id,version_id,crew_id) VALUES (?,?,?)')
        .run(drawingId, d.current_version_id, crewId);
    } catch { return fail(res, 400, '该班组已领取当前版本'); }
    return json(res, 200, { ok: true });
  }

  // 任务完工：关联旧图时必须明显提示并禁止标记完工
  const tm = /^\/api\/tasks\/(\d+)\/complete$/.exec(url.pathname);
  if (tm && req.method === 'POST') {
    if (!requireRole(user, res, ['admin', 'pm', 'crew'])) return;
    const t = db.prepare(`
      SELECT t.*, d.code AS drawing_code, cv.version_no AS current_no
      FROM tasks t LEFT JOIN drawings d ON d.id=t.drawing_id
      LEFT JOIN drawing_versions cv ON cv.id=d.current_version_id
      WHERE t.id=?`).get(Number(tm[1]));
    if (!t) return fail(res, 404, '任务不存在');
    if (t.status === 'done') return fail(res, 400, '任务已完工');
    if (user.role === 'crew' && t.crew_id !== user.crew_id) return fail(res, 403, '只能操作本班组任务');
    const outdated = t.drawing_id && t.version_id != null && t.version_id !== (
      db.prepare('SELECT current_version_id FROM drawings WHERE id=?').get(t.drawing_id) || {}
    ).current_version_id;
    if (outdated) {
      return fail(res, 409,
        '【禁止完工】任务「' + t.name + '」仍关联已作废的旧图 ' + t.drawing_code +
        '，当前有效版本为 ' + t.current_no + '。请先改按新版本施工并更新任务关联版本后，再标记完工。');
    }
    const now = db.prepare("SELECT datetime('now','localtime') t").get().t;
    db.prepare("UPDATE tasks SET status='done', done_at=? WHERE id=?").run(now, t.id);
    return json(res, 200, { ok: true });
  }

  // 更新任务关联版本（班组按新图施工后切换）
  const tum = /^\/api\/tasks\/(\d+)\/version$/.exec(url.pathname);
  if (tum && req.method === 'POST') {
    if (!requireRole(user, res, ['admin', 'pm', 'crew'])) return;
    const tid = Number(tum[1]);
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(tid);
    if (!t) return fail(res, 404, '任务不存在');
    const b = await body();
    if (b.version_id) {
      const v = db.prepare(`SELECT * FROM drawing_versions WHERE id=? AND drawing_id=? AND status='effective'`)
        .get(b.version_id, t.drawing_id);
      if (!v) return fail(res, 400, '只能关联当前生效版本');
      db.prepare('UPDATE tasks SET version_id=? WHERE id=?').run(v.id, tid);
    }
    return json(res, 200, { ok: true });
  }

  // 现场问题：在具体图纸位置创建，关联照片/责任人/意见，永久绑定原版本
  const im = /^\/api\/drawings\/(\d+)\/issues$/.exec(url.pathname);
  if (im && req.method === 'POST') {
    if (!requireAuth(user, res)) return;
    const drawingId = Number(im[1]);
    const b = await body();
    if (!b.version_id) return fail(res, 400, '问题必须关联到具体图纸版本');
    const v = db.prepare('SELECT * FROM drawing_versions WHERE id=? AND drawing_id=?')
      .get(b.version_id, drawingId);
    if (!v) return fail(res, 400, '版本不属于该图纸');
    if (!b.title || !b.title.trim()) return fail(res, 400, '问题标题必填');
    const photos = [];
    for (const item of (b.photos || []).slice(0, 6)) {
      try { photos.push(saveUploaded(item.data, item.name)); } catch { /* 忽略坏图 */ }
    }
    const r = db.prepare(`INSERT INTO issues
      (drawing_id,version_id,x,y,title,description,photos,assignee,opinion,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(drawingId, v.id, Number(b.x) || 0, Number(b.y) || 0, b.title.trim(),
           b.description || '', JSON.stringify(photos), b.assignee || '', b.opinion || '', user.id);
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }
  const ium = /^\/api\/issues\/(\d+)$/.exec(url.pathname);
  if (ium && req.method === 'POST') {
    const issue = db.prepare('SELECT * FROM issues WHERE id=?').get(Number(ium[1]));
    if (!issue) return fail(res, 404, '问题不存在');
    const b = await body();
    db.prepare('UPDATE issues SET assignee=?, opinion=?, status=? WHERE id=?')
      .run(b.assignee ?? issue.assignee, b.opinion ?? issue.opinion,
           b.status ?? issue.status, issue.id);
    return json(res, 200, { ok: true });
  }
  if (ium && req.method === 'GET') {
    return json(res, 200, db.prepare(`
      SELECT i.*, v.version_no, u.name AS created_by_name FROM issues i
      JOIN drawing_versions v ON v.id=i.version_id
      LEFT JOIN users u ON u.id=i.created_by WHERE i.id=?`).get(Number(ium[1])));
  }

  return fail(res, 404, '未知接口');
}

/* ---------- 静态资源与上传文件 ---------- */

function serveStatic(res, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe === '' || safe === '.' ? 'index.html' : safe);
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) =>
        e2 ? fail(res, 404, 'Not found') : json(res, 200, idx.toString('utf8'), { 'Content-Type': 'text/html; charset=utf-8' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveUpload(req, res, url) {
  const m = /^\/files\/([a-f0-9]+\.[a-z0-9]+)$/.exec(url.pathname);
  if (!m) return serveStatic(res, '');
  const file = path.join(UPLOAD_DIR, m[1]);
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, '文件不存在');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Disposition': 'inline; filename="' + m[1] + '"',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const user = currentUser(req);
      return await handleApi(req, res, url, user);
    }
    if (url.pathname.startsWith('/files/')) return serveUpload(req, res, url);
    return serveStatic(res, url.pathname.replace(/^\/+/, ''));
  } catch (e) {
    return fail(res, 500, e.message || '服务器内部错误');
  }
});

server.listen(PORT, () => {
  console.log('图纸变更管理平台已启动: http://localhost:' + PORT);
});
