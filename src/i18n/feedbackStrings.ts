import type { BotLocale } from './locale';

const FB = {
  uz: {
    writeNext:
      `<b>Shikoyat yoki taklif yozish:</b> ✍️\n\n` +
      `Iltimos, qandaydir shikoyatingiz yoki taklifingiz bo‘lsa, yozib qoldiring!`,
    cancelNothing: `Hozir shikoyat rejimi yo‘q.\n\n` + `Kerak bo‘lsa: <code>/feedback</code>`,
    cancelOk: `Bekor qilindi. Endi film qidirishingiz mumkin.`,
    wrongMedia: `Iltimos, rasm yoki matn yuboring.`,
    problemAfterNo:
      `<b>Shikoyat yoki taklif yozish:</b> ✍️\n\n` +
      `Iltimos, qandaydir shikoyatingiz yoki taklifingiz bo‘lsa, yozib qoldiring!`,
    photoNeedCaption:
      `<b>Shikoyat yoki taklif yozish:</b> ✍️\n\n` +
      `Iltimos, qandaydir shikoyatingiz yoki taklifingiz bo‘lsa, yozib qoldiring!`,
    consumeError:
      '⚠️ Fikrni saqlab bo‘lmadi (server band yoki vaqtinchalik xato). Keyinroq qayta urinib ko‘ring.',
    callbackBadFormat: 'Noto‘g‘ri format.',
    callbackBadButton: 'Noto‘g‘ri tugma.',
    callbackErr: 'Xato.',
    thanksYes: 'Rahmat — bot shu bilan o‘rganadi ❤️',
    thanksNo: 'Tushundim. Iltimos, qisqa izoh yozing ✍️',
    feedbackBack: '◀️ Ortga',
    feedbackNoMode: 'Shikoyat rejimi yo‘q. Film qidirishingiz mumkin.',
    documentNotImage: '📸 Iltimos, rasm yuboring (screenshot yoki foto).',
    problemRejectTooShort: 'Biroz batafsilroq yozing — nimani noto‘g‘ri topganimiz?',
    problemRejectUrl:
      'Havolani shu yerga emas — alohida xabar qilib yuboring. Shikoyat esa oddiy matn bilan.',
    problemRejectCommand: '<code>/cancel</code> ni alohida yuboring yoki <b>Ortga</b> tugmasini bosing.',
    problemRejectNumbersOnly: 'Bir-ikki gap bilan yozing. Yangi qidiruv — oddiy chatda.',
    problemReportSaved:
      'Rahmat! Yozganingiz qabul qilindi — jamoamiz xabarni ko‘rib chiqadi. Yangi qidiruvni davom ettirishingiz mumkin.',
    problemReportError:
      '❌ Hozir yozuvni saqlab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring yoki /help orqali yordam oling.',
  },
  ru: {
    writeNext:
      `<b>Жалоба или предложение:</b> ✍️\n\n` +
      `Напишите текст жалобы или предложения.`,
    cancelNothing: `Режим жалобы не активен.\n\n` + `Нужно: <code>/feedback</code>`,
    cancelOk: `Отменено. Можно снова искать фильм.`,
    wrongMedia: `Отправьте фото или текст.`,
    problemAfterNo:
      `<b>Жалоба или предложение:</b> ✍️\n\n` +
      `Напишите текст жалобы или предложения.`,
    photoNeedCaption:
      `<b>Жалоба или предложение:</b> ✍️\n\n` +
      `Напишите текст жалобы или предложения.`,
    consumeError:
      '⚠️ Не удалось сохранить отзыв (сервер занят или временная ошибка). Попробуйте позже.',
    callbackBadFormat: 'Неверный формат.',
    callbackBadButton: 'Неверная кнопка.',
    callbackErr: 'Ошибка.',
    thanksYes: 'Спасибо — так бот учится ❤️',
    thanksNo: 'Понял. Напишите коротко, что не так ✍️',
    feedbackBack: '◀️ Назад',
    feedbackNoMode: 'Режим жалобы не активен. Можно искать фильм.',
    documentNotImage: '📸 Отправьте изображение (скриншот или фото).',
    problemRejectTooShort: 'Напишите чуть подробнее — что именно не так?',
    problemRejectUrl:
      'Ссылку отправьте отдельным сообщением. Жалоба — обычным текстом.',
    problemRejectCommand: 'Отправьте <code>/cancel</code> отдельной строкой или нажмите <b>Назад</b>.',
    problemRejectNumbersOnly: 'Напишите пару слов. Новый поиск — в обычном чате.',
    problemReportSaved:
      'Спасибо! Жалоба принята — команда её рассмотрит. Можно продолжить поиск.',
    problemReportError:
      '❌ Не удалось сохранить. Попробуйте позже или см. /help.',
  },
} as const;

export function feedbackT(locale: BotLocale): (typeof FB)[BotLocale] {
  return FB[locale];
}
