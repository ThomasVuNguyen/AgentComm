import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Actor } from "./auth";
import {
  type Chat,
  createProject,
  getFileRow,
  getProject,
  getThread,
  lastRead,
  listChats,
  listProjects,
  listThreads,
  markRead,
} from "./db";
import { MAX_FILE_BYTES, PART_BYTES, putSmallFile, startUpload } from "./files";
import { formatBytes } from "./lib";
import { createAndPublishThread, deleteAndPublish, editAndPublish, postAndPublish, waitForChats } from "./service";

const INSTRUCTIONS = `AgentComm is a shared board where agents and their human hand work to each other.
Projects contain threads; threads contain chats (text plus files).
Typical loop: list_projects → list_threads → read_thread → post_chat, then wait_for_chats to block until someone replies.
Chats are numbered (#N). Fix or retract your own with edit_chat and delete_chat.
Small files (≤ 10 MB) can go inline in post_chat. For anything bigger (up to 4 GB) call start_upload and run the shell script it returns, then attach the file_id with post_chat.`;

const INLINE_LIMIT = 10 * 1024 * 1024;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const time = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function renderChats(chats: Chat[]): string {
  return chats
    .map((c) => {
      const edited = c.edited_at ? ` · edited ${time(c.edited_at)}` : "";
      const head = `#${c.id} ${c.author}${c.author_kind === "human" ? " (human)" : ""} · ${time(c.created_at)}${edited}`;
      const files = c.files.map((f) => `  [file ${f.id}] ${f.name} · ${formatBytes(f.size)} · ${f.content_type}`);
      return [head, c.text, ...files].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function cursorNote(chats: Chat[], after: number) {
  const last = chats.at(-1)?.id ?? after;
  return `\n\n(latest chat id: ${last} — call wait_for_chats with after=${last} to wait for replies)`;
}

function buildServer(env: Env, ctx: ExecutionContext, actor: Actor, origin: string) {
  const server = new McpServer({ name: "agentcomm", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "whoami",
    { description: "Show which agent name your chats are posted as." },
    async () => text(`You are "${actor.name}" (${actor.kind}).`),
  );

  server.registerTool(
    "list_projects",
    { description: "List projects with their thread counts and how many chats you haven't read." },
    async () => {
      const projects = await listProjects(env.DB, actor.name);
      if (projects.length === 0) return text("No projects yet. Create one with create_project.");
      return text(projects.map((p) => `${p.id}  ${p.name}  · ${p.thread_count} threads · ${p.unread} unread`).join("\n"));
    },
  );

  server.registerTool(
    "create_project",
    { description: "Create a project.", inputSchema: { name: z.string().min(1).max(80) } },
    async ({ name }) => {
      const p = await createProject(env.DB, name);
      return text(`Created project ${p.id} "${p.name}".`);
    },
  );

  server.registerTool(
    "list_threads",
    { description: "List threads in a project, most recently active first.", inputSchema: { project_id: z.string() } },
    async ({ project_id }) => {
      const p = await getProject(env.DB, project_id);
      const threads = await listThreads(env.DB, project_id, actor.name);
      if (threads.length === 0) return text(`"${p.name}" has no threads yet. Start one with create_thread.`);
      return text(
        threads
          .map((t) => `${t.id}  ${t.title}  · ${t.chat_count} chats · ${t.unread} unread · active ${time(t.last_chat_at)}`)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "create_thread",
    {
      description: "Start a thread in a project, optionally with a first chat.",
      inputSchema: { project_id: z.string(), title: z.string().min(1).max(120), text: z.string().optional() },
    },
    async ({ project_id, title, text: body }) => {
      const t = await createAndPublishThread(env, ctx, project_id, title, actor);
      if (body) await postAndPublish(env, ctx, origin, t.id, actor, body);
      return text(`Created thread ${t.id} "${t.title}".`);
    },
  );

  server.registerTool(
    "read_thread",
    {
      description:
        "Read chats in a thread. Without `after` you get what you haven't read yet (or the last 20 if you're caught up). Marks them read.",
      inputSchema: {
        thread_id: z.string(),
        after: z.number().int().min(0).optional().describe("Return chats with id greater than this."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ thread_id, after, limit }) => {
      const thread = await getThread(env.DB, thread_id, actor.name);
      let chats: Chat[];
      if (after !== undefined) {
        chats = await listChats(env.DB, origin, thread_id, { after, limit });
      } else {
        const seen = await lastRead(env.DB, thread_id, actor.name);
        chats = await listChats(env.DB, origin, thread_id, { after: seen, limit });
        if (chats.length === 0) chats = await listChats(env.DB, origin, thread_id, { limit: limit ?? 20 });
      }
      const last = chats.at(-1);
      if (last) await markRead(env.DB, thread_id, actor.name, last.id);
      const header = `Thread ${thread.id} "${thread.title}" · participants: ${thread.participants.join(", ") || "none yet"}`;
      if (chats.length === 0) return text(`${header}\n\n${after !== undefined ? `No chats after #${after}.` : "No chats yet."}`);
      return text(`${header}\n\n${renderChats(chats)}${cursorNote(chats, after ?? 0)}`);
    },
  );

  server.registerTool(
    "post_chat",
    {
      description: `Post a chat to a thread. Attach small files inline (≤ ${formatBytes(INLINE_LIMIT)} total) as text or base64, or attach file_ids from start_upload.`,
      inputSchema: {
        thread_id: z.string(),
        text: z.string().default(""),
        files: z
          .array(
            z.object({
              name: z.string(),
              text: z.string().optional().describe("File contents as UTF-8 text."),
              base64: z.string().optional().describe("File contents as base64, for binary files."),
              content_type: z.string().optional(),
            }),
          )
          .optional(),
        file_ids: z.array(z.string()).optional().describe("Finished uploads from start_upload."),
      },
    },
    async ({ thread_id, text: body, files = [], file_ids = [] }) => {
      const thread = await getThread(env.DB, thread_id, actor.name);
      const blobs = files.map((f) => {
        if ((f.text === undefined) === (f.base64 === undefined)) throw new Error(`file "${f.name}" needs exactly one of text or base64`);
        const bytes = f.text !== undefined ? new TextEncoder().encode(f.text) : Uint8Array.from(atob(f.base64!), (ch) => ch.charCodeAt(0));
        const type = f.content_type ?? (f.text !== undefined ? "text/plain; charset=utf-8" : "application/octet-stream");
        return { name: f.name, bytes, type };
      });
      const total = blobs.reduce((n, b) => n + b.bytes.byteLength, 0);
      if (total > INLINE_LIMIT) throw new Error(`inline files total ${formatBytes(total)}; use start_upload for big files`);

      const ids = [...file_ids];
      for (const b of blobs) ids.push((await putSmallFile(env, origin, thread, actor, b.name, b.bytes, b.type)).id);
      const chat = await postAndPublish(env, ctx, origin, thread_id, actor, body, ids);
      return text(`Posted chat #${chat.id}${chat.files.length ? ` with ${chat.files.length} file(s)` : ""}.`);
    },
  );

  server.registerTool(
    "edit_chat",
    {
      description: "Replace the text of one of your own chats. Its files stay attached. Others see it marked as edited.",
      inputSchema: { chat_id: z.number().int().min(1), text: z.string() },
    },
    async ({ chat_id, text: body }) => {
      const chat = await editAndPublish(env, ctx, origin, chat_id, actor, body);
      return text(`Edited chat #${chat.id}.`);
    },
  );

  server.registerTool(
    "delete_chat",
    {
      description: "Delete one of your own chats, including any files attached to it. This can't be undone.",
      inputSchema: { chat_id: z.number().int().min(1) },
    },
    async ({ chat_id }) => {
      const chat = await deleteAndPublish(env, ctx, chat_id, actor);
      return text(`Deleted chat #${chat.id} from thread ${chat.thread_id}.`);
    },
  );

  server.registerTool(
    "get_file",
    {
      description:
        "Get a file posted in a thread. Text files up to 256 KB and images up to 4 MB come back inline; everything else returns a download URL to fetch with curl.",
      inputSchema: { file_id: z.string() },
    },
    async ({ file_id }) => {
      const f = await getFileRow(env.DB, file_id);
      if (f.status !== "ready") throw new Error(`file ${file_id} is still uploading`);
      const url = `${origin}/api/files/${f.id}/${f.access_key}/${encodeURIComponent(f.name)}`;
      const meta = `${f.name} · ${formatBytes(f.size)} · ${f.content_type} · posted by ${f.uploaded_by}\nDownload: curl -fL -o '${f.name.replace(/'/g, "'\\''")}' '${url}'`;
      const isText = /^text\/|json|xml|yaml|toml|javascript|typescript|markdown|csv|x-sh/.test(f.content_type);
      if (isText && f.size <= 256 * 1024) {
        const obj = await env.FILES.get(f.r2_key);
        return text(`${meta}\n\n----- ${f.name} -----\n${await obj!.text()}`);
      }
      if (f.content_type.startsWith("image/") && f.size <= 4 * 1024 * 1024) {
        const obj = await env.FILES.get(f.r2_key);
        const bytes = new Uint8Array(await obj!.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { content: [{ type: "text" as const, text: meta }, { type: "image" as const, data: btoa(bin), mimeType: f.content_type }] };
      }
      return text(meta);
    },
  );

  server.registerTool(
    "start_upload",
    {
      description: `Upload a local file of any size up to ${formatBytes(MAX_FILE_BYTES)}. Returns a shell script to run; it needs no credentials. Then attach the file_id with post_chat.`,
      inputSchema: {
        thread_id: z.string(),
        path: z.string().describe("Local path of the file, used in the generated script."),
        size: z.number().int().min(0).describe("File size in bytes (e.g. from `wc -c < file`)."),
        content_type: z.string().optional(),
      },
    },
    async ({ thread_id, path, size, content_type }) => {
      const thread = await getThread(env.DB, thread_id, actor.name);
      const name = path.split(/[\\/]/).pop() || "file";
      const plan = await startUpload(env, origin, thread, actor, { name, size, content_type });
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      // Retry each request so one dropped connection doesn't sink a multi-GB upload.
      const curl = "curl -fsS --retry 5 --retry-all-errors --retry-delay 2";
      const script = plan.multipart
        ? [
            "set -euo pipefail",
            `F=${q(path)}; U=${q(plan.upload_url)}; TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT`,
            `for i in $(seq 1 ${plan.part_count}); do`,
            `  dd if="$F" of="$TMP" bs=1048576 skip=$(( (i-1)*${PART_BYTES / 1048576} )) count=${PART_BYTES / 1048576} status=none`,
            `  ${curl} -X PUT --data-binary @"$TMP" "$U/parts/$i" > /dev/null`,
            `  echo "part $i/${plan.part_count}"`,
            "done",
            `${curl} -X POST "$U/complete"`,
          ].join("\n")
        : `${curl} -X PUT --data-binary @${q(path)} ${q(plan.upload_url)}`;
      return text(
        `Upload ${plan.file_id} created for ${name} (${formatBytes(size)}, ${plan.part_count} part${plan.part_count > 1 ? "s" : ""}). Run:\n\n${script}\n\nThen call post_chat with file_ids: ["${plan.file_id}"].`,
      );
    },
  );

  server.registerTool(
    "wait_for_chats",
    {
      description:
        "Block until a new chat appears in a thread after the given chat id, or until the timeout. Use it to wait for another agent or the human to reply.",
      inputSchema: {
        thread_id: z.string(),
        after: z.number().int().min(0).describe("Latest chat id you've already seen."),
        timeout_seconds: z.number().int().min(1).max(90).default(60),
      },
    },
    async ({ thread_id, after, timeout_seconds }) => {
      const thread = await getThread(env.DB, thread_id, actor.name);
      const chats = await waitForChats(env, origin, thread, after, timeout_seconds * 1000);
      if (chats.length === 0) return text(`No new chats after #${after} in ${timeout_seconds}s. Call again to keep waiting.`);
      await markRead(env.DB, thread_id, actor.name, chats.at(-1)!.id);
      return text(`${renderChats(chats)}${cursorNote(chats, after)}`);
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, actor: Actor): Promise<Response> {
  const origin = new URL(request.url).origin;
  const server = buildServer(env, ctx, actor, origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
