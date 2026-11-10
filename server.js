// 職員向けお知らせPWA 試作版 サーバー
// 役割: ログイン / お知らせAPI / プッシュ通知の購読管理と送信 / 静的ファイル配信
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const db = require('./db');
const leave = require('./leave');
const health = require('./health');
const alerts = require('./alerts');
const dept = require('./dept');
const messages = require('./messages');
const schedule = require('./schedule');
const training = require('./training');
const surveys = require('./surveys');
const multer = require('multer');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || db.HOSPITAL_NAME;

// ---- VAPID（プッシュ通知の鍵）--------------------------------------------
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です。`npm run vapid` で生成して .env に書いてください。');
  process.exit(1);
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-in-production')) {
  console.error('【警告】SESSION_SECRET が初期値のままです。Render の Environment で長いランダムな文字列を設定してください。');
}

// ---- アプリ設定 ---------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Render / Railway 等のリバースプロキシ配下でも secure cookie が動くように
app.use(express.json({ limit: '100kb' }));
app.use(
  cookieSession({
    name: 'sess',
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30日
  })
);

// 静的ファイル: 常に最新を取りに行かせる（HTML / SW / JS はキャッシュさせない）
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|webmanifest|json)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

// ---- 認証ヘルパー -------------------------------------------------------
function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.findUserById(req.session.userId);
}
function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'ログインが必要です' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: '管理者のみ操作できます' });
    next();
  });
}

// APIは一切キャッシュさせない
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---- ログインの総当たり対策（職員番号ごと：5回失敗で15分ロック）-----------------------------
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // staffId -> { count, until }
function loginLocked(staffId) {
  const f = loginFails.get(staffId);
  if (!f) return 0;
  if (f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 60000);
  if (f.until && f.until <= Date.now()) loginFails.delete(staffId);
  return 0;
}
function loginFailed(staffId) {
  const f = loginFails.get(staffId) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= LOGIN_MAX_FAILS) { f.until = Date.now() + LOGIN_LOCK_MS; f.count = 0; console.warn(`ログイン連続失敗によりロック: ${staffId}`); }
  loginFails.set(staffId, f);
}

// ---- パスワードの強度チェック -------------------------------------------------------
// パスワードは数字4桁（運用上の決定）。職員番号と同じものと、推測されやすい並びは不可
function passwordProblem(pw, user) {
  const p = String(pw || '').normalize('NFKC');
  if (!/^\d{4}$/.test(p)) return 'パスワードは数字4桁で入力してください';
  if (user && p === String(user.staff_id)) return '職員番号と同じパスワードは使えません';
  if (/^(\d)\1{3}$/.test(p) || ['1234', '0123', '4321', '9876', '0000'].includes(p)) return '推測されやすいパスワード（同じ数字の繰り返し、1234 など）は使えません';
  return null;
}

// ---- 認証API ------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { staffId, password } = req.body || {};
  if (!staffId || !password) return res.status(400).json({ error: '職員番号とパスワードを入力してください' });
  const sid = db.normalizeStaffId(staffId);
  const lockMin = loginLocked(sid);
  if (lockMin) return res.status(429).json({ error: `ログインに連続して失敗したため、あと約${lockMin}分ロックされています` });
  const user = db.findUserByStaffId(sid);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    loginFailed(sid);
    return res.status(401).json({ error: '職員番号またはパスワードが違います' });
  }
  loginFails.delete(sid);
  req.session.userId = user.id;
  req.session.loginAt = Date.now();
  res.json({ user: publicUser(user) });
});

// 初期パスワードのままの職員は、パスワード変更が終わるまで他の機能を使えない
const MUST_CHANGE_ALLOW = ['/me', '/password', '/logout', '/login', '/departments', '/push/public-key']; // app.use('/api') 配下なので /api を除いたパス
app.use('/api', (req, res, next) => {
  if (MUST_CHANGE_ALLOW.includes(req.path)) return next();
  const user = currentUser(req);
  if (user && user.must_change_password) return res.status(403).json({ error: '最初にパスワードを変更してください', mustChangePassword: true });
  next();
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null, status: user ? userStatus(user) : null, rules: db.POINT_RULES, appName: APP_NAME });
});

// ポイント・くじ・歩数の今日の状態
function rankOf(points) {
  return db.POINT_RULES.ranks.find((r) => points >= r.min) || db.POINT_RULES.ranks[db.POINT_RULES.ranks.length - 1];
}
function userStatus(user) {
  const points = db.pointsTotal(user.id);
  const lottery = db.pointLogToday(user.id, 'lottery');
  return {
    points,
    rank: rankOf(points).name,
    checkedInToday: !!db.pointLogToday(user.id, 'checkin'),
    lotteryToday: lottery ? { label: lottery.note, points: lottery.points } : null,
    stepsToday: db.stepsToday(user.id),
    stepsRewardedToday: !!db.pointLogToday(user.id, 'steps'),
    healthToday: health.myToday(user.id),
  };
}

function publicUser(u) {
  return {
    id: u.id, staffId: u.staff_id, name: u.name, kana: u.kana, department: u.department, section: u.section, job: u.job, isAdmin: !!u.is_admin,
    role: u.role || '', roleLabel: leave.ROLES[u.role || ''] || '一般', hireDate: u.hire_date || '', weeklyDays: u.weekly_days || 5,
    mustChangePassword: !!u.must_change_password, passwordChangedAt: u.password_changed_at || '',
    isApprover: leave.isApprover(u), pendingApprovals: leave.pendingCount(u),
    isHealthViewer: health.isViewer(u), healthUnconfirmed: health.unconfirmedCount(u),
    canSendAlerts: alerts.canSend(u), canEditDeptFiles: dept.canEditFiles(u),
    unreadMessages: messages.unreadTotal(u),
    canEditTraining: training.canEdit(u), canCreateSurveys: surveys.canCreate(u), openSurveys: surveys.openUnanswered(u).length,
  };
}

// 自分のパスワード変更
app.post('/api/password', requireLogin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '現在のパスワードと新しいパスワードを入力してください' });
  const problem = passwordProblem(newPassword, req.user);
  if (problem) return res.status(400).json({ error: problem });
  if (!bcrypt.compareSync(currentPassword, req.user.password_hash)) return res.status(401).json({ error: '現在のパスワードが違います' });
  if (bcrypt.compareSync(newPassword, req.user.password_hash)) return res.status(400).json({ error: '現在と同じパスワードは使えません' });
  db.setPassword(req.user.id, bcrypt.hashSync(newPassword, 10));
  res.json({ ok: true, user: publicUser(db.findUserById(req.user.id)) });
});

