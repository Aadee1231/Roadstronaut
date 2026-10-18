import { describe, expect, it } from 'vitest';
import { FEET_PER_UNIT, formatDistance, unitsPerSecondToMph } from '../../src/sim/units';

describe('display unit conversions', () => {
  it('converts game speed to miles per hour', () => {
    expect(FEET_PER_UNIT).toBe(0.12);
    expect(unitsPerSecondToMph(430)).toBeCloseTo(35, 0);
    expect(unitsPerSecondToMph(980)).toBeCloseTo(80, 0);
  });

  it('formats distances in feet below one mile and miles at one mile', () => {
    expect(formatDistance(1_240 / FEET_PER_UNIT)).toBe('1,240 FT');
    expect(formatDistance(5_279 / FEET_PER_UNIT)).toBe('5,279 FT');
    expect(formatDistance(5_280 / FEET_PER_UNIT)).toBe('1.00 MI');
  });
});
