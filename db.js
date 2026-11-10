// SQLite（better-sqlite3）によるデータ保存
// 初回起動時にテーブル作成とダミーデータ（seed.js）の投入を行う
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const seed = require('./seed');
const DEPARTMENTS = require('./departments').merge(seed.DEPARTMENTS); // 部署一覧は departments.js が正。seed の課・病棟も取り込む

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id      TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    kana          TEXT    NOT NULL DEFAULT '',
    department    TEXT    NOT NULL DEFAULT '',          -- 部門（部・課）
    section       TEXT    NOT NULL DEFAULT '',          -- 課・病棟（部門内の区分。なければ空）
    job           TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT    NOT NULL DEFAULT 'general',   -- important / general / department
    department TEXT    NOT NULL DEFAULT '',          -- 部門別の対象。「看護部」=部門全体、「看護部/3A」=課のみ
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS point_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,                     -- checkin / lottery / steps / initial / admin
    points     INTEGER NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    day        TEXT    NOT NULL DEFAULT (date('now','localtime')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_point_logs_user_day ON point_logs(user_id, kind, day);
  CREATE TABLE IF NOT EXISTS steps (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,
    steps      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS contents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tab        TEXT    NOT NULL,                     -- culture / learn / tools
    section    TEXT    NOT NULL,                     -- 見出し（院長メッセージ 等）
    kind       TEXT    NOT NULL DEFAULT 'article',   -- article / link
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    note       TEXT    NOT NULL DEFAULT '',          -- link の補足（内線番号など）
    url        TEXT    NOT NULL DEFAULT '',
    author     TEXT    NOT NULL DEFAULT '',
    date       TEXT    NOT NULL DEFAULT (date('now','localtime')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    published  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT    NOT NULL UNIQUE,
    keys_json  TEXT    NOT NULL,
    user_agent TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// ---- 既存DBへの列追加（休暇管理用。何度起動しても安全） ----------------------
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('hire_date')) db.exec("ALTER TABLE users ADD COLUMN hire_date TEXT NOT NULL DEFAULT ''");       // 入職日 YYYY-MM-DD
if (!userCols.includes('weekly_days')) db.exec('ALTER TABLE users ADD COLUMN weekly_days INTEGER NOT NULL DEFAULT 5'); // 週所定労働日数（年休の付与日数に使う）
if (!userCols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT ''");                 // '' / shunin / kacho（課長） / bucho（部長）
if (!userCols.includes('must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'); // 1 = 初期パスワードのまま（ログイン後に変更必須）
if (!userCols.includes('password_changed_at')) db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');

// 初期パスワードは職員番号と同じ（例：職員番号 4531 → 4531）。初回ログイン時に変更を必須にする
const initialPassword = (staffId) => String(staffId);
// 職員番号は先頭の0を付けない（00173 → 173）
const normalizeStaffId = (s) => String(s || '').normalize('NFKC').trim().replace(/^0+(?=\d)/, '');

// お知らせの添付ファイル（JSON: [{name, url}]）
const noticeCols = db.prepare('PRAGMA table_info(notices)').all().map((c) => c.name);
if (!noticeCols.includes('attachments')) db.exec("ALTER TABLE notices ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");

// ---- 初期データ投入 ------------------------------------------------------
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const insUser = db.prepare('INSERT INTO users (staff_id, name, kana, department, section, job, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
  const insNotice = db.prepare('INSERT INTO notices (category, department, title, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const idByStaff = {};
  // 試作用のダミー職員は投入せず、初期管理者だけを作る（本物の職員は管理モードのCSV一括登録で登録する）
  // 初期管理者は環境変数 ADMIN_STAFF_ID / ADMIN_NAME で変更できる（既定：4531 のざわ）
  const initialStaff = [{ staffId: normalizeStaffId(process.env.ADMIN_STAFF_ID || '4531'), name: process.env.ADMIN_NAME || 'のざわ', kana: process.env.ADMIN_NAME || 'のざわ', department: '事務部', section: '', job: '', isAdmin: true }];
  db.transaction(() => {
    for (const s of initialStaff) {
      const info = insUser.run(s.staffId, s.name, s.kana, s.department, s.section || '', s.job, bcrypt.hashSync(initialPassword(s.staffId), 10), s.isAdmin ? 1 : 0);
      idByStaff[s.staffId] = info.lastInsertRowid;
    }
    // 試作用のダミーお知らせは投入せず、initial_notices.js（財団掲示板からの転記）を投入する
    const insNotice2 = db.prepare('INSERT INTO notices (category, department, title, body, created_by, created_at, attachments) VALUES (?, ?, ?, ?, NULL, ?, ?)');
    for (const n of require('./initial_notices')) insNotice2.run(n.category, n.department || '', n.title, n.body, n.createdAt, JSON.stringify(n.attachments || []));
    const insLog = db.prepare("INSERT INTO point_logs (user_id, kind, points, note, day, created_at) VALUES (?, 'initial', ?, '試作用の初期ポイント', '2026-09-01', '2026-09-01 09:00:00')");
    for (const [sid, pts] of Object.entries(seed.INITIAL_POINTS || {})) if (idByStaff[sid]) insLog.run(idByStaff[sid], pts);
    const insContent = db.prepare('INSERT INTO contents (tab, section, kind, title, body, note, url, author, date, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (seed.CONTENTS || []).forEach((c, i) => {
      const info = insContent.run(c.tab, c.section, c.kind || 'article', c.title, c.body || '', c.note || '', c.url || '', c.author || '', c.date || '2026-09-01', i);
      if (c.pickup) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pickup_content_id', ?)").run(String(info.lastInsertRowid));
    });
  })();
  console.log(`初期データを投入しました: 管理者 ${initialStaff[0].staffId}（初期パスワードは職員番号と同じ） / お知らせ ${require('./initial_notices').length} 件（初回ログイン時に変更必須）`);
}

// ---- SQL -----------------------------------------------------------------
const NOTICE_SELECT = `
  SELECT n.id, n.category, n.department, n.title, n.body, n.created_at AS createdAt, n.attachments, u.name AS author
  FROM notices n LEFT JOIN users u ON u.id = n.created_by`;

const stmts = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByStaffId: db.prepare('SELECT * FROM users WHERE staff_id = ?'),
  userList: db.prepare(`
    SELECT u.id, u.staff_id AS staffId, u.name, u.kana, u.department, u.section, u.job, u.is_admin AS isAdmin, u.created_at AS createdAt,
           u.hire_date AS hireDate, u.weekly_days AS weeklyDays, u.role, u.must_change_password AS mustChangePassword, u.password_changed_at AS passwordChangedAt,
           (SELECT COUNT(*) FROM push_subscriptions s WHERE s.user_id = u.id) AS devices
    FROM users u ORDER BY u.staff_id`),
  userInsert: db.prepare('INSERT INTO users (staff_id, name, kana, department, section, job, password_hash, is_admin, hire_date, weekly_days, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  userSetLeaveProfile: db.prepare('UPDATE users SET hire_date = ?, weekly_days = ?, role = ? WHERE id = ?'),
  userResetPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?'),
  userDelete: db.prepare('DELETE FROM users WHERE id = ?'),
  userSetPassword: db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now','localtime') WHERE id = ?"),
  userCount: db.prepare('SELECT COUNT(*) AS c FROM users'),

  // 職員向け: 重要・一般は全員、部門別は自部署のみ
  noticeListFor: db.prepare(`${NOTICE_SELECT}
    WHERE n.category IN ('important','general')
       OR (n.category = 'department' AND (n.department = ? OR n.department = ?))
    ORDER BY n.id DESC LIMIT ?`),
  noticeListAll: db.prepare(`${NOTICE_SELECT} ORDER BY n.id DESC LIMIT ?`),
  noticeById: db.prepare(`${NOTICE_SELECT} WHERE n.id = ?`),
  noticeInsert: db.prepare('INSERT INTO notices (category, department, title, body, created_by, attachments) VALUES (?, ?, ?, ?, ?, ?)'),
  noticeDelete: db.prepare('DELETE FROM notices WHERE id = ?'),

  // ポイント
  pointsTotal: db.prepare('SELECT COALESCE(SUM(points),0) AS p FROM point_logs WHERE user_id = ?'),
  pointLogToday: db.prepare("SELECT * FROM point_logs WHERE user_id = ? AND kind = ? AND day = date('now','localtime')"),
  pointLogInsert: db.prepare('INSERT INTO point_logs (user_id, kind, points, note) VALUES (?, ?, ?, ?)'),
  pointHistory: db.prepare('SELECT kind, points, note, created_at AS createdAt FROM point_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
  pointsAllTotal: db.prepare('SELECT COALESCE(SUM(points),0) AS p FROM point_logs'),
  checkinsToday: db.prepare("SELECT COUNT(*) AS c FROM point_logs WHERE kind = 'checkin' AND day = date('now','localtime')"),
  // 歩数
  stepsToday: db.prepare("SELECT steps FROM steps WHERE user_id = ? AND day = date('now','localtime')"),
  stepsUpsert: db.prepare(`INSERT INTO steps (user_id, day, steps) VALUES (?, date('now','localtime'), ?)
    ON CONFLICT(user_id, day) DO UPDATE SET steps = excluded.steps, updated_at = datetime('now','localtime')`),
  stepsWeek: db.prepare("SELECT day, steps FROM steps WHERE user_id = ? AND day >= date('now','localtime','-6 days') ORDER BY day"),
  // 掲載コンテンツ
  contentList: db.prepare('SELECT * FROM contents WHERE published = 1 ORDER BY tab, sort_order, id'),
  contentListAll: db.prepare('SELECT * FROM contents ORDER BY tab, sort_order, id'),
  contentById: db.prepare('SELECT * FROM contents WHERE id = ?'),
  contentInsert: db.prepare('INSERT INTO contents (tab, section, kind, title, body, note, url, author, date, sort_order, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  contentUpdate: db.prepare('UPDATE contents SET tab=?, section=?, kind=?, title=?, body=?, note=?, url=?, author=?, date=?, sort_order=?, published=? WHERE id = ?'),
  contentDelete: db.prepare('DELETE FROM contents WHERE id = ?'),
  settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingSet: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  subUpsert: db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys_json, user_agent) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, user_agent = excluded.user_agent`),
  subDeleteByEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  subList: db.prepare('SELECT s.* FROM push_subscriptions s'),
  subListByTarget: db.prepare("SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.department = ? OR (u.department || '/' || u.section) = ?"),
  subListByUser: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
  subCount: db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions'),
  subUserCount: db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM push_subscriptions'),
};

const parseNotice = (n) => { if (!n) return n; let a = []; try { a = JSON.parse(n.attachments || '[]'); } catch (_) {} return { ...n, attachments: a }; };
const contentArgs = (c) => [c.tab, c.section, c.kind, c.title, c.body || '', c.note || '', c.url || '', c.author || '', c.date, Number(c.sortOrder || 0), c.published === false ? 0 : 1];

module.exports = {
  HOSPITAL_NAME: seed.HOSPITAL_NAME,
  POINT_RULES: seed.POINT_RULES,

  pointsTotal: (userId) => stmts.pointsTotal.get(userId).p,
  pointLogToday: (userId, kind) => stmts.pointLogToday.get(userId, kind),
  addPoints: (userId, kind, points, note) => stmts.pointLogInsert.run(userId, kind, points, note || ''),
  pointHistory: (userId, limit) => stmts.pointHistory.all(userId, limit),
  pointsAllTotal: () => stmts.pointsAllTotal.get().p,
  checkinsToday: () => stmts.checkinsToday.get().c,
  stepsToday: (userId) => (stmts.stepsToday.get(userId) || { steps: 0 }).steps,
  setStepsToday: (userId, steps) => stmts.stepsUpsert.run(userId, steps),
  stepsWeek: (userId) => stmts.stepsWeek.all(userId),

  listContents: (all) => (all ? stmts.contentListAll.all() : stmts.contentList.all()),
  findContent: (id) => stmts.contentById.get(id),
  createContent: (c) => { const info = stmts.contentInsert.run(...contentArgs(c)); return stmts.contentById.get(info.lastInsertRowid); },
  updateContent: (id, c) => { stmts.contentUpdate.run(...contentArgs(c), id); return stmts.contentById.get(id); },
  deleteContent: (id) => stmts.contentDelete.run(id),
  getSetting: (key) => (stmts.settingGet.get(key) || {}).value,
  setSetting: (key, value) => stmts.settingSet.run(key, String(value)),
  DEPARTMENTS,
  // 有効な配信対象（部門名、および 部門/課）
  TARGETS: DEPARTMENTS.flatMap((d) => [d.name, ...d.sections.map((s) => `${d.name}/${s}`)]),

  findUserById: (id) => stmts.userById.get(id),
  findUserByStaffId: (staffId) => stmts.userByStaffId.get(staffId),
  listUsers: () => stmts.userList.all(),
  createUser: ({ staffId, name, kana, department, section, job, passwordHash, isAdmin, hireDate, weeklyDays, role, mustChange }) => {
    const info = stmts.userInsert.run(staffId, name, kana || '', department || '', section || '', job || '', passwordHash, isAdmin ? 1 : 0, hireDate || '', Number(weeklyDays) || 5, role || '', mustChange ? 1 : 0);
    return stmts.userById.get(info.lastInsertRowid);
  },
  setLeaveProfile: (id, { hireDate, weeklyDays, role }) => stmts.userSetLeaveProfile.run(hireDate || '', Number(weeklyDays) || 5, role || '', id),
  initialPassword, normalizeStaffId,
  resetPassword: (id, staffId) => stmts.userResetPassword.run(bcrypt.hashSync(initialPassword(staffId), 10), id), // 初期パスワードに戻し、次回ログインで変更必須
  raw: db, // 休暇管理（leave.js）が同じ接続を使うために公開
  deleteUser: (id) => stmts.userDelete.run(id),
  setPassword: (id, hash) => stmts.userSetPassword.run(hash, id),
  countUsers: () => stmts.userCount.get().c,

  listNoticesFor: (user, limit) => (user.is_admin ? stmts.noticeListAll.all(limit) : stmts.noticeListFor.all(user.department, `${user.department}/${user.section}`, limit)).map(parseNotice),
  findNotice: (id) => parseNotice(stmts.noticeById.get(id)),
  createNotice: ({ category, department, title, body, createdBy, attachments }) => {
    const info = stmts.noticeInsert.run(category, department || '', title, body, createdBy, JSON.stringify(attachments || []));
    return parseNotice(stmts.noticeById.get(info.lastInsertRowid));
  },
  deleteNotice: (id) => stmts.noticeDelete.run(id),

  upsertSubscription: ({ userId, endpoint, keysJson, userAgent }) => stmts.subUpsert.run(userId, endpoint, keysJson, userAgent),
  deleteSubscriptionByEndpoint: (endpoint) => stmts.subDeleteByEndpoint.run(endpoint),
  listSubscriptions: () => stmts.subList.all(),
  listSubscriptionsByTarget: (target) => stmts.subListByTarget.all(target, target),
  listSubscriptionsByUser: (userId) => stmts.subListByUser.all(userId),
  countSubscriptions: () => stmts.subCount.get().c,
  countSubscribedUsers: () => stmts.subUserCount.get().c,
};