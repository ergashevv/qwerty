import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import sharpLib from 'sharp';
import { recognizeCelebrities, extractImdbId } from './rekognition';

export type MediaType = 'movie' | 'tv';

export interface MovieIdentified {
  title: string;
  type: MediaType;
  confidence?: string;
}

export interface MovieDetails {
  title: string;
  uzTitle: string;
  originalTitle: string;
  year: string;
  rating: string;
  posterUrl: string | null;
  plotUz: string;
  imdbUrl: string | null;
  watchLinks: WatchLink[];
}

export interface WatchLink {
  title: string;
  link: string;
  source: string;
}

const TMDB_KEY   = process.env.TMDB_API_KEY   || '';
const OMDB_KEY   = process.env.OMDB_API_KEY   || '';
const SERPER_KEY = process.env.SERPER_API_KEY  || '';
const VISION_KEY = process.env.VISION_API_KEY  || '';
const IMGBB_KEY  = process.env.IMGBB_API_KEY   || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY  || '';
const TIMEOUT    = 8000;

// ─── YORDAMCHI ───────────────────────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/\s*\(\d{4}.*?\)/g, '')
    .replace(/\s*[-–—|]\s*(wikipedia|imdb|rotten|letterboxd).*/i, '')
    .replace(/\s+/g, ' ').trim();
}

// Stop-words that are too common to count as meaningful matches
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is']);

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // includes() check: require the shorter string to be at least 6 chars
  // to avoid false positives from short common words like "iron", "man", "the"
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;

  // Jaccard similarity on meaningful tokens (strip stop-words)
  const tok = (s: string) => s
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  const ta = tok(na), tb = tok(nb);
  if (!ta.length || !tb.length) return false;

  // Single-word short queries must match exactly — Jaccard too lenient for them
  // (e.g. "iron" should NOT fuzzy-match "Iron Man 3")
  if (ta.length <= 1 && na.length < 6) return false;
  if (tb.length <= 1 && nb.length < 6) return false;

  const setB = new Set(tb);
  const inter = ta.filter(w => setB.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter >= 1 && (union > 0 ? inter / union : 0) >= 0.4;
}

export function isNoisyTitle(title: string): boolean {
  return /\b(music video|official video|lyrics|ft\.|feat\.|vevo|trailer)\b/i.test(title);
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

interface TmdbResult {
  id: number; title?: string; name?: string;
  original_title?: string; original_name?: string;
  release_date?: string; first_air_date?: string;
  vote_average?: number; vote_count?: number;
  poster_path?: string | null;
  overview?: string; media_type?: string;
}

export async function tmdbSearch(query: string, type: MediaType | 'multi' = 'multi'): Promise<{ result: TmdbResult; type: MediaType } | null> {
  try {
    const endpoint = type === 'multi' ? 'search/multi' : `search/${type}`;
    const r = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, {
      params: { api_key: TMDB_KEY, query, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const results: TmdbResult[] = r.data.results || [];
    const hit = type === 'multi'
      ? results.find(x => x.media_type === 'movie' || x.media_type === 'tv')
      : results[0];
    if (!hit) return null;
    const mtype: MediaType = (hit.media_type === 'tv' || type === 'tv') ? 'tv' : 'movie';
    return { result: hit, type: mtype };
  } catch { return null; }
}

async function tmdbByImdbId(imdbId: string): Promise<{ result: TmdbResult; type: MediaType } | null> {
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: { api_key: TMDB_KEY, external_source: 'imdb_id', language: 'en-US' },
      timeout: TIMEOUT,
    });
    const movies: TmdbResult[] = r.data.movie_results || [];
    const tvs: TmdbResult[]    = r.data.tv_results    || [];
    if (movies[0]) return { result: movies[0], type: 'movie' };
    if (tvs[0])    return { result: tvs[0],    type: 'tv' };
    return null;
  } catch { return null; }
}

