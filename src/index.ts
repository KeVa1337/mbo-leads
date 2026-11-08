import { createServer } from "node:http";
import { GrammyError, type Bot } from "grammy";
import { createBot } from "./bot.js";
import { createClassifier } from "./classify.js";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db.js";
import { createPipeline } from "./pipeline.js";
import { createStore } from "./store.js";
import { resolveSource } from "./sources.js";

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  await migrate(db);
  const store = createStore(db, config.TIMEZONE);

  if ((await store.listSources(false)).length === 0) {
    for (const raw of config.INITIAL_CHANNELS.split(",")) {
      const ref = resolveSource(raw);
      if (ref) await store.addSource(ref);
    }
  }

  const { bot, outbox } = createBot(config, store);
  const classify = createClassifier({ apiKey: config.ANTHROPIC_API_KEY, model: config.LEADS_MODEL, effort: config.LEADS_EFFORT });
  const pipeline = createPipeline({ store, classify, out: outbox, tz: config.TIMEZONE, freeLimit: config.FREE_DAILY_LIMIT, monthlyBudget: config.MONTHLY_BUDGET_USD,
    threads: { envToken: config.THREADS_ACCESS_TOKEN, intervalMin: config.THREADS_INTERVAL_MIN },
  });

  // Coolify/Docker health check: unhealthy when the loop has not finished a round for a long time
  let lastRound = Date.now();
  const maxSilence = config.FETCH_INTERVAL_SEC * 1000 * 5;
  createServer((req, res) => {
    const ok = req.url === "/health" && Date.now() - lastRound < maxSilence;
    res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" }).end(ok ? "ok" : "stale");
  }).listen(config.PORT);

  let running = false;
  const round = async () => {
    if (running) return; // a slow round must not overlap the next one
    running = true;
    try {
      await pipeline.run();
      lastRound = Date.now();
    } catch (err) {
      console.error("round failed", err);
    } finally {
      running = false;
    }
  };
  void round();
  const timer = setInterval(round, config.FETCH_INTERVAL_SEC * 1000);

  const stop = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    clearInterval(timer);
    await bot.stop();
    await db.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  await bot.api.setMyCommands([
    { command: "categories", description: "Що надсилати" },
    { command: "plan", description: "Тариф і ліміт" },
    { command: "pause", description: "Призупинити розсилку" },
    { command: "resume", description: "Увімкнути розсилку" },
    { command: "help", description: "Допомога" },
  ]);
  await startPolling(bot, () => outbox.admin("🟢 Бот замовлень запущений"));
}

// During a rolling update the old and new containers run side by side for a moment and Telegram lets only one poll
async function startPolling(bot: Bot, announce: () => Promise<void>): Promise<void> {
  let announced = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: (me) => {
          console.log(`bot @${me.username} started`);
          if (!announced) {
            announced = true;
            void announce();
          }
        },
      });
      return;
    } catch (err) {
      if (!(err instanceof GrammyError && err.error_code === 409) || attempt > 60) throw err;
      console.warn(`another instance is still polling, retry ${attempt}/60 in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
