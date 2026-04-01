import { tapGeminiGenerateContent, recordGeminiUsage } from '../services/geminiUsage';
import { runWithGeminiUsageContext, getGeminiUsageTelegramId } from '../services/geminiUsageContext';
import type { GenerateContentResult } from '@google/generative-ai';

describe('recordGeminiUsage', () => {
  test('usageMetadata bo‘lmasa — xotira/suhbat buzilmaydi', () => {
    expect(() =>
      recordGeminiUsage('test', undefined)
    ).not.toThrow();
  });

  test('tapGeminiGenerateContent — javobdan keyin result qaytadi', async () => {
    const fake: GenerateContentResult = {
      response: {
        text: () => '{}',
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      } as GenerateContentResult['response'],
    };
    const out = await tapGeminiGenerateContent('unit', Promise.resolve(fake));
    expect(out.response.usageMetadata?.totalTokenCount).toBe(15);
  });
});

describe('runWithGeminiUsageContext', () => {
  test('telegramId berilganda store mavjud', async () => {
    await runWithGeminiUsageContext(42, async () => {
      expect(getGeminiUsageTelegramId()).toBe(42);
    });
  });

  test('telegramId yo‘q — store bo‘sh', async () => {
    await runWithGeminiUsageContext(undefined, async () => {
      expect(getGeminiUsageTelegramId()).toBeUndefined();
    });
  });
});
