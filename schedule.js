// スケジュール（任意グループの共有カレンダー ＋ 自分だけの予定）
//  - グループは誰でも作成でき、メンバー全員が予定を登録・変更・削除できる（タイムツリー型）
//  - group_id が NULL の予定は「自分の予定」（本人だけが見える）
//  - 変更履歴として created_by / updated_by を持つ
const dbm = require('./db');
const db = dbm.raw;

db.exec(`
  CREATE TABLE IF NOT EXISTS sched_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#093388',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sched_members (
    group_id INTEGER NOT NULL REFERENCES sched_groups(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sched_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER REFERENCES sched_groups(id) ON DELETE CASCADE,  -- NULL = 自分の予定
    owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,         -- 自分の予定の持ち主
    title      TEXT    NOT NULL,
    date       TEXT    NOT NULL,
    end_date   TEXT    NOT NULL,
    start_time TEXT    NOT NULL DEFAULT '',
    end_time   TEXT    NOT NULL DEFAULT '',
    all_day    INTEGER NOT NULL DEFAULT 1,
    memo       TEXT    NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sched_events_date ON sched_events(date, end_date);
`);

const COLORS = ['#093388', '#E8912A', '#2E8B57', '#C0392B', '#8E44AD', '#16A085', '#D4A017', '#7F8C8D'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || '');

