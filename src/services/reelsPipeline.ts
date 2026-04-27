import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sharpLib from 'sharp';
import { identifyMovie, titlesMatch, type MovieIdentified } from './movieService';

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_CANDIDATES = Array.from(
  new Set(
    [
      process.env.FFPROBE_PATH?.trim(),
      FFMPEG.includes('/') ? path.join(path.dirname(FFMPEG), 'ffprobe') : null,
      'ffprobe',
    ].filter((value): value is string => Boolean(value))
  )
);

const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.REELS_DOWNLOAD_TIMEOUT_MS || '90000', 10);
const FFMPEG_TIMEOUT_MS = parseInt(process.env.REELS_FFMPEG_TIMEOUT_MS || '45000', 10);
const MAX_FILE_MB = parseInt(process.env.REELS_MAX_DOWNLOAD_MB || '80', 10);
const REELS_MAX_FRAMES = Math.min(
  12,
  Math.max(4, parseInt(process.env.REELS_MAX_FRAMES || '8', 10))
);
const REELS_MIN_MATCHING_FRAMES = Math.max(
  2,
  parseInt(process.env.REELS_MIN_MATCHING_FRAMES || '2', 10)
);
const REELS_ALLOW_SINGLE_HIGH_CONFIDENCE =
  (process.env.REELS_ALLOW_SINGLE_HIGH_CONFIDENCE || 'true').trim().toLowerCase() !== 'false';
const REELS_ALLOW_SINGLE_MEDIUM_CONFIDENCE =
  (process.env.REELS_ALLOW_SINGLE_MEDIUM_CONFIDENCE || 'true').trim().toLowerCase() !== 'false';

/** Sekund — env berilsa aynan shu kadrlar olinadi; bo'lmasa duration bo'yicha dinamik tanlanadi. */
const FRAME_OFFSETS_SEC_OVERRIDE = (() => {
  const raw = process.env.REELS_FRAME_OFFSETS_SEC?.trim();
  if (!raw) return null;
  const parts = raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n) && n >= 0);
  return parts.length > 0 ? parts.slice(0, REELS_MAX_FRAMES) : null;
})();

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const errChunks: Buffer[] = [];
    const outChunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('process_timeout'));
    }, options.timeoutMs);
    child.stdout?.on('data', (d) => outChunks.push(d));
    child.stderr?.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

function reelsCookiesPath(): string | null {
  const raw =
    process.env.REELS_COOKIES_PATH ||
    process.env.INSTAGRAM_COOKIES_PATH ||
    process.env.YT_DLP_COOKIES_PATH ||
    '';
  const value = raw.trim();
  if (!value) return null;
  return fs.existsSync(value) ? value : null;
}

async function downloadVideo(reelUrl: string, workDir: string): Promise<string> {
  const outTmpl = path.join(workDir, 'src.%(ext)s');
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--geo-bypass',
    '--max-filesize',
    `${MAX_FILE_MB}M`,
    '-f',
    'bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--socket-timeout',
    '25',
    '--retries',
    '4',
    '--fragment-retries',
    '4',
    '--user-agent',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    '-o',
    outTmpl,
    reelUrl,
  ];
  const cookies = reelsCookiesPath();
  if (cookies) {
    args.splice(args.length - 1, 0, '--cookies', cookies);
  }
  const r = await runProcess(YT_DLP, args, { cwd: workDir, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`yt-dlp: ${r.stderr.slice(-400) || 'xato'}`);
  }
  const names = fs.readdirSync(workDir).filter((n) => /\.(mp4|webm|mkv|mov)$/i.test(n));
  if (names.length === 0) {
    throw new Error('video_fayl_topilmadi');
  }
  return path.join(workDir, names[0]);
}

async function extractOneFrame(videoPath: string, workDir: string, offsetSec: number, index: number): Promise<string | null> {
  const out = path.join(workDir, `frame_${index}.jpg`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(offsetSec),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    out,
  ];
  const r = await runProcess(FFMPEG, args, { cwd: workDir, timeoutMs: FFMPEG_TIMEOUT_MS });
  if (r.code !== 0 || !fs.existsSync(out)) return null;
  return out;
}

async function readVideoDurationSeconds(videoPath: string, workDir: string): Promise<number | null> {
  for (const ffprobe of FFPROBE_CANDIDATES) {
    try {
      const r = await runProcess(
        ffprobe,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          videoPath,
        ],
        { cwd: workDir, timeoutMs: 12000 }
      );
      if (r.code !== 0) continue;
      const n = parseFloat(r.stdout.trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      continue;
    }
  }
  return null;
}

