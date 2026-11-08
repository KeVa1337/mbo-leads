import { fetchFeed, type FeedPage } from "./rss-source.js";
import { fetchChannel, normalizeHandle } from "./telegram-source.js";

// A source is either a public Telegram channel (read through t.me/s) or an RSS/Atom feed.

export type SourceKind = "telegram" | "rss";
export type SourceRef = { kind: SourceKind; handle: string; url: string | null };

/** "@channel", "t.me/channel" → Telegram; any other http(s) link → feed. null when it is neither */
export function resolveSource(input: string): SourceRef | null {
  const s = input.trim();
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

export function fetchSource(src: { kind: string; handle: string; url: string | null }): Promise<FeedPage> {
  return src.kind === "rss" && src.url ? fetchFeed(src.url) : fetchChannel(src.handle);
}

/** How a source is named to people: "@channel" or the feed's title */
export function sourceLabel(src: { kind?: string | null; handle?: string | null; title?: string | null }): string {
  if (src.kind === "rss") return src.title || src.handle || "стрічка";
  return `@${src.handle ?? ""}`;
}
