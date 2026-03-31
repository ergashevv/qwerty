/**
 * Fikr-mulohaza va shikoyat oqimi uchun foydalanuvchiga ko‘rinadigan matnlar (HTML).
 */

/** `/feedback` va qayta `/feedback` — pastda «Ortga» tugmasi */
export const FEEDBACK_WRITE_NEXT_HTML =
  `<b>Shikoyat yoki taklif yozish:</b> ✍️\n\n` +
  `Iltimos, qandaydir shikoyatingiz yoki taklifingiz bo‘lsa, yozib qoldiring!`;

export const FEEDBACK_PENDING_REMINDER_HTML = FEEDBACK_WRITE_NEXT_HTML;

/** Shikoyat rejimida ovoz, video va hokazo */
export const FEEDBACK_WRONG_MEDIA_HTML = `Iltimos, rasm yoki matn yuboring.`;

/** Eski: uzun yordam — faqat kerak bo‘lsa alohida chaqirish mumkin */
export const FEEDBACK_COMMAND_HELP_HTML =
  `ℹ️ <b>Shikoyat va fikr</b>\n\n` +
  `<code>/feedback</code> — keyingi matn xabaringiz shikoyat sifatida yuboriladi.\n\n` +
  `Har bir topilgan film ostida <b>Ha, shu film</b> va <b>Yo‘q, bu emas</b> tugmalari chiqadi. ` +
  `<b>Yo‘q</b> bosganda ham keyingi matningiz shikoyat sifatida saqlanadi.\n\n` +
  `Rasm yuborayotgan bo‘lsangiz, shikoyatni <b>caption</b>da yozing yoki alohida matn yuboring.`;

export const FEEDBACK_CANCEL_NOTHING_HTML =
  `Hozir shikoyat rejimi yo‘q.\n\n` +
  `Kerak bo‘lsa: <code>/feedback</code>`;

export const FEEDBACK_CANCEL_OK_HTML =
  `Bekor qilindi. Endi film qidirishingiz mumkin.`;

export const PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML = FEEDBACK_WRITE_NEXT_HTML;

/** «Yo‘q» bosilgandan keyin */
export const PROBLEM_REPORT_AFTER_NO_HTML = FEEDBACK_WRITE_NEXT_HTML;

export const PROBLEM_REPORT_REJECT_URL_HTML =
  `Havolani shu yerga emas — alohida xabar qilib yuboring. Shikoyat esa oddiy matn bilan.`;

export const PROBLEM_REPORT_REJECT_COMMAND_HTML =
  `<code>/cancel</code> ni alohida yuboring yoki <b>Ortga</b> tugmasini bosing.`;

export const PROBLEM_REPORT_REJECT_NUMBERS_ONLY_HTML =
  `Bir-ikki gap bilan yozing. Yangi qidiruv — oddiy chatda.`;

export const PROBLEM_REPORT_REJECT_TOO_SHORT_HTML =
  `Biroz batafsilroq yozing — nimani noto‘g‘ri topganimiz?`;