// ---- ポイント・くじ・歩数 -----------------------------------------------------
app.post('/api/points/checkin', requireLogin, (req, res) => {
  if (db.pointLogToday(req.user.id, 'checkin')) return res.status(409).json({ error: '本日の出社ポイントは取得済みです' });
  db.addPoints(req.user.id, 'checkin', db.POINT_RULES.checkin, '出社ポイント');
  res.json({ granted: db.POINT_RULES.checkin, status: userStatus(req.user) });
});

app.post('/api/points/lottery', requireLogin, (req, res) => {
  if (db.pointLogToday(req.user.id, 'lottery')) return res.status(409).json({ error: '本日のくじは引き終わっています' });
  const table = db.POINT_RULES.lottery;
  const total = table.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  let hit = table[0];
  for (const t of table) { r -= t.weight; if (r < 0) { hit = t; break; } }
  db.addPoints(req.user.id, 'lottery', hit.points, hit.label);
  res.json({ result: { label: hit.label, points: hit.points }, status: userStatus(req.user) });
});

app.post('/api/steps', requireLogin, (req, res) => {
  const steps = Math.floor(Number(req.body && req.body.steps));
  if (!Number.isFinite(steps) || steps < 0 || steps > 100000) return res.status(400).json({ error: '歩数は 0〜100000 の数値で入力してください' });
  db.setStepsToday(req.user.id, steps);
  let granted = 0;
  if (steps >= db.POINT_RULES.stepsGoal && !db.pointLogToday(req.user.id, 'steps')) {
    db.addPoints(req.user.id, 'steps', db.POINT_RULES.stepsBonus, `目標歩数 ${db.POINT_RULES.stepsGoal} 歩 達成`);
    granted = db.POINT_RULES.stepsBonus;
  }
  res.json({ granted, status: userStatus(req.user), week: db.stepsWeek(req.user.id) });
});

app.get('/api/points/history', requireLogin, (req, res) => {
  res.json({ history: db.pointHistory(req.user.id, 50), week: db.stepsWeek(req.user.id) });
});

// ---- 掲載コンテンツ（カルチャー / 知る・学ぶ / お役立ち）----------------------------
app.get('/api/contents', requireLogin, (req, res) => {
  res.json({ contents: db.listContents(false), pickupId: Number(db.getSetting('pickup_content_id') || 0) });
});

app.get('/api/admin/contents', requireAdmin, (req, res) => {
  res.json({ contents: db.listContents(true), pickupId: Number(db.getSetting('pickup_content_id') || 0) });
});

const TABS = ['culture', 'learn', 'tools'];
function validateContent(body) {
  const c = body || {};
  if (!TABS.includes(c.tab)) return 'タブを選択してください';
  if (!c.section || !String(c.section).trim()) return '見出しを入力してください';
  if (!c.title || !String(c.title).trim()) return 'タイトルを入力してください';
  if (!['article', 'link'].includes(c.kind)) return '種類を選択してください';
  if (c.date && !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return '日付は YYYY-MM-DD 形式で入力してください';
  return null;
}
app.post('/api/admin/contents', requireAdmin, (req, res) => {
  const err = validateContent(req.body);
  if (err) return res.status(400).json({ error: err });
  const c = { ...req.body, section: String(req.body.section).trim(), title: String(req.body.title).trim(), date: req.body.date || new Date().toISOString().slice(0, 10) };
  res.json({ content: db.createContent(c) });
});
app.put('/api/admin/contents/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.findContent(id)) return res.status(404).json({ error: '見つかりません' });
  const err = validateContent(req.body);
  if (err) return res.status(400).json({ error: err });
  const c = { ...req.body, section: String(req.body.section).trim(), title: String(req.body.title).trim(), date: req.body.date || new Date().toISOString().slice(0, 10) };
  res.json({ content: db.updateContent(id, c) });
});
app.delete('/api/admin/contents/:id', requireAdmin, (req, res) => {
  db.deleteContent(Number(req.params.id));
  if (Number(db.getSetting('pickup_content_id')) === Number(req.params.id)) db.setSetting('pickup_content_id', '0');
  res.json({ ok: true });
});
app.post('/api/admin/pickup', requireAdmin, (req, res) => {
  const id = Number(req.body && req.body.contentId);
  if (id && !db.findContent(id)) return res.status(404).json({ error: '見つかりません' });
  db.setSetting('pickup_content_id', String(id || 0));
  res.json({ ok: true, pickupId: id || 0 });
});

app.get('/api/departments', (req, res) => {
  res.json({ departments: db.DEPARTMENTS });
});

// ---- お知らせAPI --------------------------------------------------------
app.get('/api/notices', requireLogin, (req, res) => {
  res.json({ notices: db.listNoticesFor(req.user, 100) });
});

app.get('/api/notices/:id', requireLogin, (req, res) => {
  const n = db.findNotice(Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'お知らせが見つかりません' });
  res.json({ notice: n });
});

