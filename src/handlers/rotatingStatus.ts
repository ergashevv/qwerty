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
export async function withRotatingStatus<T>(
  ctx: Context,
  chatId: number,
  messageId: number,
  lines: string[],
  task: () => Promise<T>,
  options?: { intervalMs?: number }
): Promise<T> {
  const intervalMs = options?.intervalMs ?? 3200;
  if (lines.length <= 1) {
    return task();
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
  }
}
