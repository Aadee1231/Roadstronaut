import {
  CAR_LENGTH, GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY,
  LAUNCH_BOOST, START_SPEED,
  SUPER_JUMP_VELOCITY, VERTICAL_LAUNCH_BOOST, VERTICAL_LAUNCH_VY_CAP,
  VRAMP_FIRST_AT_SECONDS, distanceAtTime, speedAtTime, timeAtDistance,
} from './constants.js';
import { atan2, clamp, max, min, sin } from './detmath.js';
import { SeededRng } from './rng.js';

export const BASE_Y = 520;

export type SegmentKind = 'flat' | 'kicker' | 'launch' | 'slope' | 'platform' | 'gap' | 'quarter' | 'vramp';

export interface CourseSegment {
  id: string;
  kind: SegmentKind;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Hazard {
  id: string;
  kind: HazardKind;
  x: number;
  width: number;
  height: number;
  baseY: number;
  safeJumpReach: number;
  minSpacing: number;
  motion?: { period: number; phase: number };
  /** Individual parked vehicles that make up a 'vehicles' lineup hazard. */
  vehicles?: VehicleUnit[];
  /** True when this lineup is only clearable via the launch ramp placed before it. */
  requiresRamp?: boolean;
}

export type HazardKind = 'barrier' | 'pylon' | 'crate' | 'gap' | 'beam' | 'piston' | 'vehicles';

export type VehicleKind = 'sedan' | 'sport' | 'pickup' | 'semi';

export interface VehicleUnit {
  /** Offset from the hazard's x where this vehicle starts. */
  dx: number;
  width: number;
  height: number;
  kind: VehicleKind;
}

export interface VerticalRunInfo {
  /** x where the approach flat begins. */
  x0: number;
  /** x of the curved wall segment. */
  rampX0: number;
  /** x of the launch lip. */
  lipX: number;
  /** Height of the launch lip above BASE_Y baseline. */
  lipY: number;
  /** x where the safe landing flat begins (far edge of the pit). */
  landingX0: number;
  /** x where the protected landing flat ends. */
  landingX1: number;
  /** Surface height of the elevated landing deck below the lip. */
  deckY: number;
}

export interface ObstacleBox {
  x0: number;
  x1: number;
  top: number;
  base: number;
}

/** Collision/near-miss boxes for a hazard. 'vehicles' lineups expose one box per parked vehicle. */
export function obstacleBoxes(hazard: Hazard, height = hazard.height): ObstacleBox[] {
  if (hazard.kind === 'vehicles' && hazard.vehicles) {
    return hazard.vehicles.map((vehicle) => ({
      x0: hazard.x + vehicle.dx,
      x1: hazard.x + vehicle.dx + vehicle.width,
      top: hazard.baseY - vehicle.height,
      base: hazard.baseY,
    }));
  }
  return [{ x0: hazard.x, x1: hazard.x + hazard.width, top: hazard.baseY - height, base: hazard.baseY }];
}

export interface CeilingSegment {
  id: string;
  x0: number;
  x1: number;
  y: number;
}

export interface RailZone {
  ceiling: CeilingSegment;
  x0: number;
  x1: number;
}

export interface Surface {
  y: number;
  slope: number;
  segment: CourseSegment;
}

export function pistonHeight(hazard: Hazard, elapsed: number): number {
  if (hazard.kind !== 'piston' || !hazard.motion) return hazard.height;
  const cycle = elapsed / hazard.motion.period + hazard.motion.phase;
  const wave = sin(cycle * Math.PI * 2 - Math.PI / 2);
  return clamp((wave + 1) * hazard.height / 2, 0, hazard.height);
}

type Pattern =
  | 'hill' | 'kicker' | 'obstacle' | 'gap' | 'platform' | 'double'
  | 'obstacle-gap' | 'gap-obstacle' | 'barrier-beam' | 'narrow' | 'vehicles';
type WeightedPattern = readonly [Pattern, number];

const PLAIN_AIRTIME = -2 * JUMP_VELOCITY / GRAVITY;
const PLAIN_GAP_APPROACH = 1.5 * CAR_LENGTH;
const OPENING_RUNWAY_DISTANCE = 1_500;
const ONBOARDING_END_SECONDS = 12;
const ONBOARDING_HAZARD_SPACING_SECONDS = 1.8;
const FIRST_SUCTION_AT = 62;
const SUCTION_INTERVAL = 30;
const VRAMP_INTERVAL_MIN = 45;
const VRAMP_INTERVAL_MAX = 70;

type Band = 0 | 1 | 2 | 3 | 4 | 5;

function difficultyBand(time: number): Band {
  if (time < 12) return 0;
  if (time < 30) return 1;
  if (time < 60) return 2;
  if (time < 150) return 3;
  if (time < 300) return 4;
  return 5;
}

export class Course {
  private readonly rng: SeededRng;
  private readonly segments: CourseSegment[] = [];
  private readonly hazards: Hazard[] = [];
  private readonly ceilings: CeilingSegment[] = [];
  private readonly railZones: RailZone[] = [];
  private readonly vruns: VerticalRunInfo[] = [];
  private x = 0;
  private y = BASE_Y;
  private protectedUntil = 0;
  private nextLaunchAt = distanceAtTime(10);
  private nextSuctionAt = distanceAtTime(FIRST_SUCTION_AT);
  private nextVRunAt = distanceAtTime(VRAMP_FIRST_AT_SECONDS + 8);

