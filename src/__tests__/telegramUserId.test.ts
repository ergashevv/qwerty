import { parseTelegramUserIdFromDb } from '../utils/telegramUserId';

describe('parseTelegramUserIdFromDb', () => {
  test('string, number, bigint', () => {
    expect(parseTelegramUserIdFromDb('123456789')).toBe(123456789);
    expect(parseTelegramUserIdFromDb(480032)).toBe(480032);
    expect(parseTelegramUserIdFromDb(BigInt(999))).toBe(999);
  });

  test('yaroqsiz', () => {
    expect(parseTelegramUserIdFromDb('')).toBeNull();
    expect(parseTelegramUserIdFromDb('-1')).toBeNull();
    expect(parseTelegramUserIdFromDb('abc')).toBeNull();
    expect(parseTelegramUserIdFromDb(null)).toBeNull();
  });
});
