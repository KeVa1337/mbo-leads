import { parse, type HTMLElement } from "node-html-parser";

// Public channels have a web preview at t.me/s/<name>: the last ~20 posts as HTML, no login or API key needed.

export type ChannelPost = { extId: number; url: string; text: string; postedAt: Date };
export type ChannelPage = { title: string | null; posts: ChannelPost[] };

/** "@name", "name", "t.me/name", "https://t.me/s/name" → "name"; null when it is not a channel username */
export function normalizeHandle(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\//, "").replace(/^(www\.)?t(elegram)?\.me\/(s\/)?/, "").replace(/^@/, "").split(/[/?#]/)[0] ?? "";
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? s.toLowerCase() : null;
}

function textOf(el: HTMLElement): string {
  // <br> carries the line breaks of the post
  const html = el.innerHTML.replace(/<br\s*\/?>/gi, "\n");
  return parse(html).textContent.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseChannelPage(html: string, handle: string): ChannelPage {
  const root = parse(html);
  const title = root.querySelector(".tgme_channel_info_header_title")?.textContent.trim() || null;
  const posts: ChannelPost[] = [];
  for (const msg of root.querySelectorAll(".tgme_widget_message[data-post]")) {
    const ref = msg.getAttribute("data-post") ?? "";
    const extId = Number(ref.split("/")[1]);
    const body = msg.querySelector(".tgme_widget_message_text");
    const time = msg.querySelector("time[datetime]")?.getAttribute("datetime");
    if (!Number.isInteger(extId) || !body || !time) continue; // media without a caption, service messages
    const text = textOf(body);
    if (!text) continue;
    posts.push({ extId, url: `https://t.me/${handle}/${extId}`, text, postedAt: new Date(time) });
  }
  return { title, posts };
}

export class SourceError extends Error {}

export async function fetchChannel(handle: string, timeoutMs = 15_000): Promise<ChannelPage> {
  const res = await fetch(`https://t.me/s/${handle}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (compatible; MBOLeadsBot/1.0)", "accept-language": "uk,en;q=0.8" },
    redirect: "manual", // a channel without a public preview redirects to t.me/<name>
  });
  if (res.status >= 300 && res.status < 400) throw new SourceError("у каналу немає публічного перегляду (приватний або це не канал)");
  if (!res.ok) throw new SourceError(`t.me відповів ${res.status}`);
  const html = await res.text();
  if (!html.includes("tgme_channel_info")) throw new SourceError("канал не знайдено");
  return parseChannelPage(html, handle);
}
