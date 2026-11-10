// アンケート
//  - 作成できるのは管理者・部長・課長。宛先は全職員または部門
//  - 設問：単一選択 / 複数選択 / 自由記述。匿名アンケートは回答者名を保存しない
//  - 回答は締切まで修正可。集計は作成者（と管理者）が閲覧、CSV出力
const dbm = require('./db');
const db = dbm.raw;

db.exec(`
  CREATE TABLE IF NOT EXISTS surveys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    target      TEXT    NOT NULL DEFAULT 'all',
    anonymous   INTEGER NOT NULL DEFAULT 0,
    deadline    TEXT    NOT NULL DEFAULT '',          -- YYYY-MM-DD（空＝なし）
    questions   TEXT    NOT NULL,                     -- JSON [{id,type,text,options[],required}]
    status      TEXT    NOT NULL DEFAULT 'open',      -- open / closed
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS survey_answers (
    survey_id   INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answers     TEXT    NOT NULL,                     -- JSON {qid: value | [values] | text}
    answered_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (survey_id, user_id)
  );
`);

const TYPES = { single: '単一選択', multi: '複数選択', text: '自由記述' };
const stmts = {
  insert: db.prepare('INSERT INTO surveys (title, description, target, anonymous, deadline, questions, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  byId: db.prepare('SELECT s.*, u.name AS creatorName FROM surveys s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?'),
  setStatus: db.prepare('UPDATE surveys SET status = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM surveys WHERE id = ?'),
  forUser: db.prepare(`SELECT s.*, u.name AS creatorName, a.answered_at AS myAnsweredAt FROM surveys s LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN survey_answers a ON a.survey_id = s.id AND a.user_id = ? WHERE (s.target = 'all' OR s.target = ?) ORDER BY (s.status = 'open') DESC, s.id DESC LIMIT 50`),
  mine: db.prepare('SELECT s.*, u.name AS creatorName FROM surveys s LEFT JOIN users u ON u.id = s.created_by WHERE (? = 1 OR s.created_by = ?) ORDER BY s.id DESC LIMIT 50'),
  answerGet: db.prepare('SELECT * FROM survey_answers WHERE survey_id = ? AND user_id = ?'),
  answerUpsert: db.prepare(`INSERT INTO survey_answers (survey_id, user_id, answers) VALUES (?, ?, ?)
    ON CONFLICT(survey_id, user_id) DO UPDATE SET answers = excluded.answers, answered_at = datetime('now','localtime')`),
  answers: db.prepare('SELECT a.*, u.name, u.staff_id AS staffId, u.department, u.section FROM survey_answers a JOIN users u ON u.id = a.user_id WHERE a.survey_id = ? ORDER BY a.answered_at'),
  answerCount: db.prepare('SELECT COUNT(*) AS c FROM survey_answers WHERE survey_id = ?'),
  targetCount: db.prepare("SELECT COUNT(*) AS c FROM users WHERE (? = 'all' OR department = ?)"),
};

const today = () => db.prepare("SELECT date('now','localtime') AS d").get().d;
const canCreate = (u) => !!(u.is_admin || ['kacho', 'bucho'].includes(u.role || ''));
const canManage = (u, s) => !!(u.is_admin || s.created_by === u.id);
const isOpen = (s) => s.status === 'open' && (!s.deadline || s.deadline >= today());
const isTarget = (u, s) => s.target === 'all' || s.target === u.department;

function pub(s, extra = {}) {
  return {
    id: s.id, title: s.title, description: s.description, target: s.target, targetLabel: s.target === 'all' ? '全職員' : s.target,
    anonymous: !!s.anonymous, deadline: s.deadline, status: s.status, open: isOpen(s), questions: JSON.parse(s.questions),
    creatorName: s.creatorName || '', createdAt: s.created_at, answerCount: stmts.answerCount.get(s.id).c, targetCount: stmts.targetCount.get(s.target, s.target).c, ...extra,
  };
}
function validateQuestions(qs) {
  if (!Array.isArray(qs) || !qs.length) return { error: '設問を1つ以上作成してください' };
  if (qs.length > 30) return { error: '設問は30個までです' };
  const out = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i] || {};
    const text = String(q.text || '').trim().slice(0, 300);
    if (!text) return { error: `設問${i + 1}の文を入力してください` };
    if (!TYPES[q.type]) return { error: `設問${i + 1}の形式が不正です` };
    let options = [];
    if (q.type !== 'text') {
      options = (Array.isArray(q.options) ? q.options : String(q.options || '').split('\n')).map((o) => String(o).trim().slice(0, 100)).filter(Boolean);
      if (options.length < 2) return { error: `設問${i + 1}の選択肢を2つ以上入力してください` };
    }
    out.push({ id: i + 1, type: q.type, text, options, required: q.required !== false });
  }
  return { value: out };
}

