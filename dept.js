// 部署ページ（朝礼・シフト表・掃除/日誌担当表・その他の共有ファイル）
//  - 部署＝users.department。自部門のページは全員が閲覧できる。管理者は全部署を切り替えて閲覧
//  - 朝礼メモ：同じ部門の職員なら誰でも入力・修正できる（最終更新者を記録）。日ごとに1件
//  - ファイル：アップロード・削除は課長・主任・部長・管理者。保存先は DB と同じ場所の files/（永続ディスク上）
const path = require('path');
const fs = require('fs');
const dbm = require('./db');
const db = dbm.raw;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const FILES_DIR = process.env.FILES_DIR || path.join(path.dirname(DB_PATH), 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS dept_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT    NOT NULL,
    day        TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (department, day)
  );
  CREATE TABLE IF NOT EXISTS dept_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    department  TEXT    NOT NULL,
    category    TEXT    NOT NULL,                    -- shift / duty / other
    month       TEXT    NOT NULL DEFAULT '',         -- YYYY-MM（シフト・担当表の対象月）
    title       TEXT    NOT NULL,
    orig_name   TEXT    NOT NULL,
    stored_name TEXT    NOT NULL,
    mime        TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_dept_files ON dept_files(department, category, month);
`);

const CATEGORIES = { shift: 'シフト表', duty: '掃除・日誌担当表', other: 'その他の資料' };
const ALLOWED = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'image/png': '.png', 'image/jpeg': '.jpg',
};
const MAX_SIZE = 10 * 1024 * 1024;

const stmts = {
  today: db.prepare("SELECT date('now','localtime') AS d"),
  noteGet: db.prepare('SELECT n.*, u.name AS editorName FROM dept_notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.department = ? AND n.day = ?'),
  noteUpsert: db.prepare(`INSERT INTO dept_notes (department, day, body, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(department, day) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = datetime('now','localtime')`),
  noteList: db.prepare('SELECT n.*, u.name AS editorName FROM dept_notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.department = ? AND n.day < ? ORDER BY n.day DESC LIMIT ?'),
  fileInsert: db.prepare('INSERT INTO dept_files (department, category, month, title, orig_name, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  fileById: db.prepare('SELECT f.*, u.name AS uploaderName FROM dept_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.id = ?'),
  fileList: db.prepare('SELECT f.*, u.name AS uploaderName FROM dept_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.department = ? ORDER BY f.category, f.month DESC, f.id DESC'),
  fileDelete: db.prepare('DELETE FROM dept_files WHERE id = ?'),
  members: db.prepare("SELECT id, staff_id AS staffId, name, section, job, role FROM users WHERE department = ? AND (? = '' OR section = ?) ORDER BY section, staff_id"),
};

const today = () => stmts.today.get().d;
// ページキー：'事務部' または '看護部/3A'
const parseKey = (key) => { const [department, section = ''] = String(key || '').split('/'); return { department, section }; };
const isValidKey = (key) => { const { department, section } = parseKey(key); const d = dbm.DEPARTMENTS.find((x) => x.name === department); return !!d && (!section || d.sections.includes(section)); };
const canEditFiles = (u) => !!(u.is_admin || ['shunin', 'kacho', 'bucho'].includes(u.role || ''));
const canView = () => true; // 全職員がどの部署のページも閲覧できる
const belongs = (u, key) => { const { department, section } = parseKey(key); return u.department === department && (!section || !u.section || u.section === section); };
const canEditNote = (u, key) => !!(u.is_admin || belongs(u, key));           // 朝礼：その部署の職員
const canManageFiles = (u, key) => !!(u.is_admin || (canEditFiles(u) && belongs(u, key))); // ファイル：その部署の権限者
const pageList = () => dbm.DEPARTMENTS.flatMap((d) => [{ key: d.name, department: d.name, section: '', label: d.name }, ...d.sections.map((s) => ({ key: `${d.name}/${s}`, department: d.name, section: s, label: `${d.name} ${s}` }))]);

const pubFile = (f) => ({ id: f.id, department: f.department, category: f.category, categoryLabel: CATEGORIES[f.category], month: f.month, title: f.title, origName: f.orig_name, mime: f.mime, size: f.size, uploaderName: f.uploaderName || '', createdAt: f.created_at, url: `/api/dept/files/${f.id}/download` });
const pubNote = (n) => (n ? { day: n.day, body: n.body, editorName: n.editorName || '', updatedAt: n.updated_at } : null);

module.exports = {
  CATEGORIES, ALLOWED, MAX_SIZE, FILES_DIR, today, canEditFiles, canView, canEditNote, canManageFiles, isValidKey, parseKey, pageList, pubFile,
  page: (key) => {
    const { department, section } = parseKey(key);
    return {
      department: key, baseDepartment: department, section, label: section ? `${department} ${section}` : department, today: today(),
      note: pubNote(stmts.noteGet.get(key, today())),
      recentNotes: stmts.noteList.all(key, today(), 14).map(pubNote),
      files: stmts.fileList.all(key).map(pubFile),
      members: stmts.members.all(department, section, section),
      categories: CATEGORIES,
    };
  },
  getNote: (dept, day) => pubNote(stmts.noteGet.get(dept, day)),
  saveNote: (dept, day, body, userId) => { stmts.noteUpsert.run(dept, day, String(body || '').trim().slice(0, 4000), userId); return pubNote(stmts.noteGet.get(dept, day)); },
  addFile: ({ department, category, month, title, origName, storedName, mime, size, userId }) => {
    if (!CATEGORIES[category]) return { error: '種類を選択してください' };
    if ((category === 'shift' || category === 'duty') && !/^\d{4}-\d{2}$/.test(month || '')) return { error: '対象月を選択してください' };
    const info = stmts.fileInsert.run(department, category, month || '', String(title || origName).trim().slice(0, 100), origName, storedName, mime, size, userId);
    return { file: pubFile(stmts.fileById.get(info.lastInsertRowid)) };
  },
  findFile: (id) => stmts.fileById.get(id),
  removeFile: (id) => {
    const f = stmts.fileById.get(id);
    if (!f) return false;
    stmts.fileDelete.run(id);
    try { fs.unlinkSync(path.join(FILES_DIR, f.stored_name)); } catch (_) { /* 既に無ければ無視 */ }
    return true;
  },
};
