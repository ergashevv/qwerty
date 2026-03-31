/**
 * Fikr-mulohaza va shikoyat oqimi uchun foydalanuvchiga ko‘rinadigan matnlar (HTML).
 */

/** `/feedback` dan keyin — keyingi matn shikoyat sifatida ketadi */
export const FEEDBACK_WRITE_NEXT_HTML = `✍️ <b>Shikoyatingizni yozing</b>`;

/** `/feedback` — allaqachon navbatda */
export const FEEDBACK_PENDING_REMINDER_HTML =
  `Siz hozir <b>shikoyat matni</b> uchun navbatdasiz. Keyingi bitta oddiy matn xabaringiz qabul qilinadi.\n\n` +
  `Bekor qilish: <code>/cancel</code>`;

/** Eski: uzun yordam — faqat kerak bo‘lsa alohida chaqirish mumkin */
export const FEEDBACK_COMMAND_HELP_HTML =
  `ℹ️ <b>Shikoyat va fikr</b>\n\n` +
  `<code>/feedback</code> — keyingi matn xabaringiz shikoyat sifatida yuboriladi.\n\n` +
  `Har bir topilgan film ostida <b>Ha, shu film</b> va <b>Yo‘q, bu emas</b> tugmalari chiqadi. ` +
  `<b>Yo‘q</b> bosganda ham keyingi matningiz shikoyat sifatida saqlanadi.\n\n` +
  `Rasm yuborayotgan bo‘lsangiz, shikoyatni <b>caption</b>da yozing yoki alohida matn yuboring.`;

export const FEEDBACK_CANCEL_NOTHING_HTML =
  `Hozir bekor qilinadigan shikoyat yozish rejimi yo‘q.\n\n` +
  `Shikoyat uchun <code>/feedback</code> yuboring.`;

export const FEEDBACK_CANCEL_OK_HTML =
  `Shikoyat yozish bekor qilindi.\n\n` +
  `Yangi qidiruv uchun film nomini yozing, rasm yoki video havola yuboring.`;

export const PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML =
  `Shikoyat matnini <b>matn xabari</b> qilib yuboring yoki rasmga <b>izoh</b> qo‘shing.\n\n` +
  `Bekor qilish: <code>/cancel</code> · <code>/feedback</code>`;
