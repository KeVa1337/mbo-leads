import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import type { ChannelPost } from "./telegram-source.js";
import { SourceError } from "./telegram-source.js";

// RSS 2.0 and Atom feeds: freelance exchanges (Freelancehunt), Reddit subreddits (/r/forhire/new/.rss) and the like.

export type FeedPage = { title: string | null; posts: ChannelPost[] };

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", processEntities: true, htmlEntities: true });

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "#text" in v ? String((v as { "#text": unknown })["#text"]) : v == null ? "" : String(v));

function htmlToText(html: string): string {
  return parse(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n"))
    .textContent.replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Feed items have no growing numeric id, so a stable one is derived from the item's guid or link */
export function itemId(key: string): number {
  return parseInt(createHash("sha1").update(key).digest("hex").slice(0, 12), 16);
}

export function parseFeed(body: string): FeedPage {
  const doc = xml.parse(body);
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    const posts = asArray<Record<string, unknown>>(ch.item).flatMap((it) => {
      const link = str(it.link).trim();
      const title = htmlToText(str(it.title));
      const desc = htmlToText(str(it.description));
      const category = asArray(it.category).map(str).filter(Boolean).join(", ");
      const date = new Date(str(it.pubDate));
      if (!link || Number.isNaN(date.getTime()) || !(title || desc)) return [];
      const text = [title, desc, category && `Категорія: ${category}`].filter(Boolean).join("\n\n");
      return [{ extId: itemId(str(it.guid) || link), url: link, text, postedAt: date }];
    });
    return { title: htmlToText(str(ch.title)) || null, posts };
  }
  if (doc.feed) {
    const posts = asArray<Record<string, unknown>>(doc.feed.entry).flatMap((e) => {
      const links = asArray<Record<string, string>>(e.link as never);
      const link = (links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0])?.["@href"] ?? "";
      const title = htmlToText(str(e.title));
      // Reddit appends "submitted by /u/name [link] [comments]" to every post
      const body = htmlToText(str(e.content) || str(e.summary)).replace(/\s*submitted by\s+\/u\/\S+[\s\S]*$/i, "").trim();
      const date = new Date(str(e.published) || str(e.updated));
      if (!link || Number.isNaN(date.getTime()) || !(title || body)) return [];
      return [{ extId: itemId(str(e.id) || link), url: link, text: [title, body].filter(Boolean).join("\n\n"), postedAt: date }];
    });
    return { title: htmlToText(str(doc.feed.title)) || null, posts };
  }
  throw new SourceError("це не RSS- і не Atom-стрічка");
}

export async function fetchFeed(url: string, timeoutMs = 20_000): Promise<FeedPage> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (compatible; MBOLeadsBot/1.0)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  if (res.status === 429 || res.status === 503) throw new SourceError(`сайт тимчасово обмежив запити (${res.status})`, true);
  if (!res.ok) throw new SourceError(`стрічка відповіла ${res.status}`);
  return parseFeed(await res.text());
}

/** Posts that are clearly not orders, dropped before they cost a model call */
export function obviouslyNotOrder(text: string): boolean {
  return /^\s*\[(for hire|offer|for sale)\]/i.test(text);
}
