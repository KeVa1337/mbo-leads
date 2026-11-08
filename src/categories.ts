// What a subscriber can follow. The classifier puts every order into exactly one of these.
export const CATEGORIES = {
  web: "🌐 Сайти й лендінги",
  design: "🎨 Дизайн і брендинг",
  bots: "🤖 Чат-боти та AI",
  smm: "📣 SMM і реклама",
  video: "🎬 Відео й монтаж",
  copy: "✍️ Тексти й переклади",
  dev: "💻 Програмування й застосунки",
  other: "📦 Інше",
} as const;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as Category[];

export function isCategory(v: string): v is Category {
  return v in CATEGORIES;
}
