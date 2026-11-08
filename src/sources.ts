import { fetchFeed, type FeedPage } from "./rss-source.js";
import { fetchChannel, normalizeHandle, SourceError } from "./telegram-source.js";
import { searchThreads } from "./threads-source.js";

// A source is a public Telegram channel (read through t.me/s), an RSS/Atom feed, or a Threads keyword search.

export type SourceKind = "telegram" | "rss" | "threads";
export type SourceRef = { kind: SourceKind; handle: string; url: string | null };

/** "@channel", "t.me/channel" → Telegram; any other http(s) link → feed. null when it is neither */
export function resolveSource(input: string): SourceRef | null {
  const s = input.trim();
  const threads = /^threads\s*:\s*(.+)$/i.exec(s);
  if (threads) {
    const query = threads[1]!.trim().replace(/\s+/g, " ").toLowerCase();
    return query.length >= 3 ? { kind: "threads", handle: `threads:${query.slice(0, 100)}`, url: null } : null;
  }
  if (/^https?:\/\//i.test(s) && !/^https?:\/\/(www\.)?t(elegram)?\.me\//i.test(s)) {
    try {
      const u = new URL(s);
      const handle = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase().slice(0, 120);
      return { kind: "rss", handle, url: u.toString() };
    } catch {
      return null;
    }
  }
  const handle = normalizeHandle(s);
  return handle ? { kind: "telegram", handle, url: null } : null;
}

export async function fetchSource(src: { kind: string; handle: string; url: string | null }, opts: { threadsToken?: string | null } = {}): Promise<FeedPage> {
  if (src.kind === "threads") {
    if (!opts.threadsToken) throw new SourceError("Threads вимкнений: не задано THREADS_ACCESS_TOKEN");
    const query = src.handle.replace(/^threads:/, "");
    return { title: `Threads «${query}»`, posts: await searchThreads(query, opts.threadsToken) };
  }
  return src.kind === "rss" && src.url ? fetchFeed(src.url) : fetchChannel(src.handle);
}

/** A readable name for a feed: sites often title them "newest submissions : multi" or in another language */
export function feedName(url: string, feedTitle: string | null): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.endsWith("reddit.com")) {
      const subs = /\/r\/([^/]+)/.exec(u.pathname)?.[1]?.split("+") ?? [];
      return subs.length ? `Reddit (${subs.map((s) => `r/${s}`).join(", ")})` : "Reddit";
    }
    if (host === "freelancehunt.com") return "Freelancehunt";
  } catch {
    // fall back to the feed's own title
  }
  return feedTitle;
}

/** How a source is named to people: "@channel" or the feed's title */
export function sourceLabel(src: { kind?: string | null; handle?: string | null; title?: string | null }): string {
  if (src.kind === "rss") return src.title || src.handle || "стрічка";
  if (src.kind === "threads") return src.title || `Threads «${(src.handle ?? "").replace(/^threads:/, "")}»`;
  return `@${src.handle ?? ""}`;
}
