// The same order is often posted in several channels with small edits (emoji, a link, a hashtag).
// Compare word sets: two texts that share most of their words are one order.

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+|t\.me\/\S+|@\w+|#\w+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordSet(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((w) => w.length > 2));
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
}

export const DUPLICATE_AT = 0.75;

/** Id of the earlier order this text repeats, or null */
export function findDuplicate(text: string, earlier: { id: number; text: string }[]): number | null {
  const words = wordSet(text);
  if (words.size < 4) return null; // too short to judge
  let best: { id: number; score: number } | null = null;
  for (const e of earlier) {
    const score = similarity(words, wordSet(e.text));
    if (score >= DUPLICATE_AT && (!best || score > best.score)) best = { id: e.id, score };
  }
  return best?.id ?? null;
}
