import { max, min } from './detmath.js';

export type LandingQuality = 'clean' | 'great' | 'perfect';

export interface RunStats {
  score: number;
  distance: number;
  maxCombo: number;
  totalFlips: number;
  bestTrick: number;
  perfects: number;
  nearMisses: number;
  stunts: number;
  duration: number;
}

export function createRunStats(): RunStats {
  return { score: 0, distance: 0, maxCombo: 0, totalFlips: 0, bestTrick: 0, perfects: 0, nearMisses: 0, stunts: 0, duration: 0 };
}

export function flipPoints(flips: number): number {
  if (flips <= 0) return 0;
  if (flips === 1) return 500;
  if (flips === 2) return 1500;
  if (flips === 3) return 3000;
  return 3000 + 2000 * (flips - 3);
}

export function landingPoints(quality: LandingQuality): number {
  return quality === 'perfect' ? 500 : quality === 'great' ? 250 : 100;
}

export function airtimePoints(seconds: number): number {
  return min(1000, Math.floor(max(0, seconds - 0.8) / 0.5) * 100);
}

export function comboMultiplier(combo: number): number {
  return min(8, 1 + combo * 0.5);
}

export function awardLanding(stats: RunStats, quality: LandingQuality, flips: number, airtime: number, combo: number): number {
  const trick = flips > 0 || quality === 'perfect';
  const nextCombo = trick ? combo + 1 : combo;
  const multiplier = comboMultiplier(nextCombo);
  const points = Math.floor((flipPoints(flips) + landingPoints(quality) + airtimePoints(airtime)) * multiplier + 0.5);
  stats.score += points;
  stats.totalFlips += flips;
  stats.bestTrick = max(stats.bestTrick, flips);
  if (quality === 'perfect') stats.perfects += 1;
  stats.maxCombo = max(stats.maxCombo, nextCombo);
  return points;
}

export function awardNearMiss(stats: RunStats, combo: number): number {
  const points = Math.floor(250 * comboMultiplier(combo) + 0.5);
  stats.score += points;
  stats.nearMisses += 1;
  return points;
}
