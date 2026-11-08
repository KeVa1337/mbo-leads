import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { Classification, Classifier } from "../src/classify.js";
import { createDb, migrate, type Db } from "../src/db.js";
import { createPipeline, type Outbox } from "../src/pipeline.js";
import { createStore, type PostRow } from "../src/store.js";

// Runs against a real Postgres: TEST_DATABASE_URL, e.g. postgres://leads:leads@localhost/leads_test. Skipped without it.
const url = process.env.TEST_DATABASE_URL;
let db: Db;

before(async () => {
  if (!url) return;
  db = createDb(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  await migrate(db); // must be idempotent
});
after(async () => db?.end());

// Pretends to be Claude: posts that start with "ORDER" are orders in the category named after it
const fakeClassifier: Classifier = async (texts) => {
  const results = new Map<number, Classification>();
  texts.forEach((t, i) => {
    const m = /^ORDER (\w+): (.*)$/s.exec(t);
    results.set(i, m
      ? { i, is_order: true, category: m[1]!, title: m[2]!.slice(0, 40), summary: m[2]!, budget: "$100", remote: true, market: t.includes("₽") ? "ru_by" : "ua" }
      : { i, is_order: false, category: "other", title: "", summary: "", budget: null, remote: null, market: "unknown" });
  });
  return { results, usage: { model: "fake", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 } };
};

test("posts go from a channel to the right subscribers once, within limits", { skip: !url }, async () => {
  const store = createStore(db, "Europe/Kyiv");
  const sent: { user: number; post: PostRow }[] = [];
  const limits: number[] = [];
  const blockedUser = 30;
  const out: Outbox = {
    async lead(user, post) {
      if (user === blockedUser) return false;
      sent.push({ user, post });
      return true;
    },
    async limitReached(user) {
      limits.push(user);
    },
    async admin() {},
  };
  const pipeline = createPipeline({ store, classify: fakeClassifier, out, tz: "Europe/Kyiv", freeLimit: 2, monthlyBudget: 30 });

  const src = await store.addSource({ kind: "telegram", handle: "freelance_test", url: null }, "Test");
  for (const [id, cats] of [[10, ["web"]], [20, ["design"]], [blockedUser, ["web"]], [40, ["web"]]] as const) {
    await store.upsertUser(id, null, null);
    for (const c of cats) await store.toggleCategory(id, c);
  }
  await store.setPlan(40, "pro", null);

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  const posts = [
    { extId: 1, text: "ORDER web: Потрібен лендінг для автосервісу з формою запису, бюджет обговорюється", postedAt: at(30) },
    { extId: 2, text: "Курс з дизайну зі знижкою 50%, встигніть!", postedAt: at(25) },
    { extId: 3, text: "ORDER web: 🔥 Потрібен лендінг для автосервісу з формою запису! Бюджет обговорюється #job", postedAt: at(20) },
    { extId: 4, text: "ORDER design: Шукаю дизайнера логотипу для кав'ярні в Києві", postedAt: at(15) },
    { extId: 5, text: "ORDER web: Інтернет-магазин одягу на WooCommerce, 20 товарів", postedAt: at(10) },
    { extId: 6, text: "ORDER web: Telegram Mini App для доставки їжі з оплатою", postedAt: at(5) },
    { extId: 7, text: "ORDER web: Старе замовлення на сайт візитку для юриста", postedAt: at(60 * 30) },
    { extId: 8, text: "ORDER web: Нужен лендинг для студии в Москве, оплата 15 000 ₽", postedAt: at(3) },
  ].map((p) => ({ ...p, url: `https://t.me/freelance_test/${p.extId}` }));
  assert.equal(await store.savePosts(src, posts), 8);
  // the same page fetched again adds nothing
  assert.equal(await store.savePosts((await store.listSources())[0]!, posts), 0);

  const c = await pipeline.classifyPending();
  assert.equal(c.posts, 8);
  assert.equal(c.orders, 5, "1 ad, 1 duplicate and 1 order from Russia are not new orders");

  await pipeline.deliver();
  const byUser = (u: number) => sent.filter((s) => s.user === u).map((s) => Number(s.post.ext_id));
  assert.deepEqual(byUser(10), [1, 5], "free web user: first two fresh web orders, then the limit");
  assert.deepEqual(byUser(20), [4]);
  assert.deepEqual(byUser(40), [1, 5, 6], "Pro gets every fresh web order");
  assert.ok(!sent.some((s) => Number(s.post.ext_id) === 7), "a 30-hour-old order is not sent");
  assert.ok(!sent.some((s) => Number(s.post.ext_id) === 8), "an order from Russia is never sent, even to Pro");
  assert.deepEqual(limits, [10], "the limit note goes out once");
  assert.equal((await store.getUser(blockedUser))?.blocked, true, "a user who blocked the bot is marked");

  // a second round sends nothing new
  const before = sent.length;
  await pipeline.deliver();
  assert.equal(sent.length, before);

  const stats = await store.stats();
  assert.equal(stats.orders24, 5);
  assert.equal(stats.dup24, 1);
  assert.equal(stats.blocked24, 1);
  assert.ok((await store.spend()).today > 0);
});

test("a feed is read by item id, its backlog is never sent, and [For Hire] ads skip the model", { skip: !url }, async () => {
  const store = createStore(db, "Europe/Kyiv");
  const sent: number[] = [];
  const out: Outbox = { async lead(u, post) { if (u === 50) sent.push(post.id); return true; }, async limitReached() {}, async admin() {} };
  let modelCalls = 0;
  const counting: Classifier = async (texts) => { modelCalls += texts.length; return fakeClassifier(texts); };
  const pipeline = createPipeline({ store, classify: counting, out, tz: "Europe/Kyiv", freeLimit: 100, monthlyBudget: 30 });
  await store.upsertUser(50, null, null);
  await store.toggleCategory(50, "design");

  const feed = await store.addSource({ kind: "rss", handle: "example.com/feed", url: "https://example.com/feed" }, "Example");
  const now = Date.now();
  const item = (id: number, text: string) => ({ extId: id, url: `https://example.com/p/${id}`, text, postedAt: new Date(now - 60_000) });
  // first read: everything is backlog
  assert.equal(await store.savePosts(feed, [item(900, "ORDER design: Логотип для пекарні")], { backlog: true }), 1);
  // later read: the same item again plus two new ones, in any id order
  const fresh = [item(900, "ORDER design: Логотип для пекарні"), item(5, "ORDER design: Банери для Instagram магазину взуття"), item(7, "[For Hire] I design logos")];
  assert.equal(await store.savePosts(feed, fresh, { skip: (t) => t.startsWith("[For Hire]") }), 2);

  await pipeline.classifyPending();
  assert.equal(modelCalls, 2, "the backlog item and the new order go to the model, the ad does not");
  await pipeline.deliver();
  const got = await Promise.all(sent.map((id) => store.getPost(id)));
  assert.deepEqual(got.map((p) => p?.text), ["ORDER design: Банери для Instagram магазину взуття"]);
  assert.equal(got[0]?.source_title, "Example");
});
