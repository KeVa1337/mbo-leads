import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CATEGORY_IDS } from "./categories.js";

// Posts go to Claude in batches: one request decides for up to BATCH posts, which keeps the cost per post low.
export const BATCH = 20;
export const MARKETS = ["ua", "intl", "ru_by", "unknown"] as const;
export type Market = (typeof MARKETS)[number];
const MAX_POST_CHARS = 1500;

const Result = z.object({
  i: z.number().int().describe("index of the post in the input list"),
  is_order: z.boolean().describe("true only if someone wants to hire a freelancer or contractor"),
  category: z.enum(CATEGORY_IDS as [string, ...string[]]),
  title: z.string().describe("what is needed, in Ukrainian, at most 80 characters; empty when not an order"),
  summary: z.string().describe("the key details in Ukrainian, at most 240 characters; empty when not an order"),
  budget: z.string().nullable().describe("budget as written in the post, e.g. '$300' or '5000 грн'; null if absent"),
  remote: z.boolean().nullable().describe("true if remote work is fine, false if on-site only, null if unclear"),
  market: z.enum(MARKETS).describe("where the client is: ua, intl, ru_by or unknown"),
});
const Output = z.object({ results: z.array(Result) });
export type Classification = z.infer<typeof Result>;

// Stable text first so the prefix can be cached across batches
const SYSTEM = `You sort posts from public Telegram channels for a bot that sends freelancers new client orders.

A post is an order (is_order = true) when a person or company is looking to hire someone for a task, project or job:
"need a landing page", "looking for a designer", "who can set up a Telegram bot", "шукаю SMM-ника", "потрібен розробник", a remote or part-time vacancy.

Not an order (is_order = false):
- freelancers or agencies advertising their own services or portfolio ("I make websites", "беру замовлення");
- courses, webinars, news, memes, giveaways, channel promotion;
- job-board digests without a concrete task, and vague posts with no task at all;
- obvious scams: pay-to-start, "easy money", crypto schemes, unrealistic pay for trivial work.

Categories:
- web: websites, landing pages, online stores, WordPress, Tilda, website fixes;
- design: UI/UX, logos, branding, graphics, banners, presentations;
- bots: Telegram and other chatbots, AI assistants, automation, integrations;
- smm: SMM, targeted ads, Google Ads, marketing, SEO;
- video: video editing, motion design, reels, animation;
- copy: copywriting, translation, content writing;
- dev: other programming: mobile apps, backend, scripts, games;
- other: anything else.

Market (where the client is):
- ua: a client in Ukraine: hryvnias (грн, UAH), Ukrainian cities, Ukrainian services (Нова Пошта, Prom, Rozetka, OLX.ua, monobank, Дія);
- ru_by: a client in Russia or Belarus: rubles (₽, руб, RUB, BYN), Russian or Belarusian cities, Russian platforms (Kwork, FL.ru, Avito, VK, Дзен, Ozon, Wildberries, Max messenger, Сбер, ЮKassa, Тинькофф, Госуслуги), Russian legal entities (ООО, ИП with Russian context);
- intl: any other country, or a remote job paid in USD/EUR with no sign of Russia or Belarus;
- unknown: no clear signal.
Russian language alone is not a signal: many clients in Ukraine and elsewhere write in Russian. Decide by currency, places, platforms and companies.

Write title and summary in Ukrainian whatever the post's language. The summary keeps what a freelancer needs to decide: the task, scope, deadline, requirements. Never copy phone numbers, emails or usernames into title or summary. Return one result for every post, with its index.`;

export type Usage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

// USD per million tokens: input, output, cache read, cache write
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export function costOf(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k)) ?? "claude-opus-5-5";
  const [inp, out, read, write] = PRICES[key]!;
  return (u.input_tokens * inp + u.output_tokens * out + (u.cache_read_input_tokens ?? 0) * read + (u.cache_creation_input_tokens ?? 0) * write) / 1e6;
}

export function createClassifier(opts: { apiKey: string; model: string; effort: "low" | "medium" | "high" }) {
  const client = new Anthropic({ apiKey: opts.apiKey });

  return async function classify(texts: string[]): Promise<{ results: Map<number, Classification>; usage: Usage }> {
    const list = texts.map((t, i) => `<post i="${i}">\n${t.slice(0, MAX_POST_CHARS)}\n</post>`).join("\n");
    const msg = await client.messages.parse({
      model: opts.model,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Sort these ${texts.length} posts:\n\n${list}` }],
      output_config: { effort: opts.effort, format: zodOutputFormat(Output) },
    });
    const u = msg.usage;
    const usage: Usage = {
      model: msg.model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cost: costOf(msg.model, u),
    };
    if (msg.stop_reason === "refusal") throw new Error("модель відмовилась розбирати цю пачку постів");
    if (!msg.parsed_output) throw new Error(`не вдалося розібрати відповідь моделі (stop_reason: ${msg.stop_reason})`);
    const results = new Map<number, Classification>();
    for (const r of msg.parsed_output.results) if (r.i >= 0 && r.i < texts.length) results.set(r.i, r);
    return { results, usage };
  };
}

export type Classifier = ReturnType<typeof createClassifier>;
