export type Me = { kind: "human" | "agent"; name: string; max_file_bytes: number };
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
  participants?: string[];
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
export type Agent = { id: string; name: string; created_at: number; last_seen_at: number | null; token?: string };
export type UploadPlan = {
  file_id: string;
  name: string;
  size: number;
  part_size: number;
  part_count: number;
  upload_url: string;
  multipart: boolean;
};
export type RoomEvent =
  | { type: "chat"; chat: Chat }
  | { type: "chat_edit"; chat: Chat }
  | { type: "chat_delete"; thread_id: string; id: number }
  | { type: "thread"; thread: Thread };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  projects: () => call<Project[]>("GET", "/api/projects"),
  createProject: (name: string) => call<Project>("POST", "/api/projects", { name }),
  threads: (pid: string) => call<Thread[]>("GET", `/api/projects/${pid}/threads`),
  createThread: (pid: string, title: string) => call<Thread>("POST", `/api/projects/${pid}/threads`, { title }),
  thread: (tid: string) => call<Thread & { participants: string[] }>("GET", `/api/threads/${tid}`),
  chats: (tid: string) => call<Chat[]>("GET", `/api/threads/${tid}/chats?limit=200`),
  post: (tid: string, text: string, file_ids: string[]) => call<Chat>("POST", `/api/threads/${tid}/chats`, { text, file_ids }),
  editChat: (id: number, text: string) => call<Chat>("PATCH", `/api/chats/${id}`, { text }),
  deleteChat: (id: number) => call<void>("DELETE", `/api/chats/${id}`),
  read: (tid: string, chat_id: number) => call<void>("POST", `/api/threads/${tid}/read`, { chat_id }),
  files: (tid: string) => call<FileMeta[]>("GET", `/api/threads/${tid}/files`),
  startUpload: (tid: string, f: File) =>
    call<UploadPlan>("POST", `/api/threads/${tid}/uploads`, { name: f.name, size: f.size, content_type: f.type || undefined }),
  agents: () => call<Agent[]>("GET", "/api/agents"),
  createAgent: (name: string) => call<Agent & { token: string }>("POST", "/api/agents", { name }),
  revokeAgent: (id: string) => call<void>("DELETE", `/api/agents/${id}`),
};

class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function putOnce(url: string, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status < 300
        ? resolve()
        : reject(new UploadError(safeError(xhr.responseText) ?? `upload failed (${xhr.status})`, xhr.status >= 500 || xhr.status === 429));
    xhr.onerror = () => reject(new UploadError("network error during upload", true));
    xhr.send(body);
  });
}

/** Dropped connections and 5xx get up to four more tries, backing off 1, 2, 4, 8 s. */
async function put(url: string, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await putOnce(url, body, onProgress);
    } catch (err) {
      if (!(err instanceof UploadError && err.retryable) || attempt >= 4) throw err;
      onProgress(0);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

function safeError(body: string): string | undefined {
  try {
    return JSON.parse(body).error;
  } catch {
    return undefined;
  }
}

/** Uploads a file (single PUT or 50 MB parts, three at a time) and returns its file id. */
export async function uploadFile(tid: string, file: File, onProgress: (fraction: number) => void): Promise<string> {
  const plan = await api.startUpload(tid, file);
  if (!plan.multipart) {
    await put(plan.upload_url, file, (sent) => onProgress(sent / Math.max(file.size, 1)));
    onProgress(1);
    return plan.file_id;
  }
  const sent = new Array<number>(plan.part_count).fill(0);
  const report = () => onProgress(sent.reduce((a, b) => a + b, 0) / file.size);
  let next = 0;
  const worker = async () => {
    while (next < plan.part_count) {
      const i = next++;
      const blob = file.slice(i * plan.part_size, Math.min(file.size, (i + 1) * plan.part_size));
      await put(`${plan.upload_url}/parts/${i + 1}`, blob, (n) => {
        sent[i] = n;
        report();
      });
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
    const res = await fetch(`${plan.upload_url}/complete`, { method: "POST" });
    if (!res.ok) throw new Error(safeError(await res.text()) ?? "could not finish upload");
  } catch (err) {
    fetch(plan.upload_url, { method: "DELETE" }).catch(() => {});
    throw err;
  }
  onProgress(1);
  return plan.file_id;
}
