import { COURSE_CHUNK_LENGTH, GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY, MAX_SPEED, SPEED_RAMP_SECONDS, START_SPEED } from './constants';
import { atan2 } from './detmath';
import { SeededRng } from './rng';

export type SegmentKind = 'flat' | 'kicker' | 'launch' | 'slope' | 'gap' | 'platform';
export type HazardKind = 'barrier' | 'pylon' | 'crate' | 'gap';

export interface CourseSegment {
  id: string;
  kind: SegmentKind;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  hazard?: Hazard;
  landingZoneEnd?: number;
}

export interface Hazard {
  id: string;
  kind: HazardKind;
  x: number;
  width: number;
  height: number;
  safeJumpReach: number;
  minSpacing: number;
}

export interface Surface {
  y: number;
  slope: number;
  segment: CourseSegment;
}

const BASE_Y = 520;

function expectedSpeed(time: number): number {
  return Math.min(MAX_SPEED, START_SPEED + (MAX_SPEED - START_SPEED) * Math.min(time / SPEED_RAMP_SECONDS, 1));
}

function fairJumpReach(time: number): number {
  const speed = expectedSpeed(time);
  const airtime = (2 * Math.abs(JUMP_VELOCITY)) / GRAVITY;
  return speed * airtime;
}

function generatedChunk(seed: number, index: number): CourseSegment {
  const start = index * COURSE_CHUNK_LENGTH;
  const rng = new SeededRng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const time = start / Math.max(START_SPEED, (START_SPEED + MAX_SPEED) / 2);
  const elapsedBand = time < 12 ? 0 : time < 30 ? 1 : time < 60 ? 2 : 3;
  const roll = rng.next();
  const reach = fairJumpReach(time);
  const recovery = expectedSpeed(time) * HAZARD_RECOVERY_SECONDS;
  let kind: SegmentKind = 'flat';
  let y0 = BASE_Y;
  let y1 = BASE_Y;
  let hazard: Hazard | undefined;

  if (elapsedBand === 0) {
    if (roll < 0.3) kind = 'kicker';
  } else if (roll < 0.2) {
    kind = 'launch';
    y0 = BASE_Y + 48;
    y1 = BASE_Y - 74;
  } else if (roll < 0.43) {
    kind = 'gap';
    const gapWidth = Math.min(240 + rng.range(0, 70), reach * 0.66);
    kind = 'gap';
    const gapStart = start + 620;
    hazard = {
      id: `gap-${index}`,
      kind: 'gap',
      x: gapStart,
      width: gapWidth,
      height: 0,
      safeJumpReach: reach,
      minSpacing: reach + recovery,
    };
    return { id: `course-${index}`, kind, x0: gapStart, x1: gapStart + gapWidth, y0: BASE_Y, y1: BASE_Y, hazard };
  } else if (roll < 0.64) {
    kind = elapsedBand > 1 ? 'platform' : 'kicker';
    if (kind === 'platform') {
      y0 = BASE_Y;
      y1 = BASE_Y - 38;
    }
  } else if (elapsedBand > 0 && roll < 0.83) {
    const height = Math.min(38 + rng.range(0, 35), Math.abs(JUMP_VELOCITY) ** 2 / (2 * GRAVITY) * 0.5);
    hazard = {
      id: `obstacle-${index}`,
      kind: rng.next() > 0.5 ? 'barrier' : 'pylon',
      x: start + 900,
      width: 45,
      height,
      safeJumpReach: reach,
      minSpacing: reach + recovery,
    };
  } else if (roll < 0.95) {
    kind = 'slope';
    y0 = BASE_Y - 24;
    y1 = BASE_Y + 24;
  }

  if (kind === 'launch') {
    return {
      id: `course-${index}`,
      kind,
      x0: start + 410,
      x1: start + 650,
      y0,
      y1,
      landingZoneEnd: start + 1250,
    };
  }
  if (kind === 'kicker') {
    y0 = BASE_Y;
    y1 = BASE_Y - 40;
  }
  return {
    id: `course-${index}`,
    kind,
    x0: start,
    x1: start + COURSE_CHUNK_LENGTH,
    y0,
    y1,
    hazard,
    landingZoneEnd: kind === 'platform' ? start + 1650 : undefined,
  };
}

export class Course {
  private readonly cache = new Map<number, CourseSegment>();

  constructor(readonly seed: number) {}

  chunk(index: number): CourseSegment {
    const key = Math.max(0, index);
    let segment = this.cache.get(key);
    if (!segment) {
      segment = generatedChunk(this.seed, key);
      this.cache.set(key, segment);
    }
    return segment;
  }

  segmentAt(x: number): CourseSegment {
    const index = Math.floor(Math.max(0, x) / COURSE_CHUNK_LENGTH);
    const generated = this.chunk(index);
    if (generated.kind === 'gap' && x >= generated.x0 && x <= generated.x1) return generated;
    if (generated.kind === 'launch' && x >= generated.x0 && x <= generated.x1) return generated;
    if (generated.kind === 'kicker') {
      const x0 = index * COURSE_CHUNK_LENGTH + COURSE_CHUNK_LENGTH * 0.42;
      if (x >= x0 && x <= x0 + 170) return { ...generated, x0, x1: x0 + 170 };
    }
    if (generated.kind === 'slope') return generated;
    if (generated.kind === 'platform' && x >= generated.x0 && x <= generated.x0 + 520) return generated;
    return { id: `flat-${index}`, kind: 'flat', x0: index * COURSE_CHUNK_LENGTH, x1: (index + 1) * COURSE_CHUNK_LENGTH, y0: BASE_Y, y1: BASE_Y };
  }

  surfaceAt(x: number): Surface | null {
    const segment = this.segmentAt(x);
    if (segment.kind === 'gap') return null;
    if (segment.kind === 'launch' || segment.kind === 'kicker' || segment.kind === 'slope' || segment.kind === 'platform') {
      const width = segment.x1 - segment.x0;
      const t = Math.max(0, Math.min(1, (x - segment.x0) / width));
      return { y: segment.y0 + (segment.y1 - segment.y0) * t, slope: atan2(segment.y1 - segment.y0, width), segment };
    }
    return { y: BASE_Y, slope: 0, segment };
  }

  hazardsAhead(x: number, distance: number): Hazard[] {
    const first = Math.max(0, Math.floor(x / COURSE_CHUNK_LENGTH) - 1);
    const last = Math.floor((x + distance) / COURSE_CHUNK_LENGTH) + 1;
    const hazards: Hazard[] = [];
    for (let i = first; i <= last; i += 1) {
      const chunk = this.chunk(i);
      if (chunk.hazard && chunk.hazard.x + chunk.hazard.width >= x && chunk.hazard.x <= x + distance) hazards.push(chunk.hazard);
    }
    return hazards;
  }
}

export function createCourse(seed: number): Course {
  return new Course(seed >>> 0);
}
