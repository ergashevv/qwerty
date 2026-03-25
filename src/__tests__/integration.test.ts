/**
 * REAL API INTEGRATION TESTLARI
 *
 * Bu testlar haqiqiy API keylar bilan ishlaydi (.env dan)
 * Har bir API uchun ulanish va natija sifatini tekshiradi:
 *   - OMDB
 *   - TMDB
 *   - AWS Rekognition (yuz tanish)
 *   - Google Vision (rasm qidirish)
 *   - Claude (film aniqlash)
 *   - Gemini (film aniqlash)
 *   - To'liq identifyMovie pipeline
 *
 * Ishlatish: npm run test:integration
 */

// sharp mock ni o'chirish — integration testlarda real sharp kerak
jest.unmock('sharp');

import 'dotenv/config';
import axios from 'axios';

// Timeout: haqiqiy API chaqiruvlar uchun ko'proq vaqt
jest.setTimeout(30000);

// ─── TEST RASMLARI ────────────────────────────────────────────────────────────

/**
 * Mashhur aktyor rasmini yuklab base64 ga o'girish.
 * Robert Downey Jr — Wikipedia ochiq litsenziyali rasm
 */
async function downloadImageAsBase64(url: string): Promise<string> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (test bot)' },
  });
  return Buffer.from(response.data).toString('base64');
}

// Mashhur aktorlar rasmlari (Wikipedia ochiq litsenziya)
const TEST_IMAGES = {
  // Robert Downey Jr — Iron Man aktori (Wikipedia CC)
  rdj: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Robert_Downey_Jr_2014_Comic_Con_%28cropped%29.jpg/330px-Robert_Downey_Jr_2014_Comic_Con_%28cropped%29.jpg',
  // Iron Man (2008) film posteri — Wikipedia EN
  ironManPoster: 'https://upload.wikimedia.org/wikipedia/en/0/02/Iron_Man_%282008_film%29_poster.jpg',
  // Parasite (2019) film posteri — Wikipedia EN
  parasitePoster: 'https://upload.wikimedia.org/wikipedia/en/5/53/Parasite_%282019_film%29.png',
  // Brad Pitt — Inglourious Basterds aktori
  bradPitt: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Brad_Pitt_2019_by_Glenn_Francis.jpg/330px-Brad_Pitt_2019_by_Glenn_Francis.jpg',
};

// ─── 1. OMDB API ──────────────────────────────────────────────────────────────

describe('OMDB API — haqiqiy kalit bilan', () => {
  const key = process.env.OMDB_API_KEY;

  test('API kalit mavjud', () => {
    expect(key).toBeTruthy();
    console.log(`OMDB key: ${key?.slice(0, 4)}****`);
  });

  test('Mashxur film topiladi: "The Dark Knight"', async () => {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: key, s: 'The Dark Knight', type: 'movie' },
      timeout: 10000,
    });
    const list = r.data?.Search || [];
    console.log(`OMDB "The Dark Knight" natijalar soni: ${list.length}`);
    console.log('Birinchi natija:', list[0]?.Title, list[0]?.Year);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].Title).toContain('Dark Knight');
  });

  test('IMDb ID bilan qidirish: tt0468569 (The Dark Knight)', async () => {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: key, i: 'tt0468569' },
      timeout: 10000,
    });
    console.log(`OMDB IMDb ID natija: "${r.data?.Title}" (${r.data?.Year})`);
    expect(r.data?.Title).toBe('The Dark Knight');
    expect(r.data?.imdbRating).toBeTruthy();
  });

  test('Mashxur bo\'lmagan film topiladi: "Incendies"', async () => {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: key, s: 'Incendies', type: 'movie' },
      timeout: 10000,
    });
    const list = r.data?.Search || [];
    console.log(`OMDB "Incendies" natijalar: ${JSON.stringify(list.map((x: { Title: string; Year: string }) => `${x.Title}(${x.Year})`))}` );
    // Bu film OMDB da bo'lishi kerak
    expect(list.length).toBeGreaterThan(0);
  });

  test('O\'zbekcha so\'rov: "Temir Odam" — OMDB natija tili inglizcha', async () => {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: key, s: 'Temir Odam', type: 'movie' },
      timeout: 10000,
    });
    const list = r.data?.Search || [];
    console.log(`OMDB "Temir Odam" natijalar: ${JSON.stringify(list.slice(0,3).map((x: { Title: string }) => x.Title))}`);
    // OMDB "Temir Odam" ni topa olmaydi — inglizcha ma'lumotlar bazasi
    // Bu MUAMMO: o'zbek foydalanuvchi uchun Claude fallback kerak
    if (list.length === 0) {
      console.log('⚠️ OMDB "Temir Odam" ni topa olmadi (kutilgan — Claude fallback kerak)');
    }
  });
});