async function tmdbPersonMovies(personName: string): Promise<TmdbResult[]> {
  try {
    const personRes = await axios.get('https://api.themoviedb.org/3/search/person', {
      params: { api_key: TMDB_KEY, query: personName, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const person = personRes.data.results?.[0];
    if (!person) return [];

    const credRes = await axios.get(`https://api.themoviedb.org/3/person/${person.id}/combined_credits`, {
      params: { api_key: TMDB_KEY, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const cast: TmdbResult[] = credRes.data.cast || [];
    return cast
      .filter(m =>
        (m.media_type === 'movie' || m.media_type === 'tv') &&
        // Kamida 100 ta ovoz — bu obscure/behind-the-scenes kontentni filtrlab tashlaydi
        (m.vote_count ?? 0) >= 100
      )
      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
      .slice(0, 30);
  } catch { return []; }
}

// ─── OMDB ────────────────────────────────────────────────────────────────────

interface OmdbItem { Title: string; Year: string; imdbID: string; Type: string; Genre?: string; }

export async function omdbSearch(query: string, type?: 'movie' | 'series'): Promise<{ title: string; type: MediaType; imdbId: string } | null> {
  if (!OMDB_KEY) return null;
  try {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: OMDB_KEY, s: query, type: type || undefined },
      timeout: TIMEOUT,
    });
    const list: OmdbItem[] = r.data?.Search || [];
    for (const item of list) {
      if (item.Type !== 'movie' && item.Type !== 'series') continue;
      if (isNoisyTitle(item.Title)) continue;
      if (!titlesMatch(query, item.Title)) continue;
      return { title: item.Title, type: item.Type === 'series' ? 'tv' : 'movie', imdbId: item.imdbID };
    }
  } catch { /* ignore */ }
  return null;
}

async function omdbById(imdbId: string): Promise<{ title: string; type: MediaType; imdbId: string } | null> {
  if (!OMDB_KEY) return null;
  try {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: OMDB_KEY, i: imdbId },
      timeout: TIMEOUT,
    });
    if (r.data?.Title && (r.data.Type === 'movie' || r.data.Type === 'series')) {
      return {
        title: r.data.Title,
        type: r.data.Type === 'series' ? 'tv' : 'movie',
        imdbId,
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ─── SERPER ──────────────────────────────────────────────────────────────────

interface SerperResult { title: string; link: string; snippet?: string; }

async function serperSearch(query: string, gl = 'uz', hl = 'uz'): Promise<SerperResult[]> {
  if (!SERPER_KEY) return [];
  try {
    const r = await axios.post('https://google.serper.dev/search',
      { q: query, gl, hl, num: 10 },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return r.data.organic || [];
  } catch { return []; }
}

// ─── IMGBB UPLOAD ────────────────────────────────────────────────────────────

async function uploadToImgbb(base64: string): Promise<string | null> {
  if (!IMGBB_KEY) return null;
  try {
    const params = new URLSearchParams();
    params.append('key', IMGBB_KEY);
    params.append('image', base64);
    params.append('expiration', '600');
    const r = await axios.post('https://api.imgbb.com/1/upload', params, { timeout: TIMEOUT });
    return r.data?.data?.url || null;
  } catch { return null; }
}

// ─── GOOGLE VISION ───────────────────────────────────────────────────────────

interface VisionWebDetection {
  bestGuessLabels?: Array<{ label?: string }>;
  pagesWithMatchingImages?: Array<{ pageTitle?: string; url?: string }>;
  webEntities?: Array<{ description?: string; score?: number }>;
}

const VISION_SKIP = new Set([
  'screenshot','film','cinema','movie','video','image','television','person',
  'man','woman','actor','actress','entertainment','scene','media','watermark',
  'poster','photo','picture','human','people','face','faces','portrait','crowd',
  'instagram','tiktok','telegram','reels','social media',
]);

async function identifyByVision(base64: string): Promise<MovieIdentified | null> {
  if (!VISION_KEY) return null;
  try {
    const r = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`,
      { requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 20 }] }] },
      { timeout: TIMEOUT }
    );
    const wd: VisionWebDetection = r.data?.responses?.[0]?.webDetection || {};

    const pages = (wd.pagesWithMatchingImages || []).filter(
      p => !/youtube|youtu\.be|tiktok|instagram|facebook|twitter|spotify|vevo/i.test(p.url || '')
    );

    // IMDb URL dan to'g'ridan topish
    for (const p of pages) {
      const m = (p.url || '').match(/imdb\.com\/title\/(tt\d+)/);
      if (m && OMDB_KEY) {
        const found = await omdbById(m[1]);
        if (found) return { title: found.title, type: found.type };
      }
    }

    // IMDb sahifa nomi
    const imdbPage = pages.find(p => /imdb/i.test(p.url || '') && p.pageTitle);
    if (imdbPage) {
      const title = imdbPage.pageTitle!
        .replace(/\s*[-–|]\s*IMDb.*/i, '')
        .replace(/\s*\(\d{4}\).*/,'').trim();
      if (title.length > 2) {
        const found = await omdbSearch(title);
        if (found) return { title: found.title, type: found.type };
      }
    }

    // bestGuess
    const bg = wd.bestGuessLabels?.[0]?.label || '';
    if (bg && !VISION_SKIP.has(bg.toLowerCase()) && bg.length > 2) {
      const found = await omdbSearch(bg);
      if (found) return { title: found.title, type: found.type };
    }

    // web entities
    const entities = (wd.webEntities || [])
      .filter(e => (e.score || 0) > 0.6 && e.description && !VISION_SKIP.has(e.description.toLowerCase()))
      .map(e => e.description!)
      .slice(0, 5);
    for (const entity of entities) {
      const found = await omdbSearch(entity);
      if (found) return { title: found.title, type: found.type };
    }
  } catch (e) {
    console.warn('Vision xato:', (e as Error).message?.slice(0, 60));
  }
  return null;
}

// ─── AWS REKOGNITION → TMDb KESISHUVI ────────────────────────────────────────

async function identifyByFaces(base64: string): Promise<MovieIdentified | null> {
  const celebrities = await recognizeCelebrities(base64);
  if (celebrities.length === 0) return null;

  console.log('🎭 Rekognition:', celebrities.map(c => `${c.name}(${c.confidence.toFixed(0)}%)`).join(', '));

  const allFilmSets = await Promise.all(
    celebrities.slice(0, 3).map(c => tmdbPersonMovies(c.name))
  );

  if (allFilmSets.length === 0 || allFilmSets[0].length === 0) return null;

  // Kesishuv: bitta aktyor uchun ham natija ber, ko'p aktyor uchun esa intersection
  let candidates: TmdbResult[] = allFilmSets[0];
  for (let i = 1; i < allFilmSets.length; i++) {
    const ids = new Set(allFilmSets[i].map(f => f.id));
    const intersection = candidates.filter(f => ids.has(f.id));
    if (intersection.length > 0) candidates = intersection;
  }

  candidates = candidates.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, 5);
  console.log('🎬 Candidates:', candidates.map(c => c.title || c.name).join(', '));

  // Bitta qolsa — aniq
  if (candidates.length === 1) {
    const c = candidates[0];
    const title = c.title || c.name || '';
    const type: MediaType = (c.media_type === 'tv') ? 'tv' : 'movie';
    return { title, type, confidence: 'high' };
  }

  // Claude bilan toraytirish
  if (candidates.length > 1 && CLAUDE_KEY) {
    const names = celebrities.map(c => c.name).join(', ');
    const titles = candidates.map(c => c.title || c.name).join(' | ');
    const pick = await claudePickFromCandidates(base64, names, titles);
    if (pick) return pick;
    // Fallback: eng mashhurini qaytaramiz
    const best = candidates[0];
    return { title: best.title || best.name || '', type: best.media_type === 'tv' ? 'tv' : 'movie', confidence: 'medium' };
  }

  return null;
}

async function claudePickFromCandidates(base64: string, actors: string, candidates: string): Promise<MovieIdentified | null> {
  try {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          {
            type: 'text',
            text: `Recognized actors: ${actors}
Candidate movies/shows: ${candidates}

Look at the screenshot carefully. Based on the scene details (costumes, setting, lighting, props), which ONE of the candidates does this screenshot belong to? Also identify which part/sequel if applicable.

Respond ONLY with JSON:
{"title": "Exact title from candidates", "type": "movie" or "tv", "confidence": "high/medium/low"}`
          }
        ]
      }]
    });
    const text = (response.content[0] as { text?: string }).text || '';
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
    if (!parsed.title) return null;
    return {
      title: parsed.title,
      type: parsed.type === 'tv' ? 'tv' : 'movie',
      confidence: parsed.confidence,
    };
  } catch { return null; }
}

// ─── CLAUDE CHAIN-OF-THOUGHT ─────────────────────────────────────────────────

async function identifyByClaude(base64: string, mimeType: string): Promise<MovieIdentified | null> {
  if (!CLAUDE_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: base64 }
          },
          {
            type: 'text',
            text: `You are a world-class movie/TV identifier with deep knowledge of ALL world cinema: Hollywood, Turkish (Yeşilçam & modern), Korean, Russian/Soviet, Uzbek, Indian (Bollywood), and CIS films.

Analyze this screenshot carefully in 4 steps:

STEP 1 — FACES & ACTORS:
- Describe each visible person: age, ethnicity, physical features (hair, beard, build, skin tone)
- Turkish cinema: Do you recognize actors like Aras Bulut İynemli, Erdal Beşikçioğlu, Mehmet Yılmaz Ak, Nuri Alço, Murat Yıldırım, Sıla Türkoğlu?
- Korean cinema: Do you recognize actors like Song Joong-ki, Lee Min-ho, Park Seo-joon?
- If you recognize anyone: their name and which specific movies they're famous for

STEP 2 — VISIBLE TEXT (read everything):
- Subtitles, watermarks, channel logos, player UI, title cards, street signs
- IGNORE social media UI (Instagram/TikTok/Telegram interface around the video)
- Any text on screen is a strong clue — read it carefully

STEP 3 — VISUAL DETAILS:
- Costumes: prison uniform, period Ottoman/Turkish clothes, military uniform, modern clothes, superhero suit
- Setting: prison cell, village, Istanbul/Ankara, rural Turkey, historical period, fantasy
- Color grading, film quality, production value
- Emotional tone of the scene

STEP 4 — CONCLUSION:
- The SPECIFIC movie/show title (not just a franchise name)
- Include part/season number if identifiable
- For Turkish films, common examples: "7. Koğuştaki Mucize", "Çukur", "Diriliş: Ertuğrul", "Kurtlar Vadisi", "Ezel", "Kara Para Aşk"
- For prison scenes with a simple/innocent man and a beard: think "7. Koğuştaki Mucize" (Miracle in Cell No. 7)

Respond ONLY with JSON:
{
  "title": "Exact title (use most common international title)",
  "type": "movie" or "tv",
  "confidence": "high/medium/low",
  "partNumber": null or 1/2/3,
  "country": "Turkey/Korea/USA/etc",
  "reasoning": "Actor X looks like... + costume/setting details = this specific movie"
}`
          }
        ]
      }]
    });

    const text = (response.content[0] as { text?: string }).text || '';
    console.log('Claude:', text.slice(0, 300));
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      title?: string; type?: string; confidence?: string; partNumber?: number | null; reasoning?: string;
    };
    if (!parsed.title || parsed.title.toLowerCase() === 'unknown') return null;

    let title = parsed.title.trim();
    if (parsed.partNumber && parsed.partNumber > 1 && !title.match(/\d$/)) {
      title = `${title} ${parsed.partNumber}`;
    }

    const verified = await omdbSearch(title);
    if (verified) return { title: verified.title, type: verified.type, confidence: parsed.confidence };

    const tmdb = await tmdbSearch(title);
    if (tmdb) return { title: tmdb.result.title || tmdb.result.name || title, type: tmdb.type, confidence: parsed.confidence };

    if (parsed.confidence !== 'low') return { title, type: parsed.type === 'tv' ? 'tv' : 'movie', confidence: parsed.confidence };
    return null;
  } catch (e) {
    console.warn('Claude xato:', (e as Error).message?.slice(0, 80));
    return null;
  }
}

// ─── GEMINI CROSS-CHECK ───────────────────────────────────────────────────────

async function identifyByGemini(base64: string): Promise<MovieIdentified | null> {
  if (!GEMINI_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      {
        inlineData: { data: base64, mimeType: 'image/jpeg' }
      },
`You are an expert in world cinema including Turkish, Korean, Hollywood, Russian, and Uzbek films.

Identify the EXACT movie or TV show in this screenshot.

Key clues to analyze:
1. Actors' faces — recognize them if possible
2. Costumes and clothing style (prison uniform? Ottoman period? Modern?)  
3. Setting and location (prison cell? Village? Istanbul?)
4. Any visible text (subtitles, watermarks, logos) — ignore social media app UI
5. Scene emotion and context

For Turkish prison dramas with an innocent/simple man: consider "7. Koğuştaki Mucize".
For Turkish historical: consider "Diriliş: Ertuğrul", "Kuruluş: Osman".
For Turkish crime: consider "Çukur", "Ezel", "Kara Para Aşk".

Respond ONLY with JSON:
{"title": "Exact title", "type": "movie" or "tv", "confidence": "high/medium/low", "reasoning": "brief explanation"}`
    ]);
    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
    if (!parsed.title || parsed.title.toLowerCase() === 'unknown') return null;

    const verified = await omdbSearch(parsed.title);
    if (verified) return { title: verified.title, type: verified.type, confidence: parsed.confidence };
    return { title: parsed.title, type: parsed.type === 'tv' ? 'tv' : 'movie', confidence: parsed.confidence };
  } catch (e) {
    console.warn('Gemini xato:', (e as Error).message?.slice(0, 200));
    return null;
  }
}

// ─── SMART CROP (watermark/UI olib tashlash) ─────────────────────────────────

async function cropFrame(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 1080;
    const h = meta.height || 1920;
    const ratio = w / h;

    let cropTop: number, cropBottom: number;
    if (ratio >= 0.9) {
      cropTop = Math.round(h * 0.05); cropBottom = Math.round(h * 0.07);
    } else if (ratio <= 0.56) {
      cropTop = Math.round(h * 0.10); cropBottom = Math.round(h * 0.14);
    } else {
      cropTop = Math.round(h * 0.12); cropBottom = Math.round(h * 0.18);
    }

    const cropH = Math.max(1, h - cropTop - cropBottom);
    const cropped = await sharpLib(buf)
      .extract({ left: 0, top: cropTop, width: w, height: cropH })
      .jpeg({ quality: 90 })
      .toBuffer();
    return cropped.toString('base64');
  } catch { return base64; }
}

// ─── VISION NATIJASINI CLAUDE BILAN TASDIQLASH ───────────────────────────────

async function claudeVerify(base64: string, candidateTitle: string, mimeType: string): Promise<boolean> {
  if (!CLAUDE_KEY) return true; // Claude yo'q bo'lsa ishon
  try {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: base64 }
          },
          {
            type: 'text',
            text: `Does this screenshot belong to the movie/TV show "${candidateTitle}"?

Look carefully at the actual film frame (ignore any app/social media UI):
- Do the actors, costumes, and setting match "${candidateTitle}"?
- Could this be from a completely different movie?

Answer ONLY with JSON: {"match": true/false, "reason": "brief explanation"}`
          }
        ]
      }]
    });
    const text = (response.content[0] as { text?: string }).text || '';
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return true;
    const parsed = JSON.parse(m[0]) as { match?: boolean; reason?: string };
    console.log(`🔍 Claude verify "${candidateTitle}": ${parsed.match} — ${parsed.reason}`);
    return parsed.match !== false;
  } catch { return true; }
}

// ─── ASOSIY ANIQLASH ─────────────────────────────────────────────────────────

export async function identifyMovie(base64: string, mimeType: string): Promise<MovieIdentified | null> {
  const withTimeout = <T>(p: Promise<T>, ms = 10000): Promise<T | null> =>
    Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]).catch(() => null);

  // Cropped version (watermark/UI olib tashlangan)
  const croppedBase64 = await cropFrame(base64);

  // PASS 1: Parallel — Rekognition (yuz) + Vision (reverse) + Gemini
  const [faces, vision, gemini] = await Promise.all([
    withTimeout(identifyByFaces(croppedBase64)),
    withTimeout(identifyByVision(croppedBase64)),
    withTimeout(identifyByGemini(croppedBase64)),
  ]);

  console.log(`Pass1 — Faces: ${faces?.title || '-'}, Vision: ${vision?.title || '-'}, Gemini: ${gemini?.title || '-'}`);

  // Ikkitasi yoki undan ko'pi bir xil javob bersa — aniq (tasdiqlashsiz)
  const results = [faces, vision, gemini].filter(Boolean) as MovieIdentified[];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (titlesMatch(results[i].title, results[j].title)) {
        console.log('✅ Consensus:', results[i].title);
        return results[i];
      }
    }
  }

  // Rekognition yuqori ishonch bilan topsa — Claude bilan tasdiqlash
  if (faces?.confidence === 'high') {
    const ok = await withTimeout(claudeVerify(croppedBase64, faces.title, mimeType));
    if (ok !== false) return faces;
    console.log(`⚠️ Claude Rekognition natijasini rad etdi: "${faces.title}"`);
  }

  // PASS 2: Claude asosiy tahlil (har doim ishlatiladi — eng ishonchli)
  const claude = await withTimeout(identifyByClaude(croppedBase64, mimeType));
  if (claude) {
    console.log('✅ Claude:', claude.title);
    // Vision bilan mosligini tekshirish
    if (vision && titlesMatch(vision.title, claude.title)) {
      return claude; // Ikkalasi mos — juda aniq
    }
    // Claude high/medium bo'lsa — uni ishon, Vision ga emas
    if (claude.confidence === 'high' || claude.confidence === 'medium') return claude;
  }

  // Vision topgan bo'lsa — Claude bilan tasdiqlash
  if (vision) {
    const verified = await withTimeout(claudeVerify(croppedBase64, vision.title, mimeType));
    if (verified !== false) {
      console.log('✅ Vision (Claude tasdiqladi):', vision.title);
      return vision;
    }
    console.log(`⚠️ Claude Vision natijasini rad etdi: "${vision.title}"`);
    // Claude rad etdi — Claude o'zining low confidence natijasini qaytarish
    if (claude) return claude;
  }

  // Qolgan natijalar
  if (claude) return claude;
  if (gemini) {
    const ok = await withTimeout(claudeVerify(croppedBase64, gemini.title, mimeType));
    if (ok !== false) return gemini;
  }
  if (faces) return faces;

  return null;
}

// ─── MATN ORQALI FILM QIDIRISH ────────────────────────────────────────────────

export async function identifyFromText(query: string): Promise<MovieIdentified | null> {
  // OMDb — to'g'ridan qidirish (faqat so'rov nomi natija nomi bilan mos kelsa)
  const omdb = await omdbSearch(query);
  if (omdb) return { title: omdb.title, type: omdb.type };

  // TMDb — natijani so'rov bilan solishtirib tekshirish
  const tmdb = await tmdbSearch(query);
  if (tmdb?.result) {
    const tmdbTitle = tmdb.result.title || tmdb.result.name || '';
    const voteCount = tmdb.result.vote_count ?? 0;
    // Ikkita holda TMDB natijasiga ishonamiz:
    // 1) Nom so'rov bilan mos kelsa (inglizcha)
    // 2) Nom mos kelmasa ham, film juda mashhur bo'lsa (≥500 ovoz) —
    //    bu boshqa tilda yozilgan so'rovlarda TMDB o'zi to'g'ri topishi mumkin
    if (titlesMatch(query, tmdbTitle) || voteCount >= 500) {
      return { title: tmdbTitle, type: tmdb.type };
    }
    // TMDb natijasi so'rov bilan mos kelmadi va mashxur emas — Claude ga o'tamiz
  }

  // Claude — tarjima, tavsif, boshqa tildan aniqlash
  if (CLAUDE_KEY) {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Identify the EXACT movie or TV show from this query (may be in Uzbek, Russian, Turkish, or English title/description):
"${query}"

Rules:
- If the query is a movie/show title in another language, return the original international title
- If it's a description, identify the most likely match
- Only respond if confidence is medium or high

Respond ONLY with JSON:
{"title": "Exact original title", "type": "movie" or "tv", "confidence": "high/medium/low"}`
        }]
      });
      const text = (response.content[0] as { text?: string }).text || '';
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) {
        const p = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
        if (p.title && p.title.toLowerCase() !== 'unknown' && p.confidence !== 'low') {
          // Claude natijasini OMDB/TMDB bilan tasdiqlash
          const verified = await omdbSearch(p.title);
          if (verified) return { title: verified.title, type: verified.type };
          const tmdbVerified = await tmdbSearch(p.title);
          if (tmdbVerified?.result) {
            return {
              title: tmdbVerified.result.title || tmdbVerified.result.name || p.title,
              type: tmdbVerified.type,
            };
          }
          // Claude topdi lekin OMDB/TMDB da yo'q — baribir qaytaramiz (low-profile film)
          if (p.confidence === 'high') {
            return { title: p.title, type: p.type === 'tv' ? 'tv' : 'movie' };
          }
        }
      }
    } catch { /* ignore */ }
  }

  return null;
}

