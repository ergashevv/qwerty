import { isAdminTelegram } from '../utils/isAdmin';

describe('isAdminTelegram', () => {
  const prev = process.env.ADMIN_TELEGRAM_ID;

  afterEach(() => {
    if (prev === undefined) delete process.env.ADMIN_TELEGRAM_ID;
    else process.env.ADMIN_TELEGRAM_ID = prev;
  });

  it('vergul bilan bir nechta ID', () => {
    process.env.ADMIN_TELEGRAM_ID = '100, 200';
    expect(isAdminTelegram(100)).toBe(true);
    expect(isAdminTelegram(200)).toBe(true);
    expect(isAdminTelegram(300)).toBe(false);
  });
});
