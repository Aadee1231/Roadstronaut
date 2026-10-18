export const FEET_PER_UNIT = 0.12;

export function unitsPerSecondToMph(speed: number): number {
  return speed * FEET_PER_UNIT * 3600 / 5280;
}

export function formatDistance(units: number): string {
  const feet = units * FEET_PER_UNIT;
  return feet < 5280
    ? `${Math.floor(feet).toLocaleString('en-US')} FT`
    : `${(feet / 5280).toFixed(2)} MI`;
}
