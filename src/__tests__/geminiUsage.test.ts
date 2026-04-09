import { tapGeminiGenerateContent, recordGeminiUsage } from '../services/geminiUsage';
import { runWithLlmUsageContext, getLlmUsageTelegramId } from '../services/llmUsageContext';
import type { LegacyGeminiGenerateResult } from '../services/geminiUsage';

describe('recordGeminiUsage', () => {
  test('usageMetadata bo‘lmasa — xotira/suhbat buzilmaydi', () => {
    expect(() =>
      recordGeminiUsage('test', undefined)
    ).not.toThrow();
  });

  test('tapGeminiGenerateContent — javobdan keyin result qaytadi', async () => {
    const fake: LegacyGeminiGenerateResult = {
      response: {
        text: () => '{}',
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    };
    const out = await tapGeminiGenerateContent('unit', Promise.resolve(fake));
    expect(out.response?.usageMetadata?.totalTokenCount).toBe(15);
  });
});

describe('runWithLlmUsageContext', () => {
  test('telegramId berilganda store mavjud', async () => {
    await runWithLlmUsageContext(42, async () => {
      expect(getLlmUsageTelegramId()).toBe(42);
    });
  });

  test('telegramId yo‘q — store bo‘sh', async () => {
    await runWithLlmUsageContext(undefined, async () => {
      expect(getLlmUsageTelegramId()).toBeUndefined();
    });
  });
});
