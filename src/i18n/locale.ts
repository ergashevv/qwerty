export type BotLocale = 'uz' | 'ru';

export const DEFAULT_LOCALE: BotLocale = 'uz';

export function parseBotLocale(raw: string | undefined | null): BotLocale | null {
  const t = (raw || '').trim().toLowerCase();
  if (t === 'uz' || t === "o'zbek" || t === 'ozbek') return 'uz';
  if (t === 'ru' || t === 'rus' || t === 'рус') return 'ru';
  return null;
}

export function isBotLocale(v: string | undefined | null): v is BotLocale {
  return v === 'uz' || v === 'ru';
}
