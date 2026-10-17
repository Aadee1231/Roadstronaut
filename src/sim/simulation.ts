import {
  AIRBORNE_FALL_LIMIT, CAR_HEIGHT, CAR_LENGTH, ENERGY_GROUNDED_REGEN, ENERGY_MAX,
  FIXED_DT, GREAT_LIMIT, GRAVITY, JUMP_VELOCITY, LANDING_LIMIT, LAUNCH_BOOST,
  MAX_ANGULAR_SPEED, MAX_RUN_SECONDS, MAX_SPEED, NEAR_MISS_CLEARANCE, PERFECT_LIMIT,
  ROTATION_ACCEL, ROTATION_ENERGY_PER_SECOND, SPEED_RAMP_SECONDS, START_SPEED,
  SUPER_JUMP_VELOCITY,
} from './constants';
import { createCourse, type Course } from './course';
import { atan2, normalizeAngle, sin } from './detmath';
import { awardLanding, awardNearMiss, createRunStats, type LandingQuality, type RunStats } from './scoring';

export type SimEvent =
  | { type: 'jump' | 'superLaunch' | 'takeoff' | 'energyEmpty' | 'milestone' }
  | { type: 'comboUp'; count: number }
  | { type: 'flipComplete'; count: number }
  | { type: 'land'; quality: LandingQuality; flips: number; airtime: number; points: number }
  | { type: 'nearMiss'; hazardId: string }
  | { type: 'crash'; reason: string };

export interface SimulationState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
  speed: number;
  energy: number;
  grounded: boolean;
  crashed: boolean;
  crashReason: string | null;
  elapsed: number;
  airtime: number;
  flips: number;
  combo: number;
  comboIdle: number;
  nearMissIds: string[];
  stats: RunStats;
}

export class Simulation {
  readonly course: Course;
  readonly state: SimulationState;
  readonly events: SimEvent[] = [];
  private previousHeld = false;
  private airbornePressEligible = false;
  private flipRotation = 0;
  private previousX = 0;
  private lastMilestone = 0;

  constructor(seed: number) {
    this.course = createCourse(seed);
    const surface = this.course.surfaceAt(0);
    this.state = {
      x: 0,
      y: (surface?.y ?? 520) - CAR_HEIGHT / 2,
      vx: START_SPEED,
      vy: 0,
      angle: 0,
      angularVelocity: 0,
      speed: START_SPEED,
      energy: ENERGY_MAX,
      grounded: true,
      crashed: false,
      crashReason: null,
      elapsed: 0,
      airtime: 0,
      flips: 0,
      combo: 0,
      comboIdle: 0,
      nearMissIds: [],
      stats: createRunStats(),
    };
  }

  step(held: boolean): void {
    this.events.length = 0;
    const state = this.state;
    if (state.crashed) return;
    if (state.elapsed >= MAX_RUN_SECONDS) {
      this.crash('time-limit');
      return;
    }
    const dt = FIXED_DT;
    state.elapsed += dt;
    state.speed = Math.min(MAX_SPEED, START_SPEED + (MAX_SPEED - START_SPEED) * Math.min(state.elapsed / SPEED_RAMP_SECONDS, 1));
    state.vx = state.speed;
    this.previousX = state.x;
    state.x += state.vx * dt;
    const previousDistance = state.stats.distance;
    state.stats.distance = Math.floor(state.x / 10);
    state.stats.score += state.stats.distance - previousDistance;
    state.stats.duration = state.elapsed;

    const newPress = held && !this.previousHeld;
    if (state.grounded) {
      state.energy = Math.min(ENERGY_MAX, state.energy + ENERGY_GROUNDED_REGEN * dt);
      state.angularVelocity *= 0.5;
      state.comboIdle += dt;
      if (state.comboIdle >= 5) {
        state.combo = 0;
        state.comboIdle = 0;
      }
      const previousSurface = this.course.surfaceAt(this.previousX);
      const surface = this.course.surfaceAt(state.x);
      if (surface) {
        state.y = surface.y - CAR_HEIGHT / 2;
        state.angle += (surface.slope - state.angle) * 0.2;
        if (newPress) {
          const superJump = surface.segment.kind === 'launch' && state.x >= surface.segment.x1 - (surface.segment.x1 - surface.segment.x0) * 0.25;
          state.grounded = false;
          state.vy = superJump ? SUPER_JUMP_VELOCITY + LAUNCH_BOOST : JUMP_VELOCITY;
          state.airtime = 0;
          state.flips = 0;
          this.flipRotation = 0;
          this.airbornePressEligible = false;
          this.events.push({ type: superJump ? 'superLaunch' : 'jump' });
        }
        if (!newPress && previousSurface && previousSurface.segment.id !== surface.segment.id && previousSurface.slope < -0.08) {
          const launch = previousSurface.segment.kind === 'launch';
          this.leaveGround(launch);
          state.vy = launch ? -340 : Math.max(-220, state.speed * sin(previousSurface.slope));
        }
      } else {
        this.leaveGround(false);
      }
    } else {
      if (newPress) this.airbornePressEligible = true;
      state.airtime += dt;
      state.vy += GRAVITY * dt;
      state.y += state.vy * dt;

      const canRotate = held && this.airbornePressEligible && state.energy >= ROTATION_ENERGY_PER_SECOND * dt;
      if (canRotate) {
        state.angularVelocity = Math.min(MAX_ANGULAR_SPEED, state.angularVelocity + ROTATION_ACCEL * dt);
        state.energy = Math.max(0, state.energy - ROTATION_ENERGY_PER_SECOND * dt);
        if (state.energy === 0) this.events.push({ type: 'energyEmpty' });
      } else {
        state.angularVelocity *= 0.91;
        if (Math.abs(normalizeAngle(state.angle)) < 0.55) state.angularVelocity += -normalizeAngle(state.angle) * 0.35 * dt;
      }
      state.angle += state.angularVelocity * dt;
      if (canRotate) this.flipRotation += Math.max(0, state.angularVelocity * dt);
      const fullFlips = Math.floor(this.flipRotation / (Math.PI * 2));
      if (fullFlips > state.flips) {
        state.energy = Math.min(ENERGY_MAX, state.energy + (fullFlips - state.flips) * 10);
        state.flips = fullFlips;
        this.events.push({ type: 'flipComplete', count: state.flips });
      }
      this.checkNearMisses();
      this.checkLanding();
    }
    if (!state.crashed) this.checkCollision();
    if (!state.grounded && state.y > (this.course.surfaceAt(state.x)?.y ?? 520) + AIRBORNE_FALL_LIMIT) this.crash('fell');
    if (Math.floor(state.elapsed / 10) > this.lastMilestone) {
      this.lastMilestone = Math.floor(state.elapsed / 10);
      this.events.push({ type: 'milestone' });
    }
    this.previousHeld = held;
  }

