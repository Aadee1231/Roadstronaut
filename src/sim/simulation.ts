import {
  AIRBORNE_FALL_LIMIT, CAR_HEIGHT, CAR_LENGTH, ENERGY_GROUNDED_REGEN, ENERGY_MAX,
  FIXED_DT, GAP_FALL_LIMIT, GREAT_LIMIT, GRAVITY, JUMP_VELOCITY, LANDING_LIMIT, LAUNCH_BOOST,
  MIN_REWARD_AIRTIME, SNAP_TOLERANCE,
  MAX_ANGULAR_SPEED, MAX_RUN_SECONDS, NEAR_MISS_CLEARANCE, PERFECT_LIMIT,
  ROTATION_ACCEL, ROTATION_ENERGY_PER_SECOND, START_SPEED, SUPER_JUMP_VELOCITY,
  WHEELBASE, WHEEL_RADIUS, speedAtTime,
} from './constants';
import { BASE_Y, createCourse, type Course, type Surface } from './course';
import { atan2, clamp, cos, max, min, normalizeAngle, sin } from './detmath';
import { awardLanding, awardNearMiss, createRunStats, type LandingQuality, type RunStats } from './scoring';

export type SimEvent =
  | { type: 'jump' | 'superLaunch' | 'takeoff' | 'energyEmpty' | 'milestone' }
  | { type: 'comboUp'; count: number }
  | { type: 'flipComplete'; count: number }
  | { type: 'land'; quality: LandingQuality; flips: number; airtime: number; points: number }
  | { type: 'touchdown' }
  | { type: 'nearMiss'; hazardId: string }
  | { type: 'crash'; reason: 'obstacle' | 'bad-landing' | 'fell' | 'time-limit' };

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
  rotating: boolean;
  crashed: boolean;
  crashReason: 'obstacle' | 'bad-landing' | 'fell' | 'time-limit' | null;
  elapsed: number;
  airtime: number;
  flips: number;
  combo: number;
  comboIdle: number;
  nearMissIds: string[];
  stats: RunStats;
}

interface WheelPoint {
  x: number;
  yOffset: number;
  bottom: number;
  surface: Surface | null;
}

interface BodyCircle {
  x: number;
  y: number;
  radius: number;
}

export const WHEEL_VERTICAL_OFFSET = CAR_HEIGHT * 0.32;
const BODY_RADIUS = CAR_HEIGHT * 0.3;
/** exp(-7 * FIXED_DT) as a literal so replays never depend on an engine's Math.exp. */
const RELEASE_DAMPING_PER_STEP = 0.94333544987349216;

export class Simulation {
  readonly course: Course;
  readonly state: SimulationState;
  readonly events: SimEvent[] = [];
  private previousHeld = false;
  private airbornePressEligible = false;
  private flipRotation = 0;
  private previousX = 0;
  private previousWheelBottoms: [number, number] = [Number.NaN, Number.NaN];
  private rewardedLandingThisAirbornePhase = false;
  private lastMilestone = 0;

