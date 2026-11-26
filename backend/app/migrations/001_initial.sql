-- Initial SQLite schema for colab-canvas (v0.1)

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    daily_quota INTEGER NOT NULL DEFAULT 50,
    max_queued INTEGER NOT NULL DEFAULT 2,
    allowed_gpus TEXT NOT NULL DEFAULT '["L4"]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS colab_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    email TEXT NOT NULL,
    cred_encrypted TEXT NOT NULL,
    home_dir TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    min_balance_cu REAL NOT NULL DEFAULT 5.0,
    unsupported_gpus TEXT NOT NULL DEFAULT '[]',
    last_balance_cu REAL,
    last_rate_hr REAL,
    last_assignments INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES colab_accounts(id),
    endpoint TEXT NOT NULL UNIQUE,
    session_name TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('managed', 'external')),
    gpu_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('assigning', 'bootstrapping', 'ready', 'stopping', 'stopped', 'error')
    ),
    comfy_port INTEGER,
    watchdog_port INTEGER,
    cached_files TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT,
    last_activity_at TEXT,
    stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    worker_id TEXT REFERENCES workers(id),
    workflow_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    params_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'booting', 'running', 'completed', 'failed', 'cancelled')
    ),
    comfy_prompt_id TEXT,
    progress REAL NOT NULL DEFAULT 0.0,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    outbox_path TEXT,
    upload_state TEXT NOT NULL CHECK (upload_state IN ('pending', 'uploaded', 'failed')),
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    upload_error TEXT,
    storage_backend TEXT NOT NULL,
    storage_key TEXT,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    meta_json TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('hf', 'civitai')),
    source_url TEXT NOT NULL,
    filename TEXT NOT NULL UNIQUE,
    sha256 TEXT,
    size_bytes INTEGER,
    default_weight REAL NOT NULL DEFAULT 0.8,
    trigger_words TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_user_created ON images(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_upload_state ON images(upload_state, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_workers_origin_status ON workers(origin, status);
