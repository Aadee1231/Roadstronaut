import { describe, expect, it } from 'vitest';
import { landingFeedbackLabels } from '../../src/ui/GameUI';

describe('landing feedback labels', () => {
  it('combines hard-landing feedback and suppresses perfect styling', () => {
    const feedback = landingFeedbackLabels([
      { type: 'hardLanding' },
      { type: 'land', quality: 'clean', flips: 0 },
    ]);

    expect(feedback).toHaveLength(1);
    expect(feedback.map(({ label }) => label)).toEqual(['HARD LANDING']);
    expect(feedback[0]?.perfect).toBe(false);
  });

  it('keeps the flip name in a hard-landing label', () => {
    expect(landingFeedbackLabels([
      { type: 'hardLanding' },
      { type: 'land', quality: 'perfect', flips: 2 },
    ])).toEqual([{ eventIndex: 1, label: 'DOUBLE FLIP · HARD LANDING', perfect: false }]);
  });
});