  constructor(seed: number) {
    this.rng = new SeededRng(seed >>> 0);
    this.appendFlat(START_SPEED * 0.72);
  }

  private speedAtX(x: number): number {
    return speedAtTime(timeAtDistance(x));
  }

  private reachAtX(x: number): number {
    return this.speedAtX(x) * PLAIN_AIRTIME;
  }

  private spacingAtX(x: number): number {
    const speed = this.speedAtX(x);
    const safeSpacing = this.reachAtX(x) + speed * HAZARD_RECOVERY_SECONDS;
    return timeAtDistance(x) < ONBOARDING_END_SECONDS
      ? max(safeSpacing, speed * ONBOARDING_HAZARD_SPACING_SECONDS)
      : safeSpacing;
  }

  private nextHazardX(preferred: number): number {
    const previous = this.hazards[this.hazards.length - 1];
    let result = max(preferred, this.protectedUntil);
    if (!previous) return result;
    const previousEnd = previous.x + previous.width;
    result = max(result, previousEnd + previous.minSpacing);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = max(result, previousEnd + this.spacingAtX(result));
    }
    return result;
  }

  private appendSegment(kind: SegmentKind, length: number, endY: number): CourseSegment {
    const safeLength = max(1, length);
    const segment: CourseSegment = {
      id: `segment-${this.segments.length}`,
      kind,
      x0: this.x,
      x1: this.x + safeLength,
      y0: this.y,
      y1: endY,
    };
    this.segments.push(segment);
    this.x = segment.x1;
    this.y = endY;
    return segment;
  }

  private appendFlat(length: number): CourseSegment {
    return this.appendSegment('flat', length, this.y);
  }

  private appendBreather(): void {
    const time = timeAtDistance(this.x);
    // Breathers shrink for the whole run: ~1.45s early, ~0.6s at 80s, ~0.28s deep game.
    const breathSeconds = 1.45 - 0.85 * clamp(time / 80, 0, 1) - 0.32 * clamp((time - 80) / 420, 0, 1);
    const speed = this.speedAtX(this.x);
    const length = speed * breathSeconds;
    if (this.rng.next() < 0.42 && length >= speed * 0.7) {
      const startY = this.y;
      const rise = this.rng.range(12, 22);
      const halfLength = length / 2;
      this.appendSegment('slope', halfLength, startY - rise);
      this.appendSegment('slope', length - halfLength, startY);
    } else {
      this.appendFlat(length);
    }
  }

  private weightedPattern(patterns: readonly WeightedPattern[]): Pattern {
    const total = patterns.reduce((sum, pattern) => sum + pattern[1], 0);
    let roll = this.rng.next() * total;
    for (const [pattern, weight] of patterns) {
      roll -= weight;
      if (roll < 0) return pattern;
    }
    return patterns[patterns.length - 1][0];
  }

  private choosePattern(band: Band, time: number): Pattern {
    if (band === 0) {
      return this.weightedPattern([['hill', 28], ['kicker', 32], ['obstacle', 32], ['vehicles', 9]]);
    }
    if (band === 1) {
      return this.weightedPattern([['hill', 14], ['kicker', 12], ['obstacle', 30], ['gap', 32], ['vehicles', 14]]);
    }
    if (band >= 4) {
      // Deep game: hills and breather platforms fade out, hazards and car
      // rows take over, and combos chain back to back at cruise speed.
      return this.weightedPattern([
        ['hill', band === 4 ? 4 : 2], ['obstacle', 20], ['gap', 16],
        ['platform', band === 4 ? 8 : 4], ['double', band === 4 ? 22 : 24],
        ['obstacle-gap', band === 4 ? 20 : 22], ['gap-obstacle', band === 4 ? 10 : 14],
        ['narrow', band === 4 ? 14 : 16], ['barrier-beam', band === 4 ? 10 : 12],
        ['vehicles', band === 4 ? 30 : 36],
      ]);
    }
    if (band === 2) {
      const patterns: WeightedPattern[] = [
        ['hill', 10], ['obstacle', 21], ['gap', 18], ['platform', 22], ['kicker', 8], ['vehicles', 18],
      ];
      if (time >= 45) patterns.push(['obstacle-gap', 10]);
      if (time >= 30) {
        patterns.push(['barrier-beam', 12], ['gap-obstacle', 8]);
      }
      return this.weightedPattern(patterns);
    }
    return this.weightedPattern([
      ['hill', 8], ['obstacle', 14], ['gap', 12], ['platform', 15],
      ['double', 16], ['obstacle-gap', 15], ['narrow', 12], ['vehicles', 22],
    ]);
  }

