import type { Db } from "./db.js";
import type { Subscriber } from "./delivery.js";
import type { Usage } from "./classify.js";

export type SourceRow = { id: number; kind: string; handle: string; url: string | null; title: string | null; active: boolean; last_ext_id: string; checked_at: Date | null; error: string | null };
export type PostRow = {
  id: number; source_id: number; ext_id: string; url: string; text: string; posted_at: Date;
  is_order: boolean | null; category: string | null; title: string | null; summary: string | null;
  budget: string | null; remote: boolean | null; market?: string | null; duplicate_of: number | null; handle?: string; kind?: string; source_title?: string | null;
};

export function localDay(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function createStore(db: Db, tz: string) {
  return {
    // ---- sources
    async addSource(ref: { kind: string; handle: string; url: string | null }, title: string | null = null): Promise<SourceRow> {
      const { rows } = await db.query(
        `INSERT INTO sources (kind, handle, url, title) VALUES ($1, $2, $3, $4)
         ON CONFLICT (handle) DO UPDATE SET active = true, url = EXCLUDED.url, title = COALESCE(EXCLUDED.title, sources.title)
         RETURNING *`,
        [ref.kind, ref.handle, ref.url, title],
      );
      return rows[0];
    },
    async removeSource(handle: string): Promise<boolean> {
      const { rowCount } = await db.query("UPDATE sources SET active = false WHERE handle = $1 AND active", [handle]);
      return (rowCount ?? 0) > 0;
    },
    async listSources(activeOnly = true): Promise<SourceRow[]> {
      const { rows } = await db.query(`SELECT * FROM sources ${activeOnly ? "WHERE active" : ""} ORDER BY handle`);
      return rows;
    },
    async markChecked(id: number, error: string | null, title?: string | null): Promise<void> {
      await db.query("UPDATE sources SET checked_at = now(), error = $2, title = COALESCE($3, title) WHERE id = $1", [id, error, title ?? null]);
    },
    async sourceOrderCounts(): Promise<Map<number, { orders: number; ru_by: number; posts: number; good: number; bad: number }>> {
      const { rows } = await db.query(
        `SELECT p.source_id, count(*)::int AS posts, count(*) FILTER (WHERE p.is_order AND p.duplicate_of IS NULL AND p.market IS DISTINCT FROM 'ru_by')::int AS orders,
                count(*) FILTER (WHERE p.is_order AND p.market = 'ru_by')::int AS ru_by,
                count(f.*) FILTER (WHERE f.kind = 'good')::int AS good, count(f.*) FILTER (WHERE f.kind IN ('bad','fake'))::int AS bad
         FROM posts p LEFT JOIN feedback f ON f.post_id = p.id
         WHERE p.fetched_at > now() - interval '7 days' GROUP BY p.source_id`,
      );
      return new Map(rows.map((r) => [r.source_id, r]));
    },

    // ---- posts
    /**
     * Stores posts the source has not given before; returns how many were new.
     * Telegram ids grow, so older ones are skipped by number; feed items are matched by their id.
     * backlog: what a source already had when it was added is kept for stats but never sent.
     * skip: posts known not to be orders are stored as sorted, without a model call.
     */
    async savePosts(source: SourceRow, posts: { extId: number; url: string; text: string; postedAt: Date }[], opts: { backlog?: boolean; skip?: (text: string) => boolean } = {}): Promise<number> {
      const last = Number(source.last_ext_id);
      const fresh = source.kind === "telegram" ? posts.filter((p) => p.extId > last) : posts;
      if (fresh.length === 0) return 0;
      let added = 0;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const p of fresh) {
          const skipped = opts.skip?.(p.text) ?? false;
          const { rowCount } = await client.query(
            `INSERT INTO posts (source_id, ext_id, url, text, posted_at, delivered_at, classified_at, is_order)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN false END)
             ON CONFLICT DO NOTHING`,
            [source.id, p.extId, p.url, p.text, p.postedAt, opts.backlog ?? false, skipped],
          );
          added += rowCount ?? 0;
        }
        if (source.kind === "telegram") await client.query("UPDATE sources SET last_ext_id = $2 WHERE id = $1", [source.id, Math.max(...fresh.map((p) => p.extId))]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return added;
    },
    async unclassified(limit: number): Promise<PostRow[]> {
      const { rows } = await db.query("SELECT * FROM posts WHERE classified_at IS NULL ORDER BY id LIMIT $1", [limit]);
      return rows;
    },
    async saveClassification(id: number, c: { is_order: boolean; category: string | null; title: string | null; summary: string | null; budget: string | null; remote: boolean | null; market: string | null; duplicate_of: number | null }): Promise<void> {
      await db.query(
        `UPDATE posts SET classified_at = now(), is_order = $2, category = $3, title = $4, summary = $5, budget = $6, remote = $7, duplicate_of = $8, market = $9 WHERE id = $1`,
        [id, c.is_order, c.category, c.title, c.summary, c.budget, c.remote, c.duplicate_of, c.market],
      );
    },
    async recentOrders(days = 7, limit = 1000): Promise<{ id: number; text: string }[]> {
      const { rows } = await db.query(
        `SELECT id, text FROM posts WHERE is_order AND duplicate_of IS NULL AND posted_at > now() - make_interval(days => $1) ORDER BY id DESC LIMIT $2`,
        [days, limit],
      );
      return rows;
    },
    async undeliveredOrders(): Promise<PostRow[]> {
      const { rows } = await db.query(
        `SELECT p.*, s.handle, s.kind, s.title AS source_title FROM posts p JOIN sources s ON s.id = p.source_id
         WHERE p.is_order AND p.duplicate_of IS NULL AND p.delivered_at IS NULL
           AND p.market IS DISTINCT FROM 'ru_by'   -- orders from Russia and Belarus are never sent
         ORDER BY p.posted_at`,
      );
      return rows;
    },
    async markDelivered(id: number): Promise<void> {
      await db.query("UPDATE posts SET delivered_at = now() WHERE id = $1", [id]);
    },
    async getPost(id: number): Promise<PostRow | null> {
      const { rows } = await db.query("SELECT p.*, s.handle, s.kind, s.title AS source_title FROM posts p JOIN sources s ON s.id = p.source_id WHERE p.id = $1", [id]);
      return rows[0] ?? null;
    },

    // ---- users
    async upsertUser(tgId: number, username: string | null, firstName: string | null): Promise<{ created: boolean }> {
      const { rows } = await db.query(
        `INSERT INTO users (tg_id, username, first_name) VALUES ($1, $2, $3)
         ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, blocked = false
         RETURNING (xmax = 0) AS created`,
        [tgId, username, firstName],
      );
      return { created: rows[0].created };
    },
    async getUser(tgId: number): Promise<(Subscriber & { username: string | null }) | null> {
      const { rows } = await db.query(`${SUBSCRIBERS} WHERE u.tg_id = $2`, [tz, tgId]);
      return rows[0] ? toSubscriber(rows[0]) : null;
    },
    async toggleCategory(tgId: number, category: string): Promise<string[]> {
      const { rows } = await db.query(
        `UPDATE users SET categories = CASE WHEN $2 = ANY(categories) THEN array_remove(categories, $2) ELSE array_append(categories, $2) END
         WHERE tg_id = $1 RETURNING categories`,
        [tgId, category],
      );
      return rows[0]?.categories ?? [];
    },
    /** Removes a user with their settings, delivery history and ratings */
    async deleteUser(tgId: number): Promise<boolean> {
      const { rowCount } = await db.query("DELETE FROM users WHERE tg_id = $1", [tgId]);
      return (rowCount ?? 0) > 0;
    },
    /** Posts older than the retention period go, with their deliveries and ratings */
    async purgePosts(days: number): Promise<number> {
      const { rowCount } = await db.query("DELETE FROM posts WHERE fetched_at < now() - make_interval(days => $1)", [days]);
      return rowCount ?? 0;
    },
    /** An author asked to remove their post */
    async deletePostByUrl(url: string): Promise<number> {
      const { rowCount } = await db.query("DELETE FROM posts WHERE url = $1 OR url = $2", [url, url.replace(/\/$/, "")]);
      return rowCount ?? 0;
    },
    async setPaused(tgId: number, paused: boolean): Promise<void> {
      await db.query("UPDATE users SET paused = $2 WHERE tg_id = $1", [tgId, paused]);
    },
    async setBlocked(tgId: number): Promise<void> {
      await db.query("UPDATE users SET blocked = true WHERE tg_id = $1", [tgId]);
    },
    async setLimitNotice(tgId: number, day: string): Promise<void> {
      await db.query("UPDATE users SET limit_notice_day = $2 WHERE tg_id = $1", [tgId, day]);
    },
    async setPlan(tgId: number, plan: "free" | "pro", until: Date | null): Promise<boolean> {
      const { rowCount } = await db.query("UPDATE users SET plan = $2, pro_until = $3 WHERE tg_id = $1", [tgId, plan, until]);
      return (rowCount ?? 0) > 0;
    },
    async subscribers(category: string): Promise<Subscriber[]> {
      const { rows } = await db.query(`${SUBSCRIBERS} WHERE $2 = ANY(u.categories) AND NOT u.paused AND NOT u.blocked`, [tz, category]);
      return rows.map(toSubscriber);
    },
    async recordDelivery(userId: number, postId: number): Promise<boolean> {
      const { rowCount } = await db.query("INSERT INTO deliveries (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, postId]);
      return (rowCount ?? 0) > 0;
    },
    async saveFeedback(userId: number, postId: number, kind: string): Promise<void> {
      await db.query(
        "INSERT INTO feedback (user_id, post_id, kind) VALUES ($1, $2, $3) ON CONFLICT (user_id, post_id) DO UPDATE SET kind = EXCLUDED.kind, created_at = now()",
        [userId, postId, kind],
      );
    },

    // ---- small state
    async getKv(key: string): Promise<string | null> {
      const { rows } = await db.query("SELECT value FROM kv WHERE key = $1", [key]);
      return rows[0]?.value ?? null;
    },
    async setKv(key: string, value: string): Promise<void> {
      await db.query("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
    },

    // ---- money and stats
    async logUsage(u: Usage): Promise<void> {
      await db.query(
        "INSERT INTO api_usage (model, input, output, cache_read, cache_write, cost_usd) VALUES ($1, $2, $3, $4, $5, $6)",
        [u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost],
      );
    },
    async spend(): Promise<{ today: number; month: number }> {
      const { rows } = await db.query(
        `SELECT COALESCE(sum(cost_usd) FILTER (WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0)::float AS today,
                COALESCE(sum(cost_usd) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1)), 0)::float AS month
         FROM api_usage`,
        [tz],
      );
      return rows[0];
    },
    async stats(): Promise<{ users: number; active: number; pro: number; posts24: number; orders24: number; dup24: number; blocked24: number; sent24: number }> {
      const { rows } = await db.query(
        `SELECT (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM users WHERE NOT blocked AND NOT paused AND cardinality(categories) > 0)::int AS active,
                (SELECT count(*) FROM users WHERE plan = 'pro' AND (pro_until IS NULL OR pro_until > now()))::int AS pro,
                (SELECT count(*) FROM posts WHERE fetched_at > now() - interval '24 hours')::int AS posts24,
                (SELECT count(*) FROM posts WHERE is_order AND duplicate_of IS NULL AND market IS DISTINCT FROM 'ru_by' AND fetched_at > now() - interval '24 hours')::int AS orders24,
                (SELECT count(*) FROM posts WHERE is_order AND market = 'ru_by' AND fetched_at > now() - interval '24 hours')::int AS blocked24,
                (SELECT count(*) FROM posts WHERE duplicate_of IS NOT NULL AND fetched_at > now() - interval '24 hours')::int AS dup24,
                (SELECT count(*) FROM deliveries WHERE sent_at > now() - interval '24 hours')::int AS sent24`,
      );
      return rows[0];
    },
  };
}

// $1 = time zone; counts what each user got today, local time
const SUBSCRIBERS = `
  SELECT u.*, (SELECT count(*) FROM deliveries d WHERE d.user_id = u.tg_id
                AND (d.sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)::int AS sent_today
  FROM users u`;

function toSubscriber(r: Record<string, unknown>): Subscriber & { username: string | null } {
  return {
    tg_id: Number(r.tg_id),
    username: (r.username as string | null) ?? null,
    categories: (r.categories as string[]) ?? [],
    plan: r.plan as string,
    pro_until: (r.pro_until as Date | null) ?? null,
    paused: Boolean(r.paused),
    blocked: Boolean(r.blocked),
    sent_today: Number(r.sent_today ?? 0),
    limit_notice_day: (r.limit_notice_day as string | null) ?? null,
  };
}

export type Store = ReturnType<typeof createStore>;
