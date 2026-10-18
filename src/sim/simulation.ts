import {
  AIRBORNE_FALL_LIMIT, BURST_COOLDOWN, BURST_COUNT_PER_AIR_PHASE, BURST_ENERGY,
  BURST_LIFT_LIMIT, BURST_LIFT_VELOCITY, BURST_ROTATION_KICK, CAR_HEIGHT, CAR_LENGTH,
  CRASH_IMPACT, ENERGY_GROUNDED_REGEN, ENERGY_MAX, FAN_DRAIN, FAN_GROUNDED_REFILL,
  FAN_MAX, FIXED_DT, GAP_FALL_LIMIT, GREAT_LIMIT, GRAVITY, HARD_IMPACT, JUMP_VELOCITY,
  LANDING_LIMIT, LAUNCH_BOOST, LAUNCH_WINDOW_FRACTION,
  MIN_AUTO_TAKEOFF_VELOCITY, MIN_REWARD_AIRTIME, MAX_ANGULAR_SPEED, MAX_RUN_SECONDS,
  NEAR_MISS_CLEARANCE, PERFECT_LIMIT, ROTATION_ACCEL, ROTATION_ENERGY_PER_SECOND,
  RECOVERY_ANGULAR_SPEED, RECOVERY_MARGIN, SUCTION_ALIGN, SUCTION_POINTS_PER_SECOND,
  SNAP_TOLERANCE, START_SPEED, SUPER_JUMP_VELOCITY,
  WHEELBASE, WHEEL_RADIUS, speedAtTime,
} from './constants';
import {
  BASE_Y, createCourse, pistonHeight, type CeilingSegment, type Course, type Surface,
} from './course';
import { atan2, clamp, cos, max, min, normalizeAngle, sin } from './detmath';
import { awardLanding, awardNearMiss, createRunStats, type LandingQuality, type RunStats } from './scoring';

