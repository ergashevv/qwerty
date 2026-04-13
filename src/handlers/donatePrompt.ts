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
import { getUserLocale } from '../db';
import type { BotLocale } from '../i18n/locale';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { t } from '../i18n/strings';

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDonateMessage(cfg: ReturnType<typeof getDonateConfig>, locale: BotLocale): string {
  const u = t(locale);
  const parts: string[] = [u.donateTitle, '', u.donateBody, '', u.donateCharityHeader];

  if (cfg.cardNumber) {
    parts.push('', `${u.donateCard} <code>${escHtml(cfg.cardNumber)}</code>`);
  }
  if (cfg.cardholder) {
    parts.push('', `${u.donateHolder} ${escHtml(cfg.cardholder)}`);
  }
  if (cfg.paymeUrl) {
    parts.push('', `🔗 <a href="${escHtml(cfg.paymeUrl)}">${u.donatePayme}</a>`);
  }
  if (cfg.extraNote) {
    parts.push('', escHtml(cfg.extraNote));
  }

  parts.push('', u.donateFooter);
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

  const locale = await getUserLocale(uid);
  const text = buildDonateMessage(cfg, locale);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: t(locale).donateDismiss, callback_data: 'donate:dismiss' }]],
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

  const locale = await getUserLocale(uid);
  const text = buildDonateMessage(cfg, locale);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: t(locale).donateDismiss, callback_data: 'donate:dismiss' }]],
    },
  });
  await markDonatePromptShown(uid, 'feedback', next);
}

/** So‘rovnoma / boshqa joydan — milestone hisoblamasdan, faqat ma’lumot. */
export async function replyWithDonateInfo(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  const locale: BotLocale = uid ? await getUserLocale(uid) : DEFAULT_LOCALE;
  const cfg = getDonateConfig();
  if (!cfg.enabled) {
    await ctx.reply(t(locale).donateThanks, {
      link_preview_options: { is_disabled: true },
    });
    return;
  }
  const text = buildDonateMessage(cfg, locale);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: t(locale).donateDismiss, callback_data: 'donate:dismiss' }]],
    },
  });
}

export async function handleDonateCallback(ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery;
  const data = cq?.data;
  if (!data?.startsWith('donate:')) return;

  const uid = ctx.from?.id;
  if (!uid) {
    await ctx.answerCallbackQuery({ text: 'Error', show_alert: true });
    return;
  }

  const loc = await getUserLocale(uid);

  if (data === 'donate:dismiss') {
    await ctx.answerCallbackQuery({
      text: loc === 'ru' ? 'Хорошо, больше не покажем 🙏' : 'Yaxshi, boshqa ko‘rsatmaymiz 🙏',
    });
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