  private leaveGround(launch: boolean): void {
    const state = this.state;
    if (!state.grounded) return;
    state.grounded = false;
    state.vy = launch ? -180 : 0;
    state.airtime = 0;
    state.flips = 0;
    this.flipRotation = 0;
    this.airbornePressEligible = false;
    this.events.push({ type: 'takeoff' });
  }

  private checkLanding(): void {
    const state = this.state;
    const front = this.course.surfaceAt(state.x + CAR_LENGTH * 0.38);
    const rear = this.course.surfaceAt(state.x - CAR_LENGTH * 0.38);
    const surface = front ?? rear;
    if (!surface || state.vy < 0) return;
    const groundY = Math.min(front?.y ?? Infinity, rear?.y ?? Infinity);
    if (state.y + CAR_HEIGHT / 2 < groundY - 6) return;
    const difference = Math.abs(normalizeAngle(state.angle - surface.slope));
    if (difference > LANDING_LIMIT) {
      this.crash('bad-landing');
      return;
    }
    state.grounded = true;
    state.y = groundY - CAR_HEIGHT / 2;
    state.vy = 0;
    const quality: LandingQuality = difference <= PERFECT_LIMIT ? 'perfect' : difference <= GREAT_LIMIT ? 'great' : 'clean';
    const oldCombo = state.combo;
    if (state.flips > 0 || quality === 'perfect') {
      state.combo += 1;
      state.comboIdle = 0;
    }
    const points = awardLanding(state.stats, quality, state.flips, state.airtime, oldCombo);
    state.energy = Math.min(ENERGY_MAX, state.energy + (quality === 'perfect' ? 25 : quality === 'great' ? 15 : 8));
    if (state.combo > oldCombo) this.events.push({ type: 'comboUp', count: state.combo });
    this.events.push({ type: 'land', quality, flips: state.flips, airtime: state.airtime, points });
    state.flips = 0;
    this.flipRotation = 0;
  }

  private checkNearMisses(): void {
    const state = this.state;
    const hazards = this.course.hazardsAhead(this.previousX, state.x - this.previousX + CAR_LENGTH);
    for (const hazard of hazards) {
      if (state.nearMissIds.includes(hazard.id)) continue;
      if (hazard.kind === 'gap') {
        const edgeDistance = Math.min(Math.abs(state.x - hazard.x), Math.abs(state.x - hazard.x - hazard.width));
        if (edgeDistance < NEAR_MISS_CLEARANCE && state.grounded) {
          state.nearMissIds.push(hazard.id);
          state.energy = Math.min(ENERGY_MAX, state.energy + 10);
          awardNearMiss(state.stats, state.combo);
          this.events.push({ type: 'nearMiss', hazardId: hazard.id });
        }
      } else if (state.x > hazard.x + hazard.width && state.x - (hazard.x + hazard.width) < NEAR_MISS_CLEARANCE && state.y + CAR_HEIGHT / 2 < 520 - hazard.height) {
        state.nearMissIds.push(hazard.id);
        state.energy = Math.min(ENERGY_MAX, state.energy + 10);
        awardNearMiss(state.stats, state.combo);
        this.events.push({ type: 'nearMiss', hazardId: hazard.id });
      }
    }
  }

  private checkCollision(): void {
    const state = this.state;
    const hazards = this.course.hazardsAhead(state.x - CAR_LENGTH / 2, CAR_LENGTH);
    for (const hazard of hazards) {
      if (hazard.kind === 'gap') continue;
      const horizontallyOverlapping = state.x + CAR_LENGTH / 2 > hazard.x && state.x - CAR_LENGTH / 2 < hazard.x + hazard.width;
      const bottom = state.y + CAR_HEIGHT / 2;
      const top = state.y - CAR_HEIGHT / 2;
      if (horizontallyOverlapping && bottom > 520 - hazard.height && top < 520) {
        this.crash('obstacle');
        return;
      }
    }
  }

  private crash(reason: string): void {
    this.state.crashed = true;
    this.state.crashReason = reason;
    this.state.combo = 0;
    this.events.push({ type: 'crash', reason });
  }

  get inputEdgeIsAirborne(): boolean {
    return this.airbornePressEligible;
  }
}

export function surfaceAngle(course: Course, x: number): number {
  const left = course.surfaceAt(x - 1);
  const right = course.surfaceAt(x + 1);
  return left && right ? atan2(right.y - left.y, 2) : 0;
}