function uniqueFrameOffsets(values: number[], durationSec: number | null): number[] {
  const maxOffset = durationSec && durationSec > 0.8 ? durationSec - 0.25 : null;
  const sorted = values
    .map((n) => Math.max(0.15, maxOffset == null ? n : Math.min(n, maxOffset)))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const out: number[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev != null && Math.abs(prev - n) < 0.65) continue;
    out.push(Number(n.toFixed(2)));
    if (out.length >= REELS_MAX_FRAMES) break;
  }
  return out;
}

function frameOffsetsForDuration(durationSec: number | null): number[] {
  if (FRAME_OFFSETS_SEC_OVERRIDE) {
    return uniqueFrameOffsets(FRAME_OFFSETS_SEC_OVERRIDE, durationSec);
  }

  if (!durationSec) {
    return [0.5, 1.5, 3, 5, 8, 12, 18, 25].slice(0, REELS_MAX_FRAMES);
  }

  const anchors = [0.35, 1.1, 2.3, 4.2, 7.0, 11.0, 16.0, 24.0, 34.0];
  const percentages = [0.12, 0.24, 0.38, 0.54, 0.7, 0.86].map((p) => durationSec * p);
  return uniqueFrameOffsets([...anchors, ...percentages], durationSec);
}

async function extractFrames(videoPath: string, workDir: string): Promise<string[]> {
  const duration = await readVideoDurationSeconds(videoPath, workDir);
  const offsets = frameOffsetsForDuration(duration);
  const frames: string[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const fp = await extractOneFrame(videoPath, workDir, offsets[i], i);
    if (fp) frames.push(fp);
  }
  return frames;
}

async function buildContactSheet(framePaths: string[], workDir: string): Promise<string | null> {
  const selected = framePaths.slice(0, Math.min(6, framePaths.length));
  if (selected.length < 2) return null;

  try {
    const thumbW = 360;
    const thumbH = 640;
    const columns = Math.min(3, selected.length);
    const rows = Math.ceil(selected.length / columns);
    const thumbs = await Promise.all(
      selected.map((framePath) =>
        sharpLib(framePath)
          .resize(thumbW, thumbH, { fit: 'inside', background: '#000000' })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer()
      )
    );
    const out = await sharpLib({
      create: {
        width: columns * thumbW,
        height: rows * thumbH,
        channels: 3,
        background: '#000000',
      },
    })
      .composite(
        thumbs.map((input, i) => ({
          input,
          left: (i % columns) * thumbW,
          top: Math.floor(i / columns) * thumbH,
        }))
      )
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    const outPath = path.join(workDir, 'contact_sheet.jpg');
    fs.writeFileSync(outPath, out);
    return outPath;
  } catch (e) {
    console.warn('Reels contact sheet xato:', (e as Error).message?.slice(0, 120));
    return null;
  }
}

export interface ReelsIdentifyResult extends Pick<MovieIdentified, 'title' | 'type' | 'confidence'> {
  usedFrameIndex: number;
}

interface ReelsConsensusBucket {
  representative: ReelsIdentifyResult;
  count: number;
}

function reelsConfidenceRank(confidence: string | undefined): number {
  const value = (confidence || '').toLowerCase();
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 0;
  return 1;
}

function chooseBetterRepresentative(
  current: ReelsIdentifyResult,
  incoming: ReelsIdentifyResult
): ReelsIdentifyResult {
  const currentRank = reelsConfidenceRank(current.confidence);
  const incomingRank = reelsConfidenceRank(incoming.confidence);
  if (incomingRank > currentRank) return incoming;
  if (incomingRank < currentRank) return current;
  return incoming.usedFrameIndex < current.usedFrameIndex ? incoming : current;
}

function buildReelsConsensusBuckets(results: ReelsIdentifyResult[]): ReelsConsensusBucket[] {
  const buckets: ReelsConsensusBucket[] = [];
  for (const result of results) {
    const bucket = buckets.find(
      (item) => item.representative.type === result.type && titlesMatch(item.representative.title, result.title)
    );
    if (!bucket) {
      buckets.push({ representative: result, count: 1 });
      continue;
    }
    bucket.count += 1;
    bucket.representative = chooseBetterRepresentative(bucket.representative, result);
  }
  return buckets.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const confDiff = reelsConfidenceRank(b.representative.confidence) - reelsConfidenceRank(a.representative.confidence);
    if (confDiff !== 0) return confDiff;
    return a.representative.usedFrameIndex - b.representative.usedFrameIndex;
  });
}

