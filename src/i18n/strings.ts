import type { BotLocale } from './locale';

/** Foydalanuvchi interfeysi matnlari — faqat `uz` va `ru`. */
export const UI = {
  uz: {
    langName: "O'zbekcha",
    langPrompt: '🌐 <b>Bot tilini tanlang</b> / Выберите язык бота:',
    startWelcome: (name: string) =>
      `Assalomu alaykum, <b>${name}</b>! 🎬\n\n` +
      `<b>Bu bot nima qiladi?</b>\n\n` +
      `Kadr, video havola yoki matndan filmni topib, o‘zbekcha tomosha havolalarini yuboraman.\n\n` +
      `<b>Yuborishingiz mumkin</b>\n` +
      `📸 Rasm — filmdan screenshot\n` +
      `🔗 Havola — Reels, YouTube\n` +
      `✍️ Matn — nom yoki qisqa tavsif\n\n` +
      `Va filmni berilgan havolalar orqali bemalol tomosha qilishingiz mumkin`,
    help: `ℹ️ <b>Yordam</b>\n\n` +
      `<b>Screenshot orqali:</b>\n` +
      `Film/serialdan istalgan kadrni yuboring. Bot aktyor yuzlarini, kostyum va sahnani tahlil qilib filmni topadi.\n\n` +
      `<b>Matn orqali:</b>\n` +
      `• Film nomi: <code>Iron Man 3</code>\n` +
      `• O'zbekcha: <code>Temir odam</code>\n` +
      `• Tavsif: <code>temir kostyumli qahramonli Marvel filmi</code>\n` +
      `• Aktyor: <code>Robert Downey Jr filmi</code>\n\n` +
      `<b>Video havola (Instagram / YouTube):</b>\n` +
      `Reels yoki YouTube (trailer, Shorts) havolasini yuboring. Matn bilan birga ham bo‘lishi mumkin. Limit: 2 ta / 6 soat (cheksiz ID lar bundan mustasno).\n\n` +
      `<b>Natijada:</b>\n` +
      `🎬 Film nomi (o'zbekcha)\n` +
      `📖 Qisqacha mazmun\n` +
      `▶️ Tomosha havolalari (tugmalar) · 📩 Ulashish (qisqa matn + bot havolasi)\n\n` +
      `<b>Fikr (iltimos, bosing):</b> <b>✅ To‘g‘ri film</b> / <b>❌ Boshqa film</b> — natija to‘g‘ri yoki yo‘qligini bildirish botni yaxshilaydi. ` +
      `<code>/feedback</code> — alohida shikoyat matni.`,
    unknownCommand: (adminHint: string) =>
      `❓ Bunday buyruq topilmadi yoki format noto‘g‘ri.\n\n` +
      `Mavjud: /start, /help, /feedback, /cancel, /lang${adminHint}.\n\n` +
      `Film nomini yozing yoki screenshot yuboring.`,
    textTooShort: '❓ Aniqroq yozing — film nomi, aktyor ismi yoki syujet tavsifi.',
    digitsOnly:
      '❓ Raqamdan film topib bo\'lmaydi.\n\n' +
      'Film <b>nomini</b>, aktyor <b>ismini</b> yoki syujet <b>tavsifini</b> yozing.',
    limitReached: (n: number) =>
      `⚠️ So'rov limiti tugadi (${n} ta / 12 soat).\n` +
      `⏳ 12 soatdan keyin yana ${n} ta ochiladi.`,
    searchStarted: '🔍 Qidiruv boshlandi — kino qidirilmoqda...',
    unclear: `❓ Bir nechta film mos keldi — bittasini tanlab bo‘lmadi.\n\n` +
      `<b>Qayta yozing, aniqroq:</b>\n` +
      `• taxminan yil (masalan: 2014)\n` +
      `• janr (drama, multfilm, ilmiy-fantastika…)\n` +
      `• aktyor yoki rejissor ismi`,
    notFound: `❌ <b>Qidiruv yakunlandi</b> — film topilmadi.\n\n` +
      `Iltimos, qayta urinish oson bo‘lishi uchun <b>kino bilan bog‘liq rasm</b> (kadrs) yoki <b>aniqroq matn</b> yuboring.\n\n` +
      `<b>Matn bilan sinash:</b>\n` +
      `• Film nomi (lotin yoki kirill)\n` +
      `• Serial/film + taxminan yil\n` +
      `• Aktyor yoki rejissor\n` +
      `• Syujet yoki esda qolgan sahna (2–4 qator)`,
    foundLoading: (title: string) => `🎯 "${title}" topildi! Yuklanmoqda...`,
    genericError: '❌ Xatolik yuz berdi. Qayta urinib ko‘ring.',
    photoSearch: '🔍 Qidiruv: rasm tahlil qilinmoqda...',
    photoBurst: (m: number, limit: number) =>
      `⏳ Juda tez-tez rasm yuboryapsiz.\n\n` +
      `Bitta filmni topish uchun 3–4 ta kadr yuborishingiz mumkin — ` +
      `lekin ${m} daqiqada maksimal <b>${limit}</b> ta rasm.\n` +
      `Biroz kutib, yana urinib ko'ring.`,
    photoDaily: (limit: number) =>
      `⚠️ Kunlik rasm limiti tugadi (<b>${limit}</b> ta / kun).\n` +
      `Ertaga yana foydalanishingiz mumkin.`,
    photoNoImage: '❌ Rasm topilmadi.',
    textHintSearch: (hint: string) => `🔍 Qidiruv: «${hint}» bo'yicha matn tekshirilmoqda...`,
    photoHintTried: (hint: string) =>
      `\n\n💡 <i>"${hint}" bo'yicha matn qidiruv ham sinab ko'rildi — topilmadi.</i>`,
    ambiguousIntro:
      '🔍 <b>Bir nechta nomzod topildi</b>, lekin bitta filmni 100% tasdiqlay olmadim.\n\n' +
      'Quyida har birining <b>posteri</b> va <b>qisqa ma’lumoti</b> — o‘zingiz mosini tanlang. ' +
      'Aniqlashtirish uchun yangi kadr yoki matn ham yuborishingiz mumkin.',
    ambiguousVariant: (i: number, n: number) => `Taxminiy variant ${i}/${n}`,
    llmRejectedBody:
      '🔍 <b>Nomzodlar topildi</b>, lekin kadr tanlangan film bilan to‘liq mos kelishini tasdiqlay olmadim — xato deb chiqarib yubormayapman.\n\n' +
      '<b>Keyingi qadam:</b>\n' +
      '• Boshqa kadr yoki aniqroq sahna (yuz / muhit yaxshi ko‘rinsin)\n' +
      '• Rasmga qisqa izoh yozing\n' +
      '• Filmni matn bilan batafsilroq tasvirlab yuboring',
    photoNotFoundBody: '🤔 Bu screenshotdan filmni aniqlay olmadim.',
    photoNextSteps:
      '\n\n<b>Keyingi qadam:</b>\n' +
      '• Yaxshi yoritilgan kadr yoki boshqa sahna yuboring\n' +
      '• Aktyor ismi yoki syujetni qisqacha yozing',
    actorGuess: (names: string) =>
      `\n\n🎭 <b>Taxminiy tanilgan aktyor</b>: ${names}\n` +
      `Quyidagi <i>taxminiy</i> filmlardan biri bo‘lishi mumkin — qidiruvda oching:`,
    actorGuessReels: (names: string) =>
      `\n\n🎭 <b>Taxminiy tanilgan aktyor</b>: ${names}\n` +
      `Quyidagi <i>taxminiy</i> filmlardan biri bo‘lishi mumkin — qidiruvda oching:`,
    detailsLoading: (title: string) => `🎯 «${title}» topildi — ma’lumotlar yig‘ilmoqda...`,
    detailsOut: (title: string) => `🎯 «${title}» topildi — ma’lumotlar chiqarilmoqda...`,
    captionFallbackTitle: 'Film',
    extraSearch: '🔍 Qo‘shimcha qidiruv',
    feedbackYes: '✅ Ha, to‘g‘ri film',
    feedbackNo: '❌ Boshqa film',
    share: '📩 Ulashish',
    confidenceMedium: `🤖 AI taklifi — noto'g'ri bo'lishi mumkin.`,
    feedbackHint: `👆 Natija to‘g‘rimi? Pastdagi 2 ta tugmani bosing — bot uchun juda foydali (1–2 soniya).`,
    surveyThanks: 'Rahmat! Yozganingiz qabul qilindi. ❤️',
    surveyDuplicate: 'Bu javob allaqachon qabul qilingan yoki sessiya tugagan. Kerak bo‘lsa, /help ni oching.',
    feedbackBack: '◀️ Ortga',
    feedbackNoMode: 'Shikoyat rejimi yo‘q. Film qidirishingiz mumkin.',
    donateDismiss: '✖️ Endi ko‘rsatmasin',
    donateThanks: 'Rahmat! ❤️ Tanlovingiz va fikringiz uchun minnatdormiz.',
    channelBtn: '📣 Kanalga obuna bo‘lish',
    channelPromo:
      `Majburiy emas 🙂\n` +
      `Lekin yangilanishlarni o‘tkazib yubormaslik uchun kanalimizga qo‘shilib qo‘ying.\n` +
      `U yerda nafaqat bot yangiliklari, balki har kuni turli film tavsiyalari ham ulashib boriladi 👇\n` +
      `@kinovaai`,
    donateTitle: '🚀 <b>Kinova loyihasini birgalikda saqlab qolamiz!</b>',
    donateCharityHeader: '✨ <b>Xayriya uchun:</b>',
    donateBody:
      "Do'stlar, botimiz bepul bo'lsa-da, uning ortida katta texnik xarajatlar turibdi. Biz reklamasiz va qulay muhitni saqlab qolishga harakat qilyapmiz.\n\n" +
      "Kichik bo'lsa ham sizning yordamingiz — bu yangi server, tezroq javoblar va yanada aqlli AI demakdir. Qo'llab-quvvatlash mutlaqo ixtiyoriy, lekin biz uchun juda qadrli.",
    donateCard: '💳 <b>Karta:</b>',
    donateHolder: '👤 <b>Egasi:</b>',
    donatePayme: 'Payme / havola',
    donateFooter: 'Katta rahmat, bizni tanlaganingiz uchun!',
    reelsCached: '⚡ Bu havola avval qayta ishlangan — natija tez yuklanmoqda...',
    reelsCacheError: '❌ Keshdan natija chiqarishda xatolik. Qayta urinib ko‘ring.',
    reelsLimit: (limit: number, hours: number) =>
      `⚠️ Instagram / YouTube havolalari orqali film qidirish limiti tugadi.\n\n` +
      `<b>${limit}</b> ta urinish / <b>${hours}</b> soat.\n` +
      `Keyingi urinishlar uchun biroz kuting yoki screenshot yuboring / matn bilan yozing.`,
    reelsQueue: '⏳ Navbatda yoki yuklanmoqda (boshqa video ish tugaguncha kutadi)...',
    reelsTimeout: '❌ Video yoki kadr qayta ishlash vaqti tugadi. Keyinroq qayta urinib ko‘ring.',
    fallbackError: "⚠️ Vaqtincha xatolik. Birozdan keyin qayta urinib ko'ring.",
    callbackError: 'Vaqtincha xatolik. Keyinroq qayta urinib ko‘ring.',
    langSet: (lang: string) => `✅ Til: <b>${lang}</b>`,
    langSavedToast: 'Til saqlandi',
    feedbackLine: (botU: string) =>
      `<b>Shikoyat yoki taklif</b> — <a href="https://t.me/${botU}?start=feedback">/feedback</a>`,
    feedbackLinePlain: `<b>Shikoyat yoki taklif</b> — <code>/feedback</code>`,
    langCommandHint: `🌐 Tilni o‘zgartirish: <code>/lang</code>`,
    reelsIgCheck: '🔍 Reels tekshirilmoqda...',
    reelsIgDownload: '📥 Instagram dan video olinmoqda...',
    reelsIgFail:
      '❌ Bu Reels dan filmni aniqlay olmadim.\n\n' +
      '<b>Keyingi qadam:</b>\n' +
      '• Havola ochiq va to‘g‘ri ekanini tekshiring\n' +
      '• Boshqa sahna screenshot yuboring (yuz yoki muhit aniq ko‘rinsin)\n' +
      '• Rasmga qisqa izoh yozing yoki filmni matn bilan tasvirlang',
    reelsIgErr:
      '❌ Reels ni qayta ishlab bo‘lmadi (yuklash yoki Instagram cheklovi). Screenshot yoki matn bilan urinib ko‘ring.',
    reelsYtCheck: '🔍 YouTube havolasi tekshirilmoqda...',
    reelsYtDownload: '📥 YouTube dan video olinmoqda...',
    reelsYtFail:
      '❌ Bu videodan filmni aniqlay olmadim.\n\n' +
      '<b>Keyingi qadam:</b>\n' +
      '• Havola ochiq ekanini tekshiring\n' +
      '• Boshqa sahna screenshot yuboring\n' +
      '• Rasmga izoh yoki filmni matn bilan tasvirlab yozing',
    reelsYtErr:
      '❌ YouTube videoni qayta ishlab bo‘lmadi. Boshqa havola, screenshot yoki matn bilan urinib ko‘ring.',
    statusIdentify: [
      '🎬 Kadr tahlil qilinmoqda...',
      '🔎 Sahna va yuzlar tekshirilmoqda...',
      '🧠 Bir nechta manbadan solishtirish...',
      '⏳ Aniq javob uchun biroz kuting...',
      '✨ Oxirgi tekshiruvlar...',
      '🎞️ Deyarli tayyor...',
    ],
    statusTextSearch: [
      '🔍 Qidiruv: nom va bazalar tekshirilmoqda...',
      '🔎 TMDB / OMDB va boshqa manbalar...',
      '⏳ Aniq javob uchun biroz kuting...',
      '🧠 Syujet bo‘lsa, AI bilan solishtirilmoqda...',
    ],
    statusDetailsLine0: (filmTitle: string) => `🎯 «${filmTitle}» topildi — ma’lumotlar yig‘ilmoqda...`,
    statusDetailsRest: [
      '📽 Poster va tavsif qidirilmoqda...',
      '🔗 Tomosha havolalari tayyorlanmoqda...',
      '⏳ Yana bir oz...',
    ],
  },
  ru: {
    langName: 'Русский',
    langPrompt: '🌐 <b>Выберите язык бота</b> / Bot tilini tanlang:',
    startWelcome: (name: string) =>
      `Здравствуйте, <b>${name}</b>! 🎬\n\n` +
      `<b>Что делает этот бот?</b>\n\n` +
      `По кадру, ссылке на видео или тексту нахожу фильм/сериал и присылаю ссылки для просмотра.\n\n` +
      `<b>Можно отправить</b>\n` +
      `📸 Кадр — скриншот из фильма\n` +
      `🔗 Ссылку — Reels, YouTube\n` +
      `✍️ Текст — название или краткое описание\n\n` +
      `Дальше можно смотреть по найденным ссылкам.`,
    help: `ℹ️ <b>Справка</b>\n\n` +
      `<b>По скриншоту:</b>\n` +
      `Отправьте кадр из фильма или сериала. Бот анализирует лица, костюмы и сцену.\n\n` +
      `<b>По тексту:</b>\n` +
      `• Название: <code>Iron Man 3</code>\n` +
      `• Описание сюжета\n` +
      `• Актёр: <code>фильм с Робертом Дауни-младшим</code>\n\n` +
      `<b>Видео (Instagram / YouTube):</b>\n` +
      `Отправьте ссылку на Reels или YouTube. Можно с текстом. Лимит: 2 запроса / 6 часов (для неограниченных ID — без лимита).\n\n` +
      `<b>В ответе:</b>\n` +
      `🎬 Название\n` +
      `📖 Краткое описание\n` +
      `▶️ Ссылки для просмотра · 📩 Поделиться\n\n` +
      `<b>Оценка:</b> <b>✅ Верно</b> / <b>❌ Другой фильм</b> — это помогает улучшить бота. ` +
      `<code>/feedback</code> — отдельный текст жалобы.`,
    unknownCommand: (adminHint: string) =>
      `❓ Команда не найдена или неверный формат.\n\n` +
      `Доступно: /start, /help, /feedback, /cancel, /lang${adminHint}.\n\n` +
      `Напишите название фильма или отправьте скриншот.`,
    textTooShort: '❓ Напишите подробнее — название фильма, актёра или описание сюжета.',
    digitsOnly:
      '❌ По одним цифрам фильм не найти.\n\n' +
      'Укажите <b>название</b>, <b>актёра</b> или <b>описание сюжета</b>.',
    limitReached: (n: number) =>
      `⚠️ Лимит запросов исчерпан (${n} за 12 часов).\n` +
      `⏳ Через 12 часов снова будет ${n} запросов.`,
    searchStarted: '🔍 Поиск запущен — ищу фильм...',
    unclear: `❓ Несколько фильмов подходят — один выбрать нельзя.\n\n` +
      `<b>Уточните:</b>\n` +
      `• примерный год (например: 2014)\n` +
      `• жанр (драма, мультфильм, фантастика…)\n` +
      `• актёр или режиссёр`,
    notFound: `❌ <b>Поиск завершён</b> — фильм не найден.\n\n` +
      `Попробуйте отправить <b>кадр из фильма</b> или <b>более точный текст</b>.\n\n` +
      `<b>Текстом:</b>\n` +
      `• Название (латиница или кириллица)\n` +
      `• Сериал/фильм + год\n` +
      `• Актёр или режиссёр\n` +
      `• Сюжет или сцена (2–4 предложения)`,
    foundLoading: (title: string) => `🎯 «${title}» найден! Загрузка...`,
    genericError: '❌ Произошла ошибка. Попробуйте позже.',
    photoSearch: '🔍 Поиск: анализ изображения...',
    photoBurst: (m: number, limit: number) =>
      `⏳ Слишком много фото подряд.\n\n` +
      `Для одного фильма можно 3–4 кадра, но не больше <b>${limit}</b> за ${m} мин.\n` +
      `Подождите и попробуйте снова.`,
    photoDaily: (limit: number) =>
      `⚠️ Дневной лимит фото исчерпан (<b>${limit}</b> в день).\n` +
      `Завтра лимит обновится.`,
    photoNoImage: '❌ Изображение не найдено.',
    textHintSearch: (hint: string) => `🔍 Поиск по тексту «${hint}»...`,
    photoHintTried: (hint: string) =>
      `\n\n💡 <i>По тексту «${hint}» тоже искали — не найдено.</i>`,
    ambiguousIntro:
      '🔍 <b>Найдено несколько вариантов</b>, но нельзя уверенно выбрать один.\n\n' +
      'Ниже постеры и описания — выберите сами. Можно отправить другой кадр или текст.',
    ambiguousVariant: (i: number, n: number) => `Вариант ${i}/${n}`,
    llmRejectedBody:
      '🔍 <b>Варианты есть</b>, но кадр не соответствует выбранному фильму — не показываю ошибочно как точный результат.\n\n' +
      '<b>Что сделать:</b>\n' +
      '• Другой кадр (лица и обстановка видны чётче)\n' +
      '• Подпись к фото\n' +
      '• Описание фильма текстом',
    photoNotFoundBody: '🤔 По этому скриншоту фильм не распознан.',
    photoNextSteps:
      '\n\n<b>Что дальше:</b>\n' +
      '• Другой кадр с лучшим освещением\n' +
      '• Имя актёра или краткое описание сюжета',
    actorGuess: (names: string) =>
      `\n\n🎭 <b>Возможные актёры</b>: ${names}\n` +
      `Ниже — <i>примерные</i> фильмы; откройте поиск:`,
    actorGuessReels: (names: string) =>
      `\n\n🎭 <b>Возможные актёры</b>: ${names}\n` +
      `Ниже — <i>примерные</i> фильмы; откройте поиск:`,
    detailsLoading: (title: string) => `🎯 «${title}» найден — собираю данные...`,
    detailsOut: (title: string) => `🎯 «${title}» найден — готовлю ответ...`,
    captionFallbackTitle: 'Фильм',
    extraSearch: '🔍 Доп. поиск',
    feedbackYes: '✅ Верно',
    feedbackNo: '❌ Другой фильм',
    share: '📩 Поделиться',
    confidenceMedium: '🤖 Предложение AI — может быть неточным.',
    feedbackHint: '👆 Верный результат? Нажмите одну из двух кнопок ниже — это помогает боту (1–2 сек).',
    surveyThanks: 'Спасибо! Ваш ответ принят. ❤️',
    surveyDuplicate: 'Ответ уже принят или сессия истекла. См. /help.',
    feedbackBack: '◀️ Назад',
    feedbackNoMode: 'Режим жалобы не активен. Можно искать фильм.',
    donateDismiss: '✖️ Больше не показывать',
    donateThanks: 'Спасибо! ❤️',
    channelBtn: '📣 Подписаться на канал',
    channelPromo:
      `Необязательно 🙂\n` +
      `Но чтобы не пропустить обновления, подпишитесь на наш канал.\n` +
      `Там не только новости бота, но и рекомендации фильмов 👇\n` +
      `@kinovaai`,
    donateTitle: '🚀 <b>Поддержим Kinova вместе!</b>',
    donateCharityHeader: '✨ <b>Поддержка:</b>',
    donateBody:
      'Бот бесплатный, но за ним серверы и AI. Мы стараемся оставаться без навязчивой рекламы.\n\n' +
      'Любая поддержка — это новые серверы, быстрее ответы и умнее бот. Это полностью по желанию.',
    donateCard: '💳 <b>Карта:</b>',
    donateHolder: '👤 <b>Владелец:</b>',
    donatePayme: 'Payme / ссылка',
    donateFooter: 'Большое спасибо за выбор нас!',
    reelsCached: '⚡ Эта ссылка уже обрабатывалась — ответ быстрый...',
    reelsCacheError: '❌ Ошибка при выдаче из кэша. Попробуйте снова.',
    reelsLimit: (limit: number, hours: number) =>
      `⚠️ Лимит поиска по ссылкам Instagram / YouTube.\n\n` +
      `<b>${limit}</b> попыток / <b>${hours}</b> ч.\n` +
      `Подождите или отправьте скриншот / текст.`,
    reelsQueue: '⏳ В очереди или загрузка (ждём другую задачу)...',
    reelsTimeout: '❌ Время обработки видео истекло. Попробуйте позже.',
    fallbackError: '⚠️ Временная ошибка. Попробуйте позже.',
    callbackError: 'Временная ошибка. Попробуйте позже.',
    langSet: (lang: string) => `✅ Язык: <b>${lang}</b>`,
    langSavedToast: 'Язык сохранён',
    feedbackLine: (botU: string) =>
      `<b>Жалоба или предложение</b> — <a href="https://t.me/${botU}?start=feedback">/feedback</a>`,
    feedbackLinePlain: `<b>Жалоба или предложение</b> — <code>/feedback</code>`,
    langCommandHint: `🌐 Сменить язык: <code>/lang</code>`,
    reelsIgCheck: '🔍 Проверяю Reels...',
    reelsIgDownload: '📥 Загружаю видео из Instagram...',
    reelsIgFail:
      '❌ Не удалось определить фильм по этому Reels.\n\n' +
      '<b>Что сделать:</b>\n' +
      '• Проверьте, что ссылка открывается\n' +
      '• Отправьте другой кадр (лица и обстановка видны)\n' +
      '• Добавьте подпись или опишите фильм текстом',
    reelsIgErr:
      '❌ Не удалось обработать Reels (загрузка или ограничение Instagram). Попробуйте скриншот или текст.',
    reelsYtCheck: '🔍 Проверяю ссылку YouTube...',
    reelsYtDownload: '📥 Загружаю видео с YouTube...',
    reelsYtFail:
      '❌ Не удалось определить фильм по этому видео.\n\n' +
      '<b>Что сделать:</b>\n' +
      '• Проверьте ссылку\n' +
      '• Другой кадр\n' +
      '• Подпись или описание фильма',
    reelsYtErr:
      '❌ Не удалось обработать видео YouTube. Другая ссылка, скриншот или текст.',
    statusIdentify: [
      '🎬 Анализ кадра...',
      '🔎 Сцена и лица...',
      '🧠 Сравнение источников...',
      '⏳ Ещё немного...',
      '✨ Финальная проверка...',
      '🎞️ Почти готово...',
    ],
    statusTextSearch: [
      '🔍 Поиск по названию и базам...',
      '🔎 TMDB / OMDB и др....',
      '⏳ Подождите...',
      '🧠 Сюжет сверяется с AI...',
    ],
    statusDetailsLine0: (filmTitle: string) => `🎯 «${filmTitle}» найден — собираю данные...`,
    statusDetailsRest: ['📽 Постер и описание...', '🔗 Ссылки для просмотра...', '⏳ Ещё мгновение...'],
  },
} as const;

export type UiMessages = (typeof UI)[BotLocale];

export function t(locale: BotLocale): UiMessages {
  return UI[locale];
}

export function statusIdentifyLines(locale: BotLocale): string[] {
  return [...t(locale).statusIdentify];
}

export function statusTextSearchLines(locale: BotLocale): string[] {
  return [...t(locale).statusTextSearch];
}

export function statusDetailsLines(locale: BotLocale, filmTitle: string): string[] {
  const u = t(locale);
  return [u.statusDetailsLine0(filmTitle), ...u.statusDetailsRest];
}
