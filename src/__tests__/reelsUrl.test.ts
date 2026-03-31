import {
  extractInstagramReelUrl,
  extractYouTubeUrl,
  extractUserHintBesideFirstUrl,
} from '../services/reelsUrl';

describe('extractInstagramReelUrl', () => {
  it('reel/ shortcode', () => {
    expect(extractInstagramReelUrl('look https://www.instagram.com/reel/ABCxyz123_/ extra')).toBe(
      'https://www.instagram.com/reel/ABCxyz123_/'
    );
  });

  it('reels/ plural', () => {
    expect(extractInstagramReelUrl('https://instagram.com/reels/ZZ99aa/')).toBe(
      'https://www.instagram.com/reel/ZZ99aa/'
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
});
