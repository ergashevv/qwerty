import { selectReelsConsensus, type ReelsIdentifyResult } from '../services/reelsPipeline';

function frame(
  title: string,
  usedFrameIndex: number,
  confidence?: string,
  type: 'movie' | 'tv' = 'movie'
): ReelsIdentifyResult {
  return { title, usedFrameIndex, confidence, type };
}

describe('selectReelsConsensus', () => {
  test('ikki frame bir xil filmni bersa consensus qaytaradi', () => {
    const result = selectReelsConsensus(
      [frame('Iron Man', 0, 'medium'), frame('Iron Man', 2, 'high')],
      { minMatchingFrames: 2, allowSingleHighConfidence: false }
    );
    expect(result?.title).toBe('Iron Man');
    expect(result?.usedFrameIndex).toBe(2);
    expect(result?.confidence).toBe('high');
  });

  test('bitta high confidence natija allow bo‘lsa qabul qilinadi', () => {
    const result = selectReelsConsensus(
      [frame('Parasite', 1, 'high')],
      { minMatchingFrames: 2, allowSingleHighConfidence: true }
    );
    expect(result?.title).toBe('Parasite');
  });

  test('bitta high confidence yonida faqat zaifroq nomzod bo‘lsa high qabul qilinadi', () => {
    const result = selectReelsConsensus(
      [frame('Parasite', 1, 'high'), frame('Wrong Turn', 2, 'medium')],
      { minMatchingFrames: 2, allowSingleHighConfidence: true }
    );
    expect(result?.title).toBe('Parasite');
  });

  test('bitta medium confidence natija ham best-effort sifatida qabul qilinadi', () => {
    const result = selectReelsConsensus(
      [frame('Reacher', 1, 'medium', 'tv')],
      { minMatchingFrames: 2, allowSingleHighConfidence: true }
    );
    expect(result?.title).toBe('Reacher');
  });

  test('turli high natijalar bittadan kelsa eng yaxshi nomzod qaytariladi', () => {
    const result = selectReelsConsensus(
      [frame('Iron Man', 0, 'high'), frame('Sherlock Holmes', 2, 'high')],
      { minMatchingFrames: 2, allowSingleHighConfidence: true }
    );
    expect(result?.title).toBe('Iron Man');
  });
});
