// 体調管理報告（毎朝、出社ポイント取得後に入力）
//  - 1人1日1件。確認済みになるまでは本人が修正できる
//  - 所属長（課長・部長）と主任は同じ部門の報告を一覧で見て「確認済み」にできる。管理者は全部門
//  - 発熱（37.5℃以上）または症状ありは「要注意」として強調表示・通知
const dbm = require('./db');
const db = dbm.raw;

const FEVER = 37.5;
const SYMPTOMS = [
  { key: 'sore_throat', label: '咽頭痛' },
  { key: 'cough', label: '咳' },
  { key: 'vomiting', label: '嘔吐' },
  { key: 'diarrhea', label: '下痢' },
];

db.exec(`
  CREATE TABLE IF NOT EXISTS health_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day          TEXT    NOT NULL,
    temperature  REAL,
    sore_throat  INTEGER NOT NULL DEFAULT 0,
    cough        INTEGER NOT NULL DEFAULT 0,
    vomiting     INTEGER NOT NULL DEFAULT 0,
    diarrhea     INTEGER NOT NULL DEFAULT 0,
    other        TEXT    NOT NULL DEFAULT '',
    confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (user_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_health_day ON health_reports(day);
`);

const SELECT = `
  SELECT h.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section, u.job, c.name AS confirmerName
  FROM health_reports h JOIN users u ON u.id = h.user_id LEFT JOIN users c ON c.id = h.confirmed_by`;
const stmts = {
  today: db.prepare("SELECT date('now','localtime') AS d"),
  byUserDay: db.prepare(`${SELECT} WHERE h.user_id = ? AND h.day = ?`),
  byId: db.prepare(`${SELECT} WHERE h.id = ?`),
  upsert: db.prepare(`
    INSERT INTO health_reports (user_id, day, temperature, sore_throat, cough, vomiting, diarrhea, other) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET temperature = excluded.temperature, sore_throat = excluded.sore_throat, cough = excluded.cough,
      vomiting = excluded.vomiting, diarrhea = excluded.diarrhea, other = excluded.other, updated_at = datetime('now','localtime')`),
  confirm: db.prepare("UPDATE health_reports SET confirmed_by = ?, confirmed_at = datetime('now','localtime') WHERE id = ?"),
  unconfirm: db.prepare('UPDATE health_reports SET confirmed_by = NULL, confirmed_at = NULL WHERE id = ?'),
  listDay: db.prepare(`${SELECT} WHERE h.day = ? AND (? = 1 OR u.department = ?) ORDER BY (h.confirmed_at IS NOT NULL), u.department, u.section, u.staff_id`),
  listRange: db.prepare(`${SELECT} WHERE h.day BETWEEN ? AND ? ORDER BY h.day, u.department, u.section, u.staff_id`),
  unconfirmedCount: db.prepare("SELECT COUNT(*) AS c FROM health_reports h JOIN users u ON u.id = h.user_id WHERE h.day = ? AND h.confirmed_at IS NULL AND (? = 1 OR u.department = ?)"),
  myHistory: db.prepare(`${SELECT} WHERE h.user_id = ? AND h.day >= date('now','localtime','start of month','-1 month') ORDER BY h.day DESC`), // 当月＋前月（直近2か月）
  // 本日出社ポイントを取ったが未報告の人（部門別）
  checkedInNoReport: db.prepare(`
    SELECT u.id, u.name AS userName, u.staff_id AS staffId, u.department, u.section FROM users u
    WHERE EXISTS (SELECT 1 FROM point_logs p WHERE p.user_id = u.id AND p.kind = 'checkin' AND p.day = ?)
      AND NOT EXISTS (SELECT 1 FROM health_reports h WHERE h.user_id = u.id AND h.day = ?)
      AND (? = 1 OR u.department = ?) ORDER BY u.department, u.section, u.staff_id`),
  leaders: db.prepare("SELECT * FROM users WHERE department = ? AND role IN ('shunin','kacho','bucho') AND id <> ?"),
};

const today = () => stmts.today.get().d;
const isViewer = (u) => !!(u.is_admin || ['shunin', 'kacho', 'bucho'].includes(u.role || ''));
const hasSymptom = (r) => SYMPTOMS.some((s) => r[s.key]) || !!(r.other && r.other.trim());
const isAlert = (r) => (r.temperature != null && r.temperature >= FEVER) || hasSymptom(r);

function validate(body) {
  const b = body || {};
  let temperature = null;
  if (b.temperature !== '' && b.temperature != null) {
    temperature = Number(b.temperature);
    if (!Number.isFinite(temperature) || temperature < 34 || temperature > 42) return { error: '体温は 34.0〜42.0 の範囲で入力してください（例：36.5）' };
    temperature = Math.round(temperature * 10) / 10;
  } else {
    return { error: '体温を入力してください' };
  }
  const flags = Object.fromEntries(SYMPTOMS.map((s) => [s.key, b[s.key] ? 1 : 0]));
  const other = String(b.other || '').trim().slice(0, 200);
  return { value: { temperature, ...flags, other } };
}

function pub(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, userName: r.userName, staffId: r.staffId, department: r.department, section: r.section, job: r.job,
    day: r.day, temperature: r.temperature,
    symptoms: SYMPTOMS.filter((s) => r[s.key]).map((s) => s.label),
    flags: Object.fromEntries(SYMPTOMS.map((s) => [s.key, !!r[s.key]])),
    other: r.other, alert: isAlert(r),
    confirmed: !!r.confirmed_at, confirmerName: r.confirmerName || '', confirmedAt: r.confirmed_at || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

module.exports = {
  FEVER, SYMPTOMS, today, isViewer, isAlert, validate, pub,
  myToday: (userId) => pub(stmts.byUserDay.get(userId, today())),
  myHistory: (userId) => stmts.myHistory.all(userId).map(pub),
  save: (user, v) => {
    const cur = stmts.byUserDay.get(user.id, today());
    if (cur && cur.confirmed_at) return { error: '本日の報告はすでに確認済みのため修正できません。変更がある場合は所属長に直接お伝えください' };
    stmts.upsert.run(user.id, today(), v.temperature, v.sore_throat, v.cough, v.vomiting, v.diarrhea, v.other);
    return { report: pub(stmts.byUserDay.get(user.id, today())), isNew: !cur };
  },
  find: (id) => stmts.byId.get(id),
  canView: (viewer, r) => !!(viewer.is_admin || (isViewer(viewer) && viewer.department === r.department)),
  confirm: (viewer, id, on) => {
    const r = stmts.byId.get(id);
    if (!r) return { error: '報告が見つかりません' };
    if (!(viewer.is_admin || (isViewer(viewer) && viewer.department === r.department))) return { error: 'この報告を確認する権限がありません' };
    if (on) stmts.confirm.run(viewer.id, id); else stmts.unconfirm.run(id);
    return { report: pub(stmts.byId.get(id)) };
  },
  listDay: (viewer, day) => stmts.listDay.all(day, viewer.is_admin ? 1 : 0, viewer.department).map(pub),
  listRange: (from, to) => stmts.listRange.all(from, to).map(pub),
  unconfirmedCount: (viewer) => (isViewer(viewer) ? stmts.unconfirmedCount.get(today(), viewer.is_admin ? 1 : 0, viewer.department).c : 0),
  missing: (viewer, day) => stmts.checkedInNoReport.all(day, day, viewer.is_admin ? 1 : 0, viewer.department),
  leadersFor: (user) => stmts.leaders.all(user.department, user.id),
};
