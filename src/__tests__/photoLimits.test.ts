import {
  PHOTO_BURST_LIMIT,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_DAILY_LIMIT,
} from '../config/limits';

/** photo_requests burst limit mantiqini oddiy massiv bilan tekshirish */
describe('photo_requests limit mantiq', () => {
  const uid = 900_001;
  const now = Math.floor(Date.now() / 1000);

  test('burst: PHOTO_BURST_LIMIT gacha ruxsat', () => {
    const burstSince = now - PHOTO_BURST_WINDOW_SECONDS;
    const rows: { telegram_id: number; created_at: number }[] = [];
    for (let i = 0; i < PHOTO_BURST_LIMIT - 1; i++) {
      rows.push({ telegram_id: uid, created_at: now - i * 10 });
    }
    const c = rows.filter((r) => r.telegram_id === uid && r.created_at >= burstSince).length;
    expect(c).toBe(PHOTO_BURST_LIMIT - 1);
  });

  test('kunlik limit: PHOTO_DAILY_LIMIT', () => {
    expect(PHOTO_DAILY_LIMIT).toBeGreaterThanOrEqual(PHOTO_BURST_LIMIT);
  });

  test('burst oyna sekundlari mantiqiy (15 daqiqa default)', () => {
    expect(PHOTO_BURST_WINDOW_SECONDS).toBeGreaterThanOrEqual(600);
  });
});
