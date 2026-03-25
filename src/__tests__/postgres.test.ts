import { pingPostgres, initPostgresSchema, closePostgresPool } from '../db/postgres';

const hasUrl = !!process.env.DATABASE_URL;

(hasUrl ? describe : describe.skip)('Postgres (DATABASE_URL bilan)', () => {
  jest.setTimeout(25_000);

  afterAll(async () => {
    await closePostgresPool();
  });

  test('ulanish va ping', async () => {
    await initPostgresSchema();
    const ok = await pingPostgres();
    expect(ok).toBe(true);
  });
});
