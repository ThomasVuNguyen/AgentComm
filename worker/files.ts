import type { Actor } from "./auth";
import { type FileRow, getFileRow, toFileMeta, fileUrl } from "./db";
import { HttpError, cleanFileName, newId, newSecret, now } from "./lib";

export const MAX_FILE_BYTES = 4 * 1024 ** 3;
/** Parts stay well under the Worker request body limit (100 MB on Free/Pro). */
export const PART_BYTES = 50 * 1024 ** 2;

export type UploadPlan = {
  file_id: string;
  name: string;
  size: number;
  part_size: number;
  part_count: number;
  /** PUT the whole file here when part_count is 1. */
  upload_url: string;
  /** Otherwise PUT each part to `${upload_url}/parts/<n>` (1-based), then POST `${upload_url}/complete`. */
  multipart: boolean;
  url: string;
};

export async function startUpload(
  env: Env,
  origin: string,
  thread: { id: string; project_id: string },
  actor: Actor,
  input: { name: string; size: number; content_type?: string },
): Promise<UploadPlan> {
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(422, "size must be the file size in bytes");
  if (size > MAX_FILE_BYTES) throw new HttpError(413, "files are limited to 4 GB");

  const id = newId("f");
  const name = cleanFileName(input.name);
  const contentType = (input.content_type || "application/octet-stream").slice(0, 200);
  const key = `${thread.project_id}/${thread.id}/${id}/${name}`;
  const accessKey = newSecret();
  const multipart = size > PART_BYTES;
  const uploadId = multipart
    ? (await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType } })).uploadId
    : null;

  await env.DB.prepare(
    `INSERT INTO files (id, thread_id, name, size, content_type, r2_key, access_key, upload_id, status, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
  )
    .bind(id, thread.id, name, size, contentType, key, accessKey, uploadId, actor.name, now())
    .run();

  return {
    file_id: id,
    name,
    size,
    part_size: PART_BYTES,
    part_count: Math.max(1, Math.ceil(size / PART_BYTES)),
    upload_url: `${origin}/api/uploads/${id}/${accessKey}`,
    multipart,
    url: fileUrl(origin, { id, access_key: accessKey, name }),
  };
}

async function uploadingFile(env: Env, id: string, key: string): Promise<FileRow> {
  const f = await getFileRow(env.DB, id);
  if (f.access_key !== key) throw new HttpError(404, `no file ${id}`);
  if (f.status !== "uploading") throw new HttpError(409, "this upload is already finished");
  return f;
}

function contentLength(req: Request): number {
  const header = req.headers.get("content-length");
  const n = Number(header);
  if (header === null || !Number.isSafeInteger(n) || (n > 0 && !req.body)) {
    throw new HttpError(411, "send a Content-Length header");
  }
  return n;
}

export async function putWholeFile(env: Env, origin: string, id: string, key: string, req: Request) {
  const f = await uploadingFile(env, id, key);
  if (f.upload_id) throw new HttpError(409, "this is a multipart upload; PUT its parts instead");
  if (contentLength(req) !== f.size) throw new HttpError(422, `expected ${f.size} bytes`);
  await env.FILES.put(f.r2_key, f.size === 0 ? "" : req.body, { httpMetadata: { contentType: f.content_type } });
  await env.DB.prepare("UPDATE files SET status = 'ready' WHERE id = ?").bind(id).run();
  return toFileMeta(origin, { ...f, status: "ready" });
}

export async function putPart(env: Env, id: string, key: string, partNumber: number, req: Request) {
  const f = await uploadingFile(env, id, key);
  if (!f.upload_id) throw new HttpError(409, "this upload is a single PUT, not multipart");
  const count = Math.ceil(f.size / PART_BYTES);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new HttpError(422, `part number must be 1–${count}`);
  }
  const expected = partNumber < count ? PART_BYTES : f.size - PART_BYTES * (count - 1);
  if (contentLength(req) !== expected) throw new HttpError(422, `part ${partNumber} must be ${expected} bytes`);

  const upload = env.FILES.resumeMultipartUpload(f.r2_key, f.upload_id);
  const part = await upload.uploadPart(partNumber, req.body!);
  await env.DB.prepare(
    `INSERT INTO upload_parts (file_id, part_number, etag) VALUES (?, ?, ?)
     ON CONFLICT (file_id, part_number) DO UPDATE SET etag = excluded.etag`,
  )
    .bind(id, partNumber, part.etag)
    .run();
  return { part_number: partNumber, of: count };
}

export async function completeUpload(env: Env, origin: string, id: string, key: string) {
  const f = await uploadingFile(env, id, key);
  if (!f.upload_id) throw new HttpError(409, "single uploads finish on PUT");
  const count = Math.ceil(f.size / PART_BYTES);
  const { results: parts } = await env.DB.prepare(
    "SELECT part_number, etag FROM upload_parts WHERE file_id = ? ORDER BY part_number",
  )
    .bind(id)
    .all<{ part_number: number; etag: string }>();
  if (parts.length !== count) {
    const have = new Set(parts.map((p) => p.part_number));
    const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
    throw new HttpError(409, `missing parts: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}`);
  }

  const upload = env.FILES.resumeMultipartUpload(f.r2_key, f.upload_id);
  await upload.complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  await env.DB.batch([
    env.DB.prepare("UPDATE files SET status = 'ready', upload_id = NULL WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM upload_parts WHERE file_id = ?").bind(id),
  ]);
  return toFileMeta(origin, { ...f, status: "ready", upload_id: null });
}

export async function abortUpload(env: Env, id: string, key: string) {
  const f = await uploadingFile(env, id, key);
  if (f.upload_id) await env.FILES.resumeMultipartUpload(f.r2_key, f.upload_id).abort();
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
}

/** Small files posted inline (MCP, form posts) go straight to R2. */
export async function putSmallFile(
  env: Env,
  origin: string,
  thread: { id: string; project_id: string },
  actor: Actor,
  name: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType?: string,
) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const plan = await startUpload(env, origin, thread, actor, { name, size: bytes.byteLength, content_type: contentType });
  if (plan.multipart) throw new HttpError(413, "inline files must be 50 MB or smaller; use the upload API");
  const f = await getFileRow(env.DB, plan.file_id);
  await env.FILES.put(f.r2_key, bytes, { httpMetadata: { contentType: f.content_type } });
  await env.DB.prepare("UPDATE files SET status = 'ready' WHERE id = ?").bind(f.id).run();
  return toFileMeta(origin, { ...f, status: "ready" });
}

export async function downloadFile(env: Env, id: string, key: string, req: Request): Promise<Response> {
  const f = await getFileRow(env.DB, id);
  if (f.access_key !== key || f.status !== "ready") throw new HttpError(404, `no file ${id}`);
  const object = await env.FILES.get(f.r2_key, { range: req.headers, onlyIf: req.headers });
  if (!object) throw new HttpError(404, `file ${id} is missing from storage`);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  const inline = new URL(req.url).searchParams.has("inline");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  headers.set("cache-control", "private, max-age=3600");

  if (!("body" in object)) return new Response(null, { status: 304, headers });
  const range = object.range as { offset: number; length: number } | undefined;
  if (range && req.headers.has("range")) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}
