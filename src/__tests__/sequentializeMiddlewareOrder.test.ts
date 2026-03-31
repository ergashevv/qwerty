/**
 * sequentialize va middleware tartibi:
 * 1) Bir xil foydalanuvchidan ketma-ket kelgan xabarlar navbatda — buni test tasdiqlaydi.
 * 2) Callback `messagePipeline` ichidagi sequentialize dan oldin ro‘yxatdan o‘tgan bo‘lsa,
 *    u uzoq xabar ishlovini kutmaydi — aks holda "query is too old" xavfi oshadi.
 */

import { Bot, Composer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { sequentialize } from '@grammyjs/runner';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** handleUpdate uchun tarmoq chaqiruvi shart emas */
const TEST_BOT_ME: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

function testBot() {
  return new Bot('1:AA', { botInfo: TEST_BOT_ME });
}

function textUpdate(uid: number, updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: uid, type: 'private' as const },
      from: { id: uid, is_bot: false, first_name: 'T' },
      text,
    },
  };
}

function callbackUpdate(uid: number, updateId: number, data: string) {
  const base = {
    message_id: 1,
    date: 0,
    chat: { id: uid, type: 'private' as const },
    from: { id: uid, is_bot: false, first_name: 'T' },
  };
  return {
    update_id: updateId,
    callback_query: {
      id: `q${updateId}`,
      from: base.from,
      message: base,
      chat_instance: '1',
      data,
    },
  };
}

describe('sequentialize — haqiqiy navbat va callback mustaqilligi', () => {
  test('bir xil user uchun ikkinchi matn xabari birinchining tugashini kutadi', async () => {
    const events: string[] = [];
    const bot = testBot();
    bot.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'x'));
    bot.on('message:text', async () => {
      events.push('m_start');
      await delay(40);
      events.push('m_end');
    });

    const uid = 9001;
    await Promise.all([
      bot.handleUpdate(textUpdate(uid, 1, 'a') as never),
      bot.handleUpdate(textUpdate(uid, 2, 'b') as never),
    ]);

    expect(events).toEqual(['m_start', 'm_end', 'm_start', 'm_end']);
  });

  test('bot.ts dagi kabi: callback messagePipeline dan tashqari — callback uzoq matn ishlovini kutmaydi', async () => {
    const events: string[] = [];
    const bot = testBot();

    bot.callbackQuery(/^fb:/, async () => {
      events.push('cb');
    });

    const messagePipeline = new Composer();
    messagePipeline.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'x'));
    messagePipeline.on('message:text', async () => {
      events.push('msg_start');
      await delay(80);
      events.push('msg_end');
    });
    bot.use(messagePipeline);

    const uid = 9002;
    await Promise.all([
      bot.handleUpdate(textUpdate(uid, 1, 'hi') as never),
      bot.handleUpdate(callbackUpdate(uid, 2, 'fb:y:tok') as never),
    ]);

    const cbIdx = events.indexOf('cb');
    const msgEndIdx = events.indexOf('msg_end');
    expect(cbIdx).toBeGreaterThanOrEqual(0);
    expect(msgEndIdx).toBeGreaterThanOrEqual(0);
    expect(cbIdx).toBeLessThan(msgEndIdx);
  });

  test('noto‘g‘ri tartib: sequentialize callback dan oldin bo‘lsa, callback oxirida chiqadi', async () => {
    const events: string[] = [];
    const bot = testBot();

    bot.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'x'));
    bot.callbackQuery(/^fb:/, async () => {
      events.push('cb');
    });
    bot.on('message:text', async () => {
      events.push('msg_start');
      await delay(80);
      events.push('msg_end');
    });

    const uid = 9003;
    await Promise.all([
      bot.handleUpdate(textUpdate(uid, 1, 'hi') as never),
      bot.handleUpdate(callbackUpdate(uid, 2, 'fb:y:tok') as never),
    ]);

    expect(events.indexOf('cb')).toBeGreaterThan(events.indexOf('msg_end'));
  });
});
