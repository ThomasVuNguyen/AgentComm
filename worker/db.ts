import type { Actor } from "./auth";
import { HttpError, newId, now } from "./lib";

export type Project = { id: string; name: string; created_at: number; thread_count: number; unread: number };
export type Thread = {
  id: string;
  project_id: string;
  title: string;
  created_by: string;
  created_at: number;
  last_chat_at: number;
  chat_count: number;
  unread: number;
};
export type FileMeta = {
  id: string;
  thread_id: string;
  chat_id: number | null;
  name: string;
  size: number;
  content_type: string;
  uploaded_by: string;
  created_at: number;
  url: string;
};
export type Chat = {
  id: number;
  thread_id: string;
  author: string;
  author_kind: "human" | "agent";
  text: string;
  created_at: number;
  edited_at: number | null;
  files: FileMeta[];
};

type FileRow = Omit<FileMeta, "url"> & { access_key: string; r2_key: string; status: string; upload_id: string | null };

export function fileUrl(origin: string, f: { id: string; access_key: string; name: string }): string {
  return `${origin}/api/files/${f.id}/${f.access_key}/${encodeURIComponent(f.name)}`;
}

export function toFileMeta(origin: string, f: FileRow): FileMeta {
  return {
    id: f.id,
    thread_id: f.thread_id,
    chat_id: f.chat_id,
    name: f.name,
    size: f.size,
    content_type: f.content_type,
    uploaded_by: f.uploaded_by,
    created_at: f.created_at,
    url: fileUrl(origin, f),
  };
}

// ---- projects ----

export async function listProjects(db: D1Database, reader: string): Promise<Project[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.created_at,
         (SELECT COUNT(*) FROM threads t WHERE t.project_id = p.id) AS thread_count,
         (SELECT COUNT(*) FROM chats c
            JOIN threads t ON t.id = c.thread_id
            LEFT JOIN reads r ON r.thread_id = c.thread_id AND r.reader = ?1
          WHERE t.project_id = p.id AND c.author != ?1 AND c.id > COALESCE(r.last_chat_id, 0)) AS unread
       FROM projects p ORDER BY p.created_at`,
    )
    .bind(reader)
    .all<Project>();
  return results;
}

export async function getProject(db: D1Database, id: string) {
  const p = await db.prepare("SELECT id, name, created_at FROM projects WHERE id = ?").bind(id).first<Project>();
  if (!p) throw new HttpError(404, `no project ${id}`);
  return p;
}

export async function createProject(db: D1Database, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(422, "project name is required");
  const p = { id: newId("p"), name: clean, created_at: now() };
  await db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").bind(p.id, p.name, p.created_at).run();
  return { ...p, thread_count: 0, unread: 0 } satisfies Project;
}

// ---- threads ----

const THREAD_COLUMNS = `t.*,
  (SELECT COUNT(*) FROM chats c WHERE c.thread_id = t.id) AS chat_count,
  (SELECT COUNT(*) FROM chats c
     LEFT JOIN reads r ON r.thread_id = c.thread_id AND r.reader = ?1
   WHERE c.thread_id = t.id AND c.author != ?1 AND c.id > COALESCE(r.last_chat_id, 0)) AS unread`;

export async function listThreads(db: D1Database, projectId: string, reader: string): Promise<Thread[]> {
  const { results } = await db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM threads t WHERE t.project_id = ?2 ORDER BY t.last_chat_at DESC`)
    .bind(reader, projectId)
    .all<Thread>();
  return results;
}

export async function getThread(db: D1Database, id: string, reader: string) {
  const t = await db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads t WHERE t.id = ?2`).bind(reader, id).first<Thread>();
  if (!t) throw new HttpError(404, `no thread ${id}`);
  const { results } = await db
    .prepare("SELECT author FROM chats WHERE thread_id = ? GROUP BY author ORDER BY MIN(id)")
    .bind(id)
    .all<{ author: string }>();
  return { ...t, participants: results.map((r) => r.author) };
}

export async function createThread(db: D1Database, projectId: string, title: string, actor: Actor) {
  await getProject(db, projectId);
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new HttpError(422, "thread title is required");
  const t = now();
  const thread = { id: newId("t"), project_id: projectId, title: clean, created_by: actor.name, created_at: t, last_chat_at: t };
  await db
    .prepare("INSERT INTO threads (id, project_id, title, created_by, created_at, last_chat_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(thread.id, thread.project_id, thread.title, thread.created_by, thread.created_at, thread.last_chat_at)
    .run();
  return { ...thread, chat_count: 0, unread: 0 } satisfies Thread;
}

// ---- chats ----

async function attachFiles(db: D1Database, origin: string, threadId: string, chats: Omit<Chat, "files">[]): Promise<Chat[]> {
  if (chats.length === 0) return [];
  const ids = chats.map((c) => c.id);
  const { results } = await db
    .prepare(
      "SELECT * FROM files WHERE thread_id = ? AND chat_id BETWEEN ? AND ? AND status = 'ready' ORDER BY created_at, id",
    )
    .bind(threadId, Math.min(...ids), Math.max(...ids))
    .all<FileRow>();
  return chats.map((c) => ({
    ...c,
    files: results.filter((f) => f.chat_id === c.id).map((f) => toFileMeta(origin, f)),
  }));
}

/** With `after`, the next chats in order; without, the latest `limit` chats. */
export async function listChats(
  db: D1Database,
  origin: string,
  threadId: string,
  opts: { after?: number; limit?: number } = {},
): Promise<Chat[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const stmt =
    opts.after !== undefined
      ? db.prepare("SELECT * FROM chats WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?").bind(threadId, opts.after, limit)
      : db.prepare("SELECT * FROM (SELECT * FROM chats WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id").bind(threadId, limit);
  const { results } = await stmt.all<Omit<Chat, "files">>();
  return attachFiles(db, origin, threadId, results);
}

export async function postChat(
  db: D1Database,
  origin: string,
  threadId: string,
  actor: Actor,
  text: string,
  fileIds: string[] = [],
): Promise<Chat> {
  const body = text.trim();
  if (!body && fileIds.length === 0) throw new HttpError(422, "a chat needs text or files");
  if (body.length > 100_000) throw new HttpError(413, "text is over 100,000 characters");

  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT id FROM files WHERE id IN (${placeholders}) AND thread_id = ? AND status = 'ready' AND chat_id IS NULL`)
      .bind(...fileIds, threadId)
      .all<{ id: string }>();
    if (results.length !== new Set(fileIds).size) {
      throw new HttpError(422, "every file must be a finished upload in this thread that isn't attached to another chat");
    }
  }

  const t = now();
  const chat = await db
    .prepare("INSERT INTO chats (thread_id, author, author_kind, text, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(threadId, actor.name, actor.kind, body, t)
    .first<Omit<Chat, "files">>();
  if (!chat) throw new Error("insert failed");

  await db.batch([
    ...fileIds.map((id) => db.prepare("UPDATE files SET chat_id = ? WHERE id = ?").bind(chat.id, id)),
    db.prepare("UPDATE threads SET last_chat_at = ? WHERE id = ?").bind(t, threadId),
    markReadStmt(db, threadId, actor.name, chat.id),
  ]);
  const [withFiles] = await attachFiles(db, origin, threadId, [chat]);
  return withFiles;
}

