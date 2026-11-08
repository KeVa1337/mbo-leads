import { BATCH, type Classifier } from "./classify.js";
import { findDuplicate } from "./dedupe.js";
import { decide, fresh } from "./delivery.js";
import { localDay, type PostRow, type Store } from "./store.js";
import { fetchChannel, SourceError } from "./telegram-source.js";

export type Outbox = {
  /** Sends an order card; resolves false when the user has blocked the bot */
  lead(userId: number, post: PostRow): Promise<boolean>;
  limitReached(userId: number, limit: number): Promise<void>;
  admin(text: string): Promise<void>;
};

type Opts = { store: Store; classify: Classifier; out: Outbox; tz: string; freeLimit: number; monthlyBudget: number };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPipeline({ store, classify, out, tz, freeLimit, monthlyBudget }: Opts) {
  async function fetchAll(): Promise<number> {
    let saved = 0;
    for (const source of await store.listSources()) {
      try {
        const page = await fetchChannel(source.handle);
        saved += await store.savePosts(source, page.posts);
        if (source.error) await out.admin(`✅ Канал @${source.handle} знову читається.`);
        await store.markChecked(source.id, null, page.title);
      } catch (err) {
        const reason = err instanceof SourceError ? err.message : err instanceof Error ? err.message : String(err);
        if (source.error !== reason) await out.admin(`⚠️ Не вдається прочитати @${source.handle}: ${reason}`);
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
          await store.saveClassification(post.id, { is_order: false, category: null, title: null, summary: null, budget: null, remote: null, duplicate_of: null });
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
          duplicate_of: duplicate,
        });
        if (duplicate === null) {
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
    async run(): Promise<void> {
      const saved = await fetchAll();
      const c = await classifyPending();
      const sent = await deliver();
      if (saved || c.posts || sent) console.log(`round: ${saved} new posts, ${c.posts} sorted, ${c.orders} orders, ${sent} sent`);
    },
  };
}