  constructor(seed: number) {
    this.course = createCourse(seed);
    const surface = this.course.surfaceAt(0);
    this.state = {
      x: 0,
      y: (surface?.y ?? BASE_Y) - WHEEL_VERTICAL_OFFSET - WHEEL_RADIUS,
      vx: START_SPEED,
      vy: 0,
      angle: 0,
      angularVelocity: 0,
      speed: START_SPEED,
      energy: ENERGY_MAX,
      grounded: true,
      rotating: false,
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
    if (surface) this.syncGroundPose(surface);
  }

  step(held: boolean): void {
    this.events.length = 0;
    const state = this.state;
    state.rotating = false;
    if (state.crashed) return;
    if (state.elapsed >= MAX_RUN_SECONDS) {
      this.crash('time-limit');
      return;
    }
    const dt = FIXED_DT;
    this.previousWheelBottoms = [
      this.wheelBottomAt(WHEELBASE / 2),
      this.wheelBottomAt(-WHEELBASE / 2),
    ];
    state.elapsed += dt;
    state.speed = speedAtTime(state.elapsed);
    state.vx = state.speed;
    this.previousX = state.x;
    state.x += state.vx * dt;
    const previousDistance = state.stats.distance;
    state.stats.distance = Math.floor(state.x / 10);
    state.stats.score += state.stats.distance - previousDistance;
    state.stats.duration = state.elapsed;

    const newPress = held && !this.previousHeld;
    if (state.grounded) {
      state.energy = min(ENERGY_MAX, state.energy + ENERGY_GROUNDED_REGEN * dt);
      state.angularVelocity *= 0.5;
      state.comboIdle += dt;
      if (state.comboIdle >= 5) {
        state.combo = 0;
        state.comboIdle = 0;
      }

      const previousSurface = this.course.surfaceAt(this.previousX);
      const surface = this.course.surfaceAt(state.x);
      if (surface) this.syncGroundPose(surface);
      if (newPress && surface) {
        const launchWindow = surface.segment.kind === 'launch'
          && state.x >= surface.segment.x1 - (surface.segment.x1 - surface.segment.x0) * 0.25;
        state.grounded = false;
        state.airtime = 0;
        state.flips = 0;
        this.flipRotation = 0;
        this.airbornePressEligible = false;
        this.rewardedLandingThisAirbornePhase = false;
        if (launchWindow) {
          state.vy = state.speed * sin(surface.slope) + SUPER_JUMP_VELOCITY + LAUNCH_BOOST;
          this.events.push({ type: 'superLaunch' });
        } else {
          state.vy = JUMP_VELOCITY;
          this.events.push({ type: 'jump' });
        }
      } else if (!surface) {
        this.leaveGround();
        if (previousSurface?.segment.kind === 'launch') {
          state.vy = state.speed * sin(previousSurface.slope) + LAUNCH_BOOST;
        }
      } else if (
        !newPress
        && previousSurface
        && previousSurface.segment.id !== surface.segment.id
        && previousSurface.slope < -0.08
      ) {
        const launch = previousSurface.segment.kind === 'launch';
        const takeoffVelocity = state.speed * sin(previousSurface.slope) + (launch ? LAUNCH_BOOST : 0);
        if (takeoffVelocity < -150) {
          this.leaveGround();
          state.vy = takeoffVelocity;
        }
      }
    } else {
      if (newPress) this.airbornePressEligible = true;
      state.airtime += dt;
      state.vy += GRAVITY * dt;
      state.y += state.vy * dt;

      const canRotate = held && this.airbornePressEligible && state.energy >= ROTATION_ENERGY_PER_SECOND * dt;
      if (canRotate) {
        state.rotating = true;
        state.angularVelocity = min(MAX_ANGULAR_SPEED, state.angularVelocity + ROTATION_ACCEL * dt);
        state.energy = max(0, state.energy - ROTATION_ENERGY_PER_SECOND * dt);
        if (state.energy === 0) this.events.push({ type: 'energyEmpty' });
      } else {
        state.angularVelocity *= RELEASE_DAMPING_PER_STEP;
        if (Math.abs(normalizeAngle(state.angle)) < 0.55) {
          state.angularVelocity += -normalizeAngle(state.angle) * 0.35 * dt;
        }
      }
      state.angle += state.angularVelocity * dt;
      this.flipRotation += max(0, state.angularVelocity * dt);
      const fullFlips = Math.floor(this.flipRotation / (Math.PI * 2));
      if (fullFlips > state.flips) {
        state.energy = min(ENERGY_MAX, state.energy + (fullFlips - state.flips) * 10);
        state.flips = fullFlips;
        this.events.push({ type: 'flipComplete', count: state.flips });
      }
      if (!this.checkPitFall()) this.checkLanding();
    }

    if (!state.crashed) this.checkCollision();
    if (!state.crashed) this.checkNearMisses();
    if (!state.grounded && state.y > this.groundReferenceY(state.x) + AIRBORNE_FALL_LIMIT) this.crash('fell');
    if (Math.floor(state.elapsed / 10) > this.lastMilestone) {
      this.lastMilestone = Math.floor(state.elapsed / 10);
      this.events.push({ type: 'milestone' });
    }
    this.previousHeld = held;
  }

  private wheelPoint(longitudinalOffset: number): WheelPoint {
    const cosine = cos(this.state.angle);
    const sine = sin(this.state.angle);
    const xOffset = cosine * longitudinalOffset - sine * WHEEL_VERTICAL_OFFSET;
    const yOffset = sine * longitudinalOffset + cosine * WHEEL_VERTICAL_OFFSET;
    const x = this.state.x + xOffset;
    return {
      x,
      yOffset,
      bottom: this.state.y + yOffset + WHEEL_RADIUS,
      surface: this.course.surfaceAt(x),
    };
  }

  private wheelBottomAt(longitudinalOffset: number): number {
    const cosine = cos(this.state.angle);
    const sine = sin(this.state.angle);
    return this.state.y + sine * longitudinalOffset + cosine * WHEEL_VERTICAL_OFFSET + WHEEL_RADIUS;
  }

  private syncGroundPose(fallback: Surface): void {
    const state = this.state;
    const front = this.wheelPoint(WHEELBASE / 2);
    const rear = this.wheelPoint(-WHEELBASE / 2);
    let slope = fallback.slope;
    if (front.surface && rear.surface) {
      slope = atan2(front.surface.y - rear.surface.y, front.x - rear.x);
    } else if (front.surface) {
      slope = front.surface.slope;
    } else if (rear.surface) {
      slope = rear.surface.slope;
    }
    state.angle += normalizeAngle(slope - state.angle) * 0.2;

    const updatedFront = this.wheelPoint(WHEELBASE / 2);
    const updatedRear = this.wheelPoint(-WHEELBASE / 2);
    const centerY: number[] = [];
    if (updatedFront.surface) centerY.push(updatedFront.surface.y - updatedFront.yOffset - WHEEL_RADIUS);
    if (updatedRear.surface) centerY.push(updatedRear.surface.y - updatedRear.yOffset - WHEEL_RADIUS);
    if (centerY.length > 0) {
      state.y = centerY.reduce((sum, value) => sum + value, 0) / centerY.length;
    } else {
      state.y = fallback.y - WHEEL_VERTICAL_OFFSET * cos(state.angle) - WHEEL_RADIUS;
    }
  }

  private leaveGround(): void {
    const state = this.state;
    if (!state.grounded) return;
    state.grounded = false;
    state.vy = 0;
    state.airtime = 0;
    state.flips = 0;
    this.flipRotation = 0;
    this.airbornePressEligible = false;
    this.rewardedLandingThisAirbornePhase = false;
    this.events.push({ type: 'takeoff' });
  }

  private bodyCircles(): BodyCircle[] {
    const cosine = cos(this.state.angle);
    const sine = sin(this.state.angle);
    const radius = BODY_RADIUS;
    return [-CAR_LENGTH * 0.32, 0, CAR_LENGTH * 0.32].map((offset) => ({
      x: this.state.x + cosine * offset,
      y: this.state.y + sine * offset,
      radius,
    }));
  }

  private checkLanding(): void {
    const state = this.state;
    if (state.vy < 0) return;
    const wheels = [this.wheelPoint(WHEELBASE / 2), this.wheelPoint(-WHEELBASE / 2)];
    const roofContact = this.bodyCircles().some((circle) => {
      const surface = this.course.surfaceAt(circle.x);
      return surface
        && circle.y + circle.radius >= surface.y
        && Math.abs(normalizeAngle(state.angle - surface.slope)) > LANDING_LIMIT;
    });
    if (roofContact) {
      this.crash('bad-landing');
      return;
    }

    const snapLimit = SNAP_TOLERANCE + Math.abs(state.vy) * FIXED_DT;
    const contacts = wheels.filter((wheel, index) => (
      wheel.surface
      && wheel.bottom >= wheel.surface.y
      && this.previousWheelBottoms[index]! <= wheel.surface.y + snapLimit
    ));
    if (contacts.length === 0) return;
    const contact = contacts.reduce((highest, wheel) => (
      (wheel.surface?.y ?? Infinity) < (highest.surface?.y ?? Infinity) ? wheel : highest
    ));
    const surface = contact.surface!;
    const difference = Math.abs(normalizeAngle(state.angle - surface.slope));
    if (difference > LANDING_LIMIT) {
      this.crash('bad-landing');
      return;
    }

    state.grounded = true;
    state.y = surface.y - contact.yOffset - WHEEL_RADIUS;
    state.vy = 0;
    if (this.rewardedLandingThisAirbornePhase || (state.airtime < MIN_REWARD_AIRTIME && state.flips === 0)) {
      this.events.push({ type: 'touchdown' });
      state.flips = 0;
      this.flipRotation = 0;
      return;
    }
    this.rewardedLandingThisAirbornePhase = true;
    const quality: LandingQuality = difference <= PERFECT_LIMIT ? 'perfect' : difference <= GREAT_LIMIT ? 'great' : 'clean';
    const oldCombo = state.combo;
    if (state.flips > 0 || quality === 'perfect') {
      state.combo += 1;
      state.comboIdle = 0;
    }
    const points = awardLanding(state.stats, quality, state.flips, state.airtime, oldCombo);
    state.energy = min(ENERGY_MAX, state.energy + (quality === 'perfect' ? 25 : quality === 'great' ? 15 : 8));
    if (state.combo > oldCombo) this.events.push({ type: 'comboUp', count: state.combo });
    this.events.push({ type: 'land', quality, flips: state.flips, airtime: state.airtime, points });
    state.flips = 0;
    this.flipRotation = 0;
  }

  private bodyBottom(): number {
    return this.bodyCircles().reduce((bottom, circle) => max(bottom, circle.y + circle.radius), -Infinity);
  }

  private checkPitFall(): boolean {
    const state = this.state;
    const bodyLeft = state.x - CAR_LENGTH / 2;
    const bodyRight = state.x + CAR_LENGTH / 2;
    const bodyBottom = this.bodyBottom();
    const gaps = this.course.segmentsInRange(bodyLeft, bodyRight).filter((segment) => (
      segment.kind === 'gap' && bodyRight >= segment.x0 && bodyLeft < segment.x1
    ));
    for (const gap of gaps) {
      if (bodyRight >= gap.x1 && bodyBottom > gap.y1) {
        this.crash('fell');
        return true;
      }
      if (bodyBottom > max(gap.y0, gap.y1) + GAP_FALL_LIMIT) {
        this.crash('fell');
        return true;
      }
    }
    return false;
  }

  private checkNearMisses(): void {
    const state = this.state;
    const hazards = this.course.hazardsAhead(this.previousX - CAR_LENGTH / 2, state.x - this.previousX + CAR_LENGTH);
    for (const hazard of hazards) {
      if (state.nearMissIds.includes(hazard.id)) continue;
      if (hazard.kind === 'gap') {
        const farEdge = hazard.x + hazard.width;
        if (state.grounded && state.x >= farEdge && state.x - farEdge < NEAR_MISS_CLEARANCE) {
          state.nearMissIds.push(hazard.id);
          state.energy = min(ENERGY_MAX, state.energy + 10);
          awardNearMiss(state.stats, state.combo);
          this.events.push({ type: 'nearMiss', hazardId: hazard.id });
        }
      } else {
        const distancePast = state.x - (hazard.x + hazard.width);
        const clearance = hazard.baseY - hazard.height - this.bodyBottom();
        if (distancePast >= 0 && distancePast < NEAR_MISS_CLEARANCE && clearance >= 0 && clearance < NEAR_MISS_CLEARANCE) {
          state.nearMissIds.push(hazard.id);
          state.energy = min(ENERGY_MAX, state.energy + 10);
          awardNearMiss(state.stats, state.combo);
          this.events.push({ type: 'nearMiss', hazardId: hazard.id });
        }
      }
    }
  }

  private checkCollision(): void {
    const state = this.state;
    const hazards = this.course.hazardsAhead(state.x - CAR_LENGTH / 2, CAR_LENGTH);
    for (const hazard of hazards) {
      if (hazard.kind === 'gap') continue;
      const top = hazard.baseY - hazard.height;
      const right = hazard.x + hazard.width;
      for (const circle of this.bodyCircles()) {
        const nearestX = clamp(circle.x, hazard.x, right);
        const nearestY = clamp(circle.y, top, hazard.baseY);
        const dx = circle.x - nearestX;
        const dy = circle.y - nearestY;
        if (dx * dx + dy * dy < circle.radius * circle.radius) {
          this.crash('obstacle');
          return;
        }
      }
    }
  }

  private groundReferenceY(x: number): number {
    const surface = this.course.surfaceAt(x);
    if (surface) return surface.y;
    const gap = this.course.segmentsInRange(x, x).find((segment) => segment.kind === 'gap');
    return gap ? max(gap.y0, gap.y1) : BASE_Y;
  }

  private crash(reason: 'obstacle' | 'bad-landing' | 'fell' | 'time-limit'): void {
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