const CATEGORIES = ['important', 'general', 'department'];
// お知らせの添付ファイル（PDF・画像など、1件につき5ファイルまで）。保存先は部署ファイルと同じ FILES_DIR
app.get('/api/notices/att/:stored', requireLogin, (req, res) => {
  const name = String(req.params.stored || '');
  if (!/^[\w.-]+$/.test(name)) return res.status(404).json({ error: 'ファイルが見つかりません' });
  const fp = path.join(dept.FILES_DIR, name);
  if (!require('fs').existsSync(fp)) return res.status(404).json({ error: 'ファイルが見つかりません' });
  const orig = String(req.query.name || name);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(orig)}`);
  res.sendFile(fp);
});
app.post('/api/admin/notices', requireAdmin, (req, res, next) => {
  // JSON でも multipart（添付あり）でも受け付ける
  if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) return upload.array('files', 5)(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ファイルは 10MB までです' : err.message }) : next()));
  next();
}, async (req, res) => {
  const { title, body, category, department } = req.body || {};
  const push = req.body.push === true || req.body.push === 'true' || req.body.push === '1';
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'タイトルを入力してください' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: '区分を選択してください' });
  if (category === 'department' && !db.TARGETS.includes(department)) return res.status(400).json({ error: '対象部門を選択してください' });
  const attachments = (req.files || []).map((f) => { const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); return { name, url: `/api/notices/att/${f.filename}?name=${encodeURIComponent(name)}` }; });

  const notice = db.createNotice({
    category,
    department: category === 'department' ? department : '',
    title: String(title).trim(),
    body: String(body || '').trim(),
    createdBy: req.user.id,
    attachments,
  });

  let pushResult = null;
  if (push) {
    // 部門別は該当部署の端末だけ、それ以外は全端末
    const targets = category === 'department' ? db.listSubscriptionsByTarget(department) : db.listSubscriptions();
    pushResult = await sendPush(targets, {
      title: (category === 'important' ? '【重要】' : '') + notice.title.replace(/^【重要】/, ''),
      body: notice.body ? notice.body.split('\n')[0].slice(0, 80) : '新しいお知らせがあります',
      url: `/?notice=${notice.id}`,
      tag: `notice-${notice.id}`,
    });
  }
  res.json({ notice, push: pushResult });
});

app.delete('/api/admin/notices/:id', requireAdmin, (req, res) => {
  db.deleteNotice(Number(req.params.id));
  res.json({ ok: true });
});

// ---- プッシュ通知 購読API ------------------------------------------------
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireLogin, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: '購読情報が不正です' });
  db.upsertSubscription({ userId: req.user.id, endpoint: sub.endpoint, keysJson: JSON.stringify(sub.keys), userAgent: req.get('user-agent') || '' });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireLogin, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) db.deleteSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// 自分の端末にだけテスト送信（通知が届くかの確認用）
app.post('/api/push/test', requireLogin, async (req, res) => {
  const subs = db.listSubscriptionsByUser(req.user.id);
  if (subs.length === 0) return res.status(400).json({ error: 'この端末はまだ通知を受け取る設定になっていません' });
  const result = await sendPush(subs, {
    title: `${APP_NAME} テスト通知`,
    body: `${req.user.name} さんの端末に届いています`,
    url: '/',
    tag: 'test',
  });
  res.json(result);
});

// ---- 管理API ------------------------------------------------------------
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({
    users: db.countUsers(),
    subscriptions: db.countSubscriptions(),
    subscribedUsers: db.countSubscribedUsers(),
    checkinsToday: db.checkinsToday(),
    pointsTotal: db.pointsAllTotal(),
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: db.listUsers() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { staffId, name, kana, department, section, job, password, isAdmin, hireDate, weeklyDays, role } = req.body || {};
  if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return res.status(400).json({ error: '入職日は YYYY-MM-DD 形式で入力してください' });
  if (role && !Object.prototype.hasOwnProperty.call(leave.ROLES, role)) return res.status(400).json({ error: '役職の指定が不正です' });
  if (!staffId || !name) return res.status(400).json({ error: '職員番号・氏名は必須です' });
  const sidNorm = db.normalizeStaffId(staffId);
  if (!/^\d{1,6}$/.test(sidNorm)) return res.status(400).json({ error: '職員番号は数字で入力してください（先頭の0は不要）' });
  if (password && !/^\d{4}$/.test(String(password))) return res.status(400).json({ error: '初期パスワードを指定する場合は数字4桁にしてください（空欄なら職員番号と同じ）' });
  const dept = db.DEPARTMENTS.find((d) => d.name === department);
  if (!dept) return res.status(400).json({ error: '部門を選択してください' });
  if (dept.sections.length && !dept.sections.includes(section)) return res.status(400).json({ error: '課・病棟を選択してください' });
  if (db.findUserByStaffId(sidNorm)) return res.status(409).json({ error: 'その職員番号はすでに登録されています' });
  const user = db.createUser({
    staffId: sidNorm, name: String(name).trim(), kana: String(kana || '').trim(),
    department, section: dept.sections.length ? section : '', job: String(job || '').trim(), passwordHash: bcrypt.hashSync(password || db.initialPassword(sidNorm), 10), isAdmin: !!isAdmin,
    hireDate: hireDate || '', weeklyDays: Number(weeklyDays) || 5, role: role || '', mustChange: true, // 初回ログイン時に変更必須
  });
  res.json({ user: publicUser(user), initialPassword: password ? '' : db.initialPassword(user.staff_id) });
});

// 職員のCSV一括登録
//  列：職員番号,氏名,ふりがな,部門,課・病棟,職種,役職,入職日,週所定日数,管理者
//  - 職員番号は先頭の0を取り除いて登録（00173 → 173）
//  - 役職は「部長／副部長／施設長→部長権限」「課長／副課長→課長権限」「主任→主任権限」、空欄は一般
//  - ふりがな・氏名のカタカナ（半角含む）はひらがなに変換
//  - 既存の職員番号は更新（氏名・所属・役職など）。パスワードは変更しない
const toHiragana = (s) => String(s || '').normalize('NFKC').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).trim();
const ROLE_WORDS = { bucho: ['部長', '副部長', '施設長', '室長', '所長'], kacho: ['課長', '副課長', '師長', '科長'], shunin: ['主任', '副師長', '係長'] };
function roleFromLabel(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (['bucho', 'kacho', 'shunin'].includes(t)) return t;
  for (const [role, words] of Object.entries(ROLE_WORDS)) if (words.some((w) => t.includes(w))) return role;
  return null;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}
app.post('/api/admin/users/import', requireAdmin, (req, res) => {
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length < 2) return res.status(400).json({ error: 'ヘッダー行と1名以上のデータが必要です' });
  const head = rows[0].map((h) => String(h).trim());
  const col = (names) => head.findIndex((h) => names.includes(h));
  const ci = { staffId: col(['職員番号', '職員ID', 'staffId']), name: col(['氏名', '名前', 'name']), kana: col(['ふりがな', 'フリガナ', 'カナ', 'kana']), department: col(['部門', '部署', 'department']), section: col(['課・病棟', '課', '病棟', 'section']), job: col(['職種', 'job']), role: col(['役職', 'role']), hireDate: col(['入職日', 'hireDate']), weeklyDays: col(['週所定日数', 'weeklyDays']), isAdmin: col(['管理者', 'isAdmin']) };
  if (ci.staffId < 0 || ci.name < 0) return res.status(400).json({ error: '「職員番号」「氏名」の列が必要です' });
  const get = (r, k) => (ci[k] >= 0 ? String(r[ci[k]] ?? '').trim() : '');
  const result = { created: [], updated: [], errors: [] };
  const tx = db.raw.transaction(() => {
    rows.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const staffId = db.normalizeStaffId(get(r, 'staffId'));
      if (!/^\d{1,6}$/.test(staffId)) { result.errors.push(`${line}行目：職員番号「${get(r, 'staffId')}」は数字にしてください`); return; }
      const name = toHiragana(get(r, 'name')) || '';
      if (!name) { result.errors.push(`${line}行目（${staffId}）：氏名が空です`); return; }
      const kana = toHiragana(get(r, 'kana')) || name;
      const department = get(r, 'department') || req.user.department;
      const d = db.DEPARTMENTS.find((x) => x.name === department);
      if (!d) { result.errors.push(`${line}行目（${staffId}）：部門「${department}」がありません`); return; }
      const section = get(r, 'section');
      if (section && !d.sections.includes(section)) { result.errors.push(`${line}行目（${staffId}）：${department} に「${section}」はありません`); return; }
      const role = roleFromLabel(get(r, 'role'));
      if (role === null) { result.errors.push(`${line}行目（${staffId}）：役職「${get(r, 'role')}」を判定できません（部長／課長／主任 など）`); return; }
      const hireDate = get(r, 'hireDate').replace(/\//g, '-');
      if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) { result.errors.push(`${line}行目（${staffId}）：入職日は YYYY-MM-DD で入力してください`); return; }
      const weeklyDays = Number(get(r, 'weeklyDays')) || 5;
      const isAdmin = /^(1|○|〇|はい|yes|true|管理者)$/i.test(get(r, 'isAdmin'));
      const existing = db.findUserByStaffId(staffId);
      if (existing) {
        db.raw.prepare('UPDATE users SET name = ?, kana = ?, department = ?, section = ?, job = ?, role = ?, hire_date = ?, weekly_days = ?, is_admin = ? WHERE id = ?')
          .run(name, kana, department, section, get(r, 'job'), role, hireDate, weeklyDays, isAdmin || existing.is_admin ? 1 : 0, existing.id);
        result.updated.push(`${staffId} ${name}`);
      } else {
        db.createUser({ staffId, name, kana, department, section, job: get(r, 'job'), passwordHash: bcrypt.hashSync(db.initialPassword(staffId), 10), isAdmin, hireDate, weeklyDays, role, mustChange: true });
        result.created.push(`${staffId} ${name}`);
      }
    });
  });
  tx();
  res.json(result);
});

// パスワードを初期化（職員番号と同じ値に戻し、次回ログインで変更必須にする）
app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const u = db.findUserById(Number(req.params.id));
  if (!u) return res.status(404).json({ error: '職員が見つかりません' });
  db.resetPassword(u.id, u.staff_id);
  res.json({ ok: true, initialPassword: db.initialPassword(u.staff_id) });
});

// 職員の休暇プロフィール（入職日・週所定日数・役職）
app.put('/api/admin/users/:id/leave-profile', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.findUserById(id);
  if (!u) return res.status(404).json({ error: '職員が見つかりません' });
  const { hireDate, weeklyDays, role } = req.body || {};
  if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return res.status(400).json({ error: '入職日は YYYY-MM-DD 形式で入力してください' });
  const wd = Number(weeklyDays);
  if (!(wd >= 1 && wd <= 5)) return res.status(400).json({ error: '週所定日数は 1〜5 で入力してください' });
  if (!Object.prototype.hasOwnProperty.call(leave.ROLES, role || '')) return res.status(400).json({ error: '役職の指定が不正です' });
  db.setLeaveProfile(id, { hireDate: hireDate || '', weeklyDays: wd, role: role || '' });
  res.json({ user: publicUser(db.findUserById(id)) });
});

// ---- スケジュールAPI --------------------------------------------------------------
app.get('/api/sched/groups', requireLogin, (req, res) => {
  res.json({ groups: schedule.groupsFor(req.user), colors: schedule.COLORS });
});
app.post('/api/sched/groups', requireLogin, (req, res) => {
  const r = schedule.createGroup(req.user, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.get('/api/sched/groups/:id', requireLogin, (req, res) => {
  const g = schedule.groupDetail(req.user, Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  res.json({ group: g });
});
app.put('/api/sched/groups/:id', requireLogin, (req, res) => {
  const r = schedule.updateGroup(req.user, Number(req.params.id), req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.post('/api/sched/groups/:id/leave', requireLogin, (req, res) => {
  const r = schedule.leaveGroup(req.user, Number(req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.delete('/api/sched/groups/:id', requireLogin, (req, res) => {
  const r = schedule.deleteGroup(req.user, Number(req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.get('/api/sched/events', requireLogin, (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return res.status(400).json({ error: '期間を指定してください' });
  res.json({ events: schedule.events(req.user, from, to) });
});
app.post('/api/sched/events', requireLogin, async (req, res) => {
  const r = schedule.create(req.user, req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  // グループの予定は他のメンバーに通知（通知を希望しない場合は notify:false）
  let push = null;
  if (r.event.groupId && (req.body.notify !== false)) {
    const subs = schedule.groupMembers(r.event.groupId).filter((m) => m.id !== req.user.id).flatMap((m) => db.listSubscriptionsByUser(m.id));
    if (subs.length) push = await sendPush(subs, { title: `予定が追加されました（${r.event.groupName}）`, body: `${r.event.date.replace(/-/g, '/')}${r.event.startTime ? ' ' + r.event.startTime : ''} ${r.event.title}`, url: `/?view=schedule&date=${r.event.date}`, tag: `sched-${r.event.id}` });
  }
  res.json({ ...r, push });
});
app.put('/api/sched/events/:id', requireLogin, (req, res) => {
  const r = schedule.update(req.user, Number(req.params.id), req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.post('/api/sched/events/:id/copy', requireLogin, (req, res) => {
  const r = schedule.copy(req.user, Number(req.params.id), req.body && req.body.date);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.delete('/api/sched/events/:id', requireLogin, (req, res) => {
  const r = schedule.remove(req.user, Number(req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// ---- メッセージAPI --------------------------------------------------------------
function loadConv(req, res, next) {
  const c = messages.find(Number(req.params.id));
  if (!c || !messages.isMember(c, req.user)) return res.status(404).json({ error: '会話が見つかりません' });
  req.conv = c;
  next();
}
app.get('/api/msg/conversations', requireLogin, (req, res) => {
  res.json({ conversations: messages.listFor(req.user) });
});
app.get('/api/msg/directory', requireLogin, (req, res) => {
  res.json({ users: messages.directory(req.user) });
});
app.post('/api/msg/conversations', requireLogin, (req, res) => {
  const b = req.body || {};
  const r = b.type === 'group' ? messages.createGroup(req.user, b.name, b.memberIds) : messages.openDirect(req.user, Number(b.userId));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ conversation: messages.detail(r.conversation, req.user) });
});
app.get('/api/msg/conversations/:id', requireLogin, loadConv, (req, res) => {
  res.json({ conversation: messages.detail(req.conv, req.user), messages: messages.messages(req.conv, req.user, { after: Number(req.query.after) || 0, before: Number(req.query.before) || 0 }) });
});
app.put('/api/msg/conversations/:id', requireLogin, loadConv, (req, res) => {
  const r = messages.updateGroup(req.user, req.conv, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ conversation: messages.detail(r.conversation, req.user) });
});
app.post('/api/msg/conversations/:id/leave', requireLogin, loadConv, (req, res) => {
  const r = messages.leave(req.user, req.conv);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.post('/api/msg/conversations/:id/messages', requireLogin, loadConv, async (req, res) => {
  const r = messages.send(req.conv, req.user, req.body && req.body.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const d = messages.detail(req.conv, req.user);
  const others = messages.members(req.conv).filter((m) => m.id !== req.user.id);
  const subs = others.flatMap((m) => db.listSubscriptionsByUser(m.id));
  const push = subs.length ? await sendPush(subs, { title: req.conv.type === 'direct' ? req.user.name : `${d.name}：${req.user.name}`, body: r.message.body.slice(0, 80), url: `/?chat=${req.conv.id}`, tag: `chat-${req.conv.id}` }) : null;
  res.json({ message: r.message, push });
});

// ---- 部署ページAPI --------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: dept.FILES_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${dept.ALLOWED[file.mimetype] || ''}`),
  }),
  limits: { fileSize: dept.MAX_SIZE },
  fileFilter: (req, file, cb) => (dept.ALLOWED[file.mimetype] ? cb(null, true) : cb(new Error('PDF・Excel・Word・画像（PNG/JPEG）のみアップロードできます'))),
});
// ページキー（'事務部' / '看護部/3A'）。指定がなければ自分の所属
function deptOf(req) {
  const q = req.query.department || (req.body && req.body.department);
  const d = q ? String(q) : req.user.department;
  return dept.isValidKey(d) ? d : null;
}

