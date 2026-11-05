/**
 * extractInstagramSource + withGemini parallel testlari (Gemini LLM mock).
 *
 * jest.resetModules() dan keyin mock `geminiChatVision` yangi instance bo'ladi;
 * movieService ham shu instance ni ishlatishi uchun mockni require ketidan olamiz.
 */

jest.mock('../services/geminiClient', () => {
  const actual = jest.requireActual<typeof import('../services/geminiClient')>('../services/geminiClient');
  return {
    ...actual,
    geminiChatText: jest.fn(),
    geminiChatVision: jest.fn(),
  };
});

import type * as MovieServiceTypes from '../services/movieService';

let extractInstagramSource: typeof MovieServiceTypes.extractInstagramSource;
let withGemini: typeof import('../services/geminiClient').withGemini;
let mockGeminiChatVision: jest.MockedFunction<
  typeof import('../services/geminiClient').geminiChatVision
>;

beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test_key';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const gc = require('../services/geminiClient') as typeof import('../services/geminiClient');
  withGemini = gc.withGemini;
  mockGeminiChatVision = gc.geminiChatVision as typeof mockGeminiChatVision;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  extractInstagramSource = require('../services/movieService').extractInstagramSource;
});

function mockVisionResponse(jsonText: string) {
  mockGeminiChatVision.mockResolvedValueOnce(jsonText);
}

function mockVisionError(err: Error) {
  mockGeminiChatVision.mockRejectedValueOnce(err);
}

const DUMMY_BASE64 = Buffer.from('fake-image-data').toString('base64');

describe('extractInstagramSource — to\'g\'ri parse', () => {
  beforeEach(() => mockGeminiChatVision.mockReset());

  test('oddiy account nomini ajratib oladi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('katta harflarni kichikka o\'giradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "KiNoLaR_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('JSON atrofidagi matnni e\'tiborsiz qoldiradi', async () => {
    mockVisionResponse('Here is the result: {"platform": "instagram", "account": "films_uz"} based on the image.');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('films_uz');
  });

  test('bo\'shliqlarni trim qiladi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "  kinolar_720  "}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('@ belgisi bilan kelsa ham tozalaydi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "@uzmovie_org"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('uzmovie_org');
  });
});

describe('extractInstagramSource — Instagram emas holatlari', () => {
  beforeEach(() => mockGeminiChatVision.mockReset());

  test('platform null — null qaytaradi (kino kadri)', async () => {
    mockVisionResponse('{"platform": null, "account": null}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('platform tiktok — null qaytaradi', async () => {
    mockVisionResponse('{"platform": "tiktok", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('platform telegram — null qaytaradi', async () => {
    mockVisionResponse('{"platform": "telegram", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });
});

describe('extractInstagramSource — username validatsiyasi', () => {
  beforeEach(() => mockGeminiChatVision.mockReset());

  test('4 ta belgi — juda qisqa (regex: min 5), null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "kino"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('3 ta belgi — juda qisqa, null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "kno"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('31 ta belgi — juda uzun, null qaytaradi', async () => {
    mockVisionResponse(`{"platform": "instagram", "account": "${'x'.repeat(31)}"}`);
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('bo\'sh joy bilan — regex o\'tmaydi, null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "kinolar 720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('maxsus belgilar (!) — regex o\'tmaydi, null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "kino!uz"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('"null" string — null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": "null"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('bo\'sh string — null qaytaradi', async () => {
    mockVisionResponse('{"platform": "instagram", "account": ""}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('JSON yo\'q javob — null qaytaradi', async () => {
    mockVisionResponse('Bu Instagram screenshoti emas.');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });
});

describe('extractInstagramSource — xatolar yutiladi', () => {
  beforeEach(() => mockGeminiChatVision.mockReset());

  test('LLM network xatosi — null qaytaradi, crash yo\'q', async () => {
    mockVisionError(new Error('Network error'));
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });

  test('Noto\'g\'ri JSON — null qaytaradi', async () => {
    mockVisionResponse('{broken json}');
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });

  test('Bo\'sh javob — null qaytaradi', async () => {
    mockVisionResponse('');
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });
});

describe('withGemini — parallel slot xavfsizligi', () => {
  test('10 ta parallel call — hech biri slot limitidan o\'tmaydi', async () => {
    let maxActive = 0;
    let currentActive = 0;
    const MAX = 10;
    const prev = process.env.GEMINI_MAX_CONCURRENT;
    process.env.GEMINI_MAX_CONCURRENT = String(MAX);

    const trackingCall = () =>
      withGemini(async () => {
        currentActive++;
        maxActive = Math.max(maxActive, currentActive);
        expect(currentActive).toBeLessThanOrEqual(MAX);
        await new Promise((r) => setTimeout(r, 5));
        currentActive--;
        return 'ok';
      });

    await Promise.all(Array.from({ length: 10 }, trackingCall));
    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(MAX);

    if (prev === undefined) delete process.env.GEMINI_MAX_CONCURRENT;
    else process.env.GEMINI_MAX_CONCURRENT = prev;
  });

  test('extractInstagramSource + parallel calllar — slot conflict yo\'q', async () => {
    mockGeminiChatVision.mockReset();
    mockVisionResponse('{"platform": "instagram", "account": "kinolar_720"}');

    let errorOccurred = false;

    const mainCalls = Array.from({ length: 5 }, () =>
      withGemini(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'main-result';
      }).catch(() => {
        errorOccurred = true;
      })
    );

    const igCall = extractInstagramSource(DUMMY_BASE64).catch(() => {
      errorOccurred = true;
    });

    await Promise.all([...mainCalls, igCall]);
    expect(errorOccurred).toBe(false);
  });
});

describe('fire-and-forget pattern — xato yutiladi', () => {
  test('void extractInstagramSource xato bersa ham caller crash bo\'lmaydi', async () => {
    mockGeminiChatVision.mockReset();
    mockVisionError(new Error('Gemini down'));

    let callerError: unknown = null;
    try {
      void extractInstagramSource(DUMMY_BASE64);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      callerError = e;
    }
    expect(callerError).toBeNull();
  });
});
