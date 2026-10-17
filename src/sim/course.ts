import {
  GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY,
  LAUNCH_BOOST, START_SPEED,
  SUPER_JUMP_VELOCITY, distanceAtTime, speedAtTime, timeAtDistance,
} from './constants';
import { atan2, clamp, max, min, sin } from './detmath';
import { SeededRng } from './rng';

export const BASE_Y = 520;

export type SegmentKind = 'flat' | 'kicker' | 'launch' | 'slope' | 'platform' | 'gap';

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
  kind: 'barrier' | 'pylon' | 'crate' | 'gap';
  x: number;
  width: number;
  height: number;
  baseY: number;
  safeJumpReach: number;
  minSpacing: number;
}

export interface Surface {
  y: number;
  slope: number;
  segment: CourseSegment;
}

type Pattern = 'hill' | 'kicker' | 'obstacle' | 'gap' | 'platform' | 'double' | 'obstacle-gap' | 'narrow';
type WeightedPattern = readonly [Pattern, number];

const PLAIN_AIRTIME = -2 * JUMP_VELOCITY / GRAVITY;

function difficultyBand(time: number): 0 | 1 | 2 | 3 {
  if (time < 12) return 0;
  if (time < 30) return 1;
  if (time < 60) return 2;
  return 3;
}

export class Course {
  private readonly rng: SeededRng;
  private readonly segments: CourseSegment[] = [];
  private readonly hazards: Hazard[] = [];
  private x = 0;
  private y = BASE_Y;
  private protectedUntil = 0;
  private nextLaunchAt = distanceAtTime(10);

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
    return this.reachAtX(x) + this.speedAtX(x) * HAZARD_RECOVERY_SECONDS;
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
    const breathSeconds = 1.6 - 0.9 * clamp(time / 90, 0, 1);
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

  private choosePattern(band: 0 | 1 | 2 | 3, time: number): Pattern {
    if (band === 0) {
      return this.weightedPattern([['hill', 28], ['kicker', 32], ['obstacle', 40]]);
    }
    if (band === 1) {
      return this.weightedPattern([['hill', 14], ['kicker', 12], ['obstacle', 36], ['gap', 38]]);
    }
    if (band === 2) {
      const patterns: WeightedPattern[] = [
        ['hill', 10], ['obstacle', 25], ['gap', 21], ['platform', 26], ['kicker', 8],
      ];
      if (time >= 45) patterns.push(['obstacle-gap', 10]);
      return this.weightedPattern(patterns);
    }
    return this.weightedPattern([
      ['hill', 8], ['obstacle', 16], ['gap', 14], ['platform', 17],
      ['double', 17], ['obstacle-gap', 16], ['narrow', 12],
    ]);
  }

  private generateNextPattern(): void {
    const time = timeAtDistance(this.x);
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
      case 'narrow':
        this.generateNarrowLanding();
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
  }

  private obstacleSpec(tiny = false): { kind: Hazard['kind']; width: number; height: number } {
    const kinds: readonly Hazard['kind'][] = ['barrier', 'pylon', 'crate'];
    const kind = kinds[this.rng.int(0, kinds.length)];
    const width = this.rng.range(42, 58);
    const apex = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY);
    const height = tiny
      ? this.rng.range(0.22, 0.38) * apex
      : this.rng.range(0.34, 0.64) * apex;
    return { kind, width, height: min(height, apex * 0.65) };
  }

  private addObstacleAt(x: number, baseY: number, obstacle: { kind: Hazard['kind']; width: number; height: number }): Hazard {
    const hazard: Hazard = {
      id: `hazard-${this.hazards.length}`,
      kind: obstacle.kind,
      x,
      width: obstacle.width,
      height: obstacle.height,
      baseY,
      safeJumpReach: this.reachAtX(x),
      minSpacing: this.spacingAtX(x),
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
    const hazardX = this.nextHazardX(this.x + speed * 0.3);
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

    const gapX = this.nextHazardX(placed.x + placed.width + placed.minSpacing);
    this.appendFlat(gapX - this.x);
    const width = this.reachAtX(gapX) * this.rng.range(0.48, 0.66);
    const baseY = this.y;
    this.appendSegment('gap', width, baseY);
    this.addGapAt(gapX, width, baseY);
    this.appendFlat(this.speedAtX(this.x) * 0.28);
  }

  private generateNarrowLanding(): void {
    const speed = this.speedAtX(this.x);
    const firstX = this.nextHazardX(this.x + speed * 0.25);
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
    return {
      y: segment.y0 + (segment.y1 - segment.y0) * t,
      slope: atan2(segment.y1 - segment.y0, width),
      segment,
    };
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
}

export function createCourse(seed: number): Course {
  return new Course(seed);
}
