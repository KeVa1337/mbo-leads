import { createHash } from "node:crypto";
import { BATCH, type Classifier } from "./classify.js";
import { findDuplicate } from "./dedupe.js";
import { decide, fresh } from "./delivery.js";
import { localDay, type PostRow, type Store } from "./store.js";
import { obviouslyNotOrder } from "./rss-source.js";
import { feedName, fetchSource, sourceLabel } from "./sources.js";
import { SourceError } from "./telegram-source.js";
import { refreshThreadsToken as refreshToken } from "./threads-source.js";

export type Outbox = {
  /** Sends an order card; resolves false when the user has blocked the bot */
  lead(userId: number, post: PostRow): Promise<boolean>;
  limitReached(userId: number, limit: number): Promise<void>;
  admin(text: string): Promise<void>;
};

type Opts = {
  store: Store; classify: Classifier; out: Outbox; tz: string; freeLimit: number; monthlyBudget: number;
  threads?: { envToken?: string | null; intervalMin: number };
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Collected posts are kept this long (stated in the privacy policy) */
export const RETENTION_DAYS = 30;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPipeline({ store, classify, out, tz, freeLimit, monthlyBudget, threads }: Opts) {
  /** The Threads token in use: the last refreshed one, else the one from the environment */
  async function threadsToken(): Promise<string | null> {
    const env = threads?.envToken ?? null;
    // a new token put into the environment replaces the refreshed copy kept in the database
    const envMark = env ? createHash("sha256").update(env).digest("hex").slice(0, 16) : "";
    if ((await store.getKv("threads_env")) !== envMark) {
      await store.setKv("threads_env", envMark);
      await store.setKv("threads_token", env ?? "");
      await store.setKv("threads_refreshed_at", String(Date.now()));
    }
    return (await store.getKv("threads_token")) || null;
  }

  /** Long-lived Threads tokens expire after 60 days unless refreshed; refresh once a week */
  async function refreshThreadsToken(): Promise<void> {
    const token = await threadsToken();
    if (!token) return;
    const last = Number(await store.getKv("threads_refreshed_at"));
    if (last && Date.now() - last < WEEK_MS) return;
    try {
      const fresh = await refreshToken(token);
      await store.setKv("threads_token", fresh.token);
      await store.setKv("threads_refreshed_at", String(Date.now()));
    } catch (err) {
      await store.setKv("threads_refreshed_at", String(Date.now() - WEEK_MS + 86_400_000)); // try again tomorrow
      await out.admin(`⚠️ Не вдалося оновити токен Threads: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function fetchAll(): Promise<number> {
    let saved = 0;
    const token = await threadsToken();
    for (const source of await store.listSources()) {
      // each Threads query is one call against a daily API limit, so it is searched less often
      if (source.kind === "threads" && source.checked_at && Date.now() - source.checked_at.getTime() < (threads?.intervalMin ?? 15) * 60_000) continue;
      try {
        const page = await fetchSource(source, { threadsToken: token });
        // the first read of a source only records what is already there
        saved += await store.savePosts(source, page.posts, { backlog: source.checked_at === null, skip: obviouslyNotOrder });
        if (source.error) await out.admin(`✅ Джерело ${sourceLabel(source)} знову читається.`);
        await store.markChecked(source.id, null, source.url ? feedName(source.url, page.title) : page.title);
      } catch (err) {
        if (err instanceof SourceError && err.transient) {
          console.warn(`${sourceLabel(source)}: ${err.message}, next round`);
          continue;
        }
        const reason = err instanceof SourceError ? err.message : err instanceof Error ? err.message : String(err);
        if (source.error !== reason) await out.admin(`⚠️ Не вдається прочитати ${sourceLabel(source)}: ${reason}`);
        await store.markChecked(source.id, reason);
      }
      await pause(1500); // be gentle with t.me
    }
    return saved;
  }

  async function classifyPending(): Promise<{ posts: number; orders: number }> {
    let posts = 0;
    let orders = 0;
    const recent = await store.recentOrders();
    for (;;) {
      const batch = await store.unclassified(BATCH);
      if (batch.length === 0) break;
      const spend = await store.spend();
      if (spend.month >= monthlyBudget) {
        await budgetWarning(spend.month);
        break;
      }
      const { results, usage } = await classify(batch.map((p) => p.text));
      await store.logUsage(usage);
      for (const [i, post] of batch.entries()) {
        const c = results.get(i);
        if (!c?.is_order) {
          await store.saveClassification(post.id, { is_order: false, category: null, title: null, summary: null, budget: null, remote: null, market: null, duplicate_of: null });
          continue;
        }
        const duplicate = findDuplicate(post.text, recent);
        await store.saveClassification(post.id, {
          is_order: true,
          category: c.category,
          title: c.title.slice(0, 120) || null,
          summary: c.summary.slice(0, 400) || null,
          budget: c.budget,
          remote: c.remote,
          market: c.market,
          duplicate_of: duplicate,
        });
        if (duplicate === null && c.market !== "ru_by") {
          recent.unshift({ id: post.id, text: post.text });
          orders++;
        }
      }
      posts += batch.length;
    }
    return { posts, orders };
  }

  let budgetWarnedDay: string | null = null;
  async function budgetWarning(month: number): Promise<void> {
    const day = localDay(tz);
    if (budgetWarnedDay === day) return;
    budgetWarnedDay = day;
    await out.admin(`💸 Витрати на розбір постів цього місяця — $${month.toFixed(2)}, бюджет $${monthlyBudget} вичерпано. Нові пости не розбираються, доки ви не збільшите MONTHLY_BUDGET_USD.`);
  }

  async function deliver(): Promise<number> {
    let sent = 0;
    const today = localDay(tz);
    for (const post of await store.undeliveredOrders()) {
      if (!post.category || !fresh(post.posted_at)) {
        await store.markDelivered(post.id);
        continue;
      }
      const { send, limitReached } = decide(post.category, await store.subscribers(post.category), freeLimit, today);
      for (const userId of send) {
        // recorded first: a crash mid-send must not send the same order twice
        if (!(await store.recordDelivery(userId, post.id))) continue;
        try {
          if (await out.lead(userId, post)) sent++;
          else await store.setBlocked(userId);
        } catch (err) {
          console.error("send failed", userId, post.id, err);
        }
        await pause(40); // Telegram allows about 30 messages a second
      }
      for (const userId of limitReached) {
        await store.setLimitNotice(userId, today);
        await out.limitReached(userId, freeLimit).catch((err) => console.error("limit note failed", err));
      }
      await store.markDelivered(post.id);
    }
    return sent;
  }

  return {
    fetchAll,
    classifyPending,
    deliver,
    refreshThreadsToken,
    async run(): Promise<void> {
      const day = localDay(tz);
      if ((await store.getKv("purge_day")) !== day) {
        await store.setKv("purge_day", day);
        const gone = await store.purgePosts(RETENTION_DAYS);
        if (gone) console.log(`retention: ${gone} posts older than ${RETENTION_DAYS} days deleted`);
      }
      await refreshThreadsToken();
      const saved = await fetchAll();
      const c = await classifyPending();
      const sent = await deliver();
      if (saved || c.posts || sent) console.log(`round: ${saved} new posts, ${c.posts} sorted, ${c.orders} orders, ${sent} sent`);
    },
  };
}
