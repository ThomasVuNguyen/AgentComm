import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Agent, type Chat, type FileMeta, type Me, type Project, type RoomEvent, type Thread, api, uploadFile } from "./api";
import { ChatText, ago, clock, formatBytes } from "./format";

type Route = { view: "agents" } | { view: "project"; pid?: string; tid?: string };

function parseRoute(path: string): Route {
  if (path.startsWith("/agents")) return { view: "agents" };
  const [, p, pid, tid] = path.split("/");
  return p === "p" ? { view: "project", pid, tid } : { view: "project" };
}

function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((path: string) => {
    if (path !== location.pathname) history.pushState(null, "", path);
    setRoute(parseRoute(path));
  }, []);
  return [route, go];
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [route, go] = useRoute();

  const refreshProjects = useCallback(() => api.projects().then(setProjects), []);
  const refreshAgents = useCallback(() => api.agents().then(setAgents), []);

  useEffect(() => {
    api.me().then(setMe).catch((e) => setError(e.message));
    refreshProjects().catch((e) => setError(e.message));
    refreshAgents().catch(() => {});
    // Live updates cover the open project; this keeps the other tabs' counts fresh.
    const timer = setInterval(() => {
      refreshProjects().catch(() => {});
      refreshAgents().catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshProjects, refreshAgents]);

  const pid = route.view === "project" ? (route.pid ?? projects?.[0]?.id) : undefined;
  const active = agents.filter((a) => a.last_seen_at && Date.now() - a.last_seen_at < 5 * 60_000).length;

  const bumpUnread = useCallback((projectId: string, delta: number) => {
    setProjects((ps) => ps?.map((p) => (p.id === projectId ? { ...p, unread: Math.max(0, p.unread + delta) } : p)) ?? ps);
  }, []);

  if (error) return <Fatal message={error} />;
  if (!me || !projects) return <div className="loading t-meta">Loading…</div>;

  return (
    <div className="app">
      <header className="top">
        <a className="brand t-meta" href="/" onClick={(e) => (e.preventDefault(), go("/"))}>
          AgentComm
        </a>
        <nav className="t-meta projects">
          {projects.map((p) => (
            <a
              key={p.id}
              href={`/p/${p.id}`}
              className={route.view === "project" && p.id === pid ? "on" : undefined}
              onClick={(e) => (e.preventDefault(), go(`/p/${p.id}`))}
            >
              {p.name}
              {p.unread > 0 && p.id !== pid && <b> {p.unread}</b>}
            </a>
          ))}
          <InlineAdd
            label="+ project"
            placeholder="Project name"
            onAdd={async (name) => {
              const p = await api.createProject(name);
              await refreshProjects();
              go(`/p/${p.id}`);
            }}
          />
        </nav>
        <a
          className={`who t-meta${route.view === "agents" ? " on" : ""}`}
          href="/agents"
          onClick={(e) => (e.preventDefault(), go("/agents"))}
        >
          {active > 0 && <b>● </b>}
          <span className="long">
            {active > 0 ? `${active} agent${active > 1 ? "s" : ""} active` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`} · {me.name}
          </span>
          <span className="short">agents</span>
        </a>
      </header>

      {route.view === "agents" ? (
        <AgentsPage agents={agents} refresh={refreshAgents} />
      ) : pid ? (
        <ProjectPage key={pid} me={me} pid={pid} tid={route.tid} go={go} bumpUnread={bumpUnread} />
      ) : (
        <Welcome
          onCreate={async (name) => {
            const p = await api.createProject(name);
            await refreshProjects();
            go(`/p/${p.id}`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProjectPage({
  me,
  pid,
  tid,
  go,
  bumpUnread,
}: {
  me: Me;
  pid: string;
  tid?: string;
  go: (path: string) => void;
  bumpUnread: (pid: string, delta: number) => void;
}) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<RoomEvent | null>(null);
  const current = tid ?? threads?.[0]?.id;
  const tidRef = useRef(current);
  tidRef.current = current;

  useEffect(() => {
    api.threads(pid).then(setThreads, (e) => setError(e.message));
  }, [pid]);

  // One socket per project; events fan out to the thread list and the open thread.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let ping: ReturnType<typeof setInterval>;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${pid}/live`);
      ws.onopen = () => {
        retry = 1000;
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      };
      ws.onmessage = (m) => {
        if (m.data === "pong") return;
        const event = JSON.parse(m.data) as RoomEvent;
        if (event.type === "thread") {
          setThreads((ts) => {
            if (!ts) return ts;
            const old = ts.find((t) => t.id === event.thread.id);
            const merged = { ...event.thread, unread: old?.unread ?? 0 };
            return [merged, ...ts.filter((t) => t.id !== merged.id)].sort((a, b) => b.last_chat_at - a.last_chat_at);
          });
        } else if (event.type === "chat" && event.chat.thread_id !== tidRef.current && event.chat.author !== me.name) {
          setThreads((ts) => ts?.map((t) => (t.id === event.chat.thread_id ? { ...t, unread: t.unread + 1 } : t)) ?? ts);
        }
        setLive(event);
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, [pid, me.name]);

  // Opening a thread clears its unread count here and on the project tab.
  const openUnread = threads?.find((t) => t.id === current)?.unread ?? 0;
  useEffect(() => {
    if (!current || openUnread === 0) return;
    bumpUnread(pid, -openUnread);
    setThreads((ts) => ts?.map((t) => (t.id === current ? { ...t, unread: 0 } : t)) ?? ts);
  }, [current, openUnread, pid, bumpUnread]);

  if (error) return <div className="page-error t-body">{error}</div>;
  return (
    <div className={`page${tid ? " in-thread" : ""}`}>
      <nav className="threads">
        <div className="label t-meta">
          Threads
          <InlineAdd
            label="+ new"
            placeholder="Thread title"
            onAdd={async (title) => {
              const t = await api.createThread(pid, title);
              setThreads((ts) => [t, ...(ts ?? []).filter((x) => x.id !== t.id)]);
              go(`/p/${pid}/${t.id}`);
            }}
          />
        </div>
        {threads?.length === 0 && <p className="empty t-body">No threads yet. Start one with + new.</p>}
        {threads?.map((t) => (
          <a
            key={t.id}
            href={`/p/${pid}/${t.id}`}
            className={`thread${t.id === current ? " on" : ""}`}
            onClick={(e) => (e.preventDefault(), go(`/p/${pid}/${t.id}`))}
          >
            <span className="t-body">{t.title}</span>
            <span className="t-meta">
              {t.unread > 0 ? <span className="new">{t.unread} new</span> : `${t.chat_count} chat${t.chat_count === 1 ? "" : "s"}`} ·{" "}
              {clock(t.last_chat_at)}
            </span>
          </a>
        ))}
      </nav>

      {current ? (
        <ThreadPane key={current} me={me} pid={pid} tid={current} live={live} back={() => go(`/p/${pid}`)} />
      ) : (
        threads && (
          <main className="chat-col">
            <div className="title">
              <h1 className="t-display">Nothing here yet</h1>
              <p className="t-body sub">Create a thread, or have an agent start one with create_thread.</p>
            </div>
          </main>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Pending = { key: number; file: File; progress: number; error?: string };

function ThreadPane({ me, pid, tid, live, back }: { me: Me; pid: string; tid: string; live: RoomEvent | null; back: () => void }) {
  const [thread, setThread] = useState<(Thread & { participants: string[] }) | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    Promise.all([api.thread(tid), api.chats(tid), api.files(tid)]).then(
      ([t, c, f]) => {
        setThread(t);
        setChats(c);
        setFiles(f);
        const last = c.at(-1);
        if (last) api.read(tid, last.id).catch(() => {});
      },
      (e) => setError(e.message),
    );
  }, [tid]);

  const addChat = useCallback(
    (chat: Chat) => {
      setChats((cs) => (cs && !cs.some((c) => c.id === chat.id) ? [...cs, chat] : cs));
      if (chat.files.length) setFiles((fs) => [...fs, ...chat.files.filter((f) => !fs.some((x) => x.id === f.id))]);
      setThread((t) => (t && !t.participants.includes(chat.author) ? { ...t, participants: [...t.participants, chat.author] } : t));
      api.read(tid, chat.id).catch(() => {});
    },
    [tid],
  );

  const replaceChat = useCallback((chat: Chat) => setChats((cs) => cs?.map((c) => (c.id === chat.id ? chat : c)) ?? cs), []);
  const removeChat = useCallback((id: number) => {
    setChats((cs) => cs?.filter((c) => c.id !== id) ?? cs);
    setFiles((fs) => fs.filter((f) => f.chat_id !== id));
  }, []);

  useEffect(() => {
    if (live?.type === "chat" && live.chat.thread_id === tid) addChat(live.chat);
    if (live?.type === "chat_edit" && live.chat.thread_id === tid) replaceChat(live.chat);
    if (live?.type === "chat_delete" && live.thread_id === tid) removeChat(live.id);
    if (live?.type === "thread" && live.thread.id === tid) setThread((t) => (t ? { ...t, ...live.thread, participants: t.participants } : t));
  }, [live, tid, addChat, replaceChat, removeChat]);

  // Chat-app scrolling: stay pinned to the newest chat unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chats]);

  // The composer grows with attachments and long drafts; keep the newest chat in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [chats === null]);

  const numbers = useMemo(() => new Map(files.map((f, i) => [f.id, i + 1])), [files]);
  const [editing, setEditing] = useState<number | null>(null);
  const editLast = () => {
    const mine = chats?.findLast((c) => c.author === me.name && c.author_kind === me.kind);
    if (mine) setEditing(mine.id);
    return Boolean(mine);
  };

  if (error) return <main className="chat-col page-error t-body">{error}</main>;
  return (
    <>
      <main className="chat-col">
        <div
          className="scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="title">
            <a className="crumb t-meta" href={`/p/${pid}`} onClick={(e) => (e.preventDefault(), back())}>
              <span className="back">← </span>threads
            </a>
            <h1 className="t-display">{thread?.title ?? " "}</h1>
            <p className="t-body sub">
              {thread ? (thread.participants.length ? listOf(thread.participants) : `Started by ${thread.created_by}`) : " "}
            </p>
          </div>
          {chats?.length === 0 && <p className="empty t-body">No chats yet. Say something, or drop a file.</p>}
          {chats?.map((c) => (
            <Message
              key={c.id}
              chat={c}
              me={me}
              numbers={numbers}
              editing={editing === c.id}
              setEditing={(on) => setEditing(on ? c.id : null)}
              onEdited={replaceChat}
              onDeleted={removeChat}
            />
          ))}
        </div>
        <Composer
          me={me}
          tid={tid}
          title={thread?.title}
          paused={editing !== null}
          onEditLast={editLast}
          onPosted={(chat) => {
            stick.current = true;
            addChat(chat);
          }}
        />
      </main>

      <aside className="files">
        <div className="label t-meta">
          Files in thread <span>{files.length}</span>
        </div>
        {files.length === 0 && <p className="empty t-body">Files posted here are listed in order.</p>}
        {files.map((f, i) => (
          <div key={f.id} className="file">
            <span className="n t-meta">{i + 1}</span>
            <a className="t-body" href={f.url}>
              {f.name}
            </a>
            <span className="t-meta">
              {f.uploaded_by} · {formatBytes(f.size)}
            </span>
          </div>
        ))}
      </aside>
    </>
  );
}

function Message({
  chat: c,
  me,
  numbers,
  editing,
  setEditing,
  onEdited,
  onDeleted,
}: {
  chat: Chat;
  me: Me;
  numbers: Map<string, number>;
  editing: boolean;
  setEditing: (on: boolean) => void;
  onEdited: (c: Chat) => void;
  onDeleted: (id: number) => void;
}) {
  const own = c.author === me.name && c.author_kind === me.kind;
  const canDelete = own || me.kind === "human";
  const [draft, setDraft] = useState(c.text);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  useEffect(() => {
    if (!editing) return;
    setDraft(c.text);
    setError(null);
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (draft.trim() === c.text) return setEditing(false);
    try {
      onEdited(await api.editChat(c.id, draft));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    const what = c.files.length ? `this chat and its ${c.files.length === 1 ? "file" : `${c.files.length} files`}` : "this chat";
    if (!confirm(`Delete ${what}${own ? "" : ` by ${c.author}`}? This can't be undone.`)) return;
    try {
      await api.deleteChat(c.id);
      onDeleted(c.id);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <article className="msg">
      <div className="meta t-meta">
        <span className={c.author_kind === "human" ? "human" : undefined}>{c.author}</span>
        <span className="time" title={`#${c.id}`}>
          {clock(c.created_at)}
          {c.edited_at ? " · edited" : ""}
        </span>
        {!editing && (own || canDelete) && (
          <span className="actions">
            {own && (
              <button className="link" onClick={() => setEditing(true)}>
                edit
              </button>
            )}
            {canDelete && (
              <button className="link" onClick={remove}>
                delete
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="editing">
          <textarea
            ref={box}
            className="t-body"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="t-meta hint">
            {error ? <span className="err">{error}</span> : "enter to save · esc to cancel"}
            <button className="link" onClick={() => setEditing(false)}>
              cancel
            </button>
            <button className="post" onClick={save}>
              save →
            </button>
          </div>
        </div>
      ) : (
        <ChatText text={c.text} />
      )}
      {c.files.map((f) => (
        <div key={f.id} className="attached">
          <span className="n t-meta">{numbers.get(f.id) ?? "·"}</span>
          <a className="t-body" href={f.url}>
            {f.name}
          </a>
          <span className="t-meta">{formatBytes(f.size)}</span>
        </div>
      ))}
    </article>
  );
}

function listOf(names: string[]) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

let pendingKey = 0;

function Composer({
  me,
  tid,
  title,
  paused,
  onEditLast,
  onPosted,
}: {
  me: Me;
  tid: string;
  title?: string;
  /** An inline edit is open; leave the keyboard to it. */
  paused: boolean;
  onEditLast: () => boolean;
  onPosted: (c: Chat) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const add = (list: FileList | File[]) => {
    const added = [...list].map((file) => ({ key: ++pendingKey, file, progress: 0 }));
    const tooBig = added.find((p) => p.file.size > me.max_file_bytes);
    if (tooBig) return setError(`${tooBig.file.name} is over the ${formatBytes(me.max_file_bytes)} limit`);
    setError(null);
    setPending((ps) => [...ps, ...added]);
  };

  // Drop files anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && (depth++, setDragging(true));
    const leave = () => --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) add(e.dataTransfer.files);
    };
    addEventListener("dragenter", enter);
    addEventListener("dragleave", leave);
    addEventListener("dragover", over);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragenter", enter);
      removeEventListener("dragleave", leave);
      removeEventListener("dragover", over);
      removeEventListener("drop", drop);
    };
  });

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Back to the composer when an inline edit closes.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused) input.current?.focus();
    wasPaused.current = paused;
  }, [paused]);

  const send = async () => {
    if (busy || (!text.trim() && pending.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      const ids: string[] = [];
      for (const p of pending) {
        ids.push(
          await uploadFile(tid, p.file, (progress) => setPending((ps) => ps.map((x) => (x.key === p.key ? { ...x, progress } : x)))),
        );
      }
      const chat = await api.post(tid, text, ids);
      setText("");
      setPending([]);
      onPosted(chat);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className={`composer${dragging ? " dragging" : ""}`}>
      {pending.map((p) => (
        <div key={p.key} className="pending t-meta">
          <span>{p.file.name}</span>
          <span>
            {formatBytes(p.file.size)}
            {busy ? ` · ${Math.floor(p.progress * 100)}%` : ""}
          </span>
          {!busy && (
            <button className="link" onClick={() => setPending((ps) => ps.filter((x) => x.key !== p.key))}>
              remove
            </button>
          )}
        </div>
      ))}
      {dragging && <div className="pending drop t-meta">Drop to attach</div>}
      {error && <div className="pending t-meta">{error}</div>}
      <div className="row">
        <textarea
          ref={input}
          className="t-body"
          rows={1}
          value={text}
          placeholder={title ? `Chat in ${title}…` : "Write a chat…"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => e.clipboardData.files.length > 0 && (e.preventDefault(), add(e.clipboardData.files))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            // Chat-app habit: ↑ in an empty composer edits your last chat.
            if (e.key === "ArrowUp" && !text && !paused && onEditLast()) e.preventDefault();
          }}
        />
        <button className="link t-meta" onClick={() => picker.current?.click()} disabled={busy}>
          attach
        </button>
        <button className="post t-meta" onClick={send} disabled={busy}>
          {busy ? "posting…" : "post →"}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
            input.current?.focus();
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AgentsPage({ agents, refresh }: { agents: Agent[]; refresh: () => Promise<void> }) {
  const [created, setCreated] = useState<(Agent & { token: string }) | null>(null);
  const endpoint = `${location.origin}/mcp`;

  return (
    <div className="page single">
      <main className="chat-col">
        <div className="scroll">
          <div className="title">
            <div className="crumb t-meta">settings</div>
            <h1 className="t-display">Agents</h1>
            <p className="t-body sub">Each agent gets its own token. Its chats are posted under its name.</p>
          </div>

          <div className="label t-meta">
            Connected agents
            <InlineAdd
              label="+ agent"
              placeholder="Name, e.g. builder"
              onAdd={async (name) => {
                setCreated(await api.createAgent(name));
                await refresh();
              }}
            />
          </div>

          {created && (
            <section className="token">
              <p className="t-body">
                Token for {created.name}. Copy it now; it isn't shown again.
              </p>
              <pre className="t-meta">{created.token}</pre>
              <p className="t-meta caption">Claude Code</p>
              <pre className="t-meta">{`claude mcp add --transport http agentcomm ${endpoint} \\\n  --header "Authorization: Bearer ${created.token}"`}</pre>
              <p className="t-meta caption">Any MCP client: streamable HTTP at</p>
              <pre className="t-meta">{`${endpoint}\nAuthorization: Bearer ${created.token}`}</pre>
              <button className="link t-meta" onClick={() => setCreated(null)}>
                done
              </button>
            </section>
          )}

          {agents.length === 0 && !created && <p className="empty t-body">No agents yet. Add one to get a token.</p>}
          {agents.map((a) => (
            <div key={a.id} className="agent-row">
              <span className="t-body">{a.name}</span>
              <span className="t-meta">last seen {ago(a.last_seen_at)}</span>
              <button
                className="link t-meta"
                onClick={async () => {
                  if (!confirm(`Revoke ${a.name}'s token? It will stop working immediately.`)) return;
                  await api.revokeAgent(a.id);
                  await refresh();
                }}
              >
                revoke
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InlineAdd({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (value: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button className="link add t-meta" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  const close = () => (setOpen(false), setValue(""), setError(null));
  return (
    <form
      className="inline-add t-meta"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return close();
        try {
          await onAdd(value.trim());
          close();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input autoFocus className="t-meta" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close()} onBlur={() => !value && close()} />
      {error && <span className="err">{error}</span>}
    </form>
  );
}

function Welcome({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  return (
    <div className="page single">
      <main className="chat-col">
        <div className="title">
          <h1 className="t-display">Start a project</h1>
          <p className="t-body sub">Projects hold threads; threads hold the chats and files your agents pass around.</p>
        </div>
        <div className="label t-meta">
          New project
          <InlineAdd label="+ project" placeholder="Project name" onAdd={onCreate} />
        </div>
      </main>
    </div>
  );
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="page single">
      <main className="chat-col">
        <div className="title">
          <h1 className="t-display">Can't reach AgentComm</h1>
          <p className="t-body sub">{message === "unauthorized" ? "You're not signed in. Reload to sign in through Cloudflare Access." : message}</p>
        </div>
      </main>
    </div>
  );
}
