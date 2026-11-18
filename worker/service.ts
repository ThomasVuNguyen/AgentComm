import type { Actor } from "./auth";
import { type Chat, createThread, deleteChat, editChat, getThread, listChats, postChat } from "./db";
import { room } from "./room";

/** Post a chat and push it (plus the thread's new position) to live viewers. */
export async function postAndPublish(
  env: Env,
  ctx: ExecutionContext,
  origin: string,
  threadId: string,
  actor: Actor,
  text: string,
  fileIds: string[] = [],
): Promise<Chat> {
  const thread = await getThread(env.DB, threadId, actor.name);
  const chat = await postChat(env.DB, origin, threadId, actor, text, fileIds);
  const r = room(env, thread.project_id);
  ctx.waitUntil(
    (async () => {
      await r.publish({ type: "chat", chat });
      // Viewers compute their own unread counts, so send the thread as seen by nobody.
      const { participants: _, ...updated } = await getThread(env.DB, threadId, "");
      await r.publish({ type: "thread", thread: updated });
    })(),
  );
  return chat;
}

export async function editAndPublish(env: Env, ctx: ExecutionContext, origin: string, id: number, actor: Actor, text: string) {
  const chat = await editChat(env.DB, origin, id, actor, text);
  const { project_id } = await getThread(env.DB, chat.thread_id, actor.name);
  ctx.waitUntil(room(env, project_id).publish({ type: "chat_edit", chat }));
  return chat;
}

/** Delete a chat and its files, then update live viewers' thread and chat count. */
export async function deleteAndPublish(env: Env, ctx: ExecutionContext, id: number, actor: Actor) {
  const { chat, r2Keys } = await deleteChat(env.DB, id, actor);
  if (r2Keys.length) ctx.waitUntil(env.FILES.delete(r2Keys));
  const { participants: _, ...thread } = await getThread(env.DB, chat.thread_id, "");
  const r = room(env, thread.project_id);
  ctx.waitUntil(
    (async () => {
      await r.publish({ type: "chat_delete", thread_id: chat.thread_id, id });
      await r.publish({ type: "thread", thread });
    })(),
  );
  return chat;
}

export async function createAndPublishThread(env: Env, ctx: ExecutionContext, projectId: string, title: string, actor: Actor) {
  const thread = await createThread(env.DB, projectId, title, actor);
  ctx.waitUntil(room(env, projectId).publish({ type: "thread", thread }));
  return thread;
}

/** Chats after `after`, waiting up to `timeoutMs` for the first one to arrive. */
export async function waitForChats(
  env: Env,
  origin: string,
  thread: { id: string; project_id: string },
  after: number,
  timeoutMs: number,
): Promise<Chat[]> {
  const deadline = Date.now() + timeoutMs;
  const r = room(env, thread.project_id);
  for (;;) {
    const chats = await listChats(env.DB, origin, thread.id, { after });
    const remaining = deadline - Date.now();
    if (chats.length > 0 || remaining <= 0) return chats;
    // Short slices re-check D1, covering a chat posted between the query and the wait.
    await r.waitForChat(thread.id, Math.min(remaining, 10_000));
  }
}
