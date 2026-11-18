CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_chat_at INTEGER NOT NULL
);
CREATE INDEX threads_by_project ON threads(project_id, last_chat_at DESC);

-- id doubles as the cursor agents use to ask for "chats after N".
CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX chats_by_thread ON chats(thread_id, id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  -- Capability secret in the file's upload and download URLs.
  access_key TEXT NOT NULL,
  -- R2 multipart upload id while a large file is uploading.
  upload_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX files_by_thread ON files(thread_id, created_at);
CREATE INDEX files_by_chat ON files(chat_id);

CREATE TABLE upload_parts (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (file_id, part_number)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- Last chat each reader (human email or agent name) has seen in a thread.
CREATE TABLE reads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  reader TEXT NOT NULL,
  last_chat_id INTEGER NOT NULL,
  PRIMARY KEY (thread_id, reader)
);
