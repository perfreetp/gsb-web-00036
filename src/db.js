const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','designer','tech','pm','crew')),
  crew_id INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS disciplines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  contact TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS drawings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  discipline_id INTEGER REFERENCES disciplines(id),
  area_id INTEGER REFERENCES areas(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(project_id, code)
);
CREATE TABLE IF NOT EXISTS drawing_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawing_id INTEGER NOT NULL REFERENCES drawings(id),
  version_no TEXT NOT NULL,
  title TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  change_reason TEXT,
  supersedes_id INTEGER REFERENCES drawing_versions(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','pending_design','pending_tech','pending_pm','effective','obsolete','returned')),
  submit_note TEXT DEFAULT '',
  submitted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  effective_at TEXT,
  UNIQUE(drawing_id, version_no)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES drawing_versions(id),
  level TEXT NOT NULL CHECK(level IN ('design','tech','pm')),
  approver_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('approved','rejected')),
  comment TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS version_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES drawing_versions(id),
  from_version_id INTEGER REFERENCES drawing_versions(id),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawing_id INTEGER NOT NULL REFERENCES drawings(id),
  version_id INTEGER NOT NULL REFERENCES drawing_versions(id),
  crew_id INTEGER NOT NULL REFERENCES crews(id),
  received_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(version_id, crew_id)
);
CREATE TABLE IF NOT EXISTS confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES drawing_versions(id),
  crew_id INTEGER NOT NULL REFERENCES crews(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed')),
  confirmed_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  UNIQUE(version_id, crew_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  drawing_id INTEGER REFERENCES drawings(id),
  version_id INTEGER REFERENCES drawing_versions(id),
  crew_id INTEGER REFERENCES crews(id),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawing_id INTEGER NOT NULL REFERENCES drawings(id),
  version_id INTEGER NOT NULL REFERENCES drawing_versions(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  photos TEXT DEFAULT '[]',
  assignee TEXT DEFAULT '',
  opinion TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

function hash(pw) {
  return crypto.createHash('sha256').update('dcms:' + pw).digest('hex');
}

function seed() {
  const has = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (has) return;
  const insUser = db.prepare('INSERT INTO users (username,password,name,role,crew_id) VALUES (?,?,?,?,?)');
  insUser.run('admin', hash('admin123'), '系统管理员', 'admin', null);
  insUser.run('designer', hash('design123'), '王设计', 'designer', null);
  insUser.run('tech', hash('tech123'), '李技术', 'tech', null);
  insUser.run('pm', hash('pm123'), '赵经理', 'pm', null);

  const p = db.prepare("INSERT INTO projects (name,code,description) VALUES ('示例厂房建设项目','PRJ-001','钢结构厂房及配套管网')").run();
  const pid = Number(p.lastInsertRowid);
  const insDis = db.prepare('INSERT INTO disciplines (project_id,name) VALUES (?,?)');
  const insArea = db.prepare('INSERT INTO areas (project_id,name) VALUES (?,?)');
  const insCrew = db.prepare('INSERT INTO crews (project_id,name,contact) VALUES (?,?,?)');
  const d1 = Number(insDis.run(pid, '结构').lastInsertRowid);
  const d2 = Number(insDis.run(pid, '电气').lastInsertRowid);
  insDis.run(pid, '给排水');
  const a1 = Number(insArea.run(pid, 'A区-主厂房').lastInsertRowid);
  const a2 = Number(insArea.run(pid, 'B区-办公楼').lastInsertRowid);
  const c1 = Number(insCrew.run(pid, '钢筋一班', '张工 13800000001').lastInsertRowid);
  const c2 = Number(insCrew.run(pid, '钢结构二班', '刘工 13800000002').lastInsertRowid);
  insUser.run('crew1', hash('crew123'), '张工(钢筋一班)', 'crew', c1);
  insUser.run('crew2', hash('crew123'), '刘工(钢结构二班)', 'crew', c2);

  const dr = db.prepare('INSERT INTO drawings (project_id,discipline_id,area_id,code,name) VALUES (?,?,?,?,?)')
    .run(pid, d1, a1, 'STR-A-001', '主厂房基础平面图');
  const did = Number(dr.lastInsertRowid);
  const v1 = db.prepare(`INSERT INTO drawing_versions
    (drawing_id,version_no,title,change_reason,supersedes_id,status,submitted_by,effective_at)
    VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`)
    .run(did, 'A', '主厂房基础平面图', '初版发布', null, 'effective', 2);
  const v1id = Number(v1.lastInsertRowid);
  db.prepare('UPDATE drawings SET current_version_id=? WHERE id=?').run(v1id, did);
  db.prepare('INSERT INTO version_diffs (version_id,from_version_id,summary) VALUES (?,?,?)')
    .run(v1id, null, '初版发布，无前置版本。');
  db.prepare('INSERT INTO receipts (drawing_id,version_id,crew_id) VALUES (?,?,?)').run(did, v1id, c1);
  db.prepare('INSERT INTO receipts (drawing_id,version_id,crew_id) VALUES (?,?,?)').run(did, v1id, c2);
  db.prepare(`INSERT INTO tasks (project_id,name,drawing_id,version_id,crew_id) VALUES (?,?,?,?,?)`)
    .run(pid, 'A区基础钢筋绑扎', did, v1id, c1);

  const dr2 = db.prepare('INSERT INTO drawings (project_id,discipline_id,area_id,code,name) VALUES (?,?,?,?,?)')
    .run(pid, d2, a2, 'ELE-B-003', '办公楼配电系统图');
  db.prepare('UPDATE drawings SET current_version_id=NULL WHERE id=?').run(Number(dr2.lastInsertRowid));
  console.log('Seeded demo data.');
}
seed();

module.exports = { db, hash };