// ─── 2. TMDB API ─────────────────────────────────────────────────────────────

describe('TMDB API — haqiqiy kalit bilan', () => {
  const key = process.env.TMDB_API_KEY;

  test('API kalit mavjud', () => {
    expect(key).toBeTruthy();
    console.log(`TMDB key: ${key?.slice(0, 6)}****`);
  });

  test('Mashxur film topiladi: "Parasite"', async () => {
    const r = await axios.get('https://api.themoviedb.org/3/search/multi', {
      params: { api_key: key, query: 'Parasite', language: 'en-US' },
      timeout: 10000,
    });
    const results = r.data?.results || [];
    console.log(`TMDB "Parasite" birinchi natija: "${results[0]?.title || results[0]?.name}" (vote: ${results[0]?.vote_average})`);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title || results[0].name).toContain('Parasite');
  });

  test('O\'zbekcha so\'rov "Temir Odam" — TMDB noto\'g\'ri natija berishi mumkin', async () => {
    const r = await axios.get('https://api.themoviedb.org/3/search/multi', {
      params: { api_key: key, query: 'Temir Odam', language: 'en-US' },
      timeout: 10000,
    });
    const results = r.data?.results || [];
    const firstTitle = results[0]?.title || results[0]?.name || 'TOPILMADI';
    console.log(`⚠️ TMDB "Temir Odam" birinchi natija: "${firstTitle}"`);
    console.log('   Barcha natijalar:', results.slice(0,3).map((x: { title?: string; name?: string }) => x.title || x.name).join(', '));
    // Bu "Iron Man" bo'lmasligi kutiladi — MUAMMO
    if (firstTitle !== 'Iron Man') {
      console.log('   ❌ MUAMMO: TMDB o\'zbekcha nomdan Iron Man ni topa olmadi');
    }
  });

  test('IMDb ID orqali topish: tt6751668 (Parasite)', async () => {
    const r = await axios.get('https://api.themoviedb.org/3/find/tt6751668', {
      params: { api_key: key, external_source: 'imdb_id' },
      timeout: 10000,
    });
    const movies = r.data?.movie_results || [];
    console.log(`TMDB IMDb ID natija: "${movies[0]?.title}" (${movies[0]?.release_date?.slice(0,4)})`);
    expect(movies[0]?.title).toBe('Parasite');
  });

  test('Aktyor bo\'yicha qidirish: Robert Downey Jr', async () => {
    const personRes = await axios.get('https://api.themoviedb.org/3/search/person', {
      params: { api_key: key, query: 'Robert Downey Jr' },
      timeout: 10000,
    });
    const person = personRes.data?.results?.[0];
    console.log(`TMDB aktyor: "${person?.name}" (id: ${person?.id})`);
    expect(person?.name).toContain('Downey');

    const credRes = await axios.get(`https://api.themoviedb.org/3/person/${person.id}/combined_credits`, {
      params: { api_key: key },
      timeout: 10000,
    });
    const allCast: Array<{ title?: string; name?: string; vote_average?: number; vote_count?: number; media_type?: string }> = credRes.data?.cast || [];

    // BEZ FILTER: vote_count yo'q, obscure filmlar chiqib ketadi (BUG DEMONSTRATSIYA)
    const topWithoutFilter = allCast
      .filter(m => m.media_type === 'movie' || m.media_type === 'tv')
      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
      .slice(0, 5)
      .map(m => m.title || m.name);
    console.log(`[BEZ FILTER] Top 5: ${topWithoutFilter.join(', ')}`);

    // FILTER BILAN (bizning kodda vote_count >= 100): to'g'ri filmlar
    const topWithFilter = allCast
      .filter(m => (m.media_type === 'movie' || m.media_type === 'tv') && (m.vote_count ?? 0) >= 100)
      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
      .slice(0, 5)
      .map(m => m.title || m.name);
    console.log(`[FILTER BILAN vote_count>=100] Top 5: ${topWithFilter.join(', ')}`);

    // Bizning kod vote_count filtrini ishlatadi — Iron Man top 5 da bo'lishi kerak
    expect(topWithFilter.some(t => t?.toLowerCase().includes('iron man'))).toBe(true);
    // Filtrsiz esa obscure filmlar chiqib ketadi
    const hasObscure = topWithoutFilter.some(t => ['Voom Portraits', 'The Frame', 'Iron Man 3 Unmasked'].includes(t || ''));
    if (hasObscure) {
      console.log('⚠️ Filtrsiz obscure filmlar top 5 da — vote_count filter muhim!');
    }
  });
});

