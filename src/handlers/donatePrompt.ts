import { Context } from 'grammy';
import {
  cooldownAllowsPrompt,
  getDonateConfig,
  nextMilestoneForTrack,
} from '../config/donate';
import {
  incrementPositiveFeedback,
  incrementSuccessfulIdent,
  markDonatePromptShown,
  setDonateOptOut,
} from '../db/donatePrompt';

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDonateMessage(cfg: ReturnType<typeof getDonateConfig>): string {
  const parts: string[] = [
    '🚀 <b>Kinova loyihasini birgalikda saqlab qolamiz!</b>',
    '',
    "Do'stlar, botimiz bepul bo'lsa-da, uning ortida katta texnik xarajatlar turibdi. Biz reklamasiz va qulay muhitni saqlab qolishga harakat qilyapmiz.",
    '',
    "Kichik bo'lsa ham sizning yordamingiz — bu yangi server, tezroq javoblar va yanada aqlli AI demakdir. Qo'llab-quvvatlash mutlaqo ixtiyoriy, lekin biz uchun juda qadrli.",
    '',
    '✨ <b>Xayriya uchun:</b>',
  ];

  if (cfg.cardNumber) {
    parts.push('', `💳 <b>Karta:</b> <code>${escHtml(cfg.cardNumber)}</code>`);
  }
  if (cfg.cardholder) {
    parts.push('', `👤 <b>Egasi:</b> ${escHtml(cfg.cardholder)}`);
  }
  if (cfg.paymeUrl) {
    parts.push('', `🔗 <a href="${escHtml(cfg.paymeUrl)}">Payme / havola</a>`);
  }
  if (cfg.extraNote) {
    parts.push('', escHtml(cfg.extraNote));
  }

  parts.push('', 'Katta rahmat, bizni tanlaganingiz uchun!');
  return parts.join('\n');
}

export async function maybeDonateAfterSuccess(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;

  const row = await incrementSuccessfulIdent(uid);
  if (!row) return;

  if (ctx.chat?.type !== 'private') return;

  const cfg = getDonateConfig();
  if (!cfg.enabled || row.donate_prompt_opt_out) return;

  const next = nextMilestoneForTrack(
    row.successful_ident_total,
    cfg.successMilestones,
    row.donate_last_success_milestone
  );
  if (next == null) return;
  if (!cooldownAllowsPrompt(row.last_donate_prompt_at, cfg.cooldownDays)) return;

  const text = buildDonateMessage(cfg);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: '✖️ Endi ko‘rsatmasin', callback_data: 'donate:dismiss' }]],
    },
  });
  await markDonatePromptShown(uid, 'success', next);
}

export async function maybeDonateAfterFeedbackYes(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;

  const row = await incrementPositiveFeedback(uid);
  if (!row) return;

  if (ctx.chat?.type !== 'private') return;

  const cfg = getDonateConfig();
  if (!cfg.enabled || row.donate_prompt_opt_out) return;

  const next = nextMilestoneForTrack(
    row.positive_feedback_total,
    cfg.feedbackMilestones,
    row.donate_last_feedback_milestone
  );
  if (next == null) return;
  if (!cooldownAllowsPrompt(row.last_donate_prompt_at, cfg.cooldownDays)) return;

  const text = buildDonateMessage(cfg);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: '✖️ Endi ko‘rsatmasin', callback_data: 'donate:dismiss' }]],
    },
  });
  await markDonatePromptShown(uid, 'feedback', next);
}

export async function handleDonateCallback(ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery;
  const data = cq?.data;
  if (!data?.startsWith('donate:')) return;

  const uid = ctx.from?.id;
  if (!uid) {
    await ctx.answerCallbackQuery({ text: 'Xato.', show_alert: true });
    return;
  }

  if (data === 'donate:dismiss') {
    await ctx.answerCallbackQuery({ text: 'Yaxshi, boshqa ko‘rsatmaymiz 🙏' });
    await setDonateOptOut(uid);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* ignore */
    }
    return;
  }

  await ctx.answerCallbackQuery();
}
