import { cooldownAllowsPrompt, nextMilestoneForTrack } from '../config/donate';

describe('donate milestones', () => {
  it('nextMilestoneForTrack returns smallest eligible milestone', () => {
    expect(nextMilestoneForTrack(2, [3, 10, 25], 0)).toBeNull();
    expect(nextMilestoneForTrack(3, [3, 10, 25], 0)).toBe(3);
    expect(nextMilestoneForTrack(10, [3, 10, 25], 0)).toBe(3);
    expect(nextMilestoneForTrack(10, [3, 10, 25], 3)).toBe(10);
    expect(nextMilestoneForTrack(25, [3, 10, 25], 10)).toBe(25);
    expect(nextMilestoneForTrack(9, [3, 10, 25], 3)).toBeNull();
  });

  it('progressive default feedback milestones (4 → +8 → +16 → +32)', () => {
    const m = [4, 12, 28, 60];
    expect(nextMilestoneForTrack(3, m, 0)).toBeNull();
    expect(nextMilestoneForTrack(4, m, 0)).toBe(4);
    expect(nextMilestoneForTrack(11, m, 4)).toBeNull();
    expect(nextMilestoneForTrack(12, m, 4)).toBe(12);
    expect(nextMilestoneForTrack(27, m, 12)).toBeNull();
    expect(nextMilestoneForTrack(28, m, 12)).toBe(28);
    expect(nextMilestoneForTrack(59, m, 28)).toBeNull();
    expect(nextMilestoneForTrack(60, m, 28)).toBe(60);
  });
});

describe('donate cooldown', () => {
  it('cooldownAllowsPrompt respects days', () => {
    expect(cooldownAllowsPrompt(null, 14)).toBe(true);
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(cooldownAllowsPrompt(recent, 14)).toBe(false);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    expect(cooldownAllowsPrompt(old, 14)).toBe(true);
  });
});