app.get('/api/dept', requireLogin, (req, res) => {
  const d = deptOf(req);
  if (!d) return res.status(404).json({ error: 'この部署のページはありません' });
  res.json({ ...dept.page(d), canEdit: dept.canManageFiles(req.user, d), canEditNote: dept.canEditNote(req.user, d), pages: dept.pageList(), myDepartment: req.user.department, mySection: req.user.section });
});
// 朝礼メモ（本日分。その部署の職員なら誰でも更新可）
app.put('/api/dept/note', requireLogin, (req, res) => {
  const d = deptOf(req);
  if (!d) return res.status(404).json({ error: 'この部署のページはありません' });
  if (!dept.canEditNote(req.user, d)) return res.status(403).json({ error: '朝礼の入力はその部署の職員のみです' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body.day || '') ? req.body.day : dept.today();
  res.json({ note: dept.saveNote(d, day, req.body.body, req.user.id) });
});
app.get('/api/dept/note', requireLogin, (req, res) => {
  const d = deptOf(req);
  if (!d) return res.status(403).json({ error: '閲覧できません' });
  res.json({ note: dept.getNote(d, /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dept.today()) });
});
// ファイル
app.post('/api/dept/files', requireLogin, (req, res) => {
  if (!dept.canEditFiles(req.user)) return res.status(403).json({ error: 'アップロードは課長・主任・部長・管理者のみです' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ファイルは 10MB までです' : err.message });
    if (!req.file) return res.status(400).json({ error: 'ファイルを選択してください' });
    const d = deptOf(req);
    if (!d || !dept.canManageFiles(req.user, d)) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} return res.status(403).json({ error: '自分の部署のページにのみ登録できます' }); }
    const r = dept.addFile({ department: d, category: req.body.category, month: req.body.month, title: req.body.title, origName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), storedName: req.file.filename, mime: req.file.mimetype, size: req.file.size, userId: req.user.id });
    if (r.error) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ error: r.error }); }
    res.json(r);
  });
});
app.get('/api/dept/files/:id/download', requireLogin, (req, res) => {
  const f = dept.findFile(Number(req.params.id));
  if (!f || !dept.canView(req.user, f.department)) return res.status(404).json({ error: 'ファイルが見つかりません' });
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.orig_name)}`);
  res.type(f.mime);
  res.sendFile(path.join(dept.FILES_DIR, f.stored_name));
});
app.delete('/api/dept/files/:id', requireLogin, (req, res) => {
  const f = dept.findFile(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'ファイルが見つかりません' });
  if (!dept.canManageFiles(req.user, f.department)) return res.status(403).json({ error: '削除は、その部署の課長・主任・部長と管理者のみです' });
  dept.removeFile(f.id);
  res.json({ ok: true });
});

// ---- 研修ページAPI --------------------------------------------------------------
app.get('/api/training', requireLogin, (req, res) => {
  res.json({ categories: training.categories(), items: training.list(req.user), canEdit: training.canEdit(req.user), links: training.links(training.canEdit(req.user)), today: dept.today() });
});
// 研修リンク（権限者が登録・編集）
app.get('/api/training/links', requireLogin, (req, res) => res.json({ links: training.links(false) }));
app.post('/api/training/links', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: 'リンクの登録は権限のある職員のみです' });
  const r = training.createLink(req.body || {}, req.user.id);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.put('/api/training/links/:id', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: 'リンクの変更は権限のある職員のみです' });
  const r = training.updateLink(Number(req.params.id), req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.delete('/api/training/links/:id', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: 'リンクの削除は権限のある職員のみです' });
  training.removeLink(Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/training', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: '研修資料の登録は権限のある職員のみです' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ファイルは 10MB までです' : err.message });
    const r = training.create({ category: req.body.category, title: req.body.title, description: req.body.description, heldOn: req.body.heldOn, url: req.body.url, required: req.body.required === 'true' || req.body.required === '1',
      origName: req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : '', storedName: req.file ? req.file.filename : '', mime: req.file ? req.file.mimetype : '', size: req.file ? req.file.size : 0, userId: req.user.id });
    if (r.error) { if (req.file) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} } return res.status(400).json({ error: r.error }); }
    res.json(r);
  });
});
app.get('/api/training/:id/download', requireLogin, (req, res) => {
  const t = training.find(Number(req.params.id));
  if (!t || !t.stored_name) return res.status(404).json({ error: 'ファイルが見つかりません' });
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(t.orig_name)}`);
  res.type(t.mime);
  res.sendFile(path.join(dept.FILES_DIR, t.stored_name));
});
app.post('/api/training/:id/done', requireLogin, (req, res) => {
  if (!training.find(Number(req.params.id))) return res.status(404).json({ error: '見つかりません' });
  training.markDone(Number(req.params.id), req.user.id, !(req.body && req.body.undo));
  res.json({ ok: true });
});
app.get('/api/training/:id/status', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: '受講状況の閲覧は権限のある職員のみです' });
  const t = training.find(Number(req.params.id));
  if (!t) return res.status(404).json({ error: '見つかりません' });
  res.json({ item: training.pub(t), ...training.status(t.id) });
});
app.delete('/api/training/:id', requireLogin, (req, res) => {
  if (!training.canEdit(req.user)) return res.status(403).json({ error: '削除は権限のある職員のみです' });
  training.remove(Number(req.params.id));
  res.json({ ok: true });
});

