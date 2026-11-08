import { itemId } from "./rss-source.js";
import type { ChannelPost } from "./telegram-source.js";
import { SourceError } from "./telegram-source.js";

// Threads through the official API: keyword search over public posts.
// Needs a Threads user access token with threads_basic and threads_keyword_search. Until Meta approves the app
// for threads_keyword_search, search returns only the token owner's own posts.

const API = "https://graph.threads.net/v1.0";

export type ThreadsPost = { id: string; text?: string; permalink?: string; timestamp?: string; username?: string };

export function threadsPosts(data: ThreadsPost[]): ChannelPost[] {
  return data.flatMap((p) => {
    const date = new Date(p.timestamp ?? "");
    if (!p.text || !p.permalink || Number.isNaN(date.getTime())) return [];
    // ids are 17-19 digits, beyond what a JS number holds exactly, so they are hashed like feed ids
    return [{ extId: itemId(`threads:${p.id}`), url: p.permalink, text: p.text, postedAt: date }];
  });
}

type ApiError = { error?: { message?: string; code?: number; error_subcode?: number } };

function apiError(status: number, body: ApiError): SourceError {
  const code = body.error?.code;
  if (code === 190) return new SourceError("токен Threads недійсний або прострочений, потрібен новий (THREADS_ACCESS_TOKEN)");
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return new SourceError("Threads тимчасово обмежив запити", true);
  if (code === 10 || code === 200) return new SourceError("немає дозволу threads_keyword_search: застосунок ще не схвалений у Meta");
  return new SourceError(`Threads API відповів ${status}: ${body.error?.message ?? "невідома помилка"}`);
}

export async function searchThreads(query: string, token: string, timeoutMs = 20_000): Promise<ChannelPost[]> {
  const url = new URL(`${API}/keyword_search`);
  url.searchParams.set("q", query);
  url.searchParams.set("search_type", "RECENT");
  url.searchParams.set("fields", "id,text,permalink,timestamp,username");
  url.searchParams.set("limit", "50");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as ApiError & { data?: ThreadsPost[] };
  if (!res.ok || body.error) throw apiError(res.status, body);
  return threadsPosts(body.data ?? []);
}

/** Long-lived tokens last 60 days; refreshing one gives another 60. Returns the new token. */
export async function refreshThreadsToken(token: string): Promise<{ token: string; expiresInSec: number }> {
  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as ApiError & { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw apiError(res.status, body);
  return { token: body.access_token, expiresInSec: body.expires_in ?? 0 };
}
