import { max, min } from './detmath';

export const FIXED_DT = 1 / 120;
export const MAX_RUN_SECONDS = 20 * 60;
export const CAR_LENGTH = 120;
export const CAR_HEIGHT = 34;
export const WHEELBASE = 84;
export const WHEEL_RADIUS = 9;
export const START_SPEED = 430;
export const MAX_SPEED = 980;
export const SPEED_RAMP_SECONDS = 90;
export const GRAVITY = 1200;
export const JUMP_VELOCITY = -520;
export const SUPER_JUMP_VELOCITY = -740;
export const LAUNCH_BOOST = -600;
export const ROTATION_ACCEL = 16;
export const MAX_ANGULAR_SPEED = 8.5;
export const ROTATION_ENERGY_PER_SECOND = 45;
export const ENERGY_MAX = 100;
export const ENERGY_GROUNDED_REGEN = 3;
export const LANDING_LIMIT = 38 * Math.PI / 180;
export const PERFECT_LIMIT = 7 * Math.PI / 180;
export const GREAT_LIMIT = 16 * Math.PI / 180;
export const MIN_REWARD_AIRTIME = 0.3;
export const SNAP_TOLERANCE = 6;
export const GAP_FALL_LIMIT = 140;
export const NEAR_MISS_CLEARANCE = 22;
export const AIRBORNE_FALL_LIMIT = 900;
export const HAZARD_RECOVERY_SECONDS = 0.35;

// Quadratic ease-out front-loads the 430→980 speed ramp over 90 seconds.
export function speedAtTime(time: number): number {
  const progress = min(1, max(0, time / SPEED_RAMP_SECONDS));
  const easeOut = 1 - (1 - progress) * (1 - progress);
  return START_SPEED + (MAX_SPEED - START_SPEED) * easeOut;
}

export function distanceAtTime(time: number): number {
  if (time <= 0) return 0;
  const rampTime = min(time, SPEED_RAMP_SECONDS);
  const rampProgress = rampTime / SPEED_RAMP_SECONDS;
  const rampDistance = START_SPEED * rampTime + (MAX_SPEED - START_SPEED) * (
    rampTime - SPEED_RAMP_SECONDS / 3 * (1 - (1 - rampProgress) * (1 - rampProgress) * (1 - rampProgress))
  );
  return rampDistance + max(0, time - SPEED_RAMP_SECONDS) * MAX_SPEED;
}

export function timeAtDistance(distance: number): number {
  const target = max(0, distance);
  let low = 0;
  let high = max(1, target / START_SPEED);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (distanceAtTime(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
