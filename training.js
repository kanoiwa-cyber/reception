// 研修ページ（医療安全・感染症対策 など）
//  - 全職員が閲覧。アップロード・削除は権限者（管理者、主任・課長・部長）のみ
//  - 資料ごとに「受講しました」を記録（施設基準の研修受講記録に使える）
const path = require('path');
const fs = require('fs');
const dbm = require('./db');
const db = dbm.raw;
const dept = require('./dept');

const DEFAULT_CATEGORIES = ['医療安全', '感染症対策']; // 登録時のラベル候補（一覧は分けずに表示）

db.exec(`
  CREATE TABLE IF NOT EXISTS training_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    held_on     TEXT    NOT NULL DEFAULT '',          -- 実施日・公開日
    orig_name   TEXT    NOT NULL DEFAULT '',
    stored_name TEXT    NOT NULL DEFAULT '',
    mime        TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    url         TEXT    NOT NULL DEFAULT '',          -- 外部リンク（動画など）の場合
    required    INTEGER NOT NULL DEFAULT 0,           -- 1 = 全職員必須
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS training_done (
    item_id INTEGER NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    done_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (item_id, user_id)
  );
`);

// 研修リンク（外部サイト・期日付き）。権限者が登録・編集する
db.exec(`
  CREATE TABLE IF NOT EXISTS training_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    deadline   TEXT    NOT NULL DEFAULT '',   -- 期日の表示文字列（例：11/27（金）12時まで）
    due_date   TEXT    NOT NULL DEFAULT '',   -- 並び替え・期限切れ判定用 YYYY-MM-DD（任意）
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
if (db.prepare('SELECT COUNT(*) AS c FROM training_links').get().c === 0) {
  const ins = db.prepare('INSERT INTO training_links (title, url, note, deadline, due_date, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('職員研修ページ（医療安全・感染症対策）', 'https://kanoiwa-hospital.or.jp/%e8%81%b7%e5%93%a1%e7%a0%94%e4%bf%ae%e3%83%9a%e3%83%bc%e3%82%b8%e3%80%8c%e3%83%91%e3%82%b9%e3%83%af%e3%83%bc%e3%83%89%e3%82%92%e5%85%a5%e5%8a%9b%e3%81%97%e3%81%a6%e3%81%8f%e3%81%a0%e3%81%95%e3%81%84', 'ページのパスワード：202611', '11/27（金）12時まで', '2026-11-27', 1);
  ins.run('ストレスチェック', 'https://tmsnavi-lite.com/v4/0015-84022/jp/login/index/', '', '11/7（土）まで', '2026-11-07', 3);
}
const lstmts = {
  list: db.prepare('SELECT * FROM training_links ORDER BY active DESC, sort_order, id'),
  byId: db.prepare('SELECT * FROM training_links WHERE id = ?'),
  insert: db.prepare('INSERT INTO training_links (title, url, note, deadline, due_date, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare("UPDATE training_links SET title = ?, url = ?, note = ?, deadline = ?, due_date = ?, sort_order = ?, active = ?, updated_at = datetime('now','localtime') WHERE id = ?"),
  del: db.prepare('DELETE FROM training_links WHERE id = ?'),
};
const todayStr = () => db.prepare("SELECT date('now','localtime') AS d").get().d;
const pubLink = (l) => ({ id: l.id, title: l.title, url: l.url, note: l.note, deadline: l.deadline, dueDate: l.due_date, sortOrder: l.sort_order, active: !!l.active, expired: !!(l.due_date && l.due_date < todayStr()) });
function validateLink(b) {
  const title = String(b.title || '').trim().slice(0, 100), url = String(b.url || '').trim().slice(0, 500);
  if (!title) return { error: 'タイトルを入力してください' };
  if (!/^https?:\/\//.test(url) && !/^\/\?view=/.test(url)) return { error: 'URLは https:// から入力してください' };
  const dueDate = String(b.dueDate || '').trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: '期日（日付）は YYYY-MM-DD 形式で入力してください' };
  return { value: { title, url, note: String(b.note || '').trim().slice(0, 200), deadline: String(b.deadline || '').trim().slice(0, 60), dueDate, sortOrder: Number(b.sortOrder) || 0, active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1 } };
}

const stmts = {
  list: db.prepare(`SELECT t.*, u.name AS uploaderName, (SELECT COUNT(*) FROM training_done d WHERE d.item_id = t.id) AS doneCount,
    (SELECT done_at FROM training_done d WHERE d.item_id = t.id AND d.user_id = ?) AS myDoneAt
    FROM training_items t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.category, t.held_on DESC, t.id DESC`),
  byId: db.prepare('SELECT t.*, u.name AS uploaderName FROM training_items t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?'),
  insert: db.prepare('INSERT INTO training_items (category, title, description, held_on, orig_name, stored_name, mime, size, url, required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  del: db.prepare('DELETE FROM training_items WHERE id = ?'),
  done: db.prepare('INSERT OR IGNORE INTO training_done (item_id, user_id) VALUES (?, ?)'),
  undone: db.prepare('DELETE FROM training_done WHERE item_id = ? AND user_id = ?'),
  doneList: db.prepare('SELECT d.done_at, u.name, u.staff_id AS staffId, u.department, u.section FROM training_done d JOIN users u ON u.id = d.user_id WHERE d.item_id = ? ORDER BY u.department, u.section, u.staff_id'),
  notDone: db.prepare('SELECT u.name, u.staff_id AS staffId, u.department, u.section FROM users u WHERE NOT EXISTS (SELECT 1 FROM training_done d WHERE d.item_id = ? AND d.user_id = u.id) ORDER BY u.department, u.section, u.staff_id'),
  categories: db.prepare('SELECT DISTINCT category FROM training_items'),
  userCount: db.prepare('SELECT COUNT(*) AS c FROM users'),
};

const canEdit = (u) => dept.canEditFiles(u);
const pub = (t) => ({
  id: t.id, category: t.category, title: t.title, description: t.description, heldOn: t.held_on, required: !!t.required,
  origName: t.orig_name, mime: t.mime, size: t.size, url: t.url, fileUrl: t.stored_name ? `/api/training/${t.id}/download` : '',
  uploaderName: t.uploaderName || '', createdAt: t.created_at, doneCount: t.doneCount || 0, myDoneAt: t.myDoneAt || '',
});

module.exports = {
  canEdit,
  links: (all) => lstmts.list.all().map(pubLink).filter((l) => all || l.active),
  createLink(b, userId) { const v = validateLink(b); if (v.error) return v; const x = v.value; const info = lstmts.insert.run(x.title, x.url, x.note, x.deadline, x.dueDate, x.sortOrder, userId); return { link: pubLink(lstmts.byId.get(info.lastInsertRowid)) }; },
  updateLink(id, b) { const l = lstmts.byId.get(id); if (!l) return { error: 'リンクが見つかりません' }; const v = validateLink({ ...pubLink(l), ...b }); if (v.error) return v; const x = v.value; lstmts.update.run(x.title, x.url, x.note, x.deadline, x.dueDate, x.sortOrder, x.active, id); return { link: pubLink(lstmts.byId.get(id)) }; },
  removeLink: (id) => lstmts.del.run(id),
  categories: () => [...new Set([...DEFAULT_CATEGORIES, ...stmts.categories.all().map((r) => r.category)])],
  list: (user) => stmts.list.all(user.id).map(pub),
  find: (id) => stmts.byId.get(id),
  pub,
  create({ category, title, description, heldOn, origName, storedName, mime, size, url, required, userId }) {
    const c = String(category || '').trim().slice(0, 30) || '研修', t = String(title || '').trim().slice(0, 100);
    if (!t) return { error: 'タイトルを入力してください' };
    if (!storedName && !/^https?:\/\//.test(url || '')) return { error: 'ファイルを選択するか、URLを入力してください' };
    const info = stmts.insert.run(c, t, String(description || '').trim().slice(0, 1000), /^\d{4}-\d{2}-\d{2}$/.test(heldOn || '') ? heldOn : '', origName || '', storedName || '', mime || '', size || 0, String(url || '').trim().slice(0, 500), required ? 1 : 0, userId);
    return { item: pub(stmts.byId.get(info.lastInsertRowid)) };
  },
  remove(id) {
    const t = stmts.byId.get(id); if (!t) return false;
    stmts.del.run(id);
    if (t.stored_name) { try { fs.unlinkSync(path.join(dept.FILES_DIR, t.stored_name)); } catch (_) {} }
    return true;
  },
  markDone: (id, userId, on) => (on ? stmts.done.run(id, userId) : stmts.undone.run(id, userId)),
  status: (id) => ({ done: stmts.doneList.all(id), notDone: stmts.notDone.all(id), total: stmts.userCount.get().c }),
};
