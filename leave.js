// 休暇管理（年休の付与・残数計算・申請・承認）
// 運用ルール（紙の「休暇届」に合わせたもの）
//  - 年度は 4/1〜翌3/31。残数は「残日数」と「残時間」の2段で管理し、1日＝8時間
//  - 4/1 に一斉付与。中途入職者は初年度のみ入職6か月後に付与し、翌年度から 4/1 に合流
//  - 前年度の未消化分は繰越（上限 40日）。2年で時効（＝前年度分までしか繰り越さない）
//  - 時間年休で残時間が足りないときは残日数から1日を崩して8時間に換算する
//  - 承認は同じ部門の課長または部長のどちらか1人（管理者は事務部として代行可）
const dbm = require('./db');
const db = dbm.raw;

const HOURS_PER_DAY = 8;
const CARRY_MAX_DAYS = 40;

db.exec(`
  CREATE TABLE IF NOT EXISTS leave_grants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fiscal_year   INTEGER NOT NULL,
    grant_date    TEXT    NOT NULL,                 -- 付与日（4/1 または 入職6か月後）
    carried_days  REAL    NOT NULL DEFAULT 0,       -- 前年度繰越（日）
    carried_hours INTEGER NOT NULL DEFAULT 0,       -- 前年度繰越（時間）
    granted_days  REAL    NOT NULL DEFAULT 0,       -- 当年度付与（日）
    note          TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (user_id, fiscal_year)
  );
  CREATE TABLE IF NOT EXISTS leave_adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fiscal_year INTEGER NOT NULL,
    days        REAL    NOT NULL DEFAULT 0,         -- ＋で増、－で減
    hours       INTEGER NOT NULL DEFAULT 0,
    note        TEXT    NOT NULL DEFAULT '',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS leave_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL,                 -- LEAVE_TYPES の key
    unit          TEXT    NOT NULL,                 -- day / am / pm / hour
    start_date    TEXT    NOT NULL,
    end_date      TEXT    NOT NULL,
    days          REAL    NOT NULL DEFAULT 0,       -- 申請日数（時間単位のときは 0）
    hours         INTEGER NOT NULL DEFAULT 0,       -- 申請時間（時間単位のときのみ）
    start_time    TEXT    NOT NULL DEFAULT '',
    end_time      TEXT    NOT NULL DEFAULT '',
    break_taken   INTEGER,                          -- 休憩 1=有 0=無 NULL=該当なし
    reason        TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'pending', -- pending / approved / rejected / cancelled
    approver_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at    TEXT,
    reject_reason TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')) -- 届出日
  );
  CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id, start_date);
  CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
`);
// 取消申請用の列（承認済みの休暇を当日中まで本人申告で取消 → 課長が承認）
const reqCols = db.prepare('PRAGMA table_info(leave_requests)').all().map((c) => c.name);
for (const [col, def] of [['cancel_reason', "TEXT NOT NULL DEFAULT ''"], ['cancel_requested_at', 'TEXT'], ['cancel_decided_by', 'INTEGER'], ['cancel_decided_at', 'TEXT'], ['cancel_reject_reason', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!reqCols.includes(col)) db.exec(`ALTER TABLE leave_requests ADD COLUMN ${col} ${def}`);
}
// status: pending（承認待ち）/ approved（承認済み）/ cancel_pending（取消申請中。残数上はまだ取得扱い）/ rejected / cancelled

// ---- 休暇種別（紙の様式どおり） --------------------------------------------------
const LEAVE_TYPES = [
  { key: 'nenkyu',    label: '年休',           paid: true,  annual: true,  units: ['day', 'am', 'pm'] },
  { key: 'keikaku',   label: '計画年休',       paid: true,  annual: true,  units: ['day', 'am', 'pm'] },
  { key: 'jikan',     label: '時間年休',       paid: true,  annual: true,  units: ['hour'] },
  { key: 'tokubetsu', label: '特別休暇',       paid: true,  annual: false, units: ['day', 'am', 'pm'] },
  { key: 'chiryo',    label: '治療サポート',   paid: true,  annual: false, units: ['day', 'am', 'pm', 'hour'] },
  { key: 'shussei',   label: '出生サポート',   paid: true,  annual: false, units: ['day', 'am', 'pm'] },
  { key: 'kango',     label: '子の看護',       paid: true,  annual: false, units: ['day', 'am', 'pm', 'hour'] },
  { key: 'sankyu',    label: '産休',           paid: true,  annual: false, units: ['day'] },
  { key: 'ikukyu',    label: '育休',           paid: true,  annual: false, units: ['day'] },
  { key: 'kaigo',     label: '介護休',         paid: true,  annual: false, units: ['day', 'am', 'pm', 'hour'] },
  { key: 'kekkin',    label: '欠勤',           paid: false, annual: false, units: ['day', 'am', 'pm'] },
  { key: 'chikoku',   label: '遅刻',           paid: false, annual: false, units: ['hour'] },
  { key: 'sotai',     label: '早退',           paid: false, annual: false, units: ['hour'] },
  { key: 'byoketsu',  label: '病欠',           paid: false, annual: false, units: ['day', 'am', 'pm'] },
  { key: 'rosai',     label: '労災',           paid: false, annual: false, units: ['day'] },
  { key: 'sonota',    label: 'その他',         paid: false, annual: false, units: ['day', 'am', 'pm', 'hour'] },
];
const TYPE = Object.fromEntries(LEAVE_TYPES.map((t) => [t.key, t]));
const UNITS = { day: '1日', am: '半日（午前）', pm: '半日（午後）', hour: '時間' };
const ROLES = { '': '一般', shunin: '主任', kacho: '課長', bucho: '部長' }; // 主任は体調報告の確認のみ（休暇の承認は課長・部長）

// 週所定労働日数ごとの付与日数（勤続 0.5年, 1.5年, 2.5年, 3.5年, 4.5年, 5.5年, 6.5年以上）
const GRANT_TABLE = {
  5: [10, 11, 12, 14, 16, 18, 20],
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};

// ---- 日付ユーティリティ ---------------------------------------------------------
const today = () => db.prepare("SELECT date('now','localtime') AS d").get().d;
const fiscalYearOf = (dateStr) => { const [y, m] = dateStr.split('-').map(Number); return m >= 4 ? y : y - 1; };
const currentFiscalYear = () => fiscalYearOf(today());
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.UTC(...b.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v))) - Date.UTC(...a.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)))) / 86400000) + 1;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));