  private generateNextPattern(): void {
    const time = timeAtDistance(this.x);
    if (this.x < OPENING_RUNWAY_DISTANCE) {
      if (this.rng.next() < 0.5) this.generateHill();
      else this.generateKicker();
      this.appendBreather();
      return;
    }

    if (this.x >= this.nextVRunAt) {
      this.generateVerticalRun();
      const nextTime = timeAtDistance(this.x) + this.rng.range(VRAMP_INTERVAL_MIN, VRAMP_INTERVAL_MAX);
      this.nextVRunAt = distanceAtTime(nextTime);
      this.appendBreather();
      return;
    }

    if (this.x >= this.nextSuctionAt) {
      this.generateSuctionSection();
      this.nextSuctionAt = distanceAtTime(timeAtDistance(this.x) + SUCTION_INTERVAL);
      this.appendBreather();
      return;
    }

    if (time >= 10 && this.x >= this.nextLaunchAt) {
      const overGap = time >= 30 && this.rng.next() < 0.42;
      this.generateLaunch(overGap);
      const nextTime = timeAtDistance(this.x) + this.rng.range(6, 10);
      this.nextLaunchAt = distanceAtTime(nextTime);
      this.appendBreather();
      return;
    }

    const band = difficultyBand(time);
    const pattern = this.choosePattern(band, time);
    switch (pattern) {
      case 'hill':
        this.generateHill();
        break;
      case 'kicker':
        this.generateKicker();
        break;
      case 'obstacle':
        this.generateObstacle(band === 0);
        break;
      case 'gap':
        this.generateGap();
        break;
      case 'platform':
        this.generatePlatform();
        break;
      case 'double':
        this.generateDoubleObstacle();
        break;
      case 'obstacle-gap':
        this.generateObstacleGap();
        break;
      case 'gap-obstacle':
        this.generateGapObstacle();
        break;
      case 'barrier-beam':
        this.generateBarrierBeam();
        break;
      case 'narrow':
        this.generateNarrowLanding();
        break;
      case 'vehicles':
        this.generateVehicleLineup(band);
        break;
    }
    this.appendBreather();
  }

  private generateHill(): void {
    const speed = this.speedAtX(this.x);
    const length = speed * this.rng.range(0.78, 1.05);
    const rise = this.rng.range(12, 28);
    const half = length / 2;
    const startY = this.y;
    this.appendSegment('slope', half, startY - rise);
    this.appendSegment('slope', length - half, startY);
  }

  private generateKicker(): void {
    const speed = this.speedAtX(this.x);
    const startY = this.y;
    const rise = this.rng.range(24, 40);
    this.appendSegment('kicker', speed * this.rng.range(0.34, 0.42), startY - rise);
    this.appendFlat(speed * 0.16);
    this.appendSegment('slope', speed * 0.22, startY);
    this.protectedUntil = this.x + speed * HAZARD_RECOVERY_SECONDS;
  }

