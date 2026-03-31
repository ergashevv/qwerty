/**
 * Fikr-mulohaza va shikoyat oqimi uchun foydalanuvchiga ko‘rinadigan matnlar (HTML).
 */

export const FEEDBACK_COMMAND_HELP_HTML =
  `ℹ️ <b>Natija haqida fikr</b>\n\n` +
  `Har bir topilgan film ostida <b>Ha, shu film</b> va <b>Yo‘q, bu emas</b> tugmalari chiqadi. ` +
  `Bu javoblar modelni yaxshilashda yordam beradi.\n\n` +
  `<b>Matnli shikoyat qachon?</b>\n` +
  `Agar ketma-ket <b>ikki marta</b> «Yo‘q, bu emas»ni bossangiz, bot sizdan qisqa izoh so‘raydi ` +
  `— keyingi <b>bitta matn</b> xabaringiz shikoyat sifatida saqlanadi.\n\n` +
  `<b>Buyruqlar</b>\n` +
  `• <code>/cancel</code> — shikoyat yozish rejimini bekor qilish\n` +
  `• <code>/feedback</code> — ushbu yordam\n\n` +
  `Rasm yuborayotgan bo‘lsangiz, shikoyat matnini <b>rasm izohiga</b> yozing yoki alohida matn xabari yuboring.`;

export const FEEDBACK_CANCEL_NOTHING_HTML =
  `Hozir bekor qilinadigan shikoyat yozish rejimi yo‘q.\n\n` +
  `Shikoyat faqat ketma-ket ikki marta «Yo‘q, bu emas»dan keyin so‘raladi. ` +
  `Batafsil: <code>/feedback</code>`;

export const FEEDBACK_CANCEL_OK_HTML =
  `Shikoyat yozish rejimi bekor qilindi.\n\n` +
  `Yangi qidiruv uchun film nomini yozing, rasm yoki Reels havolasini yuboring.`;

export const FEEDBACK_PENDING_REMINDER_HTML =
  `Siz hozir <b>shikoyat matni</b> uchun navbatdasiz. Keyingi bitta oddiy matn xabaringiz qabul qilinadi.\n\n` +
  `Bekor qilish: <code>/cancel</code>`;

export const PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML =
  `Siz shikoyat matni uchun navbatdasiz. Iltimos, izohni <b>matn xabari</b> qilib yuboring ` +
  `yoki rasmga <b>izoh (caption)</b> qo‘shib yuboring.\n\n` +
  `Bekor qilish: <code>/cancel</code> · Yordam: <code>/feedback</code>`;
