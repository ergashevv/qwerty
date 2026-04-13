import type { Context } from 'grammy';
import { getUserLocale } from '../db';
import type { BotLocale } from '../i18n/locale';
import { t } from '../i18n/strings';
import {
  getBotRuntimeFlag,
  getUserChannelPromoState,
  incrementUserChannelPromoYesCount,
  markUserChannelPromoShown,
  setBotRuntimeFlag,
  setUserChannelPromoSubscribed,
} from '../db/postgres';

const FLAG_KEY = 'channel_promo_enabled';
const CHANNEL_USERNAME = 'kinovaai';
const CACHE_TTL_MS = 30_000;

/** Ketma-ket (jami) "✅ To'g'ri film" — shu miqdordan keyin promo tekshiriladi */
const REQUIRED_YES_COUNT = 3;
/** Oldingi kanal xabaridan keyin kamida shuncha vaqt (sekund) */
const MIN_SECONDS_BETWEEN_PROMOS = 3 * 24 * 60 * 60;
/** API xato bo‘lsa, bazadagi "obuna" ma’lumoti shuncha vaqt ichida ishonchli */
const SUBSCRIBED_DB_CACHE_SEC = 24 * 60 * 60;

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

export function getChannelPromoMessageHtml(locale: BotLocale): string {
  return `${t(locale).channelPromo}`;
}

export function getChannelPromoKeyboard(locale: BotLocale): {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
} {
  return {
    inline_keyboard: [[{ text: t(locale).channelBtn, url: `https://t.me/${CHANNEL_USERNAME}` }]],
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** UTC sana kaliti — bir kunda maksimal 1 promo */
function utcDayKey(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/**
 * Faqat "✅ To'g'ri film" bosilganda chaqiriladi.
 * Qoidalar (hardcode): obunachi — hech qachon; 3 marta ✅ dan keyin; oldingi promodan ≥3 kun; bir UTC kunida ≤1 marta.
 */
export async function offerChannelPromoAfterPositiveFeedback(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return;
  const uid = ctx.from?.id;
  if (uid == null) return;
  if (!(await isChannelPromoEnabled())) return;

  const now = nowSec();

  let liveSubscribed: boolean | null = null;
  try {
    const member = await ctx.api.getChatMember(`@${CHANNEL_USERNAME}`, uid);
    liveSubscribed =
      member.status === 'member' ||
      member.status === 'administrator' ||
      member.status === 'creator';
  } catch {
    liveSubscribed = null;
  }

  if (liveSubscribed === true) {
    await setUserChannelPromoSubscribed(uid, true, now);
    return;
  }

  if (liveSubscribed === false) {
    await setUserChannelPromoSubscribed(uid, false, now);
  } else {
    const st = await getUserChannelPromoState(uid);
    if (
      st?.subscribed === true &&
      st.subscribedCheckedAt != null &&
      now - st.subscribedCheckedAt <= SUBSCRIBED_DB_CACHE_SEC
    ) {
      return;
    }
  }

  const yesCount = await incrementUserChannelPromoYesCount(uid);
  if (yesCount < REQUIRED_YES_COUNT) return;

  const state = await getUserChannelPromoState(uid);
  const last = state?.lastShownAt ?? null;
  if (last != null) {
    if (now - last < MIN_SECONDS_BETWEEN_PROMOS) return;
    if (utcDayKey(last) === utcDayKey(now)) return;
  }

  const loc = await getUserLocale(uid);
  await ctx.reply(getChannelPromoMessageHtml(loc), {
    parse_mode: 'HTML',
    reply_markup: getChannelPromoKeyboard(loc),
    link_preview_options: { is_disabled: true },
  });
  await markUserChannelPromoShown(uid, now);
}
