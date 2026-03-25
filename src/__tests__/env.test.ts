/**
 * Konfiguratsiya kalitlari — unit testda setup.ts fake qiymatlar beradi.
 * Bu testlar faqat modul eksportlarini tekshiradi.
 */
import {
  PHOTO_BURST_LIMIT,
  PHOTO_DAILY_LIMIT,
  PHOTO_BURST_WINDOW_SECONDS,
  USER_REQUEST_LIMIT,
  REQUEST_WINDOW_SECONDS,
} from '../config/limits';

describe('config / limits', () => {
  test('rasm limitlari musbat', () => {
    expect(PHOTO_BURST_LIMIT).toBeGreaterThan(0);
    expect(PHOTO_DAILY_LIMIT).toBeGreaterThan(PHOTO_BURST_LIMIT);
    expect(PHOTO_BURST_WINDOW_SECONDS).toBeGreaterThan(0);
  });

  test('matn limitlari', () => {
    expect(USER_REQUEST_LIMIT).toBeGreaterThan(0);
    expect(REQUEST_WINDOW_SECONDS).toBeGreaterThan(0);
  });
});