export function selectReelsConsensus(
  results: ReelsIdentifyResult[],
  options?: { minMatchingFrames?: number; allowSingleHighConfidence?: boolean }
): ReelsIdentifyResult | null {
  if (results.length === 0) return null;
  const minMatchingFrames = Math.max(1, options?.minMatchingFrames ?? REELS_MIN_MATCHING_FRAMES);
  const allowSingleHighConfidence =
    options?.allowSingleHighConfidence ?? REELS_ALLOW_SINGLE_HIGH_CONFIDENCE;
  const buckets = buildReelsConsensusBuckets(results);
  const best = buckets[0];
  if (!best) return null;
  if (best.count >= minMatchingFrames) return best.representative;
  const bestRank = reelsConfidenceRank(best.representative.confidence);
  if (
    allowSingleHighConfidence &&
    best.count === 1 &&
    bestRank >= 3
  ) {
    return best.representative;
  }
  if (
    allowSingleHighConfidence &&
    REELS_ALLOW_SINGLE_MEDIUM_CONFIDENCE &&
    best.count === 1 &&
    bestRank >= 2
  ) {
    return best.representative;
  }
  return null;
}

export type ReelsIdentifyOutcome =
  | { ok: true; identified: ReelsIdentifyResult }
  | { ok: false; lastFrameBase64: string | null };

function pushFrameResult(results: ReelsIdentifyResult[], incoming: ReelsIdentifyResult): void {
  if (!incoming.title.trim()) return;
  if (
    results.some(
      (item) =>
        item.usedFrameIndex === incoming.usedFrameIndex &&
        item.type === incoming.type &&
        titlesMatch(item.title, incoming.title)
    )
  ) {
    return;
  }
  results.push(incoming);
}

function collectIdentifyOutcome(
  results: ReelsIdentifyResult[],
  outcome: Awaited<ReturnType<typeof identifyMovie>>,
  usedFrameIndex: number
): void {
  if (outcome.ok) {
    pushFrameResult(results, {
      title: outcome.identified.title,
      type: outcome.identified.type,
      confidence: outcome.identified.confidence,
      usedFrameIndex,
    });
    return;
  }

  if (outcome.reason !== 'llm_verify_failed') return;
  for (const candidate of outcome.candidates.slice(0, 3)) {
    pushFrameResult(results, {
      title: candidate.title,
      type: candidate.type,
      confidence: candidate.confidence ?? 'medium',
      usedFrameIndex,
    });
  }
}

/**
 * Videodan ketma-kadrlar bilan identifyMovie — birinchi muvaffaqiyatli natija.
 * Muvaffaqiyatsiz bo‘lsa, oxirgi olingan kadr (fallback: aktyor film taxminlari) uchun base64 qaytariladi.
 */
export async function identifyMovieFromReelVideo(
  reelUrl: string,
  textHint?: string | null
): Promise<ReelsIdentifyOutcome> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinova-reel-'));
  let lastFrameBase64: string | null = null;
  const successfulFrames: ReelsIdentifyResult[] = [];
  try {
    const videoPath = await downloadVideo(reelUrl, workDir);
    const framePaths = await extractFrames(videoPath, workDir);

    if (framePaths.length > 0) {
      lastFrameBase64 = fs.readFileSync(framePaths[framePaths.length - 1]).toString('base64');
    }

    const contactSheet = await buildContactSheet(framePaths, workDir);
    if (contactSheet) {
      const sheetBase64 = fs.readFileSync(contactSheet).toString('base64');
      const sheetOutcome = await identifyMovie(sheetBase64, 'image/jpeg', textHint?.trim() || null);
      if (sheetOutcome.ok) {
        return {
          ok: true,
          identified: {
            title: sheetOutcome.identified.title,
            type: sheetOutcome.identified.type,
            confidence: sheetOutcome.identified.confidence,
            usedFrameIndex: -1,
          },
        };
      }
      collectIdentifyOutcome(successfulFrames, sheetOutcome, -1);
      const sheetConsensus = selectReelsConsensus(successfulFrames, {
        minMatchingFrames: REELS_MIN_MATCHING_FRAMES,
        allowSingleHighConfidence: true,
      });
      if (sheetConsensus) {
        return {
          ok: true,
          identified: sheetConsensus,
        };
      }
    }

    for (let i = 0; i < framePaths.length; i++) {
      const base64 = fs.readFileSync(framePaths[i]).toString('base64');
      lastFrameBase64 = base64;
      const frameOutcome = await identifyMovie(base64, 'image/jpeg', textHint?.trim() || null);
      collectIdentifyOutcome(successfulFrames, frameOutcome, i);
      const consensus = selectReelsConsensus(successfulFrames, {
        minMatchingFrames: REELS_MIN_MATCHING_FRAMES,
        allowSingleHighConfidence: false,
      });
      if (consensus) {
        return {
          ok: true,
          identified: consensus,
        };
      }
    }

    const finalConsensus = selectReelsConsensus(successfulFrames, {
      minMatchingFrames: REELS_MIN_MATCHING_FRAMES,
      allowSingleHighConfidence: REELS_ALLOW_SINGLE_HIGH_CONFIDENCE,
    });
    if (finalConsensus) {
      return {
        ok: true,
        identified: finalConsensus,
      };
    }
    return { ok: false, lastFrameBase64 };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
