import pg from "pg";

export type Db = pg.Pool;

export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

// Idempotent: safe to run on every start
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'telegram',
  handle        TEXT NOT NULL UNIQUE,            -- channel username without @
  title         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  last_ext_id   BIGINT NOT NULL DEFAULT 0,       -- newest post already stored
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at    TIMESTAMPTZ,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id            SERIAL PRIMARY KEY,
  source_id     INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ext_id        BIGINT NOT NULL,
  url           TEXT NOT NULL,
  text          TEXT NOT NULL,
  posted_at     TIMESTAMPTZ NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  classified_at TIMESTAMPTZ,
  is_order      BOOLEAN,
  category      TEXT,
  title         TEXT,
  summary       TEXT,
  budget        TEXT,
  remote        BOOLEAN,
  duplicate_of  INT REFERENCES posts(id) ON DELETE SET NULL,
  delivered_at  TIMESTAMPTZ,                     -- fan-out finished for this order
  UNIQUE (source_id, ext_id)
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS market TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS url TEXT;     -- feed address; null for Telegram channels   -- ua | intl | ru_by | unknown
CREATE INDEX IF NOT EXISTS posts_pending ON posts (id) WHERE classified_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_orders ON posts (posted_at) WHERE is_order;

CREATE TABLE IF NOT EXISTS users (
  tg_id             BIGINT PRIMARY KEY,
  username          TEXT,
  first_name        TEXT,
  categories        TEXT[] NOT NULL DEFAULT '{}',
  plan              TEXT NOT NULL DEFAULT 'free',  -- free | pro
  pro_until         TIMESTAMPTZ,
  paused            BOOLEAN NOT NULL DEFAULT false,
  blocked           BOOLEAN NOT NULL DEFAULT false, -- user blocked the bot
  limit_notice_day  TEXT,                          -- local day the "limit reached" note went out
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  user_id   BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  post_id   INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS deliveries_by_day ON deliveries (user_id, sent_at);

CREATE TABLE IF NOT EXISTS feedback (
  user_id     BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  post_id     INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- good | bad | fake
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS api_usage (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  model       TEXT NOT NULL,
  input       INT NOT NULL,
  output      INT NOT NULL,
  cache_read  INT NOT NULL,
  cache_write INT NOT NULL,
  cost_usd    NUMERIC(10, 5) NOT NULL
);
`;

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA);
}
