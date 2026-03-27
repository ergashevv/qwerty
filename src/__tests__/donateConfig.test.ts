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
