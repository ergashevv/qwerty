/**
 * Alohida jarayon: faqat web dashboard (Express).
 * Bot: `npm start` / `npm run dev` — `src/bot.ts`
 */
import 'dotenv/config';
import { pruneUserActivityHistory } from '../db';
import { initPostgresSchema, pingPostgres, runAnalyticsRetention } from '../db/postgres';
import { startDashboard } from './server';

if (!process.env.DATABASE_URL?.trim()) {
  console.error('❌ DATABASE_URL majburiy — dashboard faqat Neon Postgres bilan ishlaydi.');
  process.exit(1);
}

void (async () => {
  try {
    await initPostgresSchema();
    await pruneUserActivityHistory();
    if (await pingPostgres()) console.log('✅ Postgres (Neon) tayyor (dashboard)');
    await runAnalyticsRetention();
  } catch (e) {
    console.error('❌ Postgres:', (e as Error).message);
    process.exit(1);
  }
  startDashboard();
})();
