import { max, min } from './detmath.js';

export const FIXED_DT = 1 / 120;
export const MAX_RUN_SECONDS = 20 * 60;
export const CAR_LENGTH = 120;
export const CAR_HEIGHT = 34;
export const WHEELBASE = 84;
export const WHEEL_RADIUS = 9;
export const START_SPEED = 430;
export const MAX_SPEED = 980;
export const SPEED_RAMP_SECONDS = 90;
/** True top speed (~230 MPH at 0.12 ft/unit): reached after the 90s ramp plus a long cruise climb. */
export const TOP_SPEED = 2812;
/** Speed gained per second once the initial ramp finishes; hits TOP_SPEED around t ≈ 13.7 min. */
export const SPEED_CRUISE_RATE = 2.5;
/** Score that wins the game. */
export const WIN_SCORE = 1_000_000;
/** Score thresholds that fire a one-time celebration event when crossed. */
export const SCORE_MILESTONES: readonly number[] = [500_000];
export const GRAVITY = 1200;
export const JUMP_VELOCITY = -520;
export const SUPER_JUMP_VELOCITY = -740;
export const LAUNCH_BOOST = -600;
export const LAUNCH_WINDOW_FRACTION = 0.25;
export const MIN_AUTO_TAKEOFF_VELOCITY = -150;
export const ROTATION_ACCEL = 24;
export const MAX_ANGULAR_SPEED = 8.5;
export const ROTATION_ENERGY_PER_SECOND = 45;
export const ENERGY_MAX = 100;
export const ENERGY_GROUNDED_REGEN = 3;
export const BURST_ENERGY = 18;
export const BURST_COOLDOWN = 0.4;
export const BURST_COUNT_PER_AIR_PHASE = 2;
export const BURST_LIFT_VELOCITY = -170;
export const BURST_LIFT_LIMIT = -200;
export const BURST_ROTATION_KICK = 1.25;
export const HARD_IMPACT = 1250;
export const CRASH_IMPACT = 1900;
export const FAN_MAX = 100;
export const FAN_DRAIN = 45;
export const FAN_GROUNDED_REFILL = 30;
export const SUCTION_ALIGN = Math.PI / 3;
export const SUCTION_POINTS_PER_SECOND = 150;
/** Maximum angular correction speed during rail auto-recovery. */
export const RECOVERY_ANGULAR_SPEED = 10;
/** Starts rail auto-recovery this long before predicted ground contact. */
export const RECOVERY_MARGIN = 0.12;
export const LANDING_LIMIT = 38 * Math.PI / 180;
/** Auto-recovery only takes over when both current and predicted error exceed this angle. */
export const RECOVERY_TRIGGER_OFF = LANDING_LIMIT - 2 * Math.PI / 180;
export const PERFECT_LIMIT = 7 * Math.PI / 180;
export const GREAT_LIMIT = 16 * Math.PI / 180;
export const MIN_REWARD_AIRTIME = 0.3;
export const SNAP_TOLERANCE = 6;
export const GAP_FALL_LIMIT = 140;
export const NEAR_MISS_CLEARANCE = 22;
export const AIRBORNE_FALL_LIMIT = 900;
export const HAZARD_RECOVERY_SECONDS = 0.35;
/** Compressed-air thruster impulse added to the car's surface-normal momentum at the top of a vertical run. */
export const VERTICAL_LAUNCH_BOOST = -500;
/** Magnitude cap on the vertical-run exit velocity: above ~1400 u/s the deck
 * impact would exceed CRASH_IMPACT, so the thruster absorbs the excess surface
 * momentum instead of throwing it all upward. Keeps the run survivable at any
 * cruise speed. */
export const VERTICAL_LAUNCH_VY_CAP = 1400;
/** Base score for landing a vertical run safely past the pit. */
export const VERTICAL_RUN_BONUS = 1500;
/** Earliest run time (seconds) at which a vertical run may appear. */
export const VRAMP_FIRST_AT_SECONDS = 45;

const CRUISE_CAP_SECONDS = (TOP_SPEED - MAX_SPEED) / SPEED_CRUISE_RATE;

// Quadratic ease-out front-loads the 430→980 speed ramp over 90 seconds, then a
// steady linear climb keeps pushing the car toward the 230 MPH top speed.
export function speedAtTime(time: number): number {
  const progress = min(1, max(0, time / SPEED_RAMP_SECONDS));
  const easeOut = 1 - (1 - progress) * (1 - progress);
  const ramped = START_SPEED + (MAX_SPEED - START_SPEED) * easeOut;
  const over = max(0, time - SPEED_RAMP_SECONDS);
  return min(TOP_SPEED, ramped + SPEED_CRUISE_RATE * over);
}

export function distanceAtTime(time: number): number {
  if (time <= 0) return 0;
  const rampTime = min(time, SPEED_RAMP_SECONDS);
  const rampProgress = rampTime / SPEED_RAMP_SECONDS;
  const rampDistance = START_SPEED * rampTime + (MAX_SPEED - START_SPEED) * (
    rampTime - SPEED_RAMP_SECONDS / 3 * (1 - (1 - rampProgress) * (1 - rampProgress) * (1 - rampProgress))
  );
  const over = max(0, time - SPEED_RAMP_SECONDS);
  const cruiseTime = min(over, CRUISE_CAP_SECONDS);
  const cruiseDistance = MAX_SPEED * cruiseTime + SPEED_CRUISE_RATE * cruiseTime * cruiseTime / 2
    + TOP_SPEED * (over - cruiseTime);
  return rampDistance + cruiseDistance;
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