// ─── FILM MA'LUMOTLARI VA WATCH LINKS ────────────────────────────────────────

async function translateToUzbek(text: string): Promise<string> {
  if (!CLAUDE_KEY || !text) return text;
  try {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    const r = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Translate this movie plot to Uzbek (lotin yozuvida). Only output the translation:\n"${text}"` }]
    });
    return (r.content[0] as { text?: string }).text?.trim() || text;
  } catch { return text; }
}

async function translateTitle(englishTitle: string): Promise<string> {
  if (!CLAUDE_KEY) return englishTitle;
  try {
    const anthropic = new Anthropic({ apiKey: CLAUDE_KEY });
    const r = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Translate ONLY the movie/TV show title "${englishTitle}" to Uzbek (official localization used in Uzbek dubbing). If no official Uzbek title exists, transliterate or keep original. Output ONLY the title, nothing else.`
      }]
    });
    const result = (r.content[0] as { text?: string }).text?.trim() || englishTitle;
    return result.toLowerCase() === englishTitle.toLowerCase() ? englishTitle : result;
  } catch { return englishTitle; }
}

const ALLOWED_HOSTS = [
  'ok.ru','vk.com','vkvideo.ru','rutube.ru','dailymotion.com',
  'uzmovi.tv','uzmovi.com','uzmovi.uz','kinopoisk.ru','hd.kinopoisk.ru',
  'ivi.ru','start.ru','yandex.ru','netflix.com','primevideo.com',
  'hbomax.com','max.com','disneyplus.com',
];
const BLOCKED_HOSTS = [
  'youtube.com','youtu.be','tiktok.com','instagram.com','facebook.com',
  'twitter.com','x.com','t.me','google.com','wikipedia.org','reddit.com',
  'github.com','medium.com','academia.edu','pdf',
];

function canonHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\.|^m\./, ''); } catch { return ''; }
}

function isAllowedWatchUrl(url: string, title?: string): boolean {
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    if (title && /\b(pdf|kitob|leksiya|referat)\b/i.test(title)) return false;
    const host = canonHost(url);
    if (BLOCKED_HOSTS.some(b => host === b || host.endsWith(`.${b}`))) return false;
    return ALLOWED_HOSTS.some(a => host === a || host.endsWith(`.${a}`));
  } catch { return false; }
}

async function findWatchLinks(title: string, originalTitle: string, year: string): Promise<WatchLink[]> {
  const base = originalTitle || title;
  const q1 = `${base} ${year} o'zbek tilida tomosha ko'rish`.trim();
  const q2 = `${base} o'zbek tilida`.trim();
  const q3 = `${base} смотреть онлайн`;

  const [r1, r2, r3] = await Promise.allSettled([
    serperSearch(q1, 'uz', 'uz'),
    serperSearch(q2, 'uz', 'uz'),
    serperSearch(q3, 'ru', 'ru'),
  ]);

  const all = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ];

  const seen = new Set<string>();
  const links: WatchLink[] = [];

  for (const item of all) {
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    seen.add(host);
    links.push({ title: item.title, link: item.link, source: host });
    if (links.length >= 4) break;
  }

  return links;
}