  private obstacleSpec(tiny = false): {
    kind: HazardKind;
    width: number;
    height: number;
    motion?: { period: number; phase: number };
  } {
    const kinds: readonly Hazard['kind'][] = ['barrier', 'pylon', 'crate'];
    const time = timeAtDistance(this.x);
    if (time >= 30) {
      const roll = this.rng.next();
      if (roll < 0.3) {
        const apex = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY);
        return {
          kind: 'piston',
          width: this.rng.range(48, 62),
          height: this.rng.range(0.35, 0.6) * apex,
          motion: { period: this.rng.range(1.2, 2), phase: this.rng.next() },
        };
      }
      if (roll < 0.55) return { kind: 'beam', width: this.rng.range(90, 120), height: 26 };
    } else if (time >= 15 && this.rng.next() < 0.55) {
      return { kind: 'beam', width: this.rng.range(90, 120), height: 26 };
    }
    const kind = kinds[this.rng.int(0, kinds.length)];
    const width = this.rng.range(42, 58);
    const apex = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY);
    const height = tiny
      ? this.rng.range(0.22, 0.38) * apex
      : this.rng.range(0.34, 0.64) * apex;
    return { kind, width, height: min(height, apex * 0.65) };
  }

  private addObstacleAt(
    x: number,
    surfaceY: number,
    obstacle: { kind: HazardKind; width: number; height: number; motion?: { period: number; phase: number } },
  ): Hazard {
    const hazard: Hazard = {
      id: `hazard-${this.hazards.length}`,
      kind: obstacle.kind,
      x,
      width: obstacle.width,
      height: obstacle.height,
      baseY: obstacle.kind === 'beam' ? surfaceY - 58 : surfaceY,
      safeJumpReach: this.reachAtX(x),
      minSpacing: this.spacingAtX(x),
      ...(obstacle.motion ? { motion: { ...obstacle.motion } } : {}),
    };
    this.hazards.push(hazard);
    return hazard;
  }

  private addGapAt(x: number, width: number, baseY: number): Hazard {
    const hazard: Hazard = {
      id: `hazard-${this.hazards.length}`,
      kind: 'gap',
      x,
      width,
      height: 0,
      baseY,
      safeJumpReach: this.reachAtX(x),
      minSpacing: this.spacingAtX(x),
    };
    this.hazards.push(hazard);
    return hazard;
  }

  private generateObstacle(tiny = false): void {
    const speed = this.speedAtX(this.x);
    const obstacle = this.obstacleSpec(tiny);
    const hazardX = this.nextHazardX(this.x + speed * 0.28);
    this.appendFlat(hazardX - this.x);
    this.addObstacleAt(hazardX, this.y, obstacle);
    this.appendFlat(obstacle.width + speed * 0.34);
  }

  private generateGap(widthScale?: number, endY = this.y): Hazard {
    const speed = this.speedAtX(this.x);
    const hazardX = max(this.nextHazardX(this.x + speed * 0.3), this.x + PLAIN_GAP_APPROACH);
    this.appendFlat(hazardX - this.x);
    const reach = this.reachAtX(hazardX);
    const width = reach * (widthScale ?? this.rng.range(0.48, 0.68));
    const startY = this.y;
    this.appendSegment('gap', width, endY);
    const hazard = this.addGapAt(hazardX, width, startY);
    this.appendFlat(this.speedAtX(this.x) * 0.28);
    return hazard;
  }

  private generateDoubleObstacle(): void {
    const speed = this.speedAtX(this.x);
    const firstSpec = this.obstacleSpec();
    const firstX = this.nextHazardX(this.x + speed * 0.24);
    this.appendFlat(firstX - this.x);
    const first = this.addObstacleAt(firstX, this.y, firstSpec);
    this.appendFlat(first.width);

    const secondSpec = this.obstacleSpec();
    const secondX = this.nextHazardX(first.x + first.width + first.minSpacing);
    this.appendFlat(secondX - this.x);
    this.addObstacleAt(secondX, this.y, secondSpec);
    this.appendFlat(secondSpec.width + this.speedAtX(this.x) * 0.3);
  }

  private generateObstacleGap(): void {
    const speed = this.speedAtX(this.x);
    const obstacle = this.obstacleSpec();
    const obstacleX = this.nextHazardX(this.x + speed * 0.22);
    this.appendFlat(obstacleX - this.x);
    const placed = this.addObstacleAt(obstacleX, this.y, obstacle);
    this.appendFlat(placed.width);

    const gapX = max(
      this.nextHazardX(placed.x + placed.width + placed.minSpacing),
      this.x + PLAIN_GAP_APPROACH,
    );
    this.appendFlat(gapX - this.x);
    const width = this.reachAtX(gapX) * this.rng.range(0.48, 0.66);
    const baseY = this.y;
    this.appendSegment('gap', width, baseY);
    this.addGapAt(gapX, width, baseY);
    this.appendFlat(this.speedAtX(this.x) * 0.28);
  }

  private generateGapObstacle(): void {
    const speed = this.speedAtX(this.x);
    this.generateGap();
    const obstacle = this.obstacleSpec();
    const hazardX = this.nextHazardX(this.x + speed * 0.2);
    this.appendFlat(hazardX - this.x);
    const baseY = this.y;
    this.addObstacleAt(hazardX, baseY, obstacle);
    this.appendFlat(obstacle.width + speed * 0.3);
  }

  private generateBarrierBeam(): void {
    const speed = this.speedAtX(this.x);
    const apex = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY);
    const barrier = this.addObstacleAt(
      this.nextHazardX(this.x + speed * 0.2),
      this.y,
      { kind: 'barrier', width: 50, height: this.rng.range(0.22, 0.38) * apex },
    );
    this.appendFlat(barrier.x - this.x + barrier.width);
    const beamX = this.nextHazardX(barrier.x + barrier.width + barrier.minSpacing);
    this.appendFlat(beamX - this.x);
    const beam = this.addObstacleAt(beamX, this.y, { kind: 'beam', width: 100, height: 26 });
    this.appendFlat(beam.width + speed * 0.3);
  }

  private generateNarrowLanding(): void {
    const speed = this.speedAtX(this.x);
    const firstX = max(this.nextHazardX(this.x + speed * 0.25), this.x + PLAIN_GAP_APPROACH);
    this.appendFlat(firstX - this.x);
    const firstWidth = this.reachAtX(firstX) * 0.54;
    const raisedY = BASE_Y - 30;
    const firstBase = this.y;
    this.appendSegment('gap', firstWidth, raisedY);
    const first = this.addGapAt(firstX, firstWidth, firstBase);

    const secondX = this.nextHazardX(first.x + first.width + first.minSpacing);
    this.appendSegment('platform', secondX - this.x, raisedY);
    const secondWidth = this.reachAtX(secondX) * 0.38;
    const secondBase = this.y;
    this.appendSegment('gap', secondWidth, BASE_Y);
    this.addGapAt(secondX, secondWidth, secondBase);
    this.appendFlat(this.speedAtX(this.x) * 0.3);
  }

  private generatePlatform(): void {
    const speed = this.speedAtX(this.x);
    const startY = this.y;
    const rise = this.rng.range(65, 95);
    this.appendSegment('slope', speed * 0.42, startY - rise);

    const raisedY = this.y;
    const hasObstacle = this.rng.next() < 0.55;
    const obstacle = hasObstacle ? this.obstacleSpec(true) : null;
    const platformStart = this.x;
    let obstacleX = platformStart;
    let platformLength = speed * 0.68;
    if (obstacle) {
      obstacleX = this.nextHazardX(platformStart + speed * 0.16);
      platformLength = max(platformLength, obstacleX - platformStart + obstacle.width + speed * 0.15);
    }
    this.appendSegment('platform', platformLength, raisedY);
    if (obstacle) this.addObstacleAt(obstacleX, raisedY, obstacle);

    if (this.rng.next() < 0.48) {
      const gapX = this.nextHazardX(this.x);
      if (gapX > this.x) this.appendSegment('platform', gapX - this.x, raisedY);
      const width = this.reachAtX(gapX) * this.rng.range(0.38, 0.58);
      const baseY = this.y;
      this.appendSegment('gap', width, BASE_Y);
      this.addGapAt(gapX, width, baseY);
      this.appendFlat(this.speedAtX(this.x) * 0.28);
    } else {
      this.appendSegment('slope', speed * 0.3, startY);
    }
  }

  private generateLaunch(overGap: boolean): void {
    let speed = this.speedAtX(this.x);
    let rampLength = speed * 0.42;
    if (overGap) {
      const requiredGapX = this.nextHazardX(this.x + rampLength);
      const launchStart = max(this.x, requiredGapX - rampLength);
      if (launchStart > this.x) this.appendFlat(launchStart - this.x);
      speed = this.speedAtX(this.x);
      rampLength = speed * 0.42;
    }

    const startY = this.y;
    const rise = min(200, max(125, speed * 0.25));
    const tipY = startY - rise;
    const ramp = this.appendSegment('launch', rampLength, tipY);
    const slope = atan2(ramp.y1 - ramp.y0, ramp.x1 - ramp.x0);
    const lipSpeed = this.speedAtX(ramp.x1);
    const normalVelocity = lipSpeed * sin(slope) + LAUNCH_BOOST;
    const superVelocity = normalVelocity + SUPER_JUMP_VELOCITY;
    const plainReach = this.reachAtX(ramp.x1);
    const superReach = lipSpeed * 2 * Math.abs(superVelocity) / GRAVITY;
    const landingLength = max(plainReach, superReach) + lipSpeed * 0.12;

    if (overGap) {
      const gapX = this.nextHazardX(this.x);
      if (gapX > this.x) this.appendFlat(gapX - this.x);
      const width = this.reachAtX(gapX) * this.rng.range(0.48, 0.66);
      const rimY = this.y;
      this.appendSegment('gap', width, BASE_Y);
      this.addGapAt(gapX, width, rimY);
      this.appendFlat(landingLength);
      this.protectedUntil = this.x;
    } else {
      this.appendFlat(landingLength);
      this.appendSegment('slope', lipSpeed * 0.34, startY);
      this.protectedUntil = this.x;
    }
  }

  private generateVerticalRun(): void {
    const speed = this.speedAtX(this.x);
    if (this.y < BASE_Y - 6) {
      this.appendSegment('slope', speed * 0.3, BASE_Y);
    }
    const approachStart = this.x;
    // Charge strip: visible approach pad before the structure.
    this.appendFlat(speed * 1.15);

    const height = clamp(speed * 0.85, 470, 830);
    const width = height * 0.5;
    const rampX0 = this.x;
    this.appendSegment('vramp', width, this.y - height);
    const lipX = this.x;
    const lipY = this.y;

    // Flight corridor: a deep pit under the arc (falling in is a real crash),
    // then an elevated landing deck below the lip — the launched car arcs over
    // the chasm and touches down on the high platform like a roof deck.
    // Lip exit speed ≈ surface speed + thruster boost, capped so the deck
    // impact stays under the crash threshold even at 230mph.
    const launchVy = min(speed - VERTICAL_LAUNCH_BOOST, VERTICAL_LAUNCH_VY_CAP);
    const deckDrop = clamp(speed * 0.35, 260, 480);
    const deckY = lipY + deckDrop;
    const flightSeconds = (launchVy + Math.sqrt(launchVy * launchVy + 2 * GRAVITY * deckDrop)) / GRAVITY;
    // The deck begins a beat before the arc crosses deck height so the car —
    // rotating mid-somersault, wheels sweeping low — always arrives above its
    // top edge instead of clipping the rim.
    const deckX0 = lipX + speed * (flightSeconds - 0.22);
    this.appendSegment('gap', deckX0 - this.x, deckY);
    this.addGapAt(lipX, deckX0 - lipX, BASE_Y);

    // Deck runout: enough room to land, roll out, then descend back to grade.
    const deckLength = speed * 0.9;
    this.appendSegment('platform', deckLength, deckY);
    const landingX0 = deckX0;
    this.appendSegment('slope', speed * 0.45, BASE_Y);
    this.appendFlat(speed * 0.3);
    this.protectedUntil = this.x;

    this.vruns.push({
      x0: approachStart,
      rampX0,
      lipX,
      lipY,
      landingX0,
      landingX1: this.x,
      deckY,
    });
  }

  private vehicleUnit(kind: VehicleKind, band: Band): VehicleUnit {
    switch (kind) {
      case 'sport':
        return { dx: 0, width: this.rng.range(150, 168), height: this.rng.range(42, 50), kind };
      case 'pickup':
        return { dx: 0, width: this.rng.range(172, 195), height: this.rng.range(60, 68), kind };
      case 'semi':
        return { dx: 0, width: this.rng.range(315, 360), height: this.rng.range(88, 102), kind };
      default: {
        const tall = band >= 2 ? 58 : 54;
        return { dx: 0, width: this.rng.range(160, 184), height: this.rng.range(48, tall), kind: 'sedan' };
      }
    }
  }

  private addVehicleLineupAt(x: number, surfaceY: number, units: VehicleUnit[], requiresRamp: boolean): Hazard {
    let cursor = 0;
    for (const unit of units) {
      unit.dx = cursor;
      cursor += unit.width + this.rng.range(4, 14);
    }
    const span = units[units.length - 1]!.dx + units[units.length - 1]!.width;
    const hazard: Hazard = {
      id: `hazard-${this.hazards.length}`,
      kind: 'vehicles',
      x,
      width: span,
      height: units.reduce((top, unit) => max(top, unit.height), 0),
      baseY: surfaceY,
      safeJumpReach: this.reachAtX(x),
      minSpacing: this.spacingAtX(x),
      vehicles: units,
      requiresRamp,
    };
    this.hazards.push(hazard);
    return hazard;
  }

  private generateVehicleLineup(band: Band): void {
    const speed = this.speedAtX(this.x);
    const jumpV = -JUMP_VELOCITY;
    // Descending-side time where a plain jump loses clearance above height h:
    // jumpV*t - GRAVITY/2 t^2 = h + body margin. Solve for the second root.
    const clearanceTime = (h: number): number => {
      const disc = jumpV * jumpV - 2 * GRAVITY * (h + 14);
      return disc <= 0 ? 0 : (jumpV + Math.sqrt(disc)) / GRAVITY;
    };
    // A jump taken ~0.30s before the lineup clears vehicle faces up to ~85 tall
    // and lands ~0.57*speed past the edge; the span must end before clearance
    // at the tallest unit is lost, with margin for early presses.
    const jumpableSpan = (h: number): number => (clearanceTime(h) - 0.31) * speed - 90;

    // Ramp-assisted stunts stay spectacular but rare enough that cars on the
    // road — hoppable rows and solo parked cars — are the common case deep in.
    const wantsSemi = band >= 1 && this.rng.next() < (band >= 4 ? 0.28 : band >= 2 ? 0.38 : 0.15);
    const wantsShowcase = band >= 2 && this.rng.next() < (band >= 4 ? 0.22 : band === 3 ? 0.32 : 0.16);
    const wantsTrio = band >= 1 && this.rng.next() < (band >= 4 ? 0.32 : 0.5);

    const rampAssisted = wantsSemi || wantsShowcase || wantsTrio;

    if (!rampAssisted) {
      // Plain rows: singles early, mixed rows deep — a lone parked car is the
      // bread-and-butter hop, so solos stay common even at max difficulty.
      const count = band === 0 ? 1
        : this.rng.next() < 0.42 ? 1
          : this.rng.int(2, band >= 4 ? 6 : band >= 3 ? 5 : band >= 2 ? 4 : 3);
      const units: VehicleUnit[] = [];
      for (let index = 0; index < count; index += 1) {
        // Multi-car rows favor low sports cars so the tail stays clearable.
        const roll = this.rng.next();
        const kind: VehicleKind = count > 1
          ? (roll < 0.6 ? 'sport' : roll < 0.9 ? 'sedan' : 'pickup')
          : (roll < 0.45 ? 'sedan' : roll < 0.8 ? 'sport' : 'pickup');
        units.push(this.vehicleUnit(kind, band));
      }
      const spanOf = (): number => units.reduce((sum, unit) => sum + unit.width + 10, 0) - 10;
      // Trim trailing vehicles until the row fits the physics budget.
      while (units.length > 1) {
        const maxH = units.reduce((top, unit) => max(top, unit.height), 0);
        if (spanOf() <= jumpableSpan(maxH)) break;
        units.pop();
      }
      if (units.length === 0) {
        this.appendFlat(speed * 0.4);
        return;
      }
      const maxH = units.reduce((top, unit) => max(top, unit.height), 0);
      let budget = jumpableSpan(maxH);
      if (units.length === 1 && units[0]!.width > budget) {
        units[0]!.width = max(140, budget - 10);
      }
      // A single vehicle too tall to bound still gets a face-clearable height.
      if (budget < 140 && units.length === 1) {
        units[0]!.height = min(units[0]!.height, 46);
        units[0]!.width = min(units[0]!.width, 160);
        budget = jumpableSpan(units[0]!.height);
        if (budget < 140) {
          this.appendFlat(speed * 0.4);
          return;
        }
      }
      const lineupX = this.nextHazardX(this.x + speed * 0.28);
      this.appendFlat(lineupX - this.x);
      const hazard = this.addVehicleLineupAt(lineupX, this.y, units, false);
      this.appendFlat(hazard.width + speed * 0.34);
      return;
    }

    // Stunt lineup: a launch ramp carries the car over a row it could never
    // plain-jump. Arc math mirrors generateLaunch so the assist is guaranteed.
    const rampX = this.nextHazardX(this.x + speed * 0.3);
    this.appendFlat(rampX - this.x);
    const startY = this.y;
    const rampLength = speed * 0.42;
    const rise = min(200, max(125, speed * 0.25));
    this.appendSegment('launch', rampLength, startY - rise);
    const lipX = this.x;
    const lipY = this.y;

    // Lead-in flat, then the lineup inside the assisted arc. The flat sits at
    // lip height, so the car returns to ground level after ~2*launchV/GRAVITY.
    this.appendFlat(speed * 0.38);
    const lineupX = this.x;
    const lipSpeed = this.speedAtX(lineupX);
    const lipSlope = atan2(lipY - startY, rampLength);
    const launchV = -(lipSpeed * sin(lipSlope) + LAUNCH_BOOST);
    const flightDistance = lipSpeed * 2 * launchV / GRAVITY;
    // Keep the lineup inside the high part of the arc: its far edge must stay
    // ahead of the descent where clearance dips below vehicle height.
    const lineupBudget = 0.8 * flightDistance - (lineupX - lipX);

    const units: VehicleUnit[] = [];
    const carCount = wantsShowcase ? this.rng.int(4, 6) : wantsSemi ? this.rng.int(1, 3) : this.rng.int(3, 4);
    for (let index = 0; index < carCount; index += 1) {
      const roll = this.rng.next();
      const kind: VehicleKind = roll < 0.4 ? 'sport' : roll < 0.8 ? 'sedan' : 'pickup';
      units.push(this.vehicleUnit(kind, band));
    }
    if (wantsSemi || (wantsShowcase && this.rng.next() < 0.5)) {
      units.push(this.vehicleUnit('semi', band));
    }
    // Trim leading cars until the row fits the budget (semi stays at the end).
    while (units.length > 1 && units.reduce((sum, unit) => sum + unit.width + 10, 0) > lineupBudget) {
      units.shift();
    }
    const hazard = this.addVehicleLineupAt(lineupX, this.y, units, true);
    const landingLength = flightDistance + lipSpeed * 0.35;
    this.appendFlat(max(hazard.width + speed * 0.4, landingLength - (this.x - lipX)));
    if (this.y < BASE_Y - 6) {
      this.appendSegment('slope', lipSpeed * 0.4, BASE_Y);
      this.appendFlat(speed * 0.3);
    }
    this.protectedUntil = this.x;
  }

  private generateSuctionSection(): void {
    const speed = this.speedAtX(this.x);
    const startY = this.y;
    this.appendFlat(speed * 0.45);
    const x0 = this.x;
    this.appendSegment('quarter', speed * 0.3, startY - 24);
    this.appendSegment('quarter', speed * 0.3, startY - 64);
    this.appendSegment('quarter', speed * 0.12, startY - 190);

    const lipY = this.y;
    this.appendSegment('slope', speed * 0.3, BASE_Y - 40);
    const railLength = speed * 0.95;
    const ceiling: CeilingSegment = {
      id: `ceiling-${this.ceilings.length}`,
      x0: this.x,
      x1: this.x + railLength,
      y: lipY - 230,
    };
    this.ceilings.push(ceiling);
    this.appendFlat(railLength);
    this.appendSegment('slope', speed * 0.25, BASE_Y);
    this.appendFlat(speed * 0.9);
    this.protectedUntil = this.x;
    this.railZones.push({ ceiling, x0, x1: this.protectedUntil });
  }

  private ensureThrough(x: number): void {
    const target = max(0, x);
    while (this.segments.length === 0 || this.segments[this.segments.length - 1].x1 < target) {
      this.generateNextPattern();
    }
  }

  private segmentAt(x: number): CourseSegment {
    this.ensureThrough(x);
    const target = max(0, x);
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (target < this.segments[middle].x1) high = middle;
      else low = middle + 1;
    }
    return this.segments[low];
  }

  surfaceAt(x: number): Surface | null {
    const segment = this.segmentAt(x);
    if (segment.kind === 'gap') return null;
    const width = segment.x1 - segment.x0;
    const t = clamp((x - segment.x0) / width, 0, 1);
    if (segment.kind === 'vramp') {
      // Quarter-circle hook: dead-flat entry curling to a fully vertical lip,
      // like a stunt ramp that sweeps the car up a wall.
      const rise = segment.y1 - segment.y0;
      const tc = min(t, 0.9995);
      const eased = 1 - Math.sqrt(1 - tc * tc);
      const dyDt = rise * tc / Math.sqrt(1 - tc * tc);
      return {
        y: segment.y0 + rise * eased,
        slope: atan2(dyDt, width),
        segment,
      };
    }
    return {
      y: segment.y0 + (segment.y1 - segment.y0) * t,
      slope: atan2(segment.y1 - segment.y0, width),
      segment,
    };
  }

  verticalRunsInRange(x0: number, x1: number): VerticalRunInfo[] {
    const startX = min(x0, x1);
    const endX = max(x0, x1);
    this.ensureThrough(endX);
    return this.vruns.filter((run) => run.landingX1 >= startX && run.x0 <= endX);
  }

  hazardsAhead(x: number, distance: number): Hazard[] {
    const end = x + distance;
    const startX = min(x, end);
    const endX = max(x, end);
    this.ensureThrough(endX);
    let low = 0;
    let high = this.hazards.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.hazards[middle].x + this.hazards[middle].width < startX) low = middle + 1;
      else high = middle;
    }
    const result: Hazard[] = [];
    for (let index = low; index < this.hazards.length && this.hazards[index].x <= endX; index += 1) {
      result.push({ ...this.hazards[index] });
    }
    return result;
  }

  segmentsInRange(x0: number, x1: number): CourseSegment[] {
    const startX = min(x0, x1);
    const endX = max(x0, x1);
    this.ensureThrough(endX);
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.segments[middle].x1 < startX) low = middle + 1;
      else high = middle;
    }
    const result: CourseSegment[] = [];
    for (let index = low; index < this.segments.length && this.segments[index].x0 <= endX; index += 1) {
      result.push({ ...this.segments[index] });
    }
    return result;
  }

  ceilingsInRange(x0: number, x1: number): CeilingSegment[] {
    const startX = min(x0, x1);
    const endX = max(x0, x1);
    this.ensureThrough(endX);
    return this.ceilings
      .filter((ceiling) => ceiling.x1 >= startX && ceiling.x0 <= endX)
      .map((ceiling) => ({ ...ceiling }));
  }

  ceilingAt(x: number): CeilingSegment | null {
    return this.ceilingsInRange(x, x).find((ceiling) => x >= ceiling.x0 && x <= ceiling.x1) ?? null;
  }

  railZoneAt(x: number): RailZone | null {
    this.ensureThrough(x);
    const zone = this.railZones.find((candidate) => x >= candidate.x0 && x <= candidate.x1);
    return zone ? { ...zone, ceiling: { ...zone.ceiling } } : null;
  }
}

export function createCourse(seed: number): Course {
  return new Course(seed);
}
