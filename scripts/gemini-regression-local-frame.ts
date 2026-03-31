/**
 * Dashboardda "ko'p xato" chiqqan filmni **haqiqiy kadr** (screenshot) bilan tekshirish.
 * TMDB poster regression testi yashil bo'lsa ham, foydalanuvchi kadri boshqacha bo'lishi mumkin.
 *
 * Ishlatish (kinova_bot ildizidan, .env da GEMINI_API_KEY va boshqalar):
 *   npx ts-node --transpile-only scripts/gemini-regression-local-frame.ts ./frame.jpg
 *   npx ts-node --transpile-only scripts/gemini-regression-local-frame.ts ./frame.png
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { identifyMovie } from '../src/services/movieService';

async function main() {
  const p = process.argv[2];
  if (!p) {
    console.error('Usage: npx ts-node --transpile-only scripts/gemini-regression-local-frame.ts <image.jpg|png>');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) {
    console.error('Fayl topilmadi:', abs);
    process.exit(1);
  }
  const buf = fs.readFileSync(abs);
  const base64 = buf.toString('base64');
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';

  console.log('identifyMovie:', abs, mime, `(${Math.round(buf.length / 1024)} KB)\n`);
  const r = await identifyMovie(base64, mime);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