export type SimEvent =
  | { type: 'jump' | 'superLaunch' | 'takeoff' | 'energyEmpty' | 'milestone' }
  | { type: 'comboUp'; count: number }
  | { type: 'flipComplete'; count: number }
  | { type: 'land'; quality: LandingQuality; flips: number; airtime: number; points: number }
  | { type: 'touchdown' }
  | { type: 'hardLanding' }
  | { type: 'thrusterBurst' }
  | { type: 'railRecovery' }
  | { type: 'suctionEngage' }
  | { type: 'suctionRelease'; reason: 'end' | 'empty' }
  | { type: 'suctionBonus'; seconds: number; points: number }
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
  burstsLeft: number;
  burstCooldown: number;
  fan: number;
  inverted: boolean;
  fanRailVisible: boolean;
  grounded: boolean;
  rotating: boolean;
  recovering: boolean;
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
  private previousBodyTop = Infinity;
  private attachedCeiling: CeilingSegment | null = null;
  private suctionBonusElapsed = 0;
  private recovering = false;
  private recoveryTarget = 0;

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
      burstsLeft: BURST_COUNT_PER_AIR_PHASE,
      burstCooldown: 0,
      fan: FAN_MAX,
      inverted: false,
      fanRailVisible: false,
      grounded: true,
      rotating: false,
      recovering: false,
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

  clone(): Simulation {
    const clonedState: SimulationState = {
      ...this.state,
      nearMissIds: [...this.state.nearMissIds],
      stats: { ...this.state.stats },
    };
    return Object.assign(Object.create(Simulation.prototype), this, {
      state: clonedState,
      events: [...this.events],
      previousWheelBottoms: [...this.previousWheelBottoms] as [number, number],
    }) as Simulation;
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
    this.previousBodyTop = this.bodyTop();
    state.burstCooldown = max(0, state.burstCooldown - dt);
    state.elapsed += dt;
    state.speed = speedAtTime(state.elapsed);
    state.vx = state.speed;
    this.previousX = state.x;
    state.x += state.vx * dt;
    state.fanRailVisible = state.fanRailVisible
      || this.course.ceilingsInRange(state.x, state.x + state.speed * 8).length > 0;
    const previousDistance = state.stats.distance;
    state.stats.distance = Math.floor(state.x / 10);
    state.stats.score += state.stats.distance - previousDistance;
    state.stats.duration = state.elapsed;

    const newPress = held && !this.previousHeld;
    if (state.grounded) {
      state.energy = min(ENERGY_MAX, state.energy + ENERGY_GROUNDED_REGEN * dt);
      state.fan = min(FAN_MAX, state.fan + FAN_GROUNDED_REFILL * dt);
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
          && state.x >= surface.segment.x1 - (surface.segment.x1 - surface.segment.x0) * LAUNCH_WINDOW_FRACTION;
        state.grounded = false;
        state.airtime = 0;
        state.flips = 0;
        this.flipRotation = 0;
        this.airbornePressEligible = false;
        this.rewardedLandingThisAirbornePhase = false;
        this.clearRailRecovery();
        state.burstsLeft = BURST_COUNT_PER_AIR_PHASE;
        state.burstCooldown = 0;
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
        if (takeoffVelocity < MIN_AUTO_TAKEOFF_VELOCITY) {
          this.leaveGround();
          state.vy = takeoffVelocity;
        }
      }
    } else if (state.inverted) {
      this.stepSuction(dt);
    } else {
      this.maybeStartRailRecovery();
      if (!this.recovering && newPress) {
        this.airbornePressEligible = true;
        if (state.burstsLeft > 0 && state.burstCooldown === 0 && state.energy >= BURST_ENERGY) {
          state.energy -= BURST_ENERGY;
          state.burstsLeft -= 1;
          state.burstCooldown = BURST_COOLDOWN;
          if (state.vy > BURST_LIFT_LIMIT) state.vy += BURST_LIFT_VELOCITY;
          state.angularVelocity = min(MAX_ANGULAR_SPEED, state.angularVelocity + BURST_ROTATION_KICK);
          this.events.push({ type: 'thrusterBurst' });
          if (state.energy === 0) this.events.push({ type: 'energyEmpty' });
        }
      }
      state.airtime += dt;
      state.vy += GRAVITY * dt;
      state.y += state.vy * dt;

      if (this.recovering) {
        this.stepRailRecovery(dt);
      } else {
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
      }
      this.checkCeilingContact();
      if (!state.inverted && !state.crashed && !this.checkPitFall()) this.checkLanding();
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
    this.clearRailRecovery();
    state.burstsLeft = BURST_COUNT_PER_AIR_PHASE;
    state.burstCooldown = 0;
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

  private bodyTop(): number {
    return this.bodyCircles().reduce((top, circle) => min(top, circle.y - circle.radius), Infinity);
  }

  private maybeStartRailRecovery(): void {
    const state = this.state;
    if (state.grounded || state.inverted || this.recovering) return;
    if (!this.course.railZoneAt(state.x)) return;

    const surface = this.course.surfaceAt(state.x);
    const wheels = [this.wheelPoint(WHEELBASE / 2), this.wheelPoint(-WHEELBASE / 2)];
    const lowestWheelBottom = max(wheels[0].bottom, wheels[1].bottom);
    const height = surface ? surface.y - lowestWheelBottom : Number.NaN;
    const solveTimeToGround = (distance: number): number | null => {
      const discriminant = state.vy * state.vy + 2 * GRAVITY * distance;
      if (!Number.isFinite(discriminant) || discriminant < 0) return null;
      const solved = (-state.vy + Math.sqrt(discriminant)) / GRAVITY;
      return Number.isFinite(solved) && solved >= 0 ? solved : null;
    };
    const currentSlope = surface?.slope ?? 0;
    let timeToGround = solveTimeToGround(height);
    let targetSlope = timeToGround === null
      ? currentSlope
      : this.course.surfaceAt(state.x + state.vx * timeToGround)?.slope ?? currentSlope;
    let immediateWheelSurface: Surface | null = null;
    for (const wheel of wheels) {
      const wheelSurface = wheel.surface;
      if (!wheelSurface) continue;
      const wheelTime = solveTimeToGround(wheelSurface.y - wheel.bottom);
      if (wheelTime === null) {
        if (wheel.bottom >= wheelSurface.y
          && (immediateWheelSurface === null || wheelSurface.y < immediateWheelSurface.y)) {
          immediateWheelSurface = wheelSurface;
        }
        continue;
      }
      if (timeToGround !== null && wheelTime >= timeToGround) continue;
      timeToGround = wheelTime;
      const predictedWheelX = wheel.x + state.vx * wheelTime;
      targetSlope = this.course.surfaceAt(predictedWheelX)?.slope ?? wheelSurface.slope;
    }
    if (immediateWheelSurface !== null) {
      timeToGround = 0;
      targetSlope = immediateWheelSurface.slope;
    }
    const angleOff = Math.abs(normalizeAngle(state.angle - targetSlope));
    if (angleOff <= LANDING_LIMIT * 0.75) return;
    const immediate = timeToGround === null || timeToGround <= RECOVERY_MARGIN;
    const tooLate = state.vy > 0
      && timeToGround !== null
      && timeToGround <= angleOff / RECOVERY_ANGULAR_SPEED + RECOVERY_MARGIN;
    if (!immediate && !tooLate) return;

    this.recovering = true;
    this.recoveryTarget = targetSlope;
    state.recovering = true;
    state.flips = 0;
    this.flipRotation = 0;
    this.events.push({ type: 'railRecovery' });
  }

  private stepRailRecovery(dt: number): void {
    const delta = normalizeAngle(this.recoveryTarget - this.state.angle);
    if (Math.abs(delta) <= RECOVERY_ANGULAR_SPEED * dt) {
      this.state.angle = this.recoveryTarget;
      this.state.angularVelocity = 0;
      return;
    }
    this.state.angularVelocity = Math.sign(delta) * RECOVERY_ANGULAR_SPEED;
    this.state.angle += this.state.angularVelocity * dt;
  }

  private clearRailRecovery(): void {
    this.recovering = false;
    this.recoveryTarget = 0;
    this.state.recovering = false;
  }

  private checkCeilingContact(): void {
    const state = this.state;
    const ceiling = this.course.ceilingAt(state.x);
    if (!ceiling) return;
    const wheels = [this.wheelPoint(WHEELBASE / 2), this.wheelPoint(-WHEELBASE / 2)];
    const wheelTop = wheels.reduce((top, wheel) => min(top, wheel.bottom - WHEEL_RADIUS * 2), Infinity);
    const previousWheelTop = this.previousWheelBottoms.reduce(
      (top, bottom) => min(top, bottom - WHEEL_RADIUS * 2),
      Infinity,
    );
    const crossedWheel = previousWheelTop > ceiling.y && wheelTop <= ceiling.y;
    const roofContact = this.bodyTop() <= ceiling.y && this.previousBodyTop > ceiling.y;
    if (!crossedWheel && !roofContact) return;

    const aligned = Math.abs(normalizeAngle(state.angle - Math.PI)) <= SUCTION_ALIGN;
    if (crossedWheel && aligned && state.fan >= 5) {
      this.clearRailRecovery();
      state.inverted = true;
      state.angle = Math.PI;
      state.angularVelocity = 0;
      state.vy = 0;
      state.y = ceiling.y + WHEEL_VERTICAL_OFFSET + WHEEL_RADIUS;
      this.attachedCeiling = ceiling;
      this.suctionBonusElapsed = 0;
      this.events.push({ type: 'suctionEngage' });
      return;
    }

    state.y = ceiling.y + BODY_RADIUS;
    state.vy = Math.abs(state.vy) * 0.3;
  }

  private stepSuction(dt: number): void {
    const state = this.state;
    const ceiling = this.attachedCeiling;
    if (!ceiling || state.x >= ceiling.x1) {
      this.releaseSuction('end');
      return;
    }
    state.airtime += dt;
    state.fan = max(0, state.fan - FAN_DRAIN * dt);
    if (state.fan === 0) {
      this.releaseSuction('empty');
      return;
    }
    state.angle = Math.PI;
    state.angularVelocity = 0;
    state.vy = 0;
    state.y = ceiling.y + WHEEL_VERTICAL_OFFSET + WHEEL_RADIUS;
    this.suctionBonusElapsed += dt;
    if (this.suctionBonusElapsed >= 1) {
      const seconds = Math.floor(this.suctionBonusElapsed);
      this.suctionBonusElapsed -= seconds;
      const oldCombo = state.combo;
      state.combo += seconds;
      state.comboIdle = 0;
      const points = seconds * SUCTION_POINTS_PER_SECOND * Math.max(1, oldCombo + 1);
      state.stats.score += points;
      this.events.push({ type: 'comboUp', count: state.combo });
      this.events.push({ type: 'suctionBonus', seconds, points });
    }
  }

  private releaseSuction(reason: 'end' | 'empty'): void {
    this.state.inverted = false;
    this.state.vy = 60;
    this.attachedCeiling = null;
    this.suctionBonusElapsed = 0;
    this.events.push({ type: 'suctionRelease', reason });
  }

  private checkLanding(): void {
    const state = this.state;
    const recovering = this.recovering;
    if (state.vy < 0) return;
    const wheels = [this.wheelPoint(WHEELBASE / 2), this.wheelPoint(-WHEELBASE / 2)];
    const roofContact = this.bodyCircles().some((circle) => {
      const surface = this.course.surfaceAt(circle.x);
      return surface
        && circle.y + circle.radius >= surface.y
        && Math.abs(normalizeAngle(state.angle - surface.slope)) > LANDING_LIMIT;
    });
    if (roofContact && !recovering) {
      this.crash('bad-landing');
      return;
    }

    const snapLimit = SNAP_TOLERANCE + Math.abs(state.vy) * FIXED_DT;
    const contacts = wheels.filter((wheel, index) => (
      wheel.surface
      && wheel.bottom >= wheel.surface.y
      && (recovering || this.previousWheelBottoms[index]! <= wheel.surface.y + snapLimit)
    ));
    if (contacts.length === 0) return;
    const contact = contacts.reduce((highest, wheel) => (
      (wheel.surface?.y ?? Infinity) < (highest.surface?.y ?? Infinity) ? wheel : highest
    ));
    const surface = contact.surface!;
    const difference = Math.abs(normalizeAngle(state.angle - surface.slope));
    if (difference > LANDING_LIMIT && !recovering) {
      this.crash('bad-landing');
      return;
    }
    const impactSpeed = Math.abs(-state.vx * sin(surface.slope) + state.vy * cos(surface.slope));
    if (impactSpeed > CRASH_IMPACT && !recovering) {
      this.crash('bad-landing');
      return;
    }

    state.grounded = true;
    state.vy = 0;
    if (recovering) {
      state.angle = surface.slope;
      state.angularVelocity = 0;
      const alignedWheels = [this.wheelPoint(WHEELBASE / 2), this.wheelPoint(-WHEELBASE / 2)]
        .filter((wheel) => wheel.surface);
      const centerY = alignedWheels.map((wheel) => wheel.surface!.y - wheel.yOffset - WHEEL_RADIUS);
      state.y = centerY.length > 0
        ? centerY.reduce((sum, value) => sum + value, 0) / centerY.length
        : surface.y - WHEEL_VERTICAL_OFFSET * cos(state.angle) - WHEEL_RADIUS;
      state.flips = 0;
      this.flipRotation = 0;
      this.events.push({ type: 'touchdown' });
      this.clearRailRecovery();
      return;
    }
    state.y = surface.y - contact.yOffset - WHEEL_RADIUS;
    if (this.rewardedLandingThisAirbornePhase || (state.airtime < MIN_REWARD_AIRTIME && state.flips === 0)) {
      this.events.push({ type: 'touchdown' });
      state.flips = 0;
      this.flipRotation = 0;
      this.clearRailRecovery();
      return;
    }
    this.rewardedLandingThisAirbornePhase = true;
    const rawQuality: LandingQuality = difference <= PERFECT_LIMIT ? 'perfect' : difference <= GREAT_LIMIT ? 'great' : 'clean';
    const quality = impactSpeed > HARD_IMPACT
      ? rawQuality === 'perfect' ? 'great' : rawQuality === 'great' ? 'clean' : 'clean'
      : rawQuality;
    if (impactSpeed > HARD_IMPACT) this.events.push({ type: 'hardLanding' });
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
    this.clearRailRecovery();
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
        const height = hazard.kind === 'piston' ? pistonHeight(hazard, state.elapsed) : hazard.height;
        const clearance = hazard.baseY - height - this.bodyBottom();
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
      const height = hazard.kind === 'piston' ? pistonHeight(hazard, state.elapsed) : hazard.height;
      const top = hazard.baseY - height;
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
    this.clearRailRecovery();
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