const stmts = {
  groupInsert: db.prepare('INSERT INTO sched_groups (name, color, created_by) VALUES (?, ?, ?)'),
  groupById: db.prepare('SELECT g.*, u.name AS creatorName FROM sched_groups g LEFT JOIN users u ON u.id = g.created_by WHERE g.id = ?'),
  groupUpdate: db.prepare('UPDATE sched_groups SET name = ?, color = ? WHERE id = ?'),
  groupDelete: db.prepare('DELETE FROM sched_groups WHERE id = ?'),
  myGroups: db.prepare('SELECT g.*, u.name AS creatorName, (SELECT COUNT(*) FROM sched_members x WHERE x.group_id = g.id) AS memberCount FROM sched_groups g JOIN sched_members m ON m.group_id = g.id LEFT JOIN users u ON u.id = g.created_by WHERE m.user_id = ? ORDER BY g.id'),
  memberAdd: db.prepare('INSERT OR IGNORE INTO sched_members (group_id, user_id) VALUES (?, ?)'),
  memberDel: db.prepare('DELETE FROM sched_members WHERE group_id = ? AND user_id = ?'),
  isMember: db.prepare('SELECT 1 FROM sched_members WHERE group_id = ? AND user_id = ?'),
  members: db.prepare('SELECT u.id, u.name, u.department, u.section FROM sched_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.department, u.section, u.staff_id'),
  memberCount: db.prepare('SELECT COUNT(*) AS c FROM sched_members WHERE group_id = ?'),
  events: db.prepare(`SELECT e.*, g.name AS groupName, g.color AS groupColor, c.name AS creatorName, m.name AS updaterName
    FROM sched_events e LEFT JOIN sched_groups g ON g.id = e.group_id LEFT JOIN users c ON c.id = e.created_by LEFT JOIN users m ON m.id = e.updated_by
    WHERE e.date <= ? AND e.end_date >= ? AND ((e.group_id IS NULL AND e.owner_id = ?) OR e.group_id IN (SELECT group_id FROM sched_members WHERE user_id = ?))
    ORDER BY e.date, e.all_day DESC, e.start_time, e.id`),
  eventById: db.prepare('SELECT e.*, g.name AS groupName, g.color AS groupColor, c.name AS creatorName, m.name AS updaterName FROM sched_events e LEFT JOIN sched_groups g ON g.id = e.group_id LEFT JOIN users c ON c.id = e.created_by LEFT JOIN users m ON m.id = e.updated_by WHERE e.id = ?'),
  eventInsert: db.prepare('INSERT INTO sched_events (group_id, owner_id, title, date, end_date, start_time, end_time, all_day, memo, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  eventUpdate: db.prepare("UPDATE sched_events SET group_id = ?, owner_id = ?, title = ?, date = ?, end_date = ?, start_time = ?, end_time = ?, all_day = ?, memo = ?, updated_by = ?, updated_at = datetime('now','localtime') WHERE id = ?"),
  eventDelete: db.prepare('DELETE FROM sched_events WHERE id = ?'),
  userById: db.prepare('SELECT id FROM users WHERE id = ?'),
};

const canUseGroup = (user, groupId) => groupId == null || !!stmts.isMember.get(groupId, user.id);
const canEditEvent = (user, e) => (e.group_id == null ? e.owner_id === user.id : canUseGroup(user, e.group_id));

function pubEvent(e) {
  return {
    id: e.id, groupId: e.group_id, groupName: e.group_id ? e.groupName : '自分の予定', color: e.group_id ? e.groupColor : '#5C6B69',
    title: e.title, date: e.date, endDate: e.end_date, startTime: e.start_time, endTime: e.end_time, allDay: !!e.all_day, memo: e.memo,
    creatorName: e.creatorName || '', updaterName: e.updaterName || '', updatedAt: e.updated_at,
  };
}
function validate(user, b) {
  const title = String(b.title || '').trim().slice(0, 100);
  if (!title) return { error: '予定の名前を入力してください' };
  if (!isDate(b.date)) return { error: '日付を入力してください' };
  const endDate = isDate(b.endDate) ? b.endDate : b.date;
  if (endDate < b.date) return { error: '終了日は開始日以降にしてください' };
  const groupId = b.groupId ? Number(b.groupId) : null;
  if (groupId && !canUseGroup(user, groupId)) return { error: 'このグループには登録できません' };
  const allDay = b.allDay === undefined ? !(isTime(b.startTime)) : !!b.allDay;
  const startTime = allDay ? '' : (isTime(b.startTime) ? b.startTime : '');
  const endTime = allDay ? '' : (isTime(b.endTime) ? b.endTime : '');
  if (!allDay && !startTime) return { error: '開始時刻を入力してください（終日の場合は「終日」にチェック）' };
  if (startTime && endTime && b.date === endDate && endTime < startTime) return { error: '終了時刻は開始時刻以降にしてください' };
  return { value: { groupId, ownerId: groupId ? null : user.id, title, date: b.date, endDate, startTime, endTime, allDay: allDay ? 1 : 0, memo: String(b.memo || '').trim().slice(0, 1000) } };
}

module.exports = {
  COLORS,
  groupsFor: (user) => stmts.myGroups.all(user.id).map((g) => ({ id: g.id, name: g.name, color: g.color, creatorName: g.creatorName || '', memberCount: g.memberCount, isOwner: g.created_by === user.id || !!user.is_admin })),
  groupDetail(user, id) {
    const g = stmts.groupById.get(id);
    if (!g || !canUseGroup(user, id)) return null;
    return { id: g.id, name: g.name, color: g.color, creatorName: g.creatorName || '', createdBy: g.created_by, isOwner: g.created_by === user.id || !!user.is_admin, members: stmts.members.all(id) };
  },
  createGroup(user, { name, color, memberIds }) {
    const n = String(name || '').trim().slice(0, 50);
    if (!n) return { error: 'グループ名を入力してください' };
    const c = COLORS.includes(color) ? color : COLORS[0];
    const info = stmts.groupInsert.run(n, c, user.id);
    [user.id, ...(memberIds || []).map(Number)].filter((x) => x && stmts.userById.get(x)).forEach((id) => stmts.memberAdd.run(info.lastInsertRowid, id));
    return { group: this.groupDetail(user, info.lastInsertRowid) };
  },
  updateGroup(user, id, { name, color, addIds, removeIds }) {
    const g = stmts.groupById.get(id);
    if (!g || !canUseGroup(user, id)) return { error: 'グループが見つかりません' };
    const owner = g.created_by === user.id || !!user.is_admin;
    if ((name != null || color != null || (removeIds && removeIds.length)) && !owner) return { error: '名前・色の変更とメンバーの削除は作成者のみです' };
    stmts.groupUpdate.run(name != null && String(name).trim() ? String(name).trim().slice(0, 50) : g.name, COLORS.includes(color) ? color : g.color, id);
    (addIds || []).map(Number).filter((x) => x && stmts.userById.get(x)).forEach((uid) => stmts.memberAdd.run(id, uid));
    (removeIds || []).map(Number).filter((x) => x !== g.created_by).forEach((uid) => stmts.memberDel.run(id, uid));
    return { group: this.groupDetail(user, id) };
  },
  leaveGroup(user, id) {
    const g = stmts.groupById.get(id);
    if (!g || !canUseGroup(user, id)) return { error: 'グループが見つかりません' };
    if (g.created_by === user.id) {
      if (stmts.memberCount.get(id).c > 1) return { error: '作成者は退出できません。他のメンバーを外してからグループを削除してください' };
      stmts.groupDelete.run(id); return { ok: true, deleted: true };
    }
    stmts.memberDel.run(id, user.id); return { ok: true };
  },
  deleteGroup(user, id) {
    const g = stmts.groupById.get(id);
    if (!g) return { error: 'グループが見つかりません' };
    if (!(g.created_by === user.id || user.is_admin)) return { error: 'グループの削除は作成者のみです' };
    stmts.groupDelete.run(id); return { ok: true };
  },
  events: (user, from, to) => stmts.events.all(to, from, user.id, user.id).map(pubEvent),
  find: (id) => stmts.eventById.get(id),
  canEditEvent,
  create(user, body) {
    const v = validate(user, body || {});
    if (v.error) return v;
    const x = v.value;
    const info = stmts.eventInsert.run(x.groupId, x.ownerId, x.title, x.date, x.endDate, x.startTime, x.endTime, x.allDay, x.memo, user.id, user.id);
    return { event: pubEvent(stmts.eventById.get(info.lastInsertRowid)) };
  },
  update(user, id, body) {
    const e = stmts.eventById.get(id);
    if (!e || !canEditEvent(user, e)) return { error: '予定が見つかりません' };
    const merged = { groupId: e.group_id, title: e.title, date: e.date, endDate: e.end_date, startTime: e.start_time, endTime: e.end_time, allDay: !!e.all_day, memo: e.memo, ...(body || {}) };
    // 日付だけ動かす（ドラッグ移動）ときは期間の長さを保つ
    if (body && body.date && !body.endDate) {
      const len = Math.round((Date.parse(e.end_date) - Date.parse(e.date)) / 86400000);
      const d = new Date(`${body.date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + len); merged.endDate = d.toISOString().slice(0, 10);
    }
    const v = validate(user, merged);
    if (v.error) return v;
    const x = v.value;
    stmts.eventUpdate.run(x.groupId, x.groupId ? null : (e.owner_id || user.id), x.title, x.date, x.endDate, x.startTime, x.endTime, x.allDay, x.memo, user.id, id);
    return { event: pubEvent(stmts.eventById.get(id)) };
  },
  copy(user, id, date) {
    const e = stmts.eventById.get(id);
    if (!e || !canEditEvent(user, e)) return { error: '予定が見つかりません' };
    if (!isDate(date)) return { error: 'コピー先の日付を指定してください' };
    const len = Math.round((Date.parse(e.end_date) - Date.parse(e.date)) / 86400000);
    const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + len);
    const info = stmts.eventInsert.run(e.group_id, e.group_id ? null : user.id, e.title, date, d.toISOString().slice(0, 10), e.start_time, e.end_time, e.all_day, e.memo, user.id, user.id);
    return { event: pubEvent(stmts.eventById.get(info.lastInsertRowid)) };
  },
  remove(user, id) {
    const e = stmts.eventById.get(id);
    if (!e || !canEditEvent(user, e)) return { error: '予定が見つかりません' };
    stmts.eventDelete.run(id); return { ok: true };
  },
  groupMembers: (id) => stmts.members.all(id),
};
