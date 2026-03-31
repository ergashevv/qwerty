/**
 * So‘rovnoma: Ha/Yo‘q callback va mass yuborish (Telegram API mock).
 */

jest.mock('../db/postgres', () => ({
  getPostgresPool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
  })),
}));

jest.mock('../db/surveyBroadcast', () => ({
  insertSurveySatisfied: jest.fn(),
  clearSurveyProblemPending: jest.fn(),
  setSurveyProblemPending: jest.fn(),
  getSurveyRecipientIds: jest.fn(),
}));

import {
  applySurveyBroadcastCap,
  handleDonateBroadcastConfirm,
  handleSurveyCallback,
  mergeAdminRecipientIds,
  runSurveyBroadcast,
} from '../handlers/surveyBroadcast';
import {
  insertSurveySatisfied,
  clearSurveyProblemPending,
  setSurveyProblemPending,
  getSurveyRecipientIds,
} from '../db/surveyBroadcast';

describe('handleSurveyCallback — inline tugmalar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function baseCtx(over: Record<string, unknown> = {}) {
    return {
      callbackQuery: { data: 'svy:y:abc123dead456' },
      from: { id: 999 },
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  it('Ha (svy:y) → answerCallbackQuery, DB insert, markup olib tashlash, HTML reply', async () => {
    (insertSurveySatisfied as jest.Mock).mockResolvedValue('inserted');
    const ctx = baseCtx();
    await handleSurveyCallback(ctx as never);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(insertSurveySatisfied).toHaveBeenCalledWith('abc123dead456', 999, true, null);
    expect(clearSurveyProblemPending).toHaveBeenCalledWith(999);
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [] } });
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Kinova siz bilan o'smoqda"),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('Ha — duplicate bo‘lsa faqat duplicate matni', async () => {
    (insertSurveySatisfied as jest.Mock).mockResolvedValue('duplicate');
    const ctx = baseCtx();
    await handleSurveyCallback(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith('Siz allaqachon javob bergansiz.');
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it('Yo‘q (svy:n) → pending + xabarni tahrirlash', async () => {
    (setSurveyProblemPending as jest.Mock).mockResolvedValue(undefined);
    const ctx = baseCtx({
      callbackQuery: { data: 'svy:n:campaign999zzz' },
    });
    await handleSurveyCallback(ctx as never);

    expect(setSurveyProblemPending).toHaveBeenCalledWith(999, 'campaign999zzz');
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('belgiladingiz'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('svy: bilan boshlanmagan data — hech narsa', async () => {
    const ctx = baseCtx({ callbackQuery: { data: 'fb:yes:tok' } });
    await handleSurveyCallback(ctx as never);
    expect(insertSurveySatisfied).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });
});

describe('runSurveyBroadcast — barcha qabul qiluvchilarga', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SURVEY_BROADCAST_MAX_RECIPIENTS;
  });

  it('har bir telegram_id ga sendMessage chaqiriladi (DB ro‘yxati = yuborishlar soni)', async () => {
    const ids = [1001, 2002, 3003, 4004];
    (getSurveyRecipientIds as jest.Mock).mockResolvedValue(ids);

    const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
    const editMessageText = jest.fn().mockResolvedValue(undefined);

    const ctx = {
      api: { sendMessage, editMessageText },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await runSurveyBroadcast(ctx as never, { chatId: 55, messageId: 77 });

    expect(getSurveyRecipientIds).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(ids.length);

    const chatIds = sendMessage.mock.calls.map((c) => c[0] as number);
    expect(chatIds).toEqual(ids);

    for (const call of sendMessage.mock.calls) {
      expect(call[1]).toContain('Assalamu');
      expect(call[2]).toMatchObject({
        reply_markup: expect.anything(),
        link_preview_options: { is_disabled: true },
      });
    }

    const summaryCalls = editMessageText.mock.calls.filter((c) =>
      String(c[2]).includes('Muvaffaq')
    );
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('SURVEY_BROADCAST_MAX_RECIPIENTS — faqat boshidagi N tagacha', async () => {
    process.env.SURVEY_BROADCAST_MAX_RECIPIENTS = '2';
    (getSurveyRecipientIds as jest.Mock).mockResolvedValue([1, 2, 3, 4, 5]);

    const sendMessage = jest.fn().mockResolvedValue({});
    const ctx = {
      api: { sendMessage, editMessageText: jest.fn().mockResolvedValue(undefined) },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await runSurveyBroadcast(ctx as never, { chatId: 1, messageId: 1 });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('admin bazada bo‘lmasa ham yuboriladi (merge)', async () => {
    delete process.env.SURVEY_BROADCAST_MAX_RECIPIENTS;
    (getSurveyRecipientIds as jest.Mock).mockResolvedValue([10, 20]);
    const sendMessage = jest.fn().mockResolvedValue({});
    const ctx = {
      from: { id: 99 },
      api: { sendMessage, editMessageText: jest.fn().mockResolvedValue(undefined) },
      reply: jest.fn().mockResolvedValue(undefined),
    };
    await runSurveyBroadcast(ctx as never, { chatId: 1, messageId: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    const targets = sendMessage.mock.calls.map((c) => c[0] as number).sort((a, b) => a - b);
    expect(targets).toEqual([10, 20, 99]);
  });
});

describe('mergeAdminRecipientIds / applySurveyBroadcastCap', () => {
  it('admin ro‘yxatga qo‘shiladi, tartiblangan', () => {
    expect(mergeAdminRecipientIds([3, 1], 2)).toEqual([1, 2, 3]);
  });

  it('cap: admin birinchi qoladi', () => {
    expect(applySurveyBroadcastCap([1, 2, 3, 4, 5], 2, 5)).toEqual([5, 1]);
  });
});

describe('handleDonateBroadcastConfirm — /donate tasdiq', () => {
  afterEach(() => {
    delete process.env.ADMIN_TELEGRAM_ID;
    jest.restoreAllMocks();
  });

  it('dbc:ok → tahrir + mass yuborish (admin ham ro‘yxatda)', async () => {
    process.env.ADMIN_TELEGRAM_ID = '42';
    (getSurveyRecipientIds as jest.Mock).mockResolvedValue([]);
    const editMessageText = jest.fn().mockResolvedValue(undefined);
    const sendMessage = jest.fn().mockResolvedValue({});
    const ctx = {
      callbackQuery: {
        id: 'x',
        data: 'dbc:ok',
        message: { chat: { id: 10 }, message_id: 20 },
      },
      from: { id: 42 },
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      api: { editMessageText, sendMessage },
    };
    await handleDonateBroadcastConfirm(ctx as never);
    expect(editMessageText).toHaveBeenCalledWith(
      10,
      20,
      expect.stringContaining('Barcha'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(42);
  });

  it('dbc:no → bekor matni', async () => {
    process.env.ADMIN_TELEGRAM_ID = '42';
    const editMessageText = jest.fn().mockResolvedValue(undefined);
    const ctx = {
      callbackQuery: {
        data: 'dbc:no',
        message: { chat: { id: 1 }, message_id: 2 },
      },
      from: { id: 42 },
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      editMessageText,
      reply: jest.fn().mockResolvedValue(undefined),
      api: {},
    };
    await handleDonateBroadcastConfirm(ctx as never);
    expect(editMessageText).toHaveBeenCalledWith(
      '❌ Yuborish bekor qilindi.',
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } })
    );
  });

  it('admin emas → alert', async () => {
    process.env.ADMIN_TELEGRAM_ID = '42';
    const ctx = {
      callbackQuery: { data: 'dbc:ok', message: { chat: { id: 1 }, message_id: 1 } },
      from: { id: 999 },
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      api: {},
    };
    await handleDonateBroadcastConfirm(ctx as never);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Ruxsat'), show_alert: true })
    );
  });
});
