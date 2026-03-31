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
  it('captionda Tomosha havolalari bloki yo‘q, forward eslatmasi bor', () => {
    const c = buildMovieResultCaption(baseDetails(), {});
    expect(c).not.toMatch(/Tomosha havolalari/);
    expect(c).toMatch(/Poster va barcha havolalar: chatdagi yuqoridagi xabarni forward qiling/);
    expect(c).toMatch(/Ulashish/);
  });
});

describe('buildTelegramShareUrl', () => {
  it('har doim SHARE_FORWARD_HINT qatorini o‘z ichiga oladi', () => {
    const u = buildTelegramShareUrl(baseDetails(), 'kinova_bot');
    expect(u).not.toBeNull();
    const m = u!.match(/text=([^&]+)/);
    expect(m).not.toBeNull();
    const text = decodeURIComponent(m![1]);
    expect(text).toContain('Poster va barcha havolalar: chatdagi yuqoridagi xabarni forward qiling.');
  });

  it('juda uzun sarlavhada ham minimal fallbackda eslatma qoladi', () => {
    const d = baseDetails();
    d.title = 'A'.repeat(500);
    d.originalTitle = d.title;
    const u = buildTelegramShareUrl(d, 'kinova_bot');
    expect(u).not.toBeNull();
    const m = u!.match(/text=([^&]+)/);
    const text = decodeURIComponent(m![1]);
    expect(text).toContain('Poster va barcha havolalar: chatdagi yuqoridagi xabarni forward qiling.');
  });

  it('butun URL 2048 dan oshmasin', () => {
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