// ---- 付与日数の自動計算 -----------------------------------------------------------
// 戻り値: { grantDate, days, index } または null（その年度は付与対象外）
function computeGrant(user, fy) {
  if (!user.hire_date || !isDate(user.hire_date)) return null;
  const first = addMonths(user.hire_date, 6);          // 初回付与日（入職6か月後）
  if (first > `${fy + 1}-03-31`) return null;          // まだ初回付与に達していない
  const index = fy - fiscalYearOf(first);               // 0=初回、以降は 4/1 ごとに +1
  if (index < 0) return null;
  const table = GRANT_TABLE[Math.min(5, Math.max(1, Number(user.weekly_days) || 5))];
  return { grantDate: index === 0 ? first : `${fy}-04-01`, days: table[Math.min(index, table.length - 1)], index };
}

// ---- 残数計算（付与 → 承認済みの年休 → 修正 を日付順に適用） ----------------------------
const stmts = {
  grantGet: db.prepare('SELECT * FROM leave_grants WHERE user_id = ? AND fiscal_year = ?'),
  grantInsert: db.prepare('INSERT INTO leave_grants (user_id, fiscal_year, grant_date, carried_days, carried_hours, granted_days, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  grantUpdate: db.prepare('UPDATE leave_grants SET carried_days = ?, carried_hours = ?, granted_days = ?, note = ? WHERE id = ?'),
  adjList: db.prepare('SELECT * FROM leave_adjustments WHERE user_id = ? AND fiscal_year = ? ORDER BY created_at, id'),
  adjInsert: db.prepare('INSERT INTO leave_adjustments (user_id, fiscal_year, days, hours, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
  reqApprovedAnnual: db.prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status IN ('approved','cancel_pending') AND start_date BETWEEN ? AND ? ORDER BY start_date, id`),
  reqByUser: db.prepare('SELECT r.*, a.name AS approverName, c.name AS cancelDeciderName FROM leave_requests r LEFT JOIN users a ON a.id = r.approver_id LEFT JOIN users c ON c.id = r.cancel_decided_by WHERE r.user_id = ? ORDER BY r.start_date DESC, r.id DESC LIMIT ?'),
  reqById: db.prepare('SELECT r.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section, a.name AS approverName, c.name AS cancelDeciderName FROM leave_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users a ON a.id = r.approver_id LEFT JOIN users c ON c.id = r.cancel_decided_by WHERE r.id = ?'),
  reqInsert: db.prepare('INSERT INTO leave_requests (user_id, type, unit, start_date, end_date, days, hours, start_time, end_time, break_taken, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  reqDecide: db.prepare("UPDATE leave_requests SET status = ?, approver_id = ?, decided_at = datetime('now','localtime'), reject_reason = ? WHERE id = ?"),
  reqCancel: db.prepare("UPDATE leave_requests SET status = 'cancelled', decided_at = datetime('now','localtime') WHERE id = ?"),
  reqCancelRequest: db.prepare("UPDATE leave_requests SET status = 'cancel_pending', cancel_reason = ?, cancel_requested_at = datetime('now','localtime'), cancel_reject_reason = '' WHERE id = ?"),
  reqCancelDecide: db.prepare("UPDATE leave_requests SET status = ?, cancel_decided_by = ?, cancel_decided_at = datetime('now','localtime'), cancel_reject_reason = ? WHERE id = ?"),
  reqPendingForDept: db.prepare(`SELECT r.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section FROM leave_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status IN ('pending','cancel_pending') AND (? = 1 OR u.department = ?) ORDER BY r.created_at, r.id`),
  reqRecentForDept: db.prepare(`SELECT r.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section, a.name AS approverName, c.name AS cancelDeciderName FROM leave_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users a ON a.id = r.approver_id LEFT JOIN users c ON c.id = r.cancel_decided_by
    WHERE r.status NOT IN ('pending','cancel_pending') AND (? = 1 OR u.department = ?) ORDER BY COALESCE(r.cancel_decided_at, r.decided_at) DESC, r.id DESC LIMIT 30`),
  reqMonth: db.prepare(`SELECT r.*, u.name AS userName, u.staff_id AS staffId, u.department, u.section, a.name AS approverName FROM leave_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users a ON a.id = r.approver_id
    WHERE r.status IN ('approved','cancel_pending') AND substr(r.start_date, 1, 7) = ? ORDER BY u.staff_id, r.start_date`),
  usersAll: db.prepare('SELECT * FROM users ORDER BY staff_id'),
  approversOfDept: db.prepare("SELECT * FROM users WHERE department = ? AND role IN ('kacho','bucho') AND id <> ?"),
  kachoOfDept: db.prepare("SELECT * FROM users WHERE department = ? AND role = 'kacho' AND id <> ?"),
  admins: db.prepare('SELECT * FROM users WHERE is_admin = 1 AND id <> ?'),
};

function normalize(b) {
  while (b.hours >= HOURS_PER_DAY) { b.hours -= HOURS_PER_DAY; b.days += 1; }
  while (b.hours < 0) { b.hours += HOURS_PER_DAY; b.days -= 1; }
  return b;
}
function consume(b, days, hours) {
  if (days) b.days -= days;
  if (hours) {
    while (b.hours < hours && b.days >= 1) { b.days -= 1; b.hours += HOURS_PER_DAY; } // 1日を崩して8時間にする
    b.hours -= hours;
  }
  return b;
}
function balance(user, fy) {
  const g = stmts.grantGet.get(user.id, fy);
  if (!g) return { fiscalYear: fy, granted: false, days: 0, hours: 0, usedDays: 0, usedHours: 0, carriedDays: 0, carriedHours: 0, grantedDays: 0, totalDays: 0, grantDate: '', planned: computeGrant(user, fy) };
  const b = { days: g.carried_days + g.granted_days, hours: g.carried_hours };
  const events = [
    ...stmts.reqApprovedAnnual.all(user.id, `${fy}-04-01`, `${fy + 1}-03-31`).filter((r) => TYPE[r.type] && TYPE[r.type].annual).map((r) => ({ at: r.start_date, req: r })),
    ...stmts.adjList.all(user.id, fy).map((a) => ({ at: a.created_at.slice(0, 10), adj: a })),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  let usedDays = 0, usedHours = 0;
  for (const e of events) {
    if (e.req) { consume(b, e.req.days, e.req.hours); usedDays += e.req.days; usedHours += e.req.hours; }
    else { b.days += e.adj.days; b.hours += e.adj.hours; normalize(b); }
  }
  // 承認待ちの年休（まだ残数からは引かないが、二重申請防止のために把握しておく）
  const pending = stmts.reqByUser.all(user.id, 200).filter((r) => r.status === 'pending' && TYPE[r.type] && TYPE[r.type].annual && fiscalYearOf(r.start_date) === fy);
  const pendingHours = pending.reduce((s, r) => s + r.days * HOURS_PER_DAY + r.hours, 0);
  return {
    fiscalYear: fy, granted: true, grantDate: g.grant_date, note: g.note,
    carriedDays: g.carried_days, carriedHours: g.carried_hours, grantedDays: g.granted_days, totalDays: g.carried_days + g.granted_days,
    days: b.days, hours: b.hours, totalHours: b.days * HOURS_PER_DAY + b.hours,
    usedDays, usedHours, pendingHours,
    availableHours: b.days * HOURS_PER_DAY + b.hours - pendingHours, // 承認待ちを差し引いた申請可能量
  };
}

// 年度の付与を実行（未付与の職員にだけ作成。既存は触らない）
function runGrants(fy, asOf) {
  const results = { created: [], skipped: [] };
  const tx = db.transaction(() => {
    for (const u of stmts.usersAll.all()) {
      if (stmts.grantGet.get(u.id, fy)) { results.skipped.push({ staffId: u.staff_id, name: u.name, reason: '付与済み' }); continue; }
      const plan = computeGrant(u, fy);
      if (!plan) { results.skipped.push({ staffId: u.staff_id, name: u.name, reason: u.hire_date ? '付与時期前' : '入職日未設定' }); continue; }
      if (plan.grantDate > asOf) { results.skipped.push({ staffId: u.staff_id, name: u.name, reason: `付与日 ${plan.grantDate} 前` }); continue; }
      // 前年度の残り → 繰越（上限 40日）
      let carriedDays = 0, carriedHours = 0;
      const prev = balance(u, fy - 1);
      if (prev.granted) {
        carriedDays = Math.max(0, prev.days); carriedHours = Math.max(0, prev.hours);
        if (carriedDays >= CARRY_MAX_DAYS) { carriedDays = CARRY_MAX_DAYS; carriedHours = 0; }
      }
      stmts.grantInsert.run(u.id, fy, plan.grantDate, carriedDays, carriedHours, plan.days, plan.index === 0 ? '初回付与（入職6か月）' : '定期付与（4/1）');
      results.created.push({ staffId: u.staff_id, name: u.name, carriedDays, carriedHours, grantedDays: plan.days, grantDate: plan.grantDate });
    }
  });
  tx();
  return results;
}

// ---- 申請 -------------------------------------------------------------------------
function validateRequest(user, body) {
  const b = body || {};
  const t = TYPE[b.type];
  if (!t) return { error: '休暇種別を選択してください' };
  if (!t.units.includes(b.unit)) return { error: `${t.label}では「${UNITS[b.unit] || b.unit}」の申請はできません` };
  if (!isDate(b.startDate)) return { error: '開始日を入力してください' };
  const endDate = b.unit === 'day' ? (b.endDate || b.startDate) : b.startDate;
  if (!isDate(endDate) || endDate < b.startDate) return { error: '終了日は開始日以降にしてください' };
  let days = 0, hours = 0;
  if (b.unit === 'day') {
    const span = daysBetween(b.startDate, endDate);
    days = Number(b.days) || span;
    if (!(days > 0) || days > span || Math.round(days * 2) !== days * 2) return { error: `申請日数は 0.5日単位で、${span}日以内にしてください` };
  } else if (b.unit === 'am' || b.unit === 'pm') {
    days = 0.5;
  } else {
    hours = Number(b.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > HOURS_PER_DAY - 1) return { error: `時間数は 1〜${HOURS_PER_DAY - 1} の整数で入力してください` };
  }
  if (t.annual) {
    const bal = balance(user, fiscalYearOf(b.startDate));
    if (!bal.granted) return { error: `${fiscalYearOf(b.startDate)}年度の年休がまだ付与されていません。事務部にご確認ください` };
    if (days * HOURS_PER_DAY + hours > bal.availableHours) return { error: '年休の残りが足りません（承認待ちの申請も含めて計算しています）' };
  }
  const time = (s) => (s && /^\d{2}:\d{2}$/.test(s) ? s : '');
  return {
    value: {
      type: b.type, unit: b.unit, startDate: b.startDate, endDate, days, hours,
      startTime: b.unit === 'hour' ? time(b.startTime) : '', endTime: b.unit === 'hour' ? time(b.endTime) : '',
      breakTaken: b.breakTaken === true || b.breakTaken === 1 ? 1 : b.breakTaken === false || b.breakTaken === 0 ? 0 : null,
      reason: String(b.reason || '').trim().slice(0, 200),
    },
  };
}
function createRequest(user, v) {
  const info = stmts.reqInsert.run(user.id, v.type, v.unit, v.startDate, v.endDate, v.days, v.hours, v.startTime, v.endTime, v.breakTaken, v.reason);
  return stmts.reqById.get(info.lastInsertRowid);
}
const canApprove = (approver, req) => approver.id !== req.user_id && (approver.is_admin || (['kacho', 'bucho'].includes(approver.role) && approver.department === req.department));
const isApprover = (u) => !!(u.is_admin || ['kacho', 'bucho'].includes(u.role));
function decide(approver, reqId, action, reason) {
  const r = stmts.reqById.get(reqId);
  if (!r) return { error: '申請が見つかりません' };
  if (r.status !== 'pending') return { error: 'この申請はすでに処理されています' };
  if (!canApprove(approver, r)) return { error: 'この申請を承認する権限がありません' };
  if (action === 'approve' && TYPE[r.type].annual) {
    const u = dbm.findUserById(r.user_id);
    const bal = balance(u, fiscalYearOf(r.start_date));
    if (r.days * HOURS_PER_DAY + r.hours > bal.totalHours) return { error: '本人の年休残数が不足しているため承認できません' };
  }
  stmts.reqDecide.run(action === 'approve' ? 'approved' : 'rejected', approver.id, action === 'approve' ? '' : String(reason || '').trim().slice(0, 200), reqId);
  return { request: stmts.reqById.get(reqId) };
}
// 本人による取消
//  - 承認待ち → その場で取消
//  - 承認済み → 休暇当日中まで本人申告で「取消申請」でき、課長の承認で取消確定（残数上は承認されるまで取得扱い）
//  - 翌日以降 → 不可（事務部で残数修正）
function cancel(user, reqId, reason) {
  const r = stmts.reqById.get(reqId);
  if (!r || r.user_id !== user.id) return { error: '申請が見つかりません' };
  if (r.status === 'cancelled') return { error: 'すでに取り消されています' };
  if (r.status === 'cancel_pending') return { error: '取消を申請中です。課長の承認をお待ちください' };
  if (r.status === 'rejected') return { error: '差し戻された申請は取り消す必要がありません' };
  if (r.status === 'pending') { stmts.reqCancel.run(reqId); return { request: stmts.reqById.get(reqId), immediate: true }; }
  if (r.start_date < today()) return { error: '休暇当日を過ぎた申請は取り消せません。事務部にご連絡ください' };
  if (!String(reason || '').trim()) return { error: '取消の理由を入力してください' };
  stmts.reqCancelRequest.run(String(reason).trim().slice(0, 200), reqId);
  return { request: stmts.reqById.get(reqId), immediate: false };
}
// 取消の承認は課長のみ（事務部の管理者は代行可）
const canDecideCancel = (approver, req) => approver.id !== req.user_id && (approver.is_admin || (approver.role === 'kacho' && approver.department === req.department));
function decideCancel(approver, reqId, action, reason) {
  const r = stmts.reqById.get(reqId);
  if (!r) return { error: '申請が見つかりません' };
  if (r.status !== 'cancel_pending') return { error: 'この申請は取消申請中ではありません' };
  if (!canDecideCancel(approver, r)) return { error: '取消の承認は課長のみ行えます' };
  stmts.reqCancelDecide.run(action === 'approve' ? 'cancelled' : 'approved', approver.id, action === 'approve' ? '' : String(reason || '').trim().slice(0, 200), reqId);
  return { request: stmts.reqById.get(reqId) };
}
// 自分が処理できる承認待ち（部長は取消申請を扱わない）
const actionable = (u, r) => (r.status === 'pending' ? canApprove(u, r) : canDecideCancel(u, r));

// 申請の表示用
function publicRequest(r) {
  const t = TYPE[r.type] || { label: r.type, paid: true, annual: false };
  return {
    id: r.id, userId: r.user_id, userName: r.userName, staffId: r.staffId, department: r.department, section: r.section,
    type: r.type, typeLabel: t.label, paid: t.paid, annual: t.annual,
    unit: r.unit, unitLabel: UNITS[r.unit], startDate: r.start_date, endDate: r.end_date, days: r.days, hours: r.hours,
    startTime: r.start_time, endTime: r.end_time, breakTaken: r.break_taken, reason: r.reason,
    status: r.status, approverName: r.approverName || '', decidedAt: r.decided_at || '', rejectReason: r.reject_reason, createdAt: r.created_at,
    cancelReason: r.cancel_reason || '', cancelRequestedAt: r.cancel_requested_at || '', cancelDeciderName: r.cancelDeciderName || '', cancelDecidedAt: r.cancel_decided_at || '', cancelRejectReason: r.cancel_reject_reason || '',
  };
}
// 年5日取得義務の進捗（時間年休は含めない）
function fiveDayProgress(userId, fy) {
  const rows = stmts.reqApprovedAnnual.all(userId, `${fy}-04-01`, `${fy + 1}-03-31`).filter((r) => TYPE[r.type] && TYPE[r.type].annual);
  return rows.reduce((s, r) => s + r.days, 0);
}

module.exports = {
  HOURS_PER_DAY, CARRY_MAX_DAYS, LEAVE_TYPES, UNITS, ROLES, TYPE,
  today, fiscalYearOf, currentFiscalYear, computeGrant, balance, runGrants, fiveDayProgress,
  validateRequest, createRequest, decide, cancel, decideCancel, publicRequest, canApprove, canDecideCancel, isApprover,
  listMyRequests: (userId, limit = 100) => stmts.reqByUser.all(userId, limit).map(publicRequest),
  findRequest: (id) => stmts.reqById.get(id),
  pendingFor: (u) => stmts.reqPendingForDept.all(u.is_admin ? 1 : 0, u.department).filter((r) => actionable(u, r)).map(publicRequest),
  recentFor: (u) => stmts.reqRecentForDept.all(u.is_admin ? 1 : 0, u.department).map(publicRequest),
  pendingCount: (u) => (isApprover(u) ? stmts.reqPendingForDept.all(u.is_admin ? 1 : 0, u.department).filter((r) => actionable(u, r)).length : 0),
  monthRows: (ym) => stmts.reqMonth.all(ym).map(publicRequest),
  approversFor: (user) => { const a = stmts.approversOfDept.all(user.department, user.id); return a.length ? a : stmts.admins.all(user.id); },
  cancelApproversFor: (user) => { const a = stmts.kachoOfDept.all(user.department, user.id); return a.length ? a : stmts.admins.all(user.id); },
  addAdjustment: (userId, fy, days, hours, note, by) => stmts.adjInsert.run(userId, fy, Number(days) || 0, Math.trunc(Number(hours) || 0), String(note || '').trim(), by),
  listAdjustments: (userId, fy) => stmts.adjList.all(userId, fy),
  setGrant: (userId, fy, { carriedDays, carriedHours, grantedDays, note }) => {
    const g = stmts.grantGet.get(userId, fy);
    if (g) stmts.grantUpdate.run(Number(carriedDays) || 0, Math.trunc(Number(carriedHours) || 0), Number(grantedDays) || 0, String(note || ''), g.id);
    else stmts.grantInsert.run(userId, fy, `${fy}-04-01`, Number(carriedDays) || 0, Math.trunc(Number(carriedHours) || 0), Number(grantedDays) || 0, String(note || '手入力'));
  },
  allUsers: () => stmts.usersAll.all(),
};
