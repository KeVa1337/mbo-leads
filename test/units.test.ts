import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findDuplicate, normalize, similarity, wordSet } from "../src/dedupe.js";
import { decide, fresh, isPro, type Subscriber } from "../src/delivery.js";
import { leadText } from "../src/bot.js";
import { normalizeHandle, parseChannelPage } from "../src/telegram-source.js";
import { costOf } from "../src/classify.js";

test("channel handles are normalized from any common form", () => {
  assert.equal(normalizeHandle("@Freelance_UA"), "freelance_ua");
  assert.equal(normalizeHandle("https://t.me/s/freelance_ua?before=10"), "freelance_ua");
  assert.equal(normalizeHandle("t.me/freelance_ua/123"), "freelance_ua");
  assert.equal(normalizeHandle("telegram.me/freelance_ua"), "freelance_ua");
  assert.equal(normalizeHandle("bad name"), null);
  assert.equal(normalizeHandle("abc"), null); // too short for a username
});

test("a real t.me/s page is parsed into posts with text, link and date", () => {
  const html = readFileSync(new URL("./fixtures/channel.html", import.meta.url), "utf8");
  const page = parseChannelPage(html, "durov");
  assert.ok(page.posts.length >= 10, `expected posts, got ${page.posts.length}`);
  for (const p of page.posts) {
    assert.ok(Number.isInteger(p.extId) && p.extId > 0);
    assert.equal(p.url, `https://t.me/durov/${p.extId}`);
    assert.ok(p.text.length > 0);
    assert.ok(!Number.isNaN(p.postedAt.getTime()));
    assert.ok(!p.text.includes("<br"), "line breaks become newlines, not tags");
  }
  assert.ok(page.title);
});

test("posts without text and service messages are skipped", () => {
  const html = `<div class="tgme_channel_info"></div>
    <div class="tgme_widget_message" data-post="ch/5"><div class="tgme_widget_message_text">Шукаю дизайнера<br>для лендінгу</div><time datetime="2026-11-08T10:00:00+00:00"></time></div>
    <div class="tgme_widget_message" data-post="ch/6"><time datetime="2026-11-08T10:05:00+00:00"></time></div>`;
  const { posts } = parseChannelPage(html, "ch");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.text, "Шукаю дизайнера\nдля лендінгу");
});

test("the same order reposted with emoji, links and hashtags is a duplicate", () => {
  const a = "🔥 Шукаю розробника лендінгу для салону краси, бюджет 300$, терміни тиждень. Пишіть @anna";
  const b = "Шукаю розробника лендінгу для салону краси! Бюджет 300$, терміни — тиждень. #робота https://t.me/jobs";
  const c = "Потрібен монтажер відео для YouTube каналу про подорожі, оплата за ролик";
  assert.ok(similarity(wordSet(a), wordSet(b)) >= 0.75);
  assert.equal(findDuplicate(b, [{ id: 1, text: a }, { id: 2, text: c }]), 1);
  assert.equal(findDuplicate(c, [{ id: 1, text: a }]), null);
  assert.equal(normalize("Hello, @user! https://x.y #tag"), "hello");
});

const user = (over: Partial<Subscriber>): Subscriber => ({
  tg_id: 1, categories: ["web"], plan: "free", pro_until: null, paused: false, blocked: false, sent_today: 0, limit_notice_day: null, ...over,
});

test("free users get orders up to the daily limit and hear about the limit once a day", () => {
  const today = "2026-11-08";
  const users = [
    user({ tg_id: 1 }),
    user({ tg_id: 2, sent_today: 5 }),
    user({ tg_id: 3, sent_today: 5, limit_notice_day: today }),
    user({ tg_id: 4, sent_today: 50, plan: "pro" }),
    user({ tg_id: 5, categories: ["design"] }),
    user({ tg_id: 6, paused: true }),
    user({ tg_id: 7, sent_today: 9, plan: "pro", pro_until: new Date("2020-01-01") }),
  ];
  const d = decide("web", users, 5, today);
  assert.deepEqual(d.send, [1, 4]);
  assert.deepEqual(d.limitReached, [2, 7]);
});

test("Pro expires on its date", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  assert.ok(isPro({ plan: "pro", pro_until: new Date("2026-11-09") }, now));
  assert.ok(!isPro({ plan: "pro", pro_until: new Date("2026-11-07") }, now));
  assert.ok(isPro({ plan: "pro", pro_until: null }, now));
  assert.ok(!isPro({ plan: "free", pro_until: null }, now));
});

test("old posts are not sent", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  assert.ok(fresh(new Date("2026-11-08T09:00:00Z"), now));
  assert.ok(!fresh(new Date("2026-11-07T09:00:00Z"), now));
});

test("order card escapes HTML and shows budget, format and source", () => {
  const text = leadText({
    id: 1, source_id: 1, ext_id: "5", url: "https://t.me/ch/5", text: "", posted_at: new Date(), is_order: true, category: "web",
    title: "Лендінг <для> салону", summary: "Потрібен сайт & запис", budget: "$300", remote: true, duplicate_of: null, handle: "ch",
  });
  assert.ok(text.includes("<b>Лендінг &lt;для&gt; салону</b>"));
  assert.ok(text.includes("сайт &amp; запис"));
  assert.ok(text.includes("💰 $300") && text.includes("🌍 віддалено") && text.includes("@ch"));
});

test("cost is counted per model", () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(costOf("claude-opus-5-5", u), 24);
  assert.equal(costOf("claude-haiku-5-5", u), 0.6);
});