// ---- アンケートAPI --------------------------------------------------------------
app.get('/api/surveys', requireLogin, (req, res) => {
  res.json({ surveys: surveys.listFor(req.user), mine: surveys.canCreate(req.user) ? surveys.listMine(req.user) : [], canCreate: surveys.canCreate(req.user), types: surveys.TYPES, departments: db.DEPARTMENTS.map((d) => d.name), canTargetAll: !!req.user.is_admin, myDepartment: req.user.department });
});
app.post('/api/surveys', requireLogin, async (req, res) => {
  if (!surveys.canCreate(req.user)) return res.status(403).json({ error: 'アンケートの作成は管理者・部長・課長のみです' });
  const r = surveys.create(req.user, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  let push = null;
  if (req.body.notify) {
    const subs = (r.survey.target === 'all' ? db.listSubscriptions() : db.listSubscriptionsByTarget(r.survey.target));
    if (subs.length) push = await sendPush(subs, { title: 'アンケートのお願い', body: r.survey.title + (r.survey.deadline ? `（${r.survey.deadline.replace(/-/g, '/')} まで）` : ''), url: `/?survey=${r.survey.id}`, tag: `survey-${r.survey.id}` });
  }
  res.json({ ...r, push });
});
app.get('/api/surveys/:id', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s || !(surveys.isTarget(req.user, s) || surveys.canManage(req.user, s))) return res.status(404).json({ error: 'アンケートが見つかりません' });
  res.json({ survey: surveys.pub(s), myAnswer: surveys.myAnswer(s.id, req.user.id), canManage: surveys.canManage(req.user, s) });
});
app.post('/api/surveys/:id/answer', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'アンケートが見つかりません' });
  const r = surveys.answer(req.user, s, req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.get('/api/surveys/:id/results', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s || !surveys.canManage(req.user, s)) return res.status(404).json({ error: 'アンケートが見つかりません' });
  res.json(surveys.results(s));
});
app.post('/api/surveys/:id/status', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s || !surveys.canManage(req.user, s)) return res.status(404).json({ error: 'アンケートが見つかりません' });
  surveys.setStatus(s.id, req.body && req.body.status === 'open' ? 'open' : 'closed');
  res.json({ survey: surveys.pub(surveys.find(s.id)) });
});
app.delete('/api/surveys/:id', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s || !surveys.canManage(req.user, s)) return res.status(404).json({ error: 'アンケートが見つかりません' });
  surveys.remove(s.id);
  res.json({ ok: true });
});
app.get('/api/surveys/:id/export.csv', requireLogin, (req, res) => {
  const s = surveys.find(Number(req.params.id));
  if (!s || !surveys.canManage(req.user, s)) return res.status(404).json({ error: 'アンケートが見つかりません' });
  const r = surveys.results(s);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const qs = r.survey.questions;
  let rows;
  if (s.anonymous) {
    const raw = db.raw.prepare('SELECT answers, answered_at FROM survey_answers WHERE survey_id = ? ORDER BY answered_at').all(s.id).map((a) => ({ answers: JSON.parse(a.answers), answeredAt: a.answered_at }));
    rows = [['回答日時', ...qs.map((q) => q.text)], ...raw.map((a) => [a.answeredAt, ...qs.map((q) => (Array.isArray(a.answers[q.id]) ? a.answers[q.id].join('／') : a.answers[q.id]))])];
  } else {
    rows = [['職員番号', '氏名', '部門', '課・病棟', '回答日時', ...qs.map((q) => q.text)], ...r.respondents.map((a) => [a.staffId, a.name, a.department, a.section, a.answeredAt, ...qs.map((q) => (Array.isArray(a.answers[q.id]) ? a.answers[q.id].join('／') : a.answers[q.id]))])];
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey_${s.id}.csv"`);
  res.send('﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n'));
});

