import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { CATEGORIES, CATEGORY_IDS, isCategory } from "./categories.js";
import type { Config } from "./config.js";
import { isPro } from "./delivery.js";
import type { Outbox } from "./pipeline.js";
import type { PostRow, Store } from "./store.js";
import { fetchChannel, normalizeHandle, SourceError } from "./telegram-source.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function leadText(post: PostRow): string {
  const lines = [`<b>${esc(post.title ?? "Нове замовлення")}</b>`];
  if (post.summary) lines.push("", esc(post.summary));
  const meta: string[] = [];
  if (post.budget) meta.push(`💰 ${esc(post.budget)}`);
  if (post.remote === true) meta.push("🌍 віддалено");
  if (post.remote === false) meta.push("📍 на місці");
  if (post.category && isCategory(post.category)) meta.push(CATEGORIES[post.category]);
  if (meta.length) lines.push("", meta.join(" · "));
  lines.push("", `Джерело: @${esc(post.handle ?? "")}`);
  return lines.join("\n");
}

function leadKeyboard(post: PostRow): InlineKeyboard {
  return new InlineKeyboard()
    .url("Відкрити оголошення ↗", post.url)
    .row()
    .text("👍 Підходить", `fb:good:${post.id}`)
    .text("👎 Не те", `fb:bad:${post.id}`)
    .text("🚩 Фейк", `fb:fake:${post.id}`);
}

