/**
 * extractInstagramSource + withGemini concurrent slot testlari
 *
 * Tekshiriladigan holatlar:
 *  1. Account nomi to'g'ri parse qilinadi
 *  2. {"account": null} — null qaytaradi
 *  3. Instagram emas rasm — null qaytaradi
 *  4. Gemini xato bersa — null qaytaradi, crash yo'q
 *  5. Parallel calllar MAX_CONCURRENT ni buzmaydi
 *  6. fire-and-forget (void) pattern xatoni yutadi
 */

import { extractInstagramSource } from '../services/movieService';
import { withGemini } from '../services/geminiClient';

// @google/generative-ai ni to'liq mock qilamiz
jest.mock('@google/generative-ai', () => {
  const mockGenerateContent = jest.fn();
  const mockGetGenerativeModel = jest.fn(() => ({
    generateContent: mockGenerateContent,
  }));
  return {
    GoogleGenerativeAI: jest.fn(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    })),
    DynamicRetrievalMode: { MODE_DYNAMIC: 'MODE_DYNAMIC' },
    __mockGenerateContent: mockGenerateContent,
  };
});

// Mock orqali generateContent ga to'g'ridan-to'g'ri kirish uchun helper
function getMockGenerateContent(): jest.MockedFunction<() => Promise<{ response: { text: () => string } }>> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@google/generative-ai').__mockGenerateContent;
}

function mockGeminiResponse(jsonText: string) {
  getMockGenerateContent().mockResolvedValueOnce({
    response: { text: () => jsonText },
  });
}

function mockGeminiError(err: Error) {
  getMockGenerateContent().mockRejectedValueOnce(err);
}

const DUMMY_BASE64 = Buffer.from('fake-image-data').toString('base64');

// ─── 1. To'g'ri parse ────────────────────────────────────────────────────────

describe('extractInstagramSource — to\'g\'ri parse', () => {
  beforeEach(() => getMockGenerateContent().mockReset());

  test('oddiy account nomini ajratib oladi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('katta harflarni kichikka o\'giradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "KiNoLaR_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('JSON atrofidagi matnni e\'tiborsiz qoldiradi', async () => {
    mockGeminiResponse('Here is the result: {"platform": "instagram", "account": "films_uz"} based on the image.');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('films_uz');
  });

  test('bo\'shliqlarni trim qiladi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "  kinolar_720  "}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('kinolar_720');
  });

  test('@ belgisi bilan kelsa ham tozalaydi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "@uzmovie_org"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBe('uzmovie_org');
  });
});

// ─── 2. Platform filtri — Instagram emas → null ───────────────────────────────

describe('extractInstagramSource — Instagram emas holatlari', () => {
  beforeEach(() => getMockGenerateContent().mockReset());

  test('platform null — null qaytaradi (kino kadri)', async () => {
    mockGeminiResponse('{"platform": null, "account": null}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('platform tiktok — null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "tiktok", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('platform telegram — null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "telegram", "account": "kinolar_720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });
});

// ─── 3. Username regex validatsiyasi ─────────────────────────────────────────

describe('extractInstagramSource — username validatsiyasi', () => {
  beforeEach(() => getMockGenerateContent().mockReset());

  test('4 ta belgi — juda qisqa (regex: min 5), null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "kino"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('3 ta belgi — juda qisqa, null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "kno"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('31 ta belgi — juda uzun, null qaytaradi', async () => {
    mockGeminiResponse(`{"platform": "instagram", "account": "${'x'.repeat(31)}"}`);
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('bo\'sh joy bilan — regex o\'tmaydi, null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "kinolar 720"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('maxsus belgilar (!) — regex o\'tmaydi, null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "kino!uz"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('"null" string — null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": "null"}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('bo\'sh string — null qaytaradi', async () => {
    mockGeminiResponse('{"platform": "instagram", "account": ""}');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });

  test('JSON yo\'q javob — null qaytaradi', async () => {
    mockGeminiResponse('Bu Instagram screenshoti emas.');
    expect(await extractInstagramSource(DUMMY_BASE64)).toBeNull();
  });
});

// ─── 3. Xato holatlari — crash yo'q ──────────────────────────────────────────

describe('extractInstagramSource — xatolar yutiladi', () => {
  beforeEach(() => getMockGenerateContent().mockReset());

  test('Gemini network xatosi — null qaytaradi, crash yo\'q', async () => {
    mockGeminiError(new Error('Network error'));
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });

  test('Noto\'g\'ri JSON — null qaytaradi, crash yo\'q', async () => {
    mockGeminiResponse('{broken json}');
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });

  test('Bo\'sh javob — null qaytaradi', async () => {
    mockGeminiResponse('');
    await expect(extractInstagramSource(DUMMY_BASE64)).resolves.toBeNull();
  });
});

// ─── 4. withGemini parallel slot xavfsizligi ─────────────────────────────────

describe('withGemini — parallel slot xavfsizligi', () => {
  test('10 ta parallel call — hech biri slot limitidan o\'tmaydi', async () => {
    let maxActive = 0;
    let currentActive = 0;
    const MAX = 10;

    const trackingCall = () =>
      withGemini(async () => {
        currentActive++;
        maxActive = Math.max(maxActive, currentActive);
        expect(currentActive).toBeLessThanOrEqual(MAX);
        await new Promise(r => setTimeout(r, 5));
        currentActive--;
        return 'ok';
      });

    await Promise.all(Array.from({ length: 10 }, trackingCall));
    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(MAX);
  });

  test('extractInstagramSource + parallel calllar — slot conflict yo\'q', async () => {
    getMockGenerateContent().mockReset();

    // 5 ta asosiy call (getMovieDetails simulyatsiyasi) + 1 ta extractInstagramSource
    const responses = [
      '{"account": "kinolar_720"}', // extractInstagramSource javobi
      ...Array(5).fill('{"title": "ok"}'), // boshqa calllar
    ];
    responses.forEach(r => mockGeminiResponse(r));

    let errorOccurred = false;

    const mainCalls = Array.from({ length: 5 }, () =>
      withGemini(async () => {
        await new Promise(r => setTimeout(r, 10));
        return 'main-result';
      }).catch(() => { errorOccurred = true; })
    );

    const igCall = extractInstagramSource(DUMMY_BASE64).catch(() => { errorOccurred = true; });

    await Promise.all([...mainCalls, igCall]);
    expect(errorOccurred).toBe(false);
  });
});

// ─── 5. void fire-and-forget pattern ─────────────────────────────────────────

describe('fire-and-forget pattern — xato yutiladi', () => {
  test('void extractInstagramSource xato bersa ham caller crash bo\'lmaydi', async () => {
    getMockGenerateContent().mockReset();
    mockGeminiError(new Error('Gemini down'));

    let callerError: unknown = null;
    try {
      void extractInstagramSource(DUMMY_BASE64);
      // caller davom etadi
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      callerError = e;
    }

    expect(callerError).toBeNull();
  });
});