// ---- 緊急連絡・安否確認API -------------------------------------------------------
function requireAlertSender(req, res, next) {
  requireLogin(req, res, () => {
    if (!alerts.canSend(req.user)) return res.status(403).json({ error: '緊急連絡を送信できるのは管理者と部長のみです' });
    next();
  });
}
const alertPayload = (a) => ({
  title: `${a.is_test ? '【テスト】' : a.kind === 'emergency' ? '【緊急】' : '【安否確認】'}${a.title}`,
  body: a.kind === 'safety' ? '安否状況の回答をお願いします。' + (a.body ? a.body.split('\n')[0].slice(0, 60) : '') : (a.body ? a.body.split('\n')[0].slice(0, 80) : '内容を確認し「確認しました」を押してください'),
  url: `/?alert=${a.id}`, tag: `alert-${a.id}`, urgent: !a.is_test,
});

// 自分宛てで未締切の連絡（ホームのバナー用）
app.get('/api/alerts/open', requireLogin, (req, res) => {
  res.json({ alerts: alerts.openFor(req.user) });
});
app.get('/api/alerts/:id', requireLogin, (req, res) => {
  const a = alerts.find(Number(req.params.id));
  if (!a || !(a.target === 'all' || a.target === req.user.department || alerts.canManage(req.user, a))) return res.status(404).json({ error: '連絡が見つかりません' });
  const r = alerts.myResponse(a.id, req.user.id);
  res.json({ alert: alerts.pub(a), myResponse: r ? { status: r.status, canWork: r.can_work, comment: r.comment, respondedAt: r.responded_at } : null, safetyStatus: alerts.SAFETY_STATUS, canWork: alerts.CAN_WORK, canManage: alerts.canManage(req.user, a) });
});
app.post('/api/alerts/:id/respond', requireLogin, (req, res) => {
  const r = alerts.respond(req.user, Number(req.params.id), req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, response: r.response });
});

