// メッセージ（個人・部署・課／病棟・任意グループ）
//  - department / section の会話は自動で用意され、メンバーは users テーブルの所属から決まる（異動すれば自動で入れ替わる）
//  - direct（1対1）と group（任意）はメンバー表で管理
//  - 既読は「どのメッセージIDまで読んだか」を会話ごとに記録
const dbm = require('./db');
const db = dbm.raw;

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT    NOT NULL,                 -- direct / department / section / group
    key             TEXT    NOT NULL UNIQUE,          -- direct: d:小ID:大ID / department: dept:名 / section: sec:部門/課 / group: g:ID
    name            TEXT    NOT NULL DEFAULT '',
    department      TEXT    NOT NULL DEFAULT '',
    section         TEXT    NOT NULL DEFAULT '',
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    last_message_at TEXT
  );
  CREATE TABLE IF NOT EXISTS conversation_members (
    conv_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (conv_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
  CREATE TABLE IF NOT EXISTS conversation_reads (
    conv_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (conv_id, user_id)
  );
`);

const stmts = {
  byKey: db.prepare('SELECT * FROM conversations WHERE key = ?'),
  byId: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  insert: db.prepare('INSERT INTO conversations (type, key, name, department, section, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
  setKey: db.prepare('UPDATE conversations SET key = ? WHERE id = ?'),
  rename: db.prepare('UPDATE conversations SET name = ? WHERE id = ?'),
  touch: db.prepare("UPDATE conversations SET last_message_at = datetime('now','localtime') WHERE id = ?"),
  memberAdd: db.prepare('INSERT OR IGNORE INTO conversation_members (conv_id, user_id) VALUES (?, ?)'),
  memberDel: db.prepare('DELETE FROM conversation_members WHERE conv_id = ? AND user_id = ?'),
  memberIds: db.prepare('SELECT user_id FROM conversation_members WHERE conv_id = ?'),
  memberUsers: db.prepare('SELECT u.id, u.name, u.department, u.section, u.job FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? ORDER BY u.department, u.section, u.staff_id'),
  deptUsers: db.prepare('SELECT id, name, department, section, job FROM users WHERE department = ? ORDER BY section, staff_id'),
  secUsers: db.prepare('SELECT id, name, department, section, job FROM users WHERE department = ? AND section = ? ORDER BY staff_id'),
  myMemberConvs: db.prepare('SELECT c.* FROM conversations c JOIN conversation_members m ON m.conv_id = c.id WHERE m.user_id = ?'),
  lastMessage: db.prepare('SELECT m.*, u.name AS userName FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? ORDER BY m.id DESC LIMIT 1'),
  unread: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conv_id = ? AND id > ? AND (user_id IS NULL OR user_id <> ?)'),
  readGet: db.prepare('SELECT last_read_id FROM conversation_reads WHERE conv_id = ? AND user_id = ?'),
  readSet: db.prepare(`INSERT INTO conversation_reads (conv_id, user_id, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT(conv_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = datetime('now','localtime')`),
  msgs: db.prepare('SELECT m.*, u.name AS userName FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? AND m.id > ? ORDER BY m.id LIMIT ?'),
  msgsBefore: db.prepare('SELECT * FROM (SELECT m.*, u.name AS userName FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?) ORDER BY id'),
  msgInsert: db.prepare('INSERT INTO messages (conv_id, user_id, body) VALUES (?, ?, ?)'),
  msgById: db.prepare('SELECT m.*, u.name AS userName FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?'),
  directory: db.prepare('SELECT id, name, kana, department, section, job FROM users WHERE id <> ? ORDER BY department, section, staff_id'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
};

// 部署・課の会話を必要なときに作る
function ensureAuto(type, department, section) {
  const key = type === 'department' ? `dept:${department}` : `sec:${department}/${section}`;
  let c = stmts.byKey.get(key);
  if (!c) { const info = stmts.insert.run(type, key, type === 'department' ? department : `${department} ${section}`, department, section || '', null); c = stmts.byId.get(info.lastInsertRowid); }
  return c;
}
function members(c) {
  if (c.type === 'department') return stmts.deptUsers.all(c.department);
  if (c.type === 'section') return stmts.secUsers.all(c.department, c.section);
  return stmts.memberUsers.all(c.id);
}
function isMember(c, user) {
  if (c.type === 'department') return user.department === c.department;
  if (c.type === 'section') return user.department === c.department && user.section === c.section;
  return stmts.memberIds.all(c.id).some((m) => m.user_id === user.id);
}
function displayName(c, me) {
  if (c.type === 'direct') { const other = stmts.memberUsers.all(c.id).find((u) => u.id !== me.id); return other ? other.name : '（退職者）'; }
  return c.name;
}
function pubConv(c, me) {
  const last = stmts.lastMessage.get(c.id);
  const read = (stmts.readGet.get(c.id, me.id) || { last_read_id: 0 }).last_read_id;
  const ms = members(c);
  return {
    id: c.id, type: c.type, typeLabel: { direct: '個人', department: '部署', section: '課・病棟', group: 'グループ' }[c.type], name: displayName(c, me),
    memberCount: ms.length, lastMessage: last ? { body: last.body, userName: last.userName || '', createdAt: last.created_at, mine: last.user_id === me.id } : null,
    unread: stmts.unread.get(c.id, read, me.id).c, lastAt: c.last_message_at || c.created_at,
  };
}
const pubMsg = (m, me) => ({ id: m.id, userId: m.user_id, userName: m.userName || '（退職者）', body: m.body, createdAt: m.created_at, mine: m.user_id === me.id });

module.exports = {
  // 自分が参加している会話（部署・課は自動）
  listFor(me) {
    const list = [];
    if (me.department) list.push(ensureAuto('department', me.department));
    if (me.department && me.section) list.push(ensureAuto('section', me.department, me.section));
    list.push(...stmts.myMemberConvs.all(me.id));
    return list.map((c) => pubConv(c, me)).sort((a, b) => (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0));
  },
  unreadTotal(me) { return this.listFor(me).reduce((s, c) => s + c.unread, 0); },
  find: (id) => stmts.byId.get(id),
  isMember, members,
  detail(c, me) { return { ...pubConv(c, me), members: members(c), createdBy: c.created_by, canEdit: c.type === 'group' && (c.created_by === me.id || !!me.is_admin) }; },
  openDirect(me, otherId) {
    const other = stmts.userById.get(otherId);
    if (!other || other.id === me.id) return { error: '相手を選択してください' };
    const key = `d:${Math.min(me.id, other.id)}:${Math.max(me.id, other.id)}`;
    let c = stmts.byKey.get(key);
    if (!c) {
      const info = stmts.insert.run('direct', key, '', '', '', me.id);
      c = stmts.byId.get(info.lastInsertRowid);
      stmts.memberAdd.run(c.id, me.id); stmts.memberAdd.run(c.id, other.id);
    }
    return { conversation: c };
  },
  createGroup(me, name, memberIds) {
    const n = String(name || '').trim().slice(0, 50);
    if (!n) return { error: 'グループ名を入力してください' };
    const ids = [...new Set([me.id, ...(memberIds || []).map(Number).filter((x) => x && stmts.userById.get(x))])];
    if (ids.length < 2) return { error: 'メンバーを1人以上選んでください' };
    const info = stmts.insert.run('group', `g:tmp:${Date.now()}:${me.id}`, n, '', '', me.id);
    stmts.setKey.run(`g:${info.lastInsertRowid}`, info.lastInsertRowid);
    ids.forEach((id) => stmts.memberAdd.run(info.lastInsertRowid, id));
    return { conversation: stmts.byId.get(info.lastInsertRowid) };
  },
  updateGroup(me, c, { name, addIds, removeIds }) {
    if (c.type !== 'group') return { error: 'グループ以外は変更できません' };
    if (!(c.created_by === me.id || me.is_admin)) return { error: 'グループの変更は作成者のみです' };
    if (name != null && String(name).trim()) stmts.rename.run(String(name).trim().slice(0, 50), c.id);
    (addIds || []).map(Number).filter((x) => x && stmts.userById.get(x)).forEach((id) => stmts.memberAdd.run(c.id, id));
    (removeIds || []).map(Number).filter((x) => x !== c.created_by).forEach((id) => stmts.memberDel.run(c.id, id));
    return { conversation: stmts.byId.get(c.id) };
  },
  leave(me, c) { if (c.type !== 'group') return { error: '部署・課・個人の会話からは退出できません' }; stmts.memberDel.run(c.id, me.id); return { ok: true }; },
  messages(c, me, { after, before, limit = 60 }) {
    const rows = before ? stmts.msgsBefore.all(c.id, before, limit) : stmts.msgs.all(c.id, after || 0, after ? 200 : limit);
    // after 指定なし・before 指定なしのときは「最新 limit 件」を返す
    const list = (!after && !before) ? stmts.msgsBefore.all(c.id, Number.MAX_SAFE_INTEGER, limit) : rows;
    if (list.length) stmts.readSet.run(c.id, me.id, list[list.length - 1].id);
    return list.map((m) => pubMsg(m, me));
  },
  send(c, me, body) {
    const b = String(body || '').trim().slice(0, 2000);
    if (!b) return { error: 'メッセージを入力してください' };
    const info = stmts.msgInsert.run(c.id, me.id, b);
    stmts.touch.run(c.id);
    stmts.readSet.run(c.id, me.id, info.lastInsertRowid);
    return { message: pubMsg(stmts.msgById.get(info.lastInsertRowid), me) };
  },
  markRead: (c, me, id) => stmts.readSet.run(c.id, me.id, id),
  directory: (me) => stmts.directory.all(me.id),
};
