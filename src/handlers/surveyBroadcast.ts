import { Context, GrammyError, InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import { getPostgresPool } from '../db/postgres';
import { isAdminTelegram } from '../utils/isAdmin';
import {
  clearSurveyProblemPending,
  deleteSurveySentLog,
  getLatestCampaignIdFromSent,
  getSurveyRecipientIds,
  insertSurveySatisfied,
  insertSurveySentMessage,
  listSurveySentMessages,
  setSurveyProblemPending,
} from '../db/surveyBroadcast';
/** Admin /donate (tasdiqdan keyin) — barcha userlarga bir xil matn + Ha/Yo‘q */
const SURVEY_HTML =
  'Assalamu alaykum!\n\n' +
  "Bot sizga ma'qul kelyaptimi ?";

/** «Ha» bosilganda alohida yuboriladigan qo‘llab-quvvatlash matni */
const SURVEY_HA_REPLY_HTML =
  "💚 <b>Kinova siz bilan o'smoqda!</b>\n\n" +
  "Botimiz sizga foyda keltirayotganidan xursandmiz. Loyihamiz doimiy rivojlanishi, serverlar barqaror ishlashi va sun'iy intellekt sifatini oshirish ma'lum xarajatlarni talab qiladi.\n\n" +
  "Agar loyiha rivojiga hissa qo'shishni istasangiz, ixtiyoriy miqdorda qo'llab-quvvatlashingiz mumkin. Bu bizga yanada yaxshiroq funksiyalarni qo'shishga yordam beradi.\n\n" +
  '👤 <b>Qabul qiluvchi:</b> Ergashev P.\n' +
  '💳 <b>Humo:</b> <code>9860200101841662</code> (nusxa olish uchun ustiga bosing)\n\n' +
  "Sizning e'tiboringiz — biz uchun eng katta motivatsiya!";

const AFTER_NO_HTML =
  "<b>Bot sizga ma'qul kelyaptimi ?</b>\n\n" +
  '✅ Siz <b>Yo‘q</b> deb belgiladingiz.\n\n' +
  'Iltimos, kuzatayotgan muammo yoki taklifingizni qisqa yozing — xabar adminlarga yetadi.';

function surveyKeyboard(campaignId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ha', `svy:y:${campaignId}`)
    .text('❌ Yo‘q', `svy:n:${campaignId}`);
}

export async function runSurveyDeleteCampaign(ctx: Context, campaignIdArg: string | null): Promise<void> {
  const cid =
    campaignIdArg?.trim() ||
    (await getLatestCampaignIdFromSent());
  if (!cid) {
    await ctx.reply(
      'Bazada <code>survey_broadcast_sent</code> jurnali bo‘sh — oxirgi kampaniya uchun ham <code>message_id</code> yo‘q.\n\n' +
        '<b>Nima qilish kerak</b>\n' +
        '1) VPS da yangi kod deploy bo‘lganini va <code>pm2 restart</code> qilinganini tekshiring (jurnal faqat shu versiyadan keyin yuborilgan mass xabarlarda yoziladi).\n' +
        '2) <code>.env</code> da <code>DATABASE_URL</code> shu bot bazasiga ulanganini tekshiring.\n\n' +
        '<b>Eski kampaniya</b> (masalan, jurnal yo‘q paytda yuborilgan) xabarlarini bot orqali ommaviy o‘chirib bo‘lmaydi — Telegram har bir chat uchun alohida <code>message_id</code> beradi va bizda saqlanmagan.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const rows = await listSurveySentMessages(cid);
  if (rows.length === 0) {
    await ctx.reply(
      `Kampaniya <code>${cid}</code> uchun jurnal qatorlari yo‘q.\n\n` +
        `Bu kampaniya jurnal qo‘shilguncha yuborilgan bo‘lishi yoki boshqa bazaga yozilgan bo‘lishi mumkin. Mass <code>deleteMessage</code> uchun jadvalda <code>telegram_id</code> + <code>message_id</code> bo‘lishi kerak.`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  await ctx.reply(
    `⏳ <b>O‘chirish</b> <code>${cid}</code> — ${rows.length} ta xabar...\n` +
      `(<i>48 soatdan eski xabarlar Telegram tomonidan o‘chirilmasligi mumkin</i>)`,
    { parse_mode: 'HTML' }
  );
  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      await ctx.api.deleteMessage(row.telegram_id, row.message_id);
      ok++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 35));
  }
  await deleteSurveySentLog(cid).catch(() => {});
  await ctx.reply(
    `🗑 Kampaniya <code>${cid}</code>\n` +
      `O‘chirildi: ${ok}  |  Xato: ${fail}\n\n` +
      `Jurnal bazadan tozalandi.`,
    { parse_mode: 'HTML' }
  );
}

export function generateSurveyCampaignId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export async function handleSurveyCallback(ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery;
  const data = cq?.data;
  if (!data?.startsWith('svy:')) return;

  const uid = ctx.from?.id;
  if (!uid) {
    await ctx.answerCallbackQuery({ text: 'Xato.', show_alert: true });
    return;
  }

  const parts = data.split(':');
  if (parts.length !== 3 || !parts[2]) {
    await ctx.answerCallbackQuery();
    return;
  }
  const kind = parts[1];
  const campaignId = parts[2];

  const msg = cq?.message;
  if (!msg || !('message_id' in msg)) {
    await ctx.answerCallbackQuery({ text: 'Xabar topilmadi.', show_alert: true });
    return;
  }
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  if (kind === 'y') {
    /** callback API: ctx.reply ba’zan prod da ishlamay qoladi — faqat ctx.api.sendMessage */
    await ctx.answerCallbackQuery();
    try {
      const res = await insertSurveySatisfied(campaignId, uid, true, null);
      await clearSurveyProblemPending(uid);
      if (res === 'duplicate') {
        await ctx.api.sendMessage(uid, 'Siz allaqachon javob bergansiz.', {
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      await ctx.api
        .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
      try {
        await ctx.api.sendMessage(uid, SURVEY_HA_REPLY_HTML, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (htmlErr) {
        console.error('[survey] Ha HTML reply:', (htmlErr as Error).message);
        await ctx.api.sendMessage(
          uid,
          "💚 Kinova siz bilan o'smoqda!\n\n" +
            'Qo‘llab-quvvatlash: Humo 9860200101841662 (Ergashev P.). Rahmat!',
          { link_preview_options: { is_disabled: true } }
        );
      }
    } catch (e) {
      console.error('[survey] Ha DB:', e);
      await ctx.api
        .sendMessage(uid, 'Javobni saqlab bo‘lmadi (bazaga ulanish?). Keyinroq qayta urinib ko‘ring.', {
          link_preview_options: { is_disabled: true },
        })
        .catch((err) => console.error('[survey] Ha fallback send:', err));
    }
    return;
  }

  if (kind === 'n') {
    await setSurveyProblemPending(uid, campaignId);
    await ctx.answerCallbackQuery();
    try {
      await ctx.api.editMessageText(chatId, messageId, AFTER_NO_HTML, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      await ctx.api.sendMessage(
        uid,
        'Iltimos, kuzatayotgan muammo yoki taklifingizni qisqa yozing — xabar adminlarga yetadi.',
        { link_preview_options: { is_disabled: true } }
      );
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

function classifyBroadcastSendError(e: unknown): 'chat_not_found' | 'blocked' | 'other' {
  const raw =
    e instanceof GrammyError
      ? e.description
      : e instanceof Error
        ? e.message
        : String(e);
  const m = raw.toLowerCase();
  if (m.includes('chat not found')) return 'chat_not_found';
  if (
    m.includes('403') ||
    m.includes('forbidden') ||
    m.includes('blocked by the user') ||
    m.includes('bot was blocked')
  ) {
    return 'blocked';
  }
  return 'other';
}

function surveyBroadcastMaxRecipients(): number | null {
  const v = process.env.SURVEY_BROADCAST_MAX_RECIPIENTS?.trim();
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** DB ro‘yxatiga admin ID qo‘shiladi (o‘zi allaqachon bo‘lsa takrorlanmaydi) */
export function mergeAdminRecipientIds(ids: number[], adminUid: number | undefined): number[] {
  if (adminUid == null) return [...ids];
  const s = new Set(ids);
  s.add(adminUid);
  return Array.from(s).sort((a, b) => a - b);
}

/** Test limit: admin har doim ro‘yxatda qolishi uchun */
export function applySurveyBroadcastCap(
  ids: number[],
  cap: number,
  adminUid: number | undefined
): number[] {
  if (ids.length <= cap) return ids;
  if (adminUid != null && ids.includes(adminUid)) {
    const rest = ids.filter((id) => id !== adminUid);
    return [adminUid, ...rest.slice(0, cap - 1)];
  }
  return ids.slice(0, cap);
}

export function buildDonateBroadcastConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ha, yuboraman', 'dbc:ok')
    .text('❌ Bekor', 'dbc:no');
}

/** /donate → tasdiqlash tugmalari (faqat admin) */
export async function handleDonateBroadcastConfirm(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('dbc:')) return;

  if (!isAdminTelegram(ctx.from?.id)) {
    await ctx.answerCallbackQuery({ text: 'Ruxsat yo‘q', show_alert: true });
    return;
  }

  if (data === 'dbc:no') {
    await ctx.answerCallbackQuery({ text: 'Bekor qilindi' });
    try {
      await ctx.editMessageText('❌ Yuborish bekor qilindi.', {
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      await ctx.reply('Bekor qilindi.');
    }
    return;
  }

  if (data === 'dbc:ok') {
    await ctx.answerCallbackQuery();
    const cq = ctx.callbackQuery;
    const msg = cq?.message;
    if (!msg || !('message_id' in msg)) return;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    try {
      await ctx.api.editMessageText(
        chatId,
        messageId,
        '⏳ <b>Barcha foydalanuvchilarga yuborilmoqda…</b>',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch {
      /* ignore */
    }
    await runSurveyBroadcast(ctx, { chatId, messageId });
  }
}

export interface SurveyBroadcastProgressTarget {
  chatId: number;
  messageId: number;
}

/**
 * mass yuborish: katta ro‘yxatda birinchi "⏳" xabar uzoq turadi — progress tahriri va log kerak.
 * Test: SURVEY_BROADCAST_MAX_RECIPIENTS=50
 */
export async function runSurveyBroadcast(
  ctx: Context,
  progress?: SurveyBroadcastProgressTarget
): Promise<void> {
  const campaignId = generateSurveyCampaignId();
  const kb = surveyKeyboard(campaignId);
  const adminUid = ctx.from?.id;
  let ids = mergeAdminRecipientIds(await getSurveyRecipientIds(), adminUid);
  const cap = surveyBroadcastMaxRecipients();
  if (cap != null && ids.length > cap) {
    console.warn(
      `[broadcastsurvey] SURVEY_BROADCAST_MAX_RECIPIENTS=${cap}: faqat ${cap}/${ids.length} userga yuboriladi (admin saqlanadi)`
    );
    ids = applySurveyBroadcastCap(ids, cap, adminUid);
  }

  const total = ids.length;
  let ok = 0;
  let fail = 0;
  let failChatNotFound = 0;
  let failBlocked = 0;
  let failOther = 0;

  const updateProgress = async (): Promise<void> => {
    if (!progress) return;
    const line =
      `⏳ <b>Yuborilmoqda…</b>\n` +
      `Jarayon: ${ok + fail} / ${total}\n` +
      `✅ ${ok}  ·  ⚠️ ${fail}` +
      (fail > 0
        ? `\n<i>chat not found: ${failChatNotFound} · blok: ${failBlocked} · boshqa: ${failOther}</i>`
        : '');
    try {
      await ctx.api.editMessageText(progress.chatId, progress.messageId, line, {
        parse_mode: 'HTML',
      });
    } catch {
      /* "message is not modified" yoki rate limit */
    }
  };

  console.log(`[broadcastsurvey] kampaniya=${campaignId} qabul qiluvchilar=${total}`);
  if (total > 0) {
    console.warn(
      '[broadcastsurvey] Eslatma: xabar faqat SHU BOT_TOKEN (shu bot) bilan chat ochgan userlarga yetadi. ' +
        'Prod bazani test bot bilan ishlatsangiz, «chat not found» ko‘p bo‘ladi — bu ID saqlash xatosi emas.'
    );
  }

  for (let i = 0; i < ids.length; i++) {
    const chatId = ids[i]!;
    try {
      const sent = await ctx.api.sendMessage(chatId, SURVEY_HTML, {
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
      ok++;
      if (sent?.message_id != null) {
        await insertSurveySentMessage(campaignId, chatId, sent.message_id).catch((err) =>
          console.warn('[broadcastsurvey] jurnal:', (err as Error).message)
        );
      }
    } catch (e) {
      fail++;
      const kind = classifyBroadcastSendError(e);
      if (kind === 'chat_not_found') failChatNotFound++;
      else if (kind === 'blocked') failBlocked++;
      else failOther++;

      const msg = e instanceof Error ? e.message : String(e);
      if (i === 0 || fail <= 3) {
        console.warn(`[broadcastsurvey] sendMessage ${chatId} [${kind}]: ${msg.slice(0, 120)}`);
      }
      if (kind === 'blocked') {
        await getPostgresPool()
          .query(`UPDATE users SET blocked_at = COALESCE(blocked_at, NOW()) WHERE telegram_id = $1`, [
            chatId,
          ])
          .catch(() => {});
      }
    }

    if ((i + 1) % 25 === 0 || i === ids.length - 1) {
      await updateProgress();
      console.log(`[broadcastsurvey] ${i + 1}/${total} ok=${ok} fail=${fail}`);
    }

    await new Promise((r) => setTimeout(r, 35));
  }

  const summary =
    `📣 <b>So‘rovnoma yuborildi</b>\n` +
    `Kampaniya: <code>${campaignId}</code>\n` +
    `Muvaffaq: ${ok}  |  Xato: ${fail}  (jami ${total})\n\n` +
    `<b>Xatolar tafsiloti</b> (blok ko‘p emas — odatda ID / «chat not found»):\n` +
    `· <code>chat not found</code> (bilan yozishmagan / bazada yaroqsiz ID): <b>${failChatNotFound}</b>\n` +
    `· Bot bloklangan (403): <b>${failBlocked}</b>\n` +
    `· Boshqa: <b>${failOther}</b>`;
  if (progress) {
    try {
      await ctx.api.editMessageText(progress.chatId, progress.messageId, summary, {
        parse_mode: 'HTML',
      });
    } catch {
      await ctx.reply(summary, { parse_mode: 'HTML' });
    }
  } else {
    await ctx.reply(summary, { parse_mode: 'HTML' });
  }
}