export async function getMovieDetails(identified: MovieIdentified): Promise<MovieDetails> {
  const { title, type } = identified;

  // OMDb dan IMDb ID
  let imdbId: string | null = null;
  const omdb = await omdbSearch(title, type === 'tv' ? 'series' : 'movie');
  if (omdb) imdbId = omdb.imdbId;

  // TMDb detallar
  let tmdbResult: TmdbResult | null = null;
  if (imdbId) {
    const found = await tmdbByImdbId(imdbId);
    if (found) tmdbResult = found.result;
  }
  if (!tmdbResult) {
    const found = await tmdbSearch(title, type);
    if (found) tmdbResult = found.result;
  }

  // TMDb dan to'liq detallar
  if (tmdbResult?.id) {
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbResult.id}`, {
        params: { api_key: TMDB_KEY, language: 'en-US' },
        timeout: TIMEOUT,
      });
      tmdbResult = { ...tmdbResult, ...r.data };
    } catch { /* ignore */ }
  }

  const displayTitle = (type === 'tv' ? tmdbResult?.name : tmdbResult?.title) || title;
  const originalTitle = (type === 'tv' ? tmdbResult?.original_name : tmdbResult?.original_title) || title;
  const year = ((type === 'tv' ? tmdbResult?.first_air_date : tmdbResult?.release_date) || '').split('-')[0];
  const rating = tmdbResult?.vote_average ? tmdbResult.vote_average.toFixed(1) : 'N/A';
  const posterUrl = tmdbResult?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}` : null;

  // Plot va title tarjimasi parallel
  const englishPlot = tmdbResult?.overview || '';
  const [uzTitle, plotUz, watchLinks] = await Promise.all([
    translateTitle(displayTitle),
    englishPlot ? translateToUzbek(englishPlot) : Promise.resolve('Tavsif mavjud emas'),
    findWatchLinks(displayTitle, originalTitle, year),
  ]);

  return {
    title: displayTitle,
    uzTitle,
    originalTitle,
    year,
    rating,
    posterUrl,
    plotUz,
    imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}` : null,
    watchLinks,
  };
}
