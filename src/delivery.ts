// Who gets a new order. Kept free of I/O so the rules are easy to test.

export type Subscriber = {
  tg_id: number;
  categories: string[];
  plan: string;
  pro_until: Date | null;
  paused: boolean;
  blocked: boolean;
  sent_today: number;
  limit_notice_day: string | null;
};

export function isPro(u: Pick<Subscriber, "plan" | "pro_until">, now = new Date()): boolean {
  return u.plan === "pro" && (!u.pro_until || u.pro_until > now);
}

export type Decision = { send: number[]; limitReached: number[] };

/** Splits subscribers of the order's category into those who get it now and free users who hit today's limit */
export function decide(category: string, subscribers: Subscriber[], freeLimit: number, today: string, now = new Date()): Decision {
  const send: number[] = [];
  const limitReached: number[] = [];
  for (const u of subscribers) {
    if (u.paused || u.blocked || !u.categories.includes(category)) continue;
    if (isPro(u, now) || u.sent_today < freeLimit) send.push(u.tg_id);
    else if (u.limit_notice_day !== today) limitReached.push(u.tg_id); // told once a day, not on every order
  }
  return { send, limitReached };
}

/** Orders older than this are not sent: a new channel's backlog or a long outage must not flood subscribers */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function fresh(postedAt: Date, now = new Date()): boolean {
  return now.getTime() - postedAt.getTime() <= MAX_AGE_MS;
}
