const TAU = 6.283185307179586;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

export function clamp(value: number, lower: number, upper: number): number {
  return value < lower ? lower : value > upper ? upper : value;
}

export function sin(value: number): number {
  let x = value - Math.floor((value + PI) / TAU) * TAU;
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 - x2 / 6 + (x2 * x2) / 120 - (x2 * x2 * x2) / 5040 + (x2 * x2 * x2 * x2) / 362880);
}

export function cos(value: number): number {
  return sin(value + HALF_PI);
}

function atanUnit(value: number): number {
  const a = Math.abs(value);
  const approximation = a * (0.999866 + a * a * (-0.3302995 + a * a * (0.180141 + a * a * (-0.085133 + a * a * 0.0208351))));
  return value < 0 ? -approximation : approximation;
}

export function atan2(y: number, x: number): number {
  if (x === 0) {
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    return 0;
  }
  const ratio = y / x;
  const angle = Math.abs(ratio) <= 1 ? atanUnit(ratio) : (ratio < 0 ? -HALF_PI : HALF_PI) - atanUnit(1 / ratio);
  if (x > 0) return angle;
  return y >= 0 ? angle + PI : angle - PI;
}

export function normalizeAngle(value: number): number {
  return value - Math.floor((value + PI) / TAU) * TAU;
}
