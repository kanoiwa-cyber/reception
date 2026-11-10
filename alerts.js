// 緊急連絡・安否確認
//  - kind: emergency（緊急連絡：読んだら「確認」ボタン）/ safety（安否確認：無事・軽傷・重傷／出勤可否／コメント）
//  - 送信できるのは管理者と部長。部長は自部門宛てのみ、管理者は全職員・部門指定どちらも可
//  - テスト送信（is_test=1）は件名に【テスト】が付き、集計も別に残る
//  - 未回答者への再通知、締切（closed）あり
const dbm = require('./db');
const db = dbm.raw;

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,                     -- emergency / safety
    is_test    INTEGER NOT NULL DEFAULT 0,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    target     TEXT    NOT NULL DEFAULT 'all',       -- all / 部門名
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    closed_at  TEXT,
    reminded_at TEXT
  );
  CREATE TABLE IF NOT EXISTS alert_responses (
    alert_id     INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT    NOT NULL,                   -- emergency: confirmed / safety: safe, minor, severe
    can_work     TEXT    NOT NULL DEFAULT '',        -- safety: yes / no / unknown
    comment      TEXT    NOT NULL DEFAULT '',
    responded_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (alert_id, user_id)
  );
`);

const KIND = { emergency: '緊急連絡', safety: '安否確認' };
const SAFETY_STATUS = { safe: '無事', minor: '軽傷', severe: '重傷・要支援' };
const CAN_WORK = { yes: '出勤できる', no: '出勤できない', unknown: 'わからない' };

const stmts = {
  insert: db.prepare('INSERT INTO alerts (kind, is_test, title, body, target, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
  byId: db.prepare('SELECT a.*, u.name AS senderName FROM alerts a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ?'),
  list: db.prepare('SELECT a.*, u.name AS senderName FROM alerts a LEFT JOIN users u ON u.id = a.created_by WHERE (? = 1 OR a.target = ? OR a.created_by = ?) ORDER BY a.id DESC LIMIT 50'),
  close: db.prepare("UPDATE alerts SET closed_at = datetime('now','localtime') WHERE id = ?"),
  reopen: db.prepare('UPDATE alerts SET closed_at = NULL WHERE id = ?'),
  remind: db.prepare("UPDATE alerts SET reminded_at = datetime('now','localtime') WHERE id = ?"),
  // 自分宛てで未締切のもの（回答状況つき）
  openFor: db.prepare(`SELECT a.*, u.name AS senderName, r.status AS myStatus, r.responded_at AS myRespondedAt
    FROM alerts a LEFT JOIN users u ON u.id = a.created_by LEFT JOIN alert_responses r ON r.alert_id = a.id AND r.user_id = ?
    WHERE a.closed_at IS NULL AND (a.target = 'all' OR a.target = ?) ORDER BY a.id DESC`),
  myResponse: db.prepare('SELECT * FROM alert_responses WHERE alert_id = ? AND user_id = ?'),
  respond: db.prepare(`INSERT INTO alert_responses (alert_id, user_id, status, can_work, comment) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(alert_id, user_id) DO UPDATE SET status = excluded.status, can_work = excluded.can_work, comment = excluded.comment, responded_at = datetime('now','localtime')`),
  targets: db.prepare("SELECT * FROM users WHERE (? = 'all' OR department = ?) ORDER BY department, section, staff_id"),
  responses: db.prepare('SELECT r.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section FROM alert_responses r JOIN users u ON u.id = r.user_id WHERE r.alert_id = ?'),
};

const canSend = (u) => !!(u.is_admin || u.role === 'bucho');
const canManage = (u, a) => !!(u.is_admin || (u.role === 'bucho' && (a.target === u.department || a.created_by === u.id)));

function pub(a, extra = {}) {
  return {
    id: a.id, kind: a.kind, kindLabel: KIND[a.kind], isTest: !!a.is_test, title: a.title, body: a.body, target: a.target,
    targetLabel: a.target === 'all' ? '全職員' : a.target, senderName: a.senderName || '', createdAt: a.created_at, closedAt: a.closed_at || '', remindedAt: a.reminded_at || '',
    ...extra,
  };
}

function create(sender, { kind, title, body, target, isTest }) {
  if (!KIND[kind]) return { error: '種類を選択してください' };
  if (!title || !String(title).trim()) return { error: '件名を入力してください' };
  let t = target || 'all';
  if (!sender.is_admin) t = sender.department; // 部長は自部門のみ
  else if (t !== 'all' && !dbm.DEPARTMENTS.some((d) => d.name === t)) return { error: '宛先の部門が不正です' };
  const info = stmts.insert.run(kind, isTest ? 1 : 0, String(title).trim().slice(0, 80), String(body || '').trim().slice(0, 1000), t, sender.id);
  return { alert: stmts.byId.get(info.lastInsertRowid) };
}

function respond(user, alertId, body) {
  const a = stmts.byId.get(alertId);
  if (!a) return { error: '連絡が見つかりません' };
  if (a.closed_at) return { error: 'この連絡は締め切られています' };
  if (!(a.target === 'all' || a.target === user.department)) return { error: 'この連絡の対象ではありません' };
  const b = body || {};
  let status, canWork = '', comment = String(b.comment || '').trim().slice(0, 300);
  if (a.kind === 'emergency') { status = 'confirmed'; }
  else {
    if (!SAFETY_STATUS[b.status]) return { error: '状況（無事・軽傷・重傷）を選択してください' };
    if (!CAN_WORK[b.canWork]) return { error: '出勤できるかどうかを選択してください' };
    status = b.status; canWork = b.canWork;
  }
  stmts.respond.run(alertId, user.id, status, canWork, comment);
  return { response: stmts.myResponse.get(alertId, user.id) };
}

function summary(alertId) {
  const a = stmts.byId.get(alertId);
  if (!a) return null;
  const targets = stmts.targets.all(a.target, a.target);
  const resp = Object.fromEntries(stmts.responses.all(alertId).map((r) => [r.user_id, r]));
  const rows = targets.map((u) => {
    const r = resp[u.id];
    return { userId: u.id, name: u.name, staffId: u.staff_id, department: u.department, section: u.section, responded: !!r,
      status: r ? r.status : '', statusLabel: r ? (a.kind === 'emergency' ? '確認済み' : SAFETY_STATUS[r.status]) : '未回答',
      canWork: r ? r.can_work : '', canWorkLabel: r && r.can_work ? CAN_WORK[r.can_work] : '', comment: r ? r.comment : '', respondedAt: r ? r.responded_at : '' };
  });
  const count = (f) => rows.filter(f).length;
  return {
    alert: pub(a),
    total: rows.length, responded: count((r) => r.responded), unanswered: count((r) => !r.responded),
    safe: count((r) => r.status === 'safe'), minor: count((r) => r.status === 'minor'), severe: count((r) => r.status === 'severe'),
    canWorkYes: count((r) => r.canWork === 'yes'), canWorkNo: count((r) => r.canWork === 'no'),
    rows: rows.sort((x, y) => (x.responded !== y.responded ? (x.responded ? 1 : -1) : (x.status === 'severe' ? -1 : y.status === 'severe' ? 1 : 0))),
    nonResponders: rows.filter((r) => !r.responded).map((r) => r.userId),
  };
}

module.exports = {
  KIND, SAFETY_STATUS, CAN_WORK, canSend, canManage, pub, create, respond, summary,
  find: (id) => stmts.byId.get(id),
  listFor: (u) => stmts.list.all(u.is_admin ? 1 : 0, u.department, u.id).map((a) => { const s = summary(a.id); return pub(a, { total: s.total, responded: s.responded, severe: s.severe }); }),
  openFor: (u) => stmts.openFor.all(u.id, u.department).map((a) => pub(a, { myStatus: a.myStatus || '', myRespondedAt: a.myRespondedAt || '' })),
  myResponse: (alertId, userId) => stmts.myResponse.get(alertId, userId),
  targetUsers: (a) => stmts.targets.all(a.target, a.target),
  close: (id) => stmts.close.run(id),
  reopen: (id) => stmts.reopen.run(id),
  markReminded: (id) => stmts.remind.run(id),
};
