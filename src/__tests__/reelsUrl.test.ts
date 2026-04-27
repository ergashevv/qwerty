import {
  extractInstagramReelUrl,
  extractYouTubeUrl,
  extractUserHintBesideFirstUrl,
  normalizeVideoUrlForCache,
  hashVideoUrlForCache,
} from '../services/reelsUrl';

describe('extractInstagramReelUrl', () => {
  it('reel/ shortcode', () => {
    expect(extractInstagramReelUrl('look https://www.instagram.com/reel/ABCxyz123_/ extra')).toBe(
      'https://www.instagram.com/reel/ABCxyz123_/'
    );
  });

  it('protocolsiz instagram link', () => {
    expect(extractInstagramReelUrl('instagram.com/reel/ABCxyz123_/?igsh=abc')).toBe(
      'https://www.instagram.com/reel/ABCxyz123_/'
    );
  });

  it('reels/ plural', () => {
    expect(extractInstagramReelUrl('https://instagram.com/reels/ZZ99aa/')).toBe(
      'https://www.instagram.com/reel/ZZ99aa/'
    );
  });

  it('l.instagram.com redirect ichidagi url', () => {
    expect(
      extractInstagramReelUrl(
        'https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Freel%2FREDIR123%2F%3Figsh%3Dx'
      )
    ).toBe('https://www.instagram.com/reel/REDIR123/');
  });

  it('instagram tv link ham video sifatida olinadi', () => {
    expect(extractInstagramReelUrl('https://www.instagram.com/tv/TV123abc/')).toBe(
      'https://www.instagram.com/tv/TV123abc/'
    );
  });

  it('instagram share/reel link yt-dlp uchun saqlanadi', () => {
    expect(extractInstagramReelUrl('https://www.instagram.com/share/reel/BAIv0abcdef/?utm_source=x')).toBe(
      'https://www.instagram.com/share/reel/BAIv0abcdef/'
    );
  });

  it('no match', () => {
    expect(extractInstagramReelUrl('https://youtube.com/watch?v=1')).toBeNull();
  });
});

describe('extractYouTubeUrl', () => {
  it('watch?v=', () => {
    expect(extractYouTubeUrl('trailer https://www.youtube.com/watch?v=dQw4w9WgXcQ end')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });

  it('youtu.be', () => {
    expect(extractYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('Shorts', () => {
    expect(extractYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/shorts/dQw4w9WgXcQ'
    );
  });

  it('no match', () => {
    expect(extractYouTubeUrl('instagram.com/reel/x')).toBeNull();
  });
});

describe('extractUserHintBesideFirstUrl', () => {
  it('matn + havola', () => {
    expect(extractUserHintBesideFirstUrl('Inception https://youtu.be/dQw4w9WgXcQ')).toBe('Inception');
  });

  it('faqat havola', () => {
    expect(extractUserHintBesideFirstUrl('https://youtu.be/dQw4w9WgXcQ')).toBeNull();
  });

  it('protocolsiz instagram havolani ham olib tashlaydi', () => {
    expect(extractUserHintBesideFirstUrl('Inception instagram.com/reel/ABC123/?igsh=x')).toBe('Inception');
  });
});

describe('normalizeVideoUrlForCache', () => {
  it('YouTube watch — tracking olib tashlanadi', () => {
    expect(
      normalizeVideoUrlForCache('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&t=12')
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('youtu.be → watch', () => {
    expect(normalizeVideoUrlForCache('https://youtu.be/dQw4w9WgXcQ?feature=share')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });

  it('Instagram reel — barqaror', () => {
    expect(normalizeVideoUrlForCache('https://www.instagram.com/reel/ABC123/?igshid=x')).toBe(
      'https://www.instagram.com/reel/ABC123/'
    );
  });

  it('Instagram redirect — ichki canonical url', () => {
    expect(
      normalizeVideoUrlForCache(
        'https://l.instagram.com/?u=https%3A%2F%2Finstagram.com%2Freel%2FABC123%2F%3Figshid%3Dx'
      )
    ).toBe('https://www.instagram.com/reel/ABC123/');
  });

  it('Instagram share/reel — tracking olib tashlanadi', () => {
    expect(normalizeVideoUrlForCache('https://www.instagram.com/share/reel/BAIv0abcdef/?utm_source=x')).toBe(
      'https://www.instagram.com/share/reel/BAIv0abcdef/'
    );
  });

  it('bir xil havola — bir xil xesh', () => {
    const a = hashVideoUrlForCache('https://youtu.be/dQw4w9WgXcQ');
    const b = hashVideoUrlForCache(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx'
    );
    expect(a).toBe(b);
  });
});
