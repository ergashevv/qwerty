import type { Context } from 'grammy';

/** Reply xatolikda ham chatga xabar yetishi uchun */
export async function safeReply(ctx: Context, text: string, extra?: Parameters<Context['reply']>[1]): Promise<void> {
  try {
    await ctx.reply(text, extra);
  } catch (e) {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    try {
      await ctx.api.sendMessage(chatId, text, extra);
    } catch (e2) {
      console.error('safeReply:', (e as Error).message, (e2 as Error).message);
    }
  }
}

export async function safeEditOrNotify(
  ctx: Context,
  chatId: number,
  messageId: number | undefined,
  text: string,
  extra?: Parameters<Context['api']['editMessageText']>[3]
): Promise<void> {
  if (messageId != null) {
    try {
      await ctx.api.editMessageText(chatId, messageId, text, extra);
      return;
    } catch {
      /* yangi xabar */
    }
  }
  await safeReply(ctx, text, extra);
}
