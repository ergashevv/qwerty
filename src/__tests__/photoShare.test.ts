import type { MovieDetails } from '../services/movieService';
import {
  buildMovieResultCaption,
  buildTelegramShareUrl,
} from '../handlers/photo';

const baseDetails = (): MovieDetails => ({
  title: 'Silicon Valley',
  originalTitle: 'Silicon Valley',
  uzTitle: 'Kremniy vodiysi',
  year: '2014',
  rating: '8.5',
  plotUz: 'Test plot about Silicon Valley gold rush.',
  posterUrl: 'https://example.com/p.jpg',
  watchLinks: [
    {
      title: 'u1',
      source: 'uzbeklar.biz',
      link: 'https://uzbeklar.biz/8603-kremniy-vodiysi.html',
    },
    {
      title: 'v1',
      source: 'vk.com (RU)',
      link: 'https://vk.com/video-7902145_456241058',
    },
  ],
  imdbUrl: 'https://www.imdb.com/title/tt2575988/',
  tmdbId: 1,
  mediaType: 'tv',
});

describe('buildMovieResultCaption', () => {
  it('captionda Tomosha havolalari va ortiqcha eslatmalar yo‘q', () => {
    const c = buildMovieResultCaption(baseDetails(), {});
    expect(c).not.toMatch(/Tomosha havolalari/);
    expect(c).not.toMatch(/Poster va barcha havolalar/);
    expect(c).not.toMatch(/Ulashish/);
    expect(c).toMatch(/Kremniy vodiysi/);
    expect(c).toMatch(/Silicon Valley/);
  });
});

describe('buildTelegramShareUrl', () => {
  it('qisqa matn: sarlavha, uzun havolalar ro‘yxati yo‘q', () => {
    const u = buildTelegramShareUrl(baseDetails(), 'kinova_bot');
    expect(u).not.toBeNull();
    const m = u!.match(/text=([^&]+)/);
    expect(m).not.toBeNull();
    const text = decodeURIComponent(m![1]);
    expect(text).toMatch(/🎬 Kremniy vodiysi/);
    expect(text).toMatch(/Silicon Valley/);
    expect(text).not.toMatch(/Tomosha havolalari/);
    expect(text).not.toMatch(/Poster va barcha havolalar/);
    expect(text).not.toMatch(/https:\/\/uzbeklar/);
    expect(text).not.toMatch(/https:\/\/duckduckgo\.com\/\?q=/);
  });

  it('juda uzun sarlavhada ham URL chegarada ishlaydi', () => {
    const d = baseDetails();
    d.title = 'A'.repeat(500);
    d.originalTitle = d.title;
    const u = buildTelegramShareUrl(d, 'kinova_bot');
    expect(u).not.toBeNull();
    expect(u!.length).toBeLessThanOrEqual(2048);
    const m = u!.match(/text=([^&]+)/);
    const text = decodeURIComponent(m![1]);
    expect(text.startsWith('🎬 ')).toBe(true);
    expect(text).not.toMatch(/https:\/\//);
  });

  it('butun inline keyboard URL 2048 dan oshmasin', () => {
    const d = baseDetails();
    d.watchLinks = Array.from({ length: 20 }, (_, i) => ({
      title: `t${i}`,
      source: `s${i}`,
      link: `https://example.com/${'x'.repeat(80)}/${i}`,
    }));
    const u = buildTelegramShareUrl(d, 'kinova_bot');
    expect(u).not.toBeNull();
    expect(u!.length).toBeLessThanOrEqual(2048);
  });
});