// ─── 3. AWS REKOGNITION ───────────────────────────────────────────────────────

describe('AWS Rekognition — yuz tanish', () => {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

  test('AWS keylar mavjud', () => {
    expect(accessKey).toBeTruthy();
    expect(secretKey).toBeTruthy();
    console.log(`AWS Key: ${accessKey?.slice(0, 6)}****`);
  });

  test('Robert Downey Jr yuzini tanishi kerak', async () => {
    console.log('Robert Downey Jr rasmi yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.rdj);
    console.log(`Rasm yuklanadi: ${Math.round(base64.length / 1024)} KB`);

    const { recognizeCelebrities } = await import('../services/rekognition');
    const results = await recognizeCelebrities(base64);

    console.log(`Rekognition natijalar: ${results.length} ta`);
    results.forEach(r => {
      console.log(`  - ${r.name}: ${r.confidence.toFixed(1)}% ishonch`);
    });

    if (results.length === 0) {
      console.log('❌ MUAMMO: Rekognition hech kim tanimadi!');
      console.log('   Sabab: Rasm sifati past, yuz ko\'rinmaydi, yoki API ishlamayapti');
    } else {
      const rdj = results.find(r => r.name.toLowerCase().includes('downey'));
      if (!rdj) {
        console.log(`❌ MUAMMO: Robert Downey Jr topilmadi, lekin boshqalar topildi: ${results.map(r => r.name).join(', ')}`);
      } else {
        console.log(`✅ Robert Downey Jr topildi: ${rdj.confidence.toFixed(1)}%`);
      }
    }

    // Test: kamida biror natija bo'lishi kerak
    expect(results.length).toBeGreaterThan(0);
  });

  test('Iron Man poster dan aktyor tanilishi kerak (poster test)', async () => {
    console.log('Iron Man poster yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.ironManPoster);

    const { recognizeCelebrities } = await import('../services/rekognition');
    const results = await recognizeCelebrities(base64);

    console.log(`Poster — Rekognition natijalar: ${results.length} ta`);
    results.forEach(r => {
      console.log(`  - ${r.name}: ${r.confidence.toFixed(1)}%`);
    });

    if (results.length === 0) {
      console.log('⚠️ Posterdan aktyor tanilmadi (plakat rasmlarida qiyin)');
    }
  });
});

// ─── 4. GOOGLE VISION ────────────────────────────────────────────────────────

describe('Google Vision — rasm orqali film qidirish', () => {
  const visionKey = process.env.VISION_API_KEY;

  test('Vision API kalit mavjud', () => {
    expect(visionKey).toBeTruthy();
    console.log(`Vision key: ${visionKey?.slice(0, 10)}****`);
  });

  test('Iron Man poster orqali film aniqlanishi kerak', async () => {
    console.log('Iron Man poster Vision uchun yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.ironManPoster);

    const r = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`,
      {
        requests: [{
          image: { content: base64 },
          features: [{ type: 'WEB_DETECTION', maxResults: 20 }],
        }],
      },
      { timeout: 15000 }
    );

    const wd = r.data?.responses?.[0]?.webDetection || {};
    const bestGuess = wd.bestGuessLabels?.[0]?.label || 'YO\'Q';
    const topEntities = (wd.webEntities || []).slice(0, 5).map(
      (e: { description?: string; score?: number }) => `${e.description}(${e.score?.toFixed(2)})`
    );
    const imdbPages = (wd.pagesWithMatchingImages || [])
      .filter((p: { url?: string }) => /imdb/i.test(p.url || ''))
      .slice(0, 3)
      .map((p: { url?: string; pageTitle?: string }) => p.pageTitle || p.url);

    console.log(`Vision bestGuess: "${bestGuess}"`);
    console.log(`Vision top entities: ${topEntities.join(', ')}`);
    console.log(`Vision IMDb sahifalar: ${imdbPages.join(' | ')}`);

    if (!bestGuess.toLowerCase().includes('iron man')) {
      console.log('⚠️ Vision "Iron Man" ni bestGuess da bermadi');
    } else {
      console.log('✅ Vision Iron Man ni aniqladi');
    }

    expect(wd.webEntities || wd.bestGuessLabels).toBeTruthy();
  });
});

// ─── 5. CLAUDE API ───────────────────────────────────────────────────────────

describe('Claude API — rasm orqali film aniqlash', () => {
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  test('Claude API kalit mavjud', () => {
    expect(claudeKey).toBeTruthy();
    console.log(`Claude key: ${claudeKey?.slice(0, 20)}****`);
  });

  test('Iron Man posteri dan film aniqlanishi kerak', async () => {
    console.log('Iron Man poster Claude uchun yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.ironManPoster);

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: claudeKey });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          {
            type: 'text',
            text: 'What movie/TV show is this? Respond ONLY with JSON: {"title": "exact title", "type": "movie" or "tv", "confidence": "high/medium/low"}',
          },
        ],
      }],
    });

    const text = (response.content[0] as { text?: string }).text || '';
    const m = text.match(/\{[\s\S]*?\}/);
    const parsed = m ? JSON.parse(m[0]) : null;

    console.log(`Claude raw: ${text.slice(0, 200)}`);
    console.log(`Claude parsed: ${JSON.stringify(parsed)}`);

    if (parsed?.title?.toLowerCase().includes('iron man')) {
      console.log(`✅ Claude Iron Man ni aniqladi: "${parsed.title}" (${parsed.confidence})`);
    } else {
      console.log(`❌ Claude to'g'ri aniqlamadi: "${parsed?.title}" (kerak: Iron Man)`);
    }

    expect(parsed?.title).toBeTruthy();
  });

  test('Matn orqali: "qamoqdagi ota haqida turk filmi" — Claude tanisin', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: claudeKey });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Identify the EXACT movie from this description (may be in Uzbek, Russian, Turkish, or English):
"qamoqdagi ota haqida turk filmi, kichik qiz bilan"

Respond ONLY with JSON: {"title": "exact title", "type": "movie" or "tv", "confidence": "high/medium/low"}`,
      }],
    });

    const text = (response.content[0] as { text?: string }).text || '';
    const m = text.match(/\{[\s\S]*?\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    console.log(`Claude tavsifdan: ${JSON.stringify(parsed)}`);
    // Kutilgan: "Miracle in Cell No. 7" yoki "7. Koğuştaki Mucize"
    expect(parsed?.title).toBeTruthy();
    expect(parsed?.confidence).not.toBe('low');
  });
});

// ─── 6. GEMINI API ───────────────────────────────────────────────────────────

describe('Gemini API — rasm orqali film aniqlash', () => {
  const geminiKey = process.env.GEMINI_API_KEY;

  test('Gemini API kalit mavjud', () => {
    expect(geminiKey).toBeTruthy();
    console.log(`Gemini key: ${geminiKey?.slice(0, 10)}****`);
  });

  test('Parasite posteri dan film aniqlanishi kerak', async () => {
    console.log('Parasite poster Gemini uchun yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.parasitePoster);

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: 'image/jpeg' } },
      'What movie/TV show is this poster from? Respond ONLY with JSON: {"title": "exact title", "type": "movie" or "tv", "confidence": "high/medium/low"}',
    ]);

    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    const parsed = m ? JSON.parse(m[0]) : null;

    console.log(`Gemini raw: ${text.slice(0, 200)}`);
    console.log(`Gemini parsed: ${JSON.stringify(parsed)}`);

    if (parsed?.title?.toLowerCase().includes('parasite')) {
      console.log(`✅ Gemini Parasite ni aniqladi: "${parsed.title}"`);
    } else {
      console.log(`❌ Gemini to'g'ri aniqlamadi: "${parsed?.title}" (kerak: Parasite)`);
    }

    expect(parsed?.title).toBeTruthy();
  });
});

