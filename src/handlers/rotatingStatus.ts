import { Context } from 'grammy';

/** Rasm bo‘yicha film qidirilganda — uzoqroq kutishda matn almashadi */
export const STATUS_IDENTIFY_LINES = [
  '🎬 Kadr tahlil qilinmoqda...',
  '🔎 Sahna va yuzlar tekshirilmoqda...',
  '🧠 Bir nechta manbadan solishtirish...',
  '⏳ Aniq javob uchun biroz kuting...',
  '✨ Oxirgi tekshiruvlar...',
  '🎞️ Deyarli tayyor...',
];

/** Matn bo‘yicha qidiruv (aniqlash bosqichi) */
export const STATUS_TEXT_SEARCH_LINES = [
  '🔍 Qidiruv: nom va bazalar tekshirilmoqda...',
  '🔎 TMDB / OMDB va boshqa manbalar...',
  '⏳ Aniq javob uchun biroz kuting...',
  '🧠 Syujet bo‘lsa, AI bilan solishtirilmoqda...',
];

/** Ma’lumotlar (poster, tavsif) yig‘ilganda */
export const STATUS_DETAILS_LINES = (filmTitle: string) => [
  `🎯 «${filmTitle}» topildi — ma’lumotlar yig‘ilmoqda...`,
  '📽 Poster va tavsif qidirilmoqda...',
  '🔗 Tomosha havolalari tayyorlanmoqda...',
  '⏳ Yana bir oz...',
];

/**
 * Uzoq async vazifa davomida xabarni muntazam yangilaydi.
 * Birinchi qatorni chaqiriuvchi oldindan `editMessageText` bilan qo‘yishi kerak (yoki shu yerda birinchi qatorni berish).
 */
/** Telegram "typing..." indikatori ~5s dan keyin o‘chadi — uzoq vazifada qayta-yuborish */
function startTypingHeartbeat(ctx: Context, chatId: number): () => void {
  const fire = (): void => {
    void ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
  };
  fire();
  const id = setInterval(fire, 4500);
  return () => clearInterval(id);
}

export async function withRotatingStatus<T>(
  ctx: Context,
  chatId: number,
  messageId: number,
  lines: string[],
  task: () => Promise<T>,
  options?: { intervalMs?: number }
): Promise<T> {
  const intervalMs = options?.intervalMs ?? 3200;
  const stopTyping = startTypingHeartbeat(ctx, chatId);
  if (lines.length <= 1) {
    try {
      return await task();
    } finally {
      stopTyping();
    }
  }

  let idx = 0;
  const tick = (): void => {
    idx = (idx + 1) % lines.length;
    void ctx.api.editMessageText(chatId, messageId, lines[idx]).catch(() => {});
  };

  const timer = setInterval(tick, intervalMs);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    stopTyping();
  }
}
