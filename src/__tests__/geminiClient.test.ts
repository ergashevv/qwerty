import { withGemini } from '../services/geminiClient';

describe('withGemini', () => {
  const oldRetries = process.env.GEMINI_MAX_RETRIES;
  const oldGap = process.env.GEMINI_MIN_GAP_MS;

  beforeEach(() => {
    process.env.GEMINI_MAX_RETRIES = '4';
    process.env.GEMINI_MIN_GAP_MS = '0';
  });

  afterEach(() => {
    if (oldRetries === undefined) delete process.env.GEMINI_MAX_RETRIES;
    else process.env.GEMINI_MAX_RETRIES = oldRetries;
    if (oldGap === undefined) delete process.env.GEMINI_MIN_GAP_MS;
    else process.env.GEMINI_MIN_GAP_MS = oldGap;
  });

  test('muvaffaqiyatli chaqiruv', async () => {
    const r = await withGemini(async () => 'ok');
    expect(r).toBe('ok');
  });

  test('429 dan keyin qayta urinish (mock)', async () => {
    let n = 0;
    const r = await withGemini(async () => {
      n++;
      if (n === 1) {
        const e = new Error('Too Many Requests') as Error & { status: number };
        e.status = 429;
        throw e;
      }
      return 'done';
    });
    expect(r).toBe('done');
    expect(n).toBe(2);
  });

  test('400 da darhol xato, qayta urinmaydi', async () => {
    let n = 0;
    await expect(
      withGemini(async () => {
        n++;
        const e = new Error('Bad Request') as Error & { status: number };
        e.status = 400;
        throw e;
      })
    ).rejects.toThrow();
    expect(n).toBe(1);
  });
});