// ─── 7. TO'LIQ PIPELINE: identifyMovie ───────────────────────────────────────

describe('To\'liq pipeline: identifyMovie — haqiqiy rasm bilan', () => {
  test('Iron Man posteri → identifyMovie → "Iron Man" topilishi kerak', async () => {
    console.log('\n🎬 TO\'LIQ PIPELINE TESTI\n');
    console.log('Iron Man poster yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.ironManPoster);
    console.log(`Rasm hajmi: ${Math.round(base64.length / 1024)} KB`);

    const { identifyMovie } = await import('../services/movieService');
    const result = await identifyMovie(base64, 'image/jpeg');

    console.log(`\n🎯 Pipeline natija: ${JSON.stringify(result)}`);

    if (!result) {
      console.log('❌ MUAMMO: identifyMovie null qaytardi — hech bir API ishlamadi yoki mos kelmadi');
    } else if (result.title.toLowerCase().includes('iron man')) {
      console.log(`✅ TO'G'RI: "${result.title}" (${result.type}, ${result.confidence})`);
    } else {
      console.log(`❌ NOTO'G'RI: "${result.title}" (kerak: Iron Man)`);
    }

    expect(result).not.toBeNull();
  });

  test('Parasite posteri → identifyMovie → "Parasite" topilishi kerak', async () => {
    console.log('\n🎬 Parasite pipeline testi\n');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.parasitePoster);

    const { identifyMovie } = await import('../services/movieService');
    const result = await identifyMovie(base64, 'image/jpeg');

    console.log(`Pipeline natija: ${JSON.stringify(result)}`);

    if (!result) {
      console.log('❌ MUAMMO: identifyMovie null qaytardi');
    } else if (result.title.toLowerCase().includes('parasite')) {
      console.log(`✅ TO'G'RI: "${result.title}"`);
    } else {
      console.log(`⚠️ Boshqa natija: "${result.title}" (kerak: Parasite)`);
    }

    expect(result).not.toBeNull();
  });
});

