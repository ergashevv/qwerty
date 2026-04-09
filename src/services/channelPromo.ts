import {
  getBotRuntimeFlag,
  getUserChannelPromoState,
  markUserChannelPromoShown,
  setBotRuntimeFlag,
  setUserChannelPromoSubscribed,
} from '../db/postgres';

const FLAG_KEY = 'channel_promo_enabled';
const CHANNEL_USERNAME = 'kinovaai';
const CACHE_TTL_MS = 30_000;
const SHOW_EVERY_SECONDS = Math.max(
  3600,
  parseInt(process.env.CHANNEL_PROMO_COOLDOWN_SEC || String(3 * 24 * 3600), 10)
);
const SUB_CHECK_TTL_SECONDS = Math.max(
  1800,
  parseInt(process.env.CHANNEL_SUB_CHECK_TTL_SEC || String(24 * 3600), 10)
);

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

export interface PromoDecision {
  show: boolean;
  reason:
    | 'disabled'
    | 'no_user'
    | 'cooldown'
    | 'already_subscribed'
    | 'eligible'
    | 'status_unknown';
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** ON bo‘lsa ham userga haddan tashqari ko‘p ko‘rsatmaslik + obuna bo‘lsa umuman ko‘rsatmaslik */
export async function shouldShowChannelPromo(
  telegramId: number | undefined,
  isSubscribedNow?: boolean | null
): Promise<PromoDecision> {
  if (!(await isChannelPromoEnabled())) return { show: false, reason: 'disabled' };
  if (telegramId == null || !Number.isFinite(telegramId)) return { show: false, reason: 'no_user' };

  const state = await getUserChannelPromoState(telegramId);
  const now = nowSec();

  let subscribedKnown: boolean | null = null;
  if (typeof isSubscribedNow === 'boolean') {
    subscribedKnown = isSubscribedNow;
    await setUserChannelPromoSubscribed(telegramId, isSubscribedNow, now);
  } else if (
    state &&
    state.subscribedCheckedAt != null &&
    now - state.subscribedCheckedAt <= SUB_CHECK_TTL_SECONDS
  ) {
    subscribedKnown = state.subscribed;
  }

  if (subscribedKnown === true) return { show: false, reason: 'already_subscribed' };
  if (state?.lastShownAt != null && now - state.lastShownAt < SHOW_EVERY_SECONDS) {
    return { show: false, reason: 'cooldown' };
  }
  if (subscribedKnown === null) return { show: true, reason: 'status_unknown' };
  return { show: true, reason: 'eligible' };
}

export async function markChannelPromoShown(telegramId: number | undefined): Promise<void> {
  if (telegramId == null || !Number.isFinite(telegramId)) return;
  await markUserChannelPromoShown(telegramId, nowSec());
}