function categoryKeyboard(selected: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  CATEGORY_IDS.forEach((id, i) => {
    kb.text(`${selected.includes(id) ? "✅ " : ""}${CATEGORIES[id]}`, `cat:${id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text("Готово", "cat:done");
}

const isBlockedError = (err: unknown) => err instanceof GrammyError && (err.error_code === 403 || /chat not found/i.test(err.description));

export function createBot(config: Config, store: Store) {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const isAdmin = (ctx: Context) => ctx.from?.id === config.ADMIN_TELEGRAM_ID;

  const welcome = (limit: number) =>
    [
      "Привіт! Я ловлю нові замовлення для фрилансерів у Telegram-каналах і надсилаю їх вам, щойно вони з'являються.",
      "",
      "• без затримок: замовлення приходить за кілька хвилин після публікації;",
      "• без сміття: реклама, курси й дублікати відсіюються;",
      `• безкоштовно ${limit} замовлень на день.`,
      "",
      "Оберіть, що вам цікаво:",
    ].join("\n");

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    await store.upsertUser(ctx.from.id, ctx.from.username ?? null, ctx.from.first_name ?? null);
    const user = await store.getUser(ctx.from.id);
    await ctx.reply(welcome(config.FREE_DAILY_LIMIT), { reply_markup: categoryKeyboard(user?.categories ?? []) });
  });

  bot.command("categories", async (ctx) => {
    if (!ctx.from) return;
    await store.upsertUser(ctx.from.id, ctx.from.username ?? null, ctx.from.first_name ?? null);
    const user = await store.getUser(ctx.from.id);
    await ctx.reply("Ваші категорії:", { reply_markup: categoryKeyboard(user?.categories ?? []) });
  });

  bot.command("pause", async (ctx) => {
    if (!ctx.from) return;
    await store.setPaused(ctx.from.id, true);
    await ctx.reply("⏸ Розсилку призупинено. Щоб увімкнути знову: /resume");
  });

  bot.command("resume", async (ctx) => {
    if (!ctx.from) return;
    await store.setPaused(ctx.from.id, false);
    await ctx.reply("▶️ Розсилку увімкнено.");
  });

  bot.command("plan", async (ctx) => {
    if (!ctx.from) return;
    const user = await store.getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("Спершу натисніть /start"));
    const pro = isPro(user);
    await ctx.reply(
      pro
        ? `⭐ У вас Pro: замовлення без ліміту${user.pro_until ? ` до ${user.pro_until.toLocaleDateString("uk-UA")}` : ""}.`
        : `Безкоштовний тариф: ${config.FREE_DAILY_LIMIT} замовлень на день (сьогодні вже ${user.sent_today}).\n\nPro без ліміту скоро з'явиться.${config.SUPPORT_CONTACT ? ` Питання: ${config.SUPPORT_CONTACT}` : ""}`,
    );
  });

  bot.command("help", (ctx) =>
    ctx.reply("/categories — що надсилати\n/pause — призупинити розсилку\n/resume — увімкнути знову\n/plan — ваш тариф і ліміт"),
  );

  bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    if (id === "done") {
      const user = await store.getUser(ctx.from.id);
      const chosen = (user?.categories ?? []).filter(isCategory).map((c) => CATEGORIES[c]);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        chosen.length ? `Готово! Надсилатиму замовлення з категорій:\n${chosen.join("\n")}\n\nЗмінити: /categories` : "Ви не обрали жодної категорії. Відкрийте /categories, щоб обрати.",
      );
      return;
    }
    if (!isCategory(id)) return void (await ctx.answerCallbackQuery());
    await store.upsertUser(ctx.from.id, ctx.from.username ?? null, ctx.from.first_name ?? null);
    const categories = await store.toggleCategory(ctx.from.id, id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: categoryKeyboard(categories) }).catch(() => {});
  });

  bot.callbackQuery(/^fb:(good|bad|fake):(\d+)$/, async (ctx) => {
    const [, kind, id] = ctx.match;
    await store.saveFeedback(ctx.from.id, Number(id), kind!);
    await ctx.answerCallbackQuery({ text: kind === "good" ? "Дякую! Надсилатиму більше такого." : "Дякую, врахую." });
  });

  // ---- admin
  bot.command("addsource", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const handle = normalizeHandle(ctx.match ?? "");
    if (!handle) return void (await ctx.reply("Формат: /addsource @назва_каналу або посилання t.me/назва"));
    try {
      const page = await fetchChannel(handle);
      const source = await store.addSource(handle, page.title);
      // the backlog is stored so it is never sent; only posts after this moment reach subscribers
      await store.savePosts(source, page.posts);
      await ctx.reply(`✅ Додано @${handle}${page.title ? ` (${page.title})` : ""}. Постів на сторінці: ${page.posts.length}. Нові замовлення звідти підуть підписникам.`);
    } catch (err) {
      await ctx.reply(`Не вдалося додати @${handle}: ${err instanceof SourceError ? err.message : String(err)}`);
    }
  });

  bot.command("delsource", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const handle = normalizeHandle(ctx.match ?? "");
    if (!handle) return void (await ctx.reply("Формат: /delsource @назва_каналу"));
    await ctx.reply((await store.removeSource(handle)) ? `Канал @${handle} вимкнено.` : `Каналу @${handle} немає серед активних.`);
  });

  bot.command("sources", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sources = await store.listSources();
    if (sources.length === 0) return void (await ctx.reply("Джерел ще немає. Додайте: /addsource @канал"));
    const counts = await store.sourceOrderCounts();
    const lines = sources.map((s) => {
      const c = counts.get(s.id);
      const stat = c ? `${c.orders} замовл. з ${c.posts} постів за 7 дн.${c.good || c.bad ? `, 👍${c.good} 👎${c.bad}` : ""}` : "ще без постів";
      return `${s.error ? "⚠️" : "•"} @${s.handle} — ${stat}${s.error ? `\n   ${s.error}` : ""}`;
    });
    await ctx.reply(lines.join("\n"));
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [s, spend] = await Promise.all([store.stats(), store.spend()]);
    await ctx.reply(
      [
        `👥 Користувачів: ${s.users} (активних ${s.active}, Pro ${s.pro})`,
        `📥 За 24 год: ${s.posts24} постів → ${s.orders24} замовлень, ${s.dup24} дублікатів`,
        `📤 Надіслано за 24 год: ${s.sent24}`,
        `💸 Розбір: сьогодні $${spend.today.toFixed(2)}, за місяць $${spend.month.toFixed(2)} з $${config.MONTHLY_BUDGET_USD}`,
      ].join("\n"),
    );
  });

  // /pro <telegram id> <days> — grant Pro by hand until payments exist; 0 days takes it away
  bot.command("pro", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [id, days] = (ctx.match ?? "").split(/\s+/).map(Number);
    if (!id || days === undefined || Number.isNaN(days)) return void (await ctx.reply("Формат: /pro <telegram id> <днів>, 0 — забрати Pro"));
    const ok = days > 0 ? await store.setPlan(id, "pro", new Date(Date.now() + days * 86_400_000)) : await store.setPlan(id, "free", null);
    await ctx.reply(ok ? (days > 0 ? `⭐ Pro на ${days} дн. видано.` : "Pro знято.") : "Такого користувача немає (він має спершу натиснути /start).");
  });

  bot.catch((err) => console.error("bot error", err.error));

  const outbox: Outbox = {
    async lead(userId, post) {
      try {
        await bot.api.sendMessage(userId, leadText(post), { parse_mode: "HTML", reply_markup: leadKeyboard(post), link_preview_options: { is_disabled: true } });
        return true;
      } catch (err) {
        if (isBlockedError(err)) return false;
        throw err;
      }
    },
    async limitReached(userId, limit) {
      await bot.api
        .sendMessage(userId, `На сьогодні ліміт безкоштовних замовлень (${limit}) вичерпано. Нові прийдуть завтра.\n\nPro без ліміту скоро з'явиться — /plan`)
        .catch((err) => {
          if (!isBlockedError(err)) throw err;
        });
    },
    async admin(text) {
      await bot.api.sendMessage(config.ADMIN_TELEGRAM_ID, text).catch((err) => console.error("admin notify failed", err));
    },
  };

  return { bot, outbox };
}
