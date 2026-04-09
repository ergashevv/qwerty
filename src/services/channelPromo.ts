import { getBotRuntimeFlag, setBotRuntimeFlag } from '../db/postgres';

const FLAG_KEY = 'channel_promo_enabled';
const CHANNEL_USERNAME = 'kinovaai';
const CACHE_TTL_MS = 30_000;

let cachedEnabled: boolean | null = null;
let cachedAt = 0;

function parseBool(v: string | null): boolean {
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'on';
}

export async function isChannelPromoEnabled(forceRefresh = false): Promise<boolean> {
  const now = Date.now();
  if (!forceRefresh && cachedEnabled !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedEnabled;
  }
  const raw = await getBotRuntimeFlag(FLAG_KEY);
  cachedEnabled = parseBool(raw);
  cachedAt = now;
  return cachedEnabled;
}

export async function setChannelPromoEnabled(enabled: boolean): Promise<void> {
  await setBotRuntimeFlag(FLAG_KEY, enabled ? '1' : '0');
  cachedEnabled = enabled;
  cachedAt = Date.now();
}

export function getChannelPromoMessageHtml(): string {
  return (
    `Majburiy emas 🙂\n` +
    `Lekin yangilanishlarni o‘tkazib yubormaslik uchun kanalimizga qo‘shilib qo‘ying.\n` +
    `U yerda nafaqat bot yangiliklari, balki har kuni turli film tavsiyalari ham ulashib boriladi 👇\n` +
    `@${CHANNEL_USERNAME}`
  );
}

export function getChannelPromoKeyboard(): { inline_keyboard: Array<Array<{ text: string; url: string }>> } {
  return {
    inline_keyboard: [[{ text: '📣 Kanalga obuna bo‘lish', url: `https://t.me/${CHANNEL_USERNAME}` }]],
  };
}

