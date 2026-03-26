/**
 * /start va users jadvali: bitta yangi akkaunt — bitta qator, takroriy /start takroriy qator qo‘shmaydi.
 * DATABASE_URL bo‘lmasa testlar o‘tkazib yuboriladi.
 *
 * Eslatma: parallel test fayllari global COUNT ni o‘zgartirishi mumkin — shuning uchun tekshiruvlar
 * faqat test telegram_id bo‘yicha.
 */

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('Statistika: /start va users jadvali mosligi', () => {
  beforeAll(async () => {
    const { initPostgresSchema } = await import('../db/postgres');
    await initPostgresSchema();
  });

  test('yangi telegram_id: upsert + markUserStarted + faollik — 1 qator, started_at bor', async () => {
    const { getPostgresPool } = await import('../db/postgres');
    const { upsertUser, markUserStarted, recordUserActivityDay } = await import('../db');

    const pool = getPostgresPool();
    const userId = 666_111_000_000 + Math.floor(Math.random() * 999_999_999);

    await pool.query(`DELETE FROM user_activity_day WHERE telegram_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE telegram_id = $1`, [userId]);

    await upsertUser(userId, 'stat_test', 'Stat');
    await markUserStarted(userId);
    await recordUserActivityDay(userId);

    const u = await pool.query(
      `SELECT started_at FROM users WHERE telegram_id = $1`,
      [userId]
    );
    expect(u.rows.length).toBe(1);
    expect(u.rows[0].started_at).not.toBeNull();

    const day = new Date().toISOString().slice(0, 10);
    const act = await pool.query(
      `SELECT 1 FROM user_activity_day WHERE telegram_id = $1 AND day_utc = $2::date`,
      [userId, day]
    );
    expect(act.rows.length).toBe(1);
  });

  test('xuddi shu akkauntga markUserStarted qayta — started_at o‘zgarmaydi (bir marta)', async () => {
    const { upsertUser, markUserStarted } = await import('../db');
    const { getPostgresPool } = await import('../db/postgres');

    const pool = getPostgresPool();
    const userId = 666_222_000_000 + Math.floor(Math.random() * 999_999_999);

    await pool.query(`DELETE FROM user_activity_day WHERE telegram_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE telegram_id = $1`, [userId]);

    await upsertUser(userId, 't2', 'T2');
    await markUserStarted(userId);
    const first = (
      await pool.query(`SELECT started_at FROM users WHERE telegram_id = $1`, [userId])
    ).rows[0] as { started_at: number };

    await markUserStarted(userId);
    await markUserStarted(userId);
    const second = (
      await pool.query(`SELECT started_at FROM users WHERE telegram_id = $1`, [userId])
    ).rows[0] as { started_at: number };

    expect(second.started_at).toBe(first.started_at);
  });

  test('faqat upsert + faollik (markUserStarted yo‘q) — started_at NULL', async () => {
    const { upsertUser, recordUserActivityDay } = await import('../db');
    const { getPostgresPool } = await import('../db/postgres');

    const pool = getPostgresPool();
    const userId = 666_333_000_000 + Math.floor(Math.random() * 999_999_999);

    await pool.query(`DELETE FROM user_activity_day WHERE telegram_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE telegram_id = $1`, [userId]);

    await upsertUser(userId, 'only_text', 'Only');
    await recordUserActivityDay(userId);

    const u = await pool.query(`SELECT started_at FROM users WHERE telegram_id = $1`, [userId]);
    expect(u.rows.length).toBe(1);
    expect(u.rows[0].started_at).toBeNull();
  });
});
