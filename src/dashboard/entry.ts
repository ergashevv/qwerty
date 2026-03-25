/**
 * Alohida jarayon: faqat web dashboard (Express).
 * Bot: `npm start` / `npm run dev` — `src/bot.ts`
 */
import 'dotenv/config';
import { getDb, pruneUserActivityHistory } from '../db';
import { initPostgresSchema, pingPostgres, runAnalyticsRetention } from '../db/postgres';
import { startDashboard } from './server';

getDb();
pruneUserActivityHistory();
console.log('✅ SQLite tayyor (dashboard)');

void (async () => {
  try {
    await initPostgresSchema();
    if (await pingPostgres()) console.log('✅ Postgres (Neon) ulanishi OK');
    await runAnalyticsRetention();
  } catch (e) {
    console.warn('⚠️ Postgres (DATABASE_URL):', (e as Error).message);
  }
  startDashboard();
})();
