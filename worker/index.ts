import { Hono } from "hono";
import { type AppEnv, newAgentToken, requireActor, requireHuman } from "./auth";
import {
  createProject,
  getProject,
  getThread,
  listChats,
  listProjects,
  listThreadFiles,
  listThreads,
  markRead,
} from "./db";
import {
  MAX_FILE_BYTES,
  abortUpload,
  completeUpload,
  downloadFile,
  putPart,
  putSmallFile,
  putWholeFile,
  startUpload,
} from "./files";
import { HttpError, newId, now, sha256Hex } from "./lib";
import { handleMcp } from "./mcp";
import { room } from "./room";
import { createAndPublishThread, deleteAndPublish, editAndPublish, postAndPublish, waitForChats } from "./service";

export { ProjectRoom } from "./room";

const app = new Hono<AppEnv>();
const origin = (url: string) => new URL(url).origin;

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// ---- capability URLs: the secret in the path is the credential ----

app.get("/api/files/:id/:key/:name?", (c) => downloadFile(c.env, c.req.param("id"), c.req.param("key"), c.req.raw));
app.put("/api/uploads/:id/:key", async (c) =>
  c.json(await putWholeFile(c.env, origin(c.req.url), c.req.param("id"), c.req.param("key"), c.req.raw)),
);
app.put("/api/uploads/:id/:key/parts/:n", async (c) =>
  c.json(await putPart(c.env, c.req.param("id"), c.req.param("key"), Number(c.req.param("n")), c.req.raw)),
);
app.post("/api/uploads/:id/:key/complete", async (c) =>
  c.json(await completeUpload(c.env, origin(c.req.url), c.req.param("id"), c.req.param("key"))),
);
app.delete("/api/uploads/:id/:key", async (c) => {
  await abortUpload(c.env, c.req.param("id"), c.req.param("key"));
  return c.body(null, 204);
});

// ---- everything else needs the owner (Access) or an agent token ----

app.all("/mcp", requireActor, (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get("actor")));

app.use("/api/*", requireActor);

app.get("/api/me", (c) => c.json({ ...c.get("actor"), max_file_bytes: MAX_FILE_BYTES }));

app.get("/api/projects", async (c) => c.json(await listProjects(c.env.DB, c.get("actor").name)));
app.post("/api/projects", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  return c.json(await createProject(c.env.DB, name ?? ""), 201);
});

app.get("/api/projects/:pid/threads", async (c) => {
  await getProject(c.env.DB, c.req.param("pid"));
  return c.json(await listThreads(c.env.DB, c.req.param("pid"), c.get("actor").name));
});
app.post("/api/projects/:pid/threads", async (c) => {
  const { title, text } = await c.req.json<{ title: string; text?: string }>();
  const actor = c.get("actor");
  const ctx = c.executionCtx as ExecutionContext;
  const thread = await createAndPublishThread(c.env, ctx, c.req.param("pid"), title ?? "", actor);
  if (text) await postAndPublish(c.env, ctx, origin(c.req.url), thread.id, actor, text);
  return c.json(thread, 201);
});

app.get("/api/projects/:pid/live", async (c) => {
  await getProject(c.env.DB, c.req.param("pid"));
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "expected a websocket upgrade" }, 426);
  return room(c.env, c.req.param("pid")).fetch(c.req.raw);
});

app.get("/api/threads/:tid", async (c) => c.json(await getThread(c.env.DB, c.req.param("tid"), c.get("actor").name)));

/** `?after=N` pages forward; add `&wait=60` to long-poll for the next chat. */
app.get("/api/threads/:tid/chats", async (c) => {
  const thread = await getThread(c.env.DB, c.req.param("tid"), c.get("actor").name);
  const after = c.req.query("after");
  const wait = Math.min(Number(c.req.query("wait") ?? 0) || 0, 90);
  const limit = Number(c.req.query("limit")) || undefined;
  if (after !== undefined && wait > 0) {
    return c.json(await waitForChats(c.env, origin(c.req.url), thread, Number(after), wait * 1000));
  }
  return c.json(await listChats(c.env.DB, origin(c.req.url), thread.id, { after: after === undefined ? undefined : Number(after), limit }));
});