module.exports = {
  TYPES, canCreate, canManage, isOpen, isTarget, pub,
  create(user, b) {
    const title = String(b.title || '').trim().slice(0, 100);
    if (!title) return { error: 'タイトルを入力してください' };
    let target = b.target || 'all';
    if (!user.is_admin && target !== user.department) target = user.department; // 課長・部長は自部門のみ
    if (target !== 'all' && !dbm.DEPARTMENTS.some((d) => d.name === target)) return { error: '宛先が不正です' };
    const q = validateQuestions(b.questions);
    if (q.error) return q;
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : '';
    const info = stmts.insert.run(title, String(b.description || '').trim().slice(0, 1000), target, b.anonymous ? 1 : 0, deadline, JSON.stringify(q.value), user.id);
    return { survey: pub(stmts.byId.get(info.lastInsertRowid)) };
  },
  find: (id) => stmts.byId.get(id),
  listFor: (user) => stmts.forUser.all(user.id, user.department).map((s) => pub(s, { myAnsweredAt: s.myAnsweredAt || '' })),
  listMine: (user) => stmts.mine.all(user.is_admin ? 1 : 0, user.id).map((s) => pub(s)),
  openUnanswered: (user) => stmts.forUser.all(user.id, user.department).filter((s) => isOpen(s) && !s.myAnsweredAt).map((s) => pub(s)),
  myAnswer: (id, userId) => { const a = stmts.answerGet.get(id, userId); return a ? { answers: JSON.parse(a.answers), answeredAt: a.answered_at } : null; },
  answer(user, s, body) {
    if (!isTarget(user, s)) return { error: 'このアンケートの対象ではありません' };
    if (!isOpen(s)) return { error: 'このアンケートは締め切られています' };
    const qs = JSON.parse(s.questions);
    const given = (body && body.answers) || {};
    const out = {};
    for (const q of qs) {
      const v = given[q.id];
      if (q.type === 'single') { if (v != null && v !== '' && !q.options.includes(v)) return { error: `設問${q.id}の回答が不正です` }; out[q.id] = v || ''; }
      else if (q.type === 'multi') { const arr = Array.isArray(v) ? v.filter((x) => q.options.includes(x)) : []; out[q.id] = arr; }
      else out[q.id] = String(v || '').trim().slice(0, 1000);
      const empty = q.type === 'multi' ? !out[q.id].length : !out[q.id];
      if (q.required && empty) return { error: `設問${q.id}「${q.text.slice(0, 20)}」は必須です` };
    }
    stmts.answerUpsert.run(s.id, user.id, JSON.stringify(out));
    return { ok: true };
  },
  setStatus: (id, status) => stmts.setStatus.run(status, id),
  remove: (id) => stmts.del.run(id),
  results(s) {
    const qs = JSON.parse(s.questions);
    const rows = stmts.answers.all(s.id).map((a) => ({ ...a, answers: JSON.parse(a.answers) }));
    const summary = qs.map((q) => {
      if (q.type === 'text') return { ...q, texts: rows.map((r) => ({ text: r.answers[q.id], who: s.anonymous ? '' : r.name })).filter((t) => t.text) };
      const counts = Object.fromEntries(q.options.map((o) => [o, 0]));
      rows.forEach((r) => { const v = r.answers[q.id]; (Array.isArray(v) ? v : [v]).forEach((x) => { if (x in counts) counts[x]++; }); });
      return { ...q, counts, total: rows.length };
    });
    return {
      survey: pub(s), summary,
      respondents: s.anonymous ? [] : rows.map((r) => ({ name: r.name, staffId: r.staffId, department: r.department, section: r.section, answeredAt: r.answered_at, answers: r.answers })),
    };
  },
};