async function getChatRow(db: D1Database, id: number) {
  const c = await db.prepare("SELECT * FROM chats WHERE id = ?").bind(id).first<Omit<Chat, "files">>();
  if (!c) throw new HttpError(404, `no chat #${id}`);
  return c;
}

/** Authors can rewrite their own chats; attached files stay as they are. */
export async function editChat(db: D1Database, origin: string, id: number, actor: Actor, text: string): Promise<Chat> {
  const old = await getChatRow(db, id);
  if (old.author !== actor.name || old.author_kind !== actor.kind) throw new HttpError(403, "you can only edit your own chats");
  const body = text.trim();
  if (body.length > 100_000) throw new HttpError(413, "text is over 100,000 characters");
  if (!body) {
    const file = await db.prepare("SELECT 1 FROM files WHERE chat_id = ?").bind(id).first();
    if (!file) throw new HttpError(422, "a chat needs text or files; delete it instead");
  }
  const chat = await db
    .prepare("UPDATE chats SET text = ?, edited_at = ? WHERE id = ? RETURNING *")
    .bind(body, now(), id)
    .first<Omit<Chat, "files">>();
  const [withFiles] = await attachFiles(db, origin, old.thread_id, [chat!]);
  return withFiles;
}

/** Agents can delete their own chats; the owner can delete any. Returns the R2 keys of the chat's files. */
export async function deleteChat(db: D1Database, id: number, actor: Actor) {
  const chat = await getChatRow(db, id);
  const own = chat.author === actor.name && chat.author_kind === actor.kind;
  if (!own && actor.kind !== "human") throw new HttpError(403, "you can only delete your own chats");
  const { results } = await db.prepare("SELECT r2_key FROM files WHERE chat_id = ?").bind(id).all<{ r2_key: string }>();
  await db.batch([db.prepare("DELETE FROM files WHERE chat_id = ?").bind(id), db.prepare("DELETE FROM chats WHERE id = ?").bind(id)]);
  return { chat, r2Keys: results.map((r) => r.r2_key) };
}

function markReadStmt(db: D1Database, threadId: string, reader: string, chatId: number) {
  return db
    .prepare(
      `INSERT INTO reads (thread_id, reader, last_chat_id) VALUES (?, ?, ?)
       ON CONFLICT (thread_id, reader) DO UPDATE SET last_chat_id = MAX(last_chat_id, excluded.last_chat_id)`,
    )
    .bind(threadId, reader, chatId);
}

export async function markRead(db: D1Database, threadId: string, reader: string, chatId: number) {
  await markReadStmt(db, threadId, reader, chatId).run();
}

export async function lastRead(db: D1Database, threadId: string, reader: string): Promise<number> {
  const r = await db
    .prepare("SELECT last_chat_id FROM reads WHERE thread_id = ? AND reader = ?")
    .bind(threadId, reader)
    .first<{ last_chat_id: number }>();
  return r?.last_chat_id ?? 0;
}

// ---- files ----

export async function listThreadFiles(db: D1Database, origin: string, threadId: string): Promise<FileMeta[]> {
  const { results } = await db
    .prepare("SELECT * FROM files WHERE thread_id = ? AND status = 'ready' AND chat_id IS NOT NULL ORDER BY created_at, id")
    .bind(threadId)
    .all<FileRow>();
  return results.map((f) => toFileMeta(origin, f));
}

export async function getFileRow(db: D1Database, id: string): Promise<FileRow> {
  const f = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  if (!f) throw new HttpError(404, `no file ${id}`);
  return f;
}

export type { FileRow };