// 送信者向け
app.get('/api/alerts', requireAlertSender, (req, res) => {
  res.json({ alerts: alerts.listFor(req.user), departments: db.DEPARTMENTS.map((d) => d.name), canTargetAll: !!req.user.is_admin, myDepartment: req.user.department });
});
app.post('/api/alerts', requireAlertSender, async (req, res) => {
  const r = alerts.create(req.user, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const users = alerts.targetUsers(r.alert);
  const subs = users.flatMap((u) => db.listSubscriptionsByUser(u.id));
  const push = await sendPush(subs, alertPayload(r.alert));
  res.json({ alert: alerts.pub(r.alert), targets: users.length, push });
});
app.get('/api/alerts/:id/summary', requireAlertSender, (req, res) => {
  const a = alerts.find(Number(req.params.id));
  if (!a || !alerts.canManage(req.user, a)) return res.status(404).json({ error: '連絡が見つかりません' });
  res.json(alerts.summary(a.id));
});
// 未回答者にだけ再通知
app.post('/api/alerts/:id/remind', requireAlertSender, async (req, res) => {
  const a = alerts.find(Number(req.params.id));
  if (!a || !alerts.canManage(req.user, a)) return res.status(404).json({ error: '連絡が見つかりません' });
  if (a.closed_at) return res.status(400).json({ error: '締め切られた連絡には再通知できません' });
  const s = alerts.summary(a.id);
  const subs = s.nonResponders.flatMap((id) => db.listSubscriptionsByUser(id));
  const p = alertPayload(a); p.title = '【再通知】' + p.title; p.tag = `alert-${a.id}-r${Date.now()}`;
  const push = await sendPush(subs, p);
  alerts.markReminded(a.id);
  res.json({ unanswered: s.unanswered, push });
});
app.post('/api/alerts/:id/close', requireAlertSender, (req, res) => {
  const a = alerts.find(Number(req.params.id));
  if (!a || !alerts.canManage(req.user, a)) return res.status(404).json({ error: '連絡が見つかりません' });
  if (req.body && req.body.reopen) alerts.reopen(a.id); else alerts.close(a.id);
  res.json({ alert: alerts.pub(alerts.find(a.id)) });
});
// 集計CSV
app.get('/api/alerts/:id/export.csv', requireAlertSender, (req, res) => {
  const a = alerts.find(Number(req.params.id));
  if (!a || !alerts.canManage(req.user, a)) return res.status(404).json({ error: '連絡が見つかりません' });
  const s = alerts.summary(a.id);
  const head = ['職員番号', '氏名', '部門', '課・病棟', '回答', '出勤可否', 'コメント', '回答日時'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [head, ...s.rows.map((r) => [r.staffId, r.name, r.department, r.section, r.statusLabel, r.canWorkLabel, r.comment, r.respondedAt])].map((row) => row.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alert_${a.id}.csv"`);
  res.send(csv);
});

// ---- 体調管理報告API ----------------------------------------------------------
const fmtHealth = (r) => `${r.temperature != null ? `${r.temperature.toFixed(1)}℃` : '体温未入力'}${r.symptoms.length ? '　' + r.symptoms.join('・') : ''}${r.other ? '　' + r.other : ''}`;

// 自分の本日分と履歴
app.get('/api/health/me', requireLogin, (req, res) => {
  res.json({ today: health.today(), symptoms: health.SYMPTOMS, fever: health.FEVER, report: health.myToday(req.user.id), history: health.myHistory(req.user.id) });
});

// 報告する（本日分。確認済みになるまで修正可）→ 要注意なら所属長・主任に通知
app.post('/api/health/report', requireLogin, async (req, res) => {
  const v = health.validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = health.save(req.user, v.value);
  if (r.error) return res.status(400).json({ error: r.error });
  let push = null;
  if (r.report.alert && r.isNew) {
    const subs = health.leadersFor(req.user).flatMap((l) => db.listSubscriptionsByUser(l.id));
    if (subs.length) push = await sendPush(subs, { title: '体調報告：要注意', body: `${req.user.name}：${fmtHealth(r.report)}`, url: '/?view=health', tag: `health-${r.report.id}` });
  }
  res.json({ report: r.report, push });
});

// 所属長・主任向け一覧（日付指定、既定は本日）
app.get('/api/health/list', requireLogin, (req, res) => {
  if (!health.isViewer(req.user)) return res.status(403).json({ error: '所属長・主任のみ利用できます' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : health.today();
  res.json({ day, today: health.today(), reports: health.listDay(req.user, day), missing: health.missing(req.user, day), scope: req.user.is_admin ? '全部門' : req.user.department });
});

// 確認済み / 取り消し
app.post('/api/health/:id/confirm', requireLogin, (req, res) => {
  const r = health.confirm(req.user, Number(req.params.id), !(req.body && req.body.undo));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ report: r.report });
});

// 事務部向けCSV（期間指定）
app.get('/api/admin/health/export.csv', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || to < from) return res.status(400).json({ error: '期間は YYYY-MM-DD で、開始≦終了にしてください' });
  const head = ['日付', '職員番号', '氏名', '部門', '課・病棟', '体温', ...health.SYMPTOMS.map((s) => s.label), 'その他', '要注意', '報告時刻', '確認者', '確認日時'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = health.listRange(from, to).map((r) => [r.day, r.staffId, r.userName, r.department, r.section, r.temperature != null ? r.temperature.toFixed(1) : '', ...health.SYMPTOMS.map((s) => (r.flags[s.key] ? '有' : '')), r.other, r.alert ? '●' : '', r.updatedAt.slice(11, 16), r.confirmerName, r.confirmedAt]);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="health_${from}_${to}.csv"`);
  res.send(csv);
});

// ---- 休暇管理API ------------------------------------------------------------
const fmtJP = (r) => `${r.start_date.replace(/-/g, '/')}${r.end_date !== r.start_date ? `〜${r.end_date.slice(5).replace('-', '/')}` : ''} ${leave.TYPE[r.type].label}${r.unit === 'hour' ? ` ${r.hours}時間` : r.days ? ` ${r.days}日` : ''}`;

// 自分の残数・申請一覧
app.get('/api/leave/me', requireLogin, (req, res) => {
  const fy = Number(req.query.fy) || leave.currentFiscalYear();
  res.json({
    fiscalYear: fy, today: leave.today(), hoursPerDay: leave.HOURS_PER_DAY,
    types: leave.LEAVE_TYPES, units: leave.UNITS,
    balance: leave.balance(req.user, fy), fiveDays: leave.fiveDayProgress(req.user.id, fy),
    requests: leave.listMyRequests(req.user.id, 100),
    pendingApprovals: leave.pendingCount(req.user),
  });
});

// 申請する → 同じ部門の課長・部長に通知
app.post('/api/leave/requests', requireLogin, async (req, res) => {
  const v = leave.validateRequest(req.user, req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = leave.createRequest(req.user, v.value);
  const approvers = leave.approversFor(req.user);
  const subs = approvers.flatMap((a) => db.listSubscriptionsByUser(a.id));
  const push = subs.length ? await sendPush(subs, { title: '休暇申請が届きました', body: `${req.user.name}：${fmtJP(r)}`, url: '/?view=approve', tag: `leave-req-${r.id}` }) : null;
  res.json({ request: leave.publicRequest(r), balance: leave.balance(req.user, leave.fiscalYearOf(r.start_date)), approvers: approvers.map((a) => a.name), push });
});

// 取り消し（承認待ちはその場で。承認済みは当日中まで取消申請 → 課長へ通知）
app.post('/api/leave/requests/:id/cancel', requireLogin, async (req, res) => {
  const r = leave.cancel(req.user, Number(req.params.id), req.body && req.body.reason);
  if (r.error) return res.status(400).json({ error: r.error });
  let push = null, approvers = [];
  if (!r.immediate) {
    approvers = leave.cancelApproversFor(req.user);
    const subs = approvers.flatMap((a) => db.listSubscriptionsByUser(a.id));
    if (subs.length) push = await sendPush(subs, { title: '休暇の取消申請が届きました', body: `${req.user.name}：${fmtJP(r.request)}　${r.request.cancel_reason}`, url: '/?view=approve', tag: `leave-cancel-${r.request.id}` });
  }
  res.json({ request: leave.publicRequest(r.request), immediate: r.immediate, approvers: approvers.map((a) => a.name), push });
});

// 承認者向け: 承認待ち一覧と最近の処理
app.get('/api/leave/approvals', requireLogin, (req, res) => {
  if (!leave.isApprover(req.user)) return res.status(403).json({ error: '課長・部長のみ利用できます' });
  res.json({ pending: leave.pendingFor(req.user), recent: leave.recentFor(req.user) });
});

// 承認 / 差戻し → 本人に通知
app.post('/api/leave/approvals/:id', requireLogin, async (req, res) => {
  const { action, reason } = req.body || {};
  if (!['approve', 'reject', 'approve_cancel', 'reject_cancel'].includes(action)) return res.status(400).json({ error: '操作が不正です' });
  if (['reject', 'reject_cancel'].includes(action) && !String(reason || '').trim()) return res.status(400).json({ error: '理由を入力してください' });
  const isCancel = action.endsWith('_cancel');
  const r = isCancel ? leave.decideCancel(req.user, Number(req.params.id), action === 'approve_cancel' ? 'approve' : 'reject', reason)
                     : leave.decide(req.user, Number(req.params.id), action, reason);
  if (r.error) return res.status(400).json({ error: r.error });
  const titles = { approve: '休暇申請が承認されました', reject: '休暇申請が差し戻されました', approve_cancel: '休暇の取消が承認されました', reject_cancel: '休暇の取消は認められませんでした（休暇は有効のまま）' };
  const subs = db.listSubscriptionsByUser(r.request.user_id);
  const push = subs.length ? await sendPush(subs, {
    title: titles[action],
    body: `${fmtJP(r.request)}（${req.user.name}）${action.startsWith('reject') ? `：${String(reason).trim().slice(0, 60)}` : ''}`,
    url: '/?view=leave', tag: `leave-dec-${r.request.id}`,
  }) : null;
  res.json({ request: leave.publicRequest(r.request), push });
});

// 事務部向け: 年度の一覧（全職員の付与・残数）
app.get('/api/admin/leave/overview', requireAdmin, (req, res) => {
  const fy = Number(req.query.fy) || leave.currentFiscalYear();
  const users = leave.allUsers().map((u) => {
    const b = leave.balance(u, fy);
    return { id: u.id, staffId: u.staff_id, name: u.name, department: u.department, section: u.section, hireDate: u.hire_date, weeklyDays: u.weekly_days, role: u.role, roleLabel: leave.ROLES[u.role] || '一般', isAdmin: !!u.is_admin, balance: b, fiveDays: leave.fiveDayProgress(u.id, fy) };
  });
  res.json({ fiscalYear: fy, today: leave.today(), roles: leave.ROLES, users, pending: leave.pendingFor(req.user) });
});

// 年度の付与を実行（未付与の職員のみ）
app.post('/api/admin/leave/grant', requireAdmin, (req, res) => {
  const fy = Number(req.body && req.body.fy) || leave.currentFiscalYear();
  res.json({ fiscalYear: fy, ...leave.runGrants(fy, leave.today()) });
});

// 付与内容の手入力・上書き（繰越・付与日数）
app.put('/api/admin/leave/grant/:userId', requireAdmin, (req, res) => {
  const { fy, carriedDays, carriedHours, grantedDays, note } = req.body || {};
  const u = db.findUserById(Number(req.params.userId));
  if (!u) return res.status(404).json({ error: '職員が見つかりません' });
  leave.setGrant(u.id, Number(fy) || leave.currentFiscalYear(), { carriedDays, carriedHours, grantedDays, note });
  res.json({ balance: leave.balance(u, Number(fy) || leave.currentFiscalYear()) });
});

// 残数の修正（±日・±時間、理由つき。履歴に残る）
app.post('/api/admin/leave/adjust', requireAdmin, (req, res) => {
  const { userId, fy, days, hours, note } = req.body || {};
  const u = db.findUserById(Number(userId));
  if (!u) return res.status(404).json({ error: '職員が見つかりません' });
  if (!String(note || '').trim()) return res.status(400).json({ error: '修正の理由を入力してください' });
  const year = Number(fy) || leave.currentFiscalYear();
  leave.addAdjustment(u.id, year, days, hours, note, req.user.id);
  res.json({ balance: leave.balance(u, year), adjustments: leave.listAdjustments(u.id, year) });
});

// 職員1人分の明細（事務部用）
app.get('/api/admin/leave/users/:userId', requireAdmin, (req, res) => {
  const u = db.findUserById(Number(req.params.userId));
  if (!u) return res.status(404).json({ error: '職員が見つかりません' });
  const fy = Number(req.query.fy) || leave.currentFiscalYear();
  res.json({ user: publicUser(u), balance: leave.balance(u, fy), requests: leave.listMyRequests(u.id, 200).filter((r) => leave.fiscalYearOf(r.startDate) === fy), adjustments: leave.listAdjustments(u.id, fy) });
});

// 月次CSV（給与計算用、承認済みのみ）
app.get('/api/admin/leave/export.csv', requireAdmin, (req, res) => {
  const ym = String(req.query.month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: '対象月は YYYY-MM 形式で指定してください' });
  const head = ['職員番号', '氏名', '部門', '課・病棟', '休暇種別', '有給/無給', '開始日', '終了日', '単位', '日数', '時間', '開始時刻', '終了時刻', '休憩', '理由', '承認者', '承認日時', '届出日'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = leave.monthRows(ym).map((r) => [r.staffId, r.userName, r.department, r.section, r.typeLabel, r.paid ? '有給' : '無給', r.startDate, r.endDate, r.unitLabel, r.days || '', r.hours || '', r.startTime, r.endTime, r.breakTaken === 1 ? '有' : r.breakTaken === 0 ? '無' : '', r.reason, r.approverName, r.decidedAt, r.createdAt.slice(0, 10)]);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leave_${ym}.csv"`);
  res.send(csv);
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '自分自身は削除できません' });
  db.deleteUser(id); // 購読情報も一緒に消える（退職者の通知停止）
  res.json({ ok: true });
});

// ---- プッシュ送信処理 ---------------------------------------------------

async function sendPush(subscriptions, payload) {
  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  let failed = 0;
  await Promise.all(
    subscriptions.map(async (row) => {
      const subscription = { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) };
      try {
        await webpush.sendNotification(subscription, body, { TTL: 60 * 60 * 24 });
        sent++;
      } catch (err) {
        // 404/410 = 端末側で購読が無効になった（アプリ削除・通知OFF等）→ 登録を消す
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.deleteSubscriptionByEndpoint(row.endpoint);
          removed++;
        } else {
          failed++;
          console.error('push failed:', err.statusCode, err.body || err.message);
        }
      }
    })
  );
  return { sent, removed, failed, total: subscriptions.length };
}

// ---- 起動 ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`${APP_NAME} が起動しました: http://localhost:${PORT}`);
});