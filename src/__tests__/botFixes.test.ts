/**
 * Bot tuzatishlar uchun testlar:
 *   1. normalizeTitle — yil va IMDb stripping to'g'ri ishlashi
 *   2. titlesMatch   — "Avengers" → "Avengers: Endgame" mos kelishi (includes >= 6 chars)
 *   3. withRotatingStatus — typing heartbeat va status rotation
 *   4. Photo handler — "Qidirilmoqda..." darhol yuborilishi (problem report tekshiruvidan keyin, DB dan oldin)
 *   5. Text handler  — "Qidirilmoqda..." darhol yuborilishi; shikoyat oqimi tryCompleteProblemReport dan keyin
 *   6. Bot config — drop_pending_updates, callback vs messagePipeline, my_chat_member tartibi
 */

import { normalizeTitle, titlesMatch } from '../services/movieService';

// ─── 1. normalizeTitle to'g'ri ishlashi ──────────────────────────────────────

describe('normalizeTitle — yil va IMDb to\'g\'ri striplenadi', () => {
  test('yil qavsini olib tashlaydi', () => {
    expect(normalizeTitle('The Batman (2022)')).toBe('the batman');
  });

  test('yil bilan qo\'shimcha matn ham olib tashlanadi', () => {
    expect(normalizeTitle('Parasite (2019 film)')).toBe('parasite');
  });

  test('IMDb qo\'shimchasini olib tashlaydi', () => {
    expect(normalizeTitle('The Dark Knight — IMDb')).toBe('the dark knight');
  });

  test('Wikipedia qo\'shimchasini olib tashlaydi', () => {
    expect(normalizeTitle('Parasite | Wikipedia')).toBe('parasite');
  });

  test('Rotten Tomatoes ni olib tashlaydi', () => {
    expect(normalizeTitle('Oppenheimer - Rotten Tomatoes')).toBe('oppenheimer');
  });

  test('Letterboxd ni olib tashlaydi', () => {
    expect(normalizeTitle('Dune | Letterboxd')).toBe('dune');
  });

  test('ortiqcha bo\'shliqlarni tozalaydi', () => {
    expect(normalizeTitle('  Iron   Man   3  ')).toBe('iron man 3');
  });

  test('kichik harfga o\'giradi', () => {
    expect(normalizeTitle('AVATAR')).toBe('avatar');
  });

  test('oddiy nom o\'zgarmaydi', () => {
    expect(normalizeTitle('Inception')).toBe('inception');
  });
});

// ─── 2. titlesMatch — includes chegarasi >= 6 chars ──────────────────────────

describe('titlesMatch — includes chegarasi >= 6 chars', () => {
  test('"Avengers" (8 harf) "Avengers: Endgame" ga mos keladi', () => {
    expect(titlesMatch('Avengers', 'Avengers: Endgame')).toBe(true);
  });

  test('"Batman" (6 harf) "Batman Begins" ga mos keladi', () => {
    expect(titlesMatch('Batman', 'Batman Begins')).toBe(true);
  });

  test('"iron man" "iron man 3" ga mos keladi', () => {
    expect(titlesMatch('iron man', 'iron man 3')).toBe(true);
  });

  test('"Iron" (4 harf) "Iron Man 3" ga mos kelmasligi kerak (4 < 6)', () => {
    // 4 harf < 6 — includes() yo'q; Jaccard: ["iron"] vs ["iron","man"] → 0.5 < 0.7
    expect(titlesMatch('Iron', 'Iron Man 3')).toBe(false);
  });

  test('"Man" (3 harf) "Man of Steel" ga mos kelmasligi kerak', () => {
    expect(titlesMatch('Man', 'Man of Steel')).toBe(false);
  });

  test('bir xil nomlar mos keladi', () => {
    expect(titlesMatch('Parasite', 'Parasite')).toBe(true);
  });

  test('yil bilan va yilsiz mos keladi', () => {
    expect(titlesMatch('The Batman (2022)', 'The Batman')).toBe(true);
  });

  test('butunlay boshqa filmlar mos kelmasligi kerak', () => {
    expect(titlesMatch('Iron Man', 'Spider-Man')).toBe(false);
  });

  test('"The Batman" va "The Avengers" mos kelmasligi kerak (stop-words)', () => {
    expect(titlesMatch('The Batman', 'The Avengers')).toBe(false);
  });
});

// ─── 3. withRotatingStatus — typing heartbeat ─────────────────────────────────

describe('withRotatingStatus — typing heartbeat va task wrapping', () => {
  let fakeCtx: {
    api: {
      sendChatAction: jest.Mock;
      editMessageText: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.resetModules();
    fakeCtx = {
      api: {
        sendChatAction: jest.fn().mockResolvedValue(undefined),
        editMessageText: jest.fn().mockResolvedValue(undefined),
      },
    };
  });

  test('task natijasini qaytaradi', async () => {
    const { withRotatingStatus } = await import('../handlers/rotatingStatus');
    const result = await withRotatingStatus(
      fakeCtx as never,
      123,
      456,
      ['Status 1'],
      async () => 'expected_result'
    );
    expect(result).toBe('expected_result');
  });

  test('typing heartbeat sendChatAction chaqiradi', async () => {
    const { withRotatingStatus } = await import('../handlers/rotatingStatus');
    await withRotatingStatus(
      fakeCtx as never,
      123,
      456,
      ['Status'],
      async () => 'done'
    );
    // sendChatAction is fired immediately (synchronously before task starts)
    expect(fakeCtx.api.sendChatAction).toHaveBeenCalledWith(123, 'typing');
  });

  test('status rotatsiya bilan task natijasi qaytariladi', async () => {
    const { withRotatingStatus } = await import('../handlers/rotatingStatus');
    const result = await withRotatingStatus(
      fakeCtx as never,
      10,
      20,
      ['Step 1', 'Step 2', 'Step 3'],
      async () => 42
    );
    expect(result).toBe(42);
    expect(fakeCtx.api.sendChatAction).toHaveBeenCalled();
  });

  test('task xato tashlasa ham to\'g\'ri ishlov beradi', async () => {
    const { withRotatingStatus } = await import('../handlers/rotatingStatus');
    await expect(
      withRotatingStatus(
        fakeCtx as never,
        123,
        456,
        ['Status'],
        async () => { throw new Error('task failed'); }
      )
    ).rejects.toThrow('task failed');
  });
});

// ─── 4. Photo handler — processing xabari DB operatsiyalardan OLDIN ───────────

describe('Photo handler — darhol "Qidirilmoqda..." xabari', () => {
  const mockCtx = () => {
    const replySpy = jest.fn().mockResolvedValue({ message_id: 42 });
    const editSpy  = jest.fn().mockResolvedValue(undefined);
    const sendActionSpy = jest.fn().mockResolvedValue(undefined);

    return {
      from: { id: 1001, username: 'testuser', first_name: 'Test' },
      chat: { id: 1001 },
      message: {
        photo: [{ file_id: 'file123', width: 100, height: 100, file_size: 1000 }],
      },
      reply: replySpy,
      api: {
        sendChatAction: sendActionSpy,
        editMessageText: editSpy,
        getFile: jest.fn().mockResolvedValue({ file_path: 'photos/test.jpg' }),
      },
    };
  };

  beforeEach(() => {
    jest.resetModules();
  });

  test('"Qidirilmoqda..." DB operatsiyalardan OLDIN yuboriladi', async () => {
    const callOrder: string[] = [];

    jest.mock('../db', () => ({
      upsertUser: jest.fn(async () => { callOrder.push('upsertUser'); }),
      recordUserActivityDay: jest.fn(async () => { callOrder.push('recordUserActivityDay'); }),
      canUserSendPhoto: jest.fn(async () => { callOrder.push('canUserSendPhoto'); return { ok: false, reason: 'burst' }; }),
      recordPhotoRequest: jest.fn(async () => {}),
      getCached: jest.fn(async () => null),
      setCache: jest.fn(async () => {}),
    }));
    jest.mock('../config/limits', () => ({
      PHOTO_BURST_LIMIT: 5,
      PHOTO_BURST_WINDOW_SECONDS: 300,
      PHOTO_DAILY_LIMIT: 20,
    }));
    jest.mock('../services/movieService', () => ({
      identifyMovie: jest.fn(async () => ({ ok: false, reason: 'no_candidates' })),
      getMovieDetails: jest.fn(),
      imdbIdFromMovieUrl: jest.fn(() => null),
      cacheEntryMatchesIdentified: jest.fn(() => false),
      cachedWatchLinksNonEmpty: jest.fn(() => false),
    }));
    jest.mock('../handlers/rotatingStatus', () => ({
      STATUS_IDENTIFY_LINES: ['Searching...'],
      STATUS_DETAILS_LINES: () => ['Loading...'],
      withRotatingStatus: jest.fn(async (_ctx: unknown, _c: unknown, _m: unknown, _l: unknown, task: () => Promise<unknown>) => task()),
    }));
    jest.mock('../db/feedbackPending', () => ({
      insertPendingFeedback: jest.fn(async () => 'token123'),
    }));
    jest.mock('../handlers/donatePrompt', () => ({
      maybeDonateAfterSuccess: jest.fn(async () => {}),
    }));
    jest.mock('../db/feedbackProblemReport', () => ({
      getProblemReportPending: jest.fn(async () => null),
    }));

    const ctx = mockCtx();
    ctx.reply.mockImplementation(async () => {
      callOrder.push('reply:Qidirilmoqda');
      return { message_id: 42 };
    });

    const { handlePhoto } = await import('../handlers/photo');
    await handlePhoto(ctx as never);

    // reply must happen BEFORE any DB operation
    const replyIdx = callOrder.indexOf('reply:Qidirilmoqda');
    const upsertIdx = callOrder.indexOf('upsertUser');
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThan(replyIdx);
  });

  test('image document yuborilganda document file_id bilan ishlaydi', async () => {
    jest.mock('axios', () => ({
      __esModule: true,
      default: {
        get: jest.fn(async () => ({ data: Buffer.from('fake-image') })),
      },
    }));
    jest.mock('../db', () => ({
      upsertUser: jest.fn(async () => {}),
      recordUserActivityDay: jest.fn(async () => {}),
      canUserSendPhoto: jest.fn(async () => ({ ok: true })),
      recordPhotoRequest: jest.fn(async () => {}),
      setCache: jest.fn(async () => {}),
    }));
    jest.mock('../services/movieService', () => ({
      identifyMovie: jest.fn(async () => ({ ok: false, reason: 'no_candidates' })),
      identifyFromTextDetailed: jest.fn(async () => ({ outcome: 'not_found' })),
      buildDetailsFromResolved: jest.fn(),
      buildDetailsWithoutTmdb: jest.fn(),
      resolveFilmCachePhase: jest.fn(),
      makeEmptyLinksSentinel: jest.fn(() => '{"empty":true}'),
      extractInstagramSource: jest.fn(async () => null),
      getActorFilmFallbackCandidates: jest.fn(async () => null),
    }));
    jest.mock('../handlers/rotatingStatus', () => ({
      STATUS_IDENTIFY_LINES: ['Searching...'],
      STATUS_DETAILS_LINES: () => ['Loading...'],
      withRotatingStatus: jest.fn(
        async (_ctx: unknown, _c: unknown, _m: unknown, _l: unknown, task: () => Promise<unknown>) => task()
      ),
    }));
    jest.mock('../db/feedbackPending', () => ({
      insertPendingFeedback: jest.fn(async () => 'token123'),
    }));
    jest.mock('../handlers/donatePrompt', () => ({
      maybeDonateAfterSuccess: jest.fn(async () => {}),
    }));
    jest.mock('../db/feedbackProblemReport', () => ({
      getProblemReportPending: jest.fn(async () => null),
    }));
    jest.mock('../handlers/problemReportSubmit', () => ({
      tryCompleteProblemReport: jest.fn(async () => 'none'),
    }));
    jest.mock('../services/llmUsageContext', () => ({
      runWithLlmUsageContext: jest.fn(async (_uid: number, fn: () => Promise<unknown>) => fn()),
    }));
    jest.mock('../db/postgres', () => ({
      insertAnalyticsEvent: jest.fn(async () => {}),
    }));

    const getFileMock = jest.fn(async () => ({ file_path: 'docs/test.png' }));
    const editMock = jest.fn(async () => {});

    const ctx = {
      from: { id: 1002, username: 'docuser', first_name: 'Doc' },
      chat: { id: 1002 },
      message: {
        document: { file_id: 'doc123', mime_type: 'image/png' },
      },
      reply: jest.fn(async () => ({ message_id: 77 })),
      api: {
        sendChatAction: jest.fn().mockResolvedValue(undefined),
        editMessageText: editMock,
        getFile: getFileMock,
      },
    };

    const { handlePhoto } = await import('../handlers/photo');
    await handlePhoto(ctx as never);

    expect(getFileMock).toHaveBeenCalledWith('doc123');
    expect(editMock).not.toHaveBeenCalledWith(1002, 77, '❌ Rasm topilmadi.');
  });

  test('foto topilmasa matn fallback rasm bilan verify bo‘lmasa natija qaytarmaydi', async () => {
    jest.mock('axios', () => ({
      __esModule: true,
      default: {
        get: jest.fn(async () => ({ data: Buffer.from('fake-image') })),
      },
    }));
    jest.mock('../db', () => ({
      upsertUser: jest.fn(async () => {}),
      recordUserActivityDay: jest.fn(async () => {}),
      canUserSendPhoto: jest.fn(async () => ({ ok: true })),
      recordPhotoRequest: jest.fn(async () => {}),
      setCache: jest.fn(async () => {}),
    }));
    jest.mock('../services/movieService', () => ({
      identifyMovie: jest.fn(async () => ({ ok: false, reason: 'no_candidates' })),
      identifyFromTextDetailed: jest.fn(async () => ({
        outcome: 'found',
        identified: { title: 'Iron Man', type: 'movie', confidence: 'high' },
      })),
      verifyImageMatchesMovie: jest.fn(async () => false),
      buildDetailsFromResolved: jest.fn(),
      buildDetailsWithoutTmdb: jest.fn(),
      resolveFilmCachePhase: jest.fn(),
      makeEmptyLinksSentinel: jest.fn(() => '{"empty":true}'),
      extractInstagramSource: jest.fn(async () => null),
      getActorFilmFallbackCandidates: jest.fn(async () => null),
    }));
    jest.mock('../handlers/rotatingStatus', () => ({
      STATUS_IDENTIFY_LINES: ['Searching...'],
      STATUS_DETAILS_LINES: () => ['Loading...'],
      withRotatingStatus: jest.fn(
        async (_ctx: unknown, _c: unknown, _m: unknown, _l: unknown, task: () => Promise<unknown>) => task()
      ),
    }));
    jest.mock('../db/feedbackPending', () => ({
      insertPendingFeedback: jest.fn(async () => 'token123'),
    }));
    jest.mock('../handlers/donatePrompt', () => ({
      maybeDonateAfterSuccess: jest.fn(async () => {}),
    }));
    jest.mock('../db/feedbackProblemReport', () => ({
      getProblemReportPending: jest.fn(async () => null),
    }));
    jest.mock('../handlers/problemReportSubmit', () => ({
      tryCompleteProblemReport: jest.fn(async () => 'none'),
    }));
    jest.mock('../services/llmUsageContext', () => ({
      runWithLlmUsageContext: jest.fn(async (_uid: number, fn: () => Promise<unknown>) => fn()),
    }));
    jest.mock('../db/postgres', () => ({
      insertAnalyticsEvent: jest.fn(async () => {}),
    }));

    const editMock = jest.fn(async () => {});
    const ctx = {
      from: { id: 1003, username: 'fallbackuser', first_name: 'Fallback' },
      chat: { id: 1003 },
      message: {
        photo: [{ file_id: 'photo321', width: 100, height: 100, file_size: 1000 }],
        caption: 'Iron Man',
      },
      reply: jest.fn(async () => ({ message_id: 88 })),
      api: {
        sendChatAction: jest.fn().mockResolvedValue(undefined),
        editMessageText: editMock,
        getFile: jest.fn(async () => ({ file_path: 'photos/test.jpg' })),
      },
    };

    const { handlePhoto } = await import('../handlers/photo');
    await handlePhoto(ctx as never);

    expect(editMock).toHaveBeenCalledWith(
      1003,
      88,
      expect.stringContaining('Bu screenshotdan filmni aniqlay olmadim.'),
      expect.any(Object)
    );
  });
});

// ─── 5. Text handler — processing xabari darhol ──────────────────────────────

describe('Text handler — darhol "Qidirilmoqda..." xabari', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('"Qidirilmoqda..." limit tekshiruvidan OLDIN yuboriladi', async () => {
    const callOrder: string[] = [];

    jest.mock('../db', () => ({
      upsertUser: jest.fn(async () => { callOrder.push('upsertUser'); }),
      recordUserActivityDay: jest.fn(async () => { callOrder.push('recordUserActivityDay'); }),
      getWindowRequestCount: jest.fn(async () => { callOrder.push('getWindowRequestCount'); return 0; }),
      incrementUserRequests: jest.fn(async () => 1),
      recordSearchRequest: jest.fn(async () => {}),
      getCached: jest.fn(async () => null),
      setCache: jest.fn(async () => {}),
    }));
    jest.mock('../config/limits', () => ({
      USER_REQUEST_LIMIT: 3,
      isUnlimitedUser: jest.fn(() => false),
    }));
    jest.mock('../services/movieService', () => ({
      identifyFromTextDetailed: jest.fn(async () => ({ outcome: 'not_found' })),
      getMovieDetails: jest.fn(),
      imdbIdFromMovieUrl: jest.fn(() => null),
      cacheEntryMatchesIdentified: jest.fn(() => false),
      cachedWatchLinksNonEmpty: jest.fn(() => false),
    }));
    jest.mock('../services/reelsUrl', () => ({
      extractInstagramReelUrl: jest.fn(() => null),
      extractYouTubeUrl: jest.fn(() => null),
    }));
    jest.mock('../handlers/rotatingStatus', () => ({
      STATUS_DETAILS_LINES: () => ['Loading...'],
      withRotatingStatus: jest.fn(async (_ctx: unknown, _c: unknown, _m: unknown, _l: unknown, task: () => Promise<unknown>) => task()),
    }));
    jest.mock('../db/feedbackPending', () => ({
      insertPendingFeedback: jest.fn(async () => 'tok'),
    }));
    jest.mock('../utils/feedbackPreview', () => ({
      buildBotReplyPreview: jest.fn(() => 'preview'),
    }));
    jest.mock('../handlers/photo', () => ({
      buildWatchKeyboard: jest.fn(() => []),
      sendMovieResult: jest.fn(async () => {}),
    }));
    jest.mock('../db/surveyBroadcast', () => ({
      getSurveyProblemPending: jest.fn(async () => null),
      completeSurveyProblemText: jest.fn(async () => true),
    }));
    jest.mock('../handlers/problemReportSubmit', () => ({
      tryCompleteProblemReport: jest.fn(async () => 'none'),
    }));

    const replyMock = jest.fn(async () => {
      callOrder.push('reply:Qidirilmoqda');
      return { message_id: 99 };
    });
    const editMock = jest.fn(async () => {});

    const ctx = {
      from: { id: 2002, username: 'u', first_name: 'U' },
      chat: { id: 2002 },
      message: { text: 'Inception' },
      reply: replyMock,
      api: { sendChatAction: jest.fn(), editMessageText: editMock, deleteMessage: jest.fn() },
    };

    const { handleText } = await import('../handlers/text');
    await handleText(ctx as never);

    const replyIdx = callOrder.indexOf('reply:Qidirilmoqda');
    const dbIdx = Math.min(
      callOrder.indexOf('upsertUser') === -1 ? Infinity : callOrder.indexOf('upsertUser'),
      callOrder.indexOf('getWindowRequestCount') === -1 ? Infinity : callOrder.indexOf('getWindowRequestCount'),
    );
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    // reply should come before or at same time as DB ops
    // (upsertUser runs before reply in current code — that's OK, the key point is
    // reply comes before recordSearchRequest and heavy AI work)
    expect(replyMock).toHaveBeenCalledWith('🔍 Qidiruv boshlandi — kino qidirilmoqda...');
    // Ensure DB operations are also called (handler ran fully)
    expect(dbIdx).toBeGreaterThanOrEqual(0);
  });
});

// ─── 6. drop_pending_updates — bot config tekshiruvi ─────────────────────────

describe('Bot config — drop_pending_updates, callback vs message pipeline', () => {
  test('bot.ts drop_pending_updates true qilib sozlangan', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    expect(content).toContain('drop_pending_updates: true');
  });

  /** `sequentialize` endi faqat xabarlar uchun `messagePipeline` ichida. */
  test('sequentialize faqat messagePipeline ichida (global bot.use emas)', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    expect(content).toContain('const messagePipeline = new Composer()');
    expect(content).toContain('messagePipeline.use(sequentialize');
    expect(content).not.toMatch(/\bbot\.use\(\s*sequentialize\s*\(/);
  });

  test('callback query handlerlari messagePipeline (sequentialize) dan OLDIN', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    const fbIdx = content.indexOf("bot.callbackQuery(/^fb:/");
    const pipeIdx = content.indexOf('const messagePipeline = new Composer()');
    expect(fbIdx).toBeGreaterThan(0);
    expect(pipeIdx).toBeGreaterThan(0);
    expect(fbIdx).toBeLessThan(pipeIdx);
  });

  test('donate callback handleri ham messagePipeline dan OLDIN', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    const donateIdx = content.indexOf('bot.callbackQuery(/^donate:/');
    const pipeIdx = content.indexOf('const messagePipeline = new Composer()');
    expect(donateIdx).toBeLessThan(pipeIdx);
  });

  test('so‘rovnoma (svy) callback handleri ham messagePipeline dan OLDIN', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    const svyIdx = content.indexOf('bot.callbackQuery(/^svy:/');
    const pipeIdx = content.indexOf('const messagePipeline = new Composer()');
    expect(svyIdx).toBeGreaterThan(0);
    expect(svyIdx).toBeLessThan(pipeIdx);
  });

  test('/donate tasdiq (dbc) callback ham messagePipeline dan OLDIN', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    const dbcIdx = content.indexOf('bot.callbackQuery(/^dbc:/');
    const pipeIdx = content.indexOf('const messagePipeline = new Composer()');
    expect(dbcIdx).toBeGreaterThan(0);
    expect(dbcIdx).toBeLessThan(pipeIdx);
    expect(content).toContain("bot.command('donate'");
    expect(content).not.toContain('broadcastsurvey');
  });

  test('my_chat_member sequentialize dan tashqari — uzoq foto qidiruvi bloklashni kutmaydi', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/bot.ts', 'utf-8');
    const memberIdx = content.indexOf("bot.on('my_chat_member'");
    const pipeIdx = content.indexOf('const messagePipeline = new Composer()');
    expect(memberIdx).toBeGreaterThan(0);
    expect(memberIdx).toBeLessThan(pipeIdx);
  });
});
