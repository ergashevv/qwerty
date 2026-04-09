import { withAzureSlot } from '../services/azureLlm';

describe('withAzureSlot', () => {
  const oldRetries = process.env.AZURE_OPENAI_MAX_RETRIES;
  const oldGap = process.env.AZURE_OPENAI_MIN_GAP_MS;

  beforeAll(() => {
    process.env.AZURE_OPENAI_MAX_RETRIES = '4';
    process.env.AZURE_OPENAI_MIN_GAP_MS = '0';
  });

  afterAll(() => {
    if (oldRetries === undefined) delete process.env.AZURE_OPENAI_MAX_RETRIES;
    else process.env.AZURE_OPENAI_MAX_RETRIES = oldRetries;
    if (oldGap === undefined) delete process.env.AZURE_OPENAI_MIN_GAP_MS;
    else process.env.AZURE_OPENAI_MIN_GAP_MS = oldGap;
  });

  test('muvaffaqiyatli natija qaytadi', async () => {
    const r = await withAzureSlot(async () => 'ok');
    expect(r).toBe('ok');
  });

  test('429 uchun qayta urinadi va oxirida muvaffaq', async () => {
    let n = 0;
    const r = await withAzureSlot(async () => {
      n++;
      if (n < 2) {
        const e = new Error('429') as Error & { status?: number };
        e.status = 429;
        throw e;
      }
      return 'done';
    });
    expect(r).toBe('done');
    expect(n).toBe(2);
  });

  test('400 qayta urinmaydi', async () => {
    await expect(
      withAzureSlot(async () => {
        const e = new Error('bad') as Error & { status?: number };
        e.status = 400;
        throw e;
      })
    ).rejects.toThrow();
  });
});
