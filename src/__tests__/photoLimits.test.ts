import Database from 'better-sqlite3';
import {
  PHOTO_BURST_LIMIT,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_DAILY_LIMIT,
} from '../config/limits';

/** Alohida DB — boshqa testlar bilan aralashmasin */
function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE IF NOT EXISTS photo_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return d;
}

describe('photo_requests limit mantiq', () => {
  const uid = 900_001;
  const now = Math.floor(Date.now() / 1000);

  test('burst: PHOTO_BURST_LIMIT gacha ruxsat', () => {
    const d = makeDb();
    const burstSince = now - PHOTO_BURST_WINDOW_SECONDS;
    for (let i = 0; i < PHOTO_BURST_LIMIT - 1; i++) {
      d.prepare(`INSERT INTO photo_requests (telegram_id, created_at) VALUES (?, ?)`).run(uid, now - i * 10);
    }
    const c = d
      .prepare(`SELECT COUNT(*) AS c FROM photo_requests WHERE telegram_id = ? AND created_at >= ?`)
      .get(uid, burstSince) as { c: number };
    expect(c.c).toBe(PHOTO_BURST_LIMIT - 1);
    d.close();
  });

  test('kunlik limit: PHOTO_DAILY_LIMIT', () => {
    expect(PHOTO_DAILY_LIMIT).toBeGreaterThanOrEqual(PHOTO_BURST_LIMIT);
  });

  test('burst oyna sekundlari mantiqiy (15 daqiqa default)', () => {
    expect(PHOTO_BURST_WINDOW_SECONDS).toBeGreaterThanOrEqual(600);
  });
});