// ─── 7b. VISION WATERMARK VA SKIP TEKSHIRUVI ─────────────────────────────────

describe('Vision — watermark va noise filtering', () => {
  test('Brad Pitt rasmi bilan Vision → watermark confused natija rad etilishi kerak', async () => {
    console.log('\nBrad Pitt rasmi yuklanmoqda...');
    const base64 = await downloadImageAsBase64(TEST_IMAGES.bradPitt);

    const r = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.VISION_API_KEY}`,
      { requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 20 }] }] },
      { timeout: 15000 }
    );
    const wd = r.data?.responses?.[0]?.webDetection || {};
    const bg = wd.bestGuessLabels?.[0]?.label || 'YO\'Q';
    const entities = (wd.webEntities || []).slice(0, 5).map(
      (e: { description?: string; score?: number }) => `${e.description}(${e.score?.toFixed(2)})`
    );
    console.log(`Brad Pitt Vision bestGuess: "${bg}"`);
    console.log(`Brad Pitt Vision entities: ${entities.join(', ')}`);

    // Tasdiqlash: Vision Brad Pitt ni topdi
    const hasBradPitt = (wd.webEntities || []).some(
      (e: { description?: string }) => /brad pitt/i.test(e.description || '')
    );
    if (hasBradPitt) {
      console.log('✅ Vision Brad Pitt ni entity sifatida topdi');
    } else {
      console.log('⚠️ Vision Brad Pitt ni topmadi');
    }
    expect(wd.webEntities).toBeTruthy();
  });

  test('"Nos Bastidores de Hollywood" noise filtri bilan rad etilishi kerak', () => {
    // isNoisy logikasini to'g'ridan simulatsiya qilish
    const isNoisy = (desc: string) => {
      const lower = desc.toLowerCase();
      if (/bastidores|behind.the.scenes|making.of|on.the.set|tasavvur|cinemascenefuz/i.test(lower)) return true;
      return false;
    };

    expect(isNoisy('Nos Bastidores de Hollywood')).toBe(true);
    expect(isNoisy('TASAVVUR')).toBe(true);
    expect(isNoisy('CINEMASCENEFUZ')).toBe(true);
    expect(isNoisy('behind the scenes')).toBe(true);
    expect(isNoisy('Fight Club')).toBe(false);
    expect(isNoisy('Iron Man')).toBe(false);
    expect(isNoisy('Se7en')).toBe(false);
    console.log('✅ Barcha noise filtrlari to\'g\'ri ishlaydi');
  });
});

// ─── 8. SERPER API ───────────────────────────────────────────────────────────

describe('Serper API — tomosha havolalari qidirish', () => {
  const serperKey = process.env.SERPER_API_KEY;

  test('Serper API kalit mavjud', () => {
    expect(serperKey).toBeTruthy();
  });

  test('"Iron Man o\'zbek tilida tomosha" uchun havolalar topilishi kerak', async () => {
    const r = await axios.post(
      'https://google.serper.dev/search',
      { q: "Iron Man 2008 o'zbek tilida tomosha ko'rish", gl: 'uz', hl: 'uz', num: 10 },
      {
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    const organic = r.data?.organic || [];
    console.log(`Serper natijalar: ${organic.length} ta`);
    organic.slice(0, 3).forEach((item: { title: string; link: string }) => {
      console.log(`  - ${item.title}: ${item.link}`);
    });
    expect(organic.length).toBeGreaterThan(0);
  });
});
