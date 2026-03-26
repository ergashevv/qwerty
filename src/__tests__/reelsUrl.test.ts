import { extractInstagramReelUrl } from '../services/reelsUrl';

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
