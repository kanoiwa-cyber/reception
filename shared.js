// 院内共有資料（お役立ちの「院内資料」）：職員食堂メニュー・各種マニュアル・当直表などを写真・PDFで登録する
// 登録できるのは 管理者・部長・課長。全職員が閲覧できる。ファイルの保存先は部署ファイルと同じ FILES_DIR
const path = require('path');
const fs = require('fs');
const dbm = require('./db');
const dept = require('./dept');
const db = dbm.raw;

db.exec(`
  CREATE TABLE IF NOT EXISTS shared_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    orig_name   TEXT    NOT NULL,
    stored_name TEXT    NOT NULL,
    mime        TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_shared_files ON shared_files(slot, id);
`);

// 画面に出す枠。順番どおりに表示。note は空のときの説明
const SLOTS = [
  { key: 'shokudo', section: '職員食堂', title: '職員食堂・売店弁当メニュー', note: '営業時間 11:30〜14:30' },
  { key: 'oncall', section: '当直・救急', title: '当直オンコール表', note: '' },
  { key: 'kyujitsu', section: '当直・救急', title: '東山梨地域休日救急当直表', note: '' },
  { key: 'bcp', section: 'マニュアル', title: '停電時BCP対応マニュアル', note: '' },
  { key: 'kansen', section: 'マニュアル', title: '感染対策マニュアル', note: '' },
  { key: 'saigai', section: 'マニュアル', title: '災害対策マニュアル', note: '' },
];
const QUOTA = Number(process.env.SHARED_QUOTA_MB || 100) * 1024 * 1024; // 共有資料全体の上限

const stmts = {
  list: db.prepare('SELECT f.*, u.name AS uploaderName FROM shared_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.slot = ? ORDER BY f.id DESC'),
  counts: db.prepare('SELECT slot, COUNT(*) AS n, MAX(created_at) AS latest FROM shared_files GROUP BY slot'),
  byId: db.prepare('SELECT * FROM shared_files WHERE id = ?'),
  insert: db.prepare('INSERT INTO shared_files (slot, title, orig_name, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  del: db.prepare('DELETE FROM shared_files WHERE id = ?'),
  usage: db.prepare('SELECT COALESCE(SUM(size),0) AS b, COUNT(*) AS n FROM shared_files'),
};
const pub = (f) => ({ id: f.id, slot: f.slot, title: f.title, origName: f.orig_name, mime: f.mime, size: f.size, uploaderName: f.uploaderName || '', createdAt: f.created_at, url: `/api/shared/files/${f.id}/download` });

module.exports = {
  SLOTS, QUOTA,
  slot: (key) => SLOTS.find((s) => s.key === key) || null,
  canEdit: (u) => !!(u.is_admin || u.role === 'bucho' || u.role === 'kacho'),
  summary() {
    const c = Object.fromEntries(stmts.counts.all().map((r) => [r.slot, { count: r.n, latest: r.latest }]));
    return SLOTS.map((s) => ({ ...s, count: (c[s.key] || {}).count || 0, latest: (c[s.key] || {}).latest || '' }));
  },
  list: (key) => stmts.list.all(key).map(pub),
  storage: () => ({ ...stmts.usage.get(), quota: QUOTA }),
  add({ slot, title, origName, storedName, mime, size, userId }) {
    const u = stmts.usage.get();
    if (u.b + size > QUOTA) return { error: `院内資料の上限（${Math.round(QUOTA / 1048576)}MB）を超えます。古いファイルを削除してください` };
    const t = String(title || '').trim().slice(0, 100) || origName.replace(/\.[^.]+$/, '');
    const info = stmts.insert.run(slot, t, origName, storedName, mime, size, userId);
    return { file: pub({ ...stmts.byId.get(info.lastInsertRowid), uploaderName: '' }) };
  },
  find: (id) => stmts.byId.get(id),
  filePath: (f) => path.join(dept.FILES_DIR, f.stored_name),
  remove(id) {
    const f = stmts.byId.get(id);
    if (!f) return false;
    stmts.del.run(id);
    try { fs.unlinkSync(path.join(dept.FILES_DIR, f.stored_name)); } catch (_) {}
    return true;
  },
};