/** JSON `{ text, file_ids }`, or multipart form `text` + `file` fields for quick curl posts. */
app.post("/api/threads/:tid/chats", async (c) => {
  const actor = c.get("actor");
  const ctx = c.executionCtx as ExecutionContext;
  const o = origin(c.req.url);
  if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
    if (Number(c.req.header("content-length") ?? 0) > 50 * 1024 * 1024) {
      throw new HttpError(413, "form posts are limited to 50 MB; use /uploads for bigger files");
    }
    const thread = await getThread(c.env.DB, c.req.param("tid"), actor.name);
    const form = await c.req.formData();
    const ids: string[] = [];
    for (const value of form.getAll("file")) {
      if (typeof value === "string") continue;
      const f = await putSmallFile(c.env, o, thread, actor, value.name, await value.arrayBuffer(), value.type || undefined);
      ids.push(f.id);
    }
    return c.json(await postAndPublish(c.env, ctx, o, thread.id, actor, String(form.get("text") ?? ""), ids), 201);
  }
  const { text, file_ids } = await c.req.json<{ text?: string; file_ids?: string[] }>();
  return c.json(await postAndPublish(c.env, ctx, o, c.req.param("tid"), actor, text ?? "", file_ids ?? []), 201);
});

app.patch("/api/chats/:id", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const ctx = c.executionCtx as ExecutionContext;
  return c.json(await editAndPublish(c.env, ctx, origin(c.req.url), Number(c.req.param("id")), c.get("actor"), text ?? ""));
});
app.delete("/api/chats/:id", async (c) => {
  await deleteAndPublish(c.env, c.executionCtx as ExecutionContext, Number(c.req.param("id")), c.get("actor"));
  return c.body(null, 204);
});

app.post("/api/threads/:tid/read", async (c) => {
  const { chat_id } = await c.req.json<{ chat_id: number }>();
  await markRead(c.env.DB, c.req.param("tid"), c.get("actor").name, Number(chat_id));
  return c.body(null, 204);
});

app.get("/api/threads/:tid/files", async (c) => c.json(await listThreadFiles(c.env.DB, origin(c.req.url), c.req.param("tid"))));

app.post("/api/threads/:tid/uploads", async (c) => {
  const thread = await getThread(c.env.DB, c.req.param("tid"), c.get("actor").name);
  const body = await c.req.json<{ name: string; size: number; content_type?: string }>();
  return c.json(await startUpload(c.env, origin(c.req.url), thread, c.get("actor"), body), 201);
});

// ---- agent tokens (owner only) ----

app.get("/api/agents", requireHuman, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, created_at, last_seen_at FROM agents WHERE revoked_at IS NULL ORDER BY created_at",
  ).all();
  return c.json(results);
});

app.post("/api/agents", requireHuman, async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  const clean = (name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(clean)) {
    throw new HttpError(422, "agent names are 1–32 characters: letters, numbers, - and _");
  }
  if (clean === c.get("actor").name) throw new HttpError(409, "that name is yours");
  const taken = await c.env.DB.prepare("SELECT 1 FROM agents WHERE name = ?").bind(clean).first();
  if (taken) throw new HttpError(409, `an agent named ${clean} already exists`);
  const token = newAgentToken();
  const agent = { id: newId("a"), name: clean, created_at: now() };
  await c.env.DB.prepare("INSERT INTO agents (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(agent.id, agent.name, await sha256Hex(token), agent.created_at)
    .run();
  return c.json({ ...agent, last_seen_at: null, token }, 201);
});

app.delete("/api/agents/:id", requireHuman, async (c) => {
  // Revoked names stay reserved so old chats keep an unambiguous author.
  await c.env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").bind(now(), c.req.param("id")).run();
  return c.body(null, 204);
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app satisfies ExportedHandler<Env>;
