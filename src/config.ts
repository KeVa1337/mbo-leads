import { z } from "zod";

const optional = z.string().trim().optional().or(z.literal("").transform(() => undefined));

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string({ error: "потрібен токен Telegram-бота" }).trim().min(1, "потрібен токен Telegram-бота"),
  ANTHROPIC_API_KEY: z.string({ error: "потрібен ключ Claude API" }).trim().min(1, "потрібен ключ Claude API"),
  DATABASE_URL: z.string({ error: "потрібна адреса бази Postgres" }).min(1, "потрібна адреса бази Postgres"),
  // Telegram ID власника: лише він керує джерелами й бачить статистику
  ADMIN_TELEGRAM_ID: z.coerce.number({ error: "потрібен Telegram ID адміністратора (число)" }).int().positive(),
  // Модель, що розбирає пости. Розбір іде пачками, тож дешевша модель (claude-haiku-5-5) зменшує витрати приблизно в 40 разів
  LEADS_MODEL: z.string().default("claude-opus-5-5"),
  LEADS_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  FETCH_INTERVAL_SEC: z.coerce.number().int().min(60).default(180),
  // Скільки замовлень на день отримує безкоштовний користувач
  FREE_DAILY_LIMIT: z.coerce.number().int().min(0).default(5),
  // Публічні канали (@назва або t.me/назва) через кому, які додаються при першому запуску
  INITIAL_CHANNELS: z.string().default(""),
  TIMEZONE: z.string().default("Europe/Kyiv"),
  PORT: z.coerce.number().int().default(3000),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(30),
  SUPPORT_CONTACT: optional,
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Неправильні змінні середовища:\n${problems}`);
  }
  return parsed.data;
}
