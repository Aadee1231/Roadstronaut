import { describe, expect, it } from 'vitest';
import {
  CAR_HEIGHT, CAR_LENGTH, FIXED_DT, GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY, LANDING_LIMIT, MAX_RUN_SECONDS,
  FAN_MAX, LAUNCH_BOOST, MAX_SPEED, SPEED_RAMP_SECONDS, START_SPEED, SUPER_JUMP_VELOCITY,
  SNAP_TOLERANCE, WHEELBASE, WHEEL_RADIUS,
  distanceAtTime, speedAtTime, timeAtDistance,
} from '../../src/sim/constants';
import { atan2, cos, normalizeAngle, sin } from '../../src/sim/detmath';
import { BASE_Y, createCourse, pistonHeight, type Course, type Hazard, type RailZone, type Surface } from '../../src/sim/course';
import { SeededRng } from '../../src/sim/rng';
import { Simulation, WHEEL_VERTICAL_OFFSET } from '../../src/sim/simulation';

const DISTANCE_150_SECONDS = distanceAtTime(150);
const FAIRNESS_DISTANCE = DISTANCE_150_SECONDS + 10_000;
const LAUNCH_WINDOW = 0.25;
const OPENING_RUNWAY_DISTANCE = 1_500;
const ONBOARDING_END_SECONDS = 12;
const ONBOARDING_DISTANCE = distanceAtTime(ONBOARDING_END_SECONDS);

function checkFairness(seed: number): void {
  const course = createCourse(seed);
  const segments = course.segmentsInRange(0, FAIRNESS_DISTANCE);
  expect(segments[0]?.x0, `seed ${seed} starts at x=0`).toBe(0);
  expect(segments[segments.length - 1]?.x1, `seed ${seed} covers 150 seconds`).toBeGreaterThanOrEqual(DISTANCE_150_SECONDS);
  for (let index = 1; index < segments.length; index += 1) {
    expect(segments[index].x0, `seed ${seed} segment ${segments[index].id}`).toBe(segments[index - 1].x1);
  }

  const hazards = course.hazardsAhead(0, FAIRNESS_DISTANCE);
  let previous: Hazard | undefined;
  for (const hazard of hazards) {
    const speed = speedAtTime(timeAtDistance(hazard.x));
    expect(hazard.safeJumpReach).toBeGreaterThan(0);
    expect(hazard.minSpacing).toBeGreaterThanOrEqual(
      hazard.safeJumpReach + speed * HAZARD_RECOVERY_SECONDS - 0.05,
    );
    if (hazard.kind === 'gap') {
      expect(hazard.width, hazard.id).toBeLessThanOrEqual(hazard.safeJumpReach * 0.72);
    } else {
      const plainJumpApex = JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY);
      expect(hazard.height, hazard.id).toBeLessThanOrEqual(plainJumpApex * 0.65);
      if (hazard.kind === 'beam') expect(hazard.height).toBe(26);
      if (hazard.kind === 'piston') {
        expect(hazard.motion?.period).toBeGreaterThanOrEqual(1.2);
        expect(hazard.motion?.period).toBeLessThanOrEqual(2);
      }
    }
    if (previous) {
      expect(hazard.x - previous.x - previous.width, `${previous.id} → ${hazard.id}`).toBeGreaterThanOrEqual(
        previous.minSpacing - 0.05,
      );
    }
    previous = hazard;
  }

  for (const launch of segments.filter((segment) => segment.kind === 'launch' && segment.x1 <= DISTANCE_150_SECONDS)) {
    const slope = atan2(launch.y1 - launch.y0, launch.x1 - launch.x0);
    const speed = speedAtTime(timeAtDistance(launch.x1));
    const plainReach = speed * -2 * JUMP_VELOCITY / GRAVITY;
    const superVelocity = speed * sin(slope) + LAUNCH_BOOST + SUPER_JUMP_VELOCITY;
    const landingLength = Math.max(plainReach, speed * 2 * Math.abs(superVelocity) / GRAVITY) + speed * 0.12;
    const next = segments.find((segment) => segment.x0 === launch.x1);
    expect(next, `${launch.id} has a contiguous landing sequence`).toBeDefined();
    if (next?.kind === 'gap') {
      expect(segments.find((segment) => segment.x0 === next.x1)?.x1! - next.x1).toBeGreaterThanOrEqual(plainReach);
      const protectedStart = next.x1;
      const protectedEnd = protectedStart + landingLength;
      const unprotectedHazards = hazards.filter((hazard) => (
        hazard.x + hazard.width >= protectedStart
        && hazard.x < protectedEnd
        && !(hazard.kind === 'gap' && hazard.x === next.x0)
      ));
      expect(unprotectedHazards, `${launch.id} landing zone`).toEqual([]);
    } else {
      expect(next?.kind).toBe('flat');
      expect((next?.x1 ?? 0) - launch.x1).toBeGreaterThanOrEqual(plainReach);
      const protectedEnd = launch.x1 + landingLength + speed * 0.34;
      const unprotectedHazards = hazards.filter((hazard) => (
        hazard.x + hazard.width >= launch.x1 && hazard.x < protectedEnd
      ));
      expect(unprotectedHazards, `${launch.id} landing zone`).toEqual([]);
    }
  }

  for (const gap of segments.filter((segment) => segment.kind === 'gap')) {
    expect(course.surfaceAt((gap.x0 + gap.x1) / 2), `${gap.id} has no interior surface`).toBeNull();
    const index = segments.indexOf(gap);
    const approach = segments[index - 1];
    if (approach?.kind !== 'launch') {
      expect(['flat', 'platform']).toContain(approach?.kind);
      expect(approach!.x1 - approach!.x0, `${gap.id} has a flat run-up`).toBeGreaterThanOrEqual(1.5 * CAR_LENGTH);
    }
  }
}

function eventsPerTenSeconds(course: Course, startSeconds = 0, windowCount = 15): number[] {
  const endDistance = distanceAtTime(startSeconds + windowCount * 10);
  const segments = course.segmentsInRange(0, endDistance);
  const hazards = course.hazardsAhead(0, endDistance);
  const positions = [
    ...segments.filter((segment) => segment.kind !== 'flat' && segment.kind !== 'gap').map((segment) => segment.x0),
    ...hazards.map((hazard) => hazard.x),
  ];
  return Array.from({ length: windowCount }, (_, window) => {
    const start = distanceAtTime(startSeconds + window * 10);
    const end = distanceAtTime(startSeconds + (window + 1) * 10);
    return positions.filter((x) => x >= start && x < end).length;
  });
}

function firstNoInputCrashTime(seed: number): number {
  const simulation = new Simulation(seed);
  const maxTicks = Math.ceil((MAX_RUN_SECONDS + 1) / FIXED_DT);
  for (let tick = 0; tick < maxTicks && !simulation.state.crashed; tick += 1) {
    simulation.step(false);
  }
  return simulation.state.elapsed;
}

function lookaheadJump(simulation: Simulation): boolean {
  const { state } = simulation;
  if (!state.grounded) return false;
  const hazards = simulation.course.hazardsAhead(state.x - 50, state.speed * 2 + 100);
  const next = hazards.find((hazard) => hazard.x + hazard.width >= state.x);
  if (!next) return false;
  if (next.kind === 'beam') return false;
  const lead = next.kind === 'gap' ? next.safeJumpReach * 0.08 : next.safeJumpReach * 0.35;
  const targetX = next.x - lead;
  return state.x < targetX && state.x + state.speed * FIXED_DT >= targetX;
}

function survivesLookahead(simulation: Simulation, pressNow: boolean): boolean {
  const branch = simulation.clone();
  for (let tick = 0; tick < Math.ceil(1.5 / FIXED_DT) && !branch.state.crashed; tick += 1) {
    branch.step(tick === 0 ? pressNow : lookaheadJump(branch));
  }
  return !branch.state.crashed;
}

function searchBotInput(simulation: Simulation): boolean {
  const { state } = simulation;
  if (!state.grounded) return false;
  const next = simulation.course.hazardsAhead(state.x - CAR_LENGTH / 2, state.speed * 1.5 + CAR_LENGTH)
    .find((hazard) => hazard.x + hazard.width >= state.x);
  if (!next || next.kind === 'beam') return false;
  const lead = next.kind === 'gap' ? next.safeJumpReach * 0.08 : next.safeJumpReach * 0.35;
  const targetX = next.x - lead;
  if (state.x >= targetX || state.x + state.speed * 0.05 < targetX) return false;
  const noPressSurvives = survivesLookahead(simulation, false);
  const pressSurvives = survivesLookahead(simulation, true);
  if (pressSurvives !== noPressSurvives) return pressSurvives;
  return true;
}

function runSearchBot(seed: number, seconds: number): Simulation {
  const simulation = new Simulation(seed);
  const ticks = Math.ceil(seconds / FIXED_DT);
  let held = false;
  for (let tick = 0; tick < ticks && !simulation.state.crashed; tick += 1) {
    if (tick % 6 === 0) held = searchBotInput(simulation);
    simulation.step(held);
    held = false;
  }
  return simulation;
}

function runNoFlipBot(seed: number, seconds: number): Simulation {
  const simulation = new Simulation(seed);
  const ticks = Math.ceil(seconds / FIXED_DT);
  for (let tick = 0; tick < ticks && !simulation.state.crashed; tick += 1) {
    simulation.step(lookaheadJump(simulation));
  }
  return simulation;
}

interface SuctionTrial {
  engaged: boolean;
  releaseReason: 'end' | 'empty' | null;
  alive: boolean;
  grounded: boolean;
  flips: number;
  fanMinimum: number;
}

function runSuctionTrial(
  seed: number,
  options: { noInputFromQuarter?: boolean; lowFan?: boolean } = {},
): SuctionTrial {
  const simulation = new Simulation(seed);
  const ceiling = simulation.course.ceilingsInRange(0, distanceAtTime(90))[0];
  if (!ceiling) throw new Error(`seed ${seed} has no suction section`);
  const segments = simulation.course.segmentsInRange(0, ceiling.x0);
  const quarter = segments.filter((segment) => segment.kind === 'quarter').at(-1);
  if (!quarter) throw new Error(`seed ${seed} suction section has no quarter-pipe`);

  let engaged = false;
  let releaseReason: SuctionTrial['releaseReason'] = null;
  let fanMinimum = FAN_MAX;
  let fanSet = false;
  const maxTicks = Math.ceil(100 / FIXED_DT);
  for (let tick = 0; tick < maxTicks && !simulation.state.crashed; tick += 1) {
    const state = simulation.state;
    let held = lookaheadJump(simulation);
    if (state.x >= quarter.x0 && !state.grounded && state.x < ceiling.x1 + state.speed) {
      if (options.lowFan && !fanSet) {
        state.fan = 5;
        fanSet = true;
      }
      held = !options.noInputFromQuarter && !state.inverted && (engaged || state.x >= quarter.x0);
    }
    if (state.inverted) {
      engaged = true;
      held = false;
    } else if (releaseReason === 'end' && engaged && state.x >= ceiling.x1) {
      held = state.angle < Math.PI * 2 - 0.6;
    }
    simulation.step(held);
    fanMinimum = Math.min(fanMinimum, simulation.state.fan);
    if (simulation.events.some((event) => event.type === 'suctionEngage')) engaged = true;
    const release = simulation.events.find((event) => event.type === 'suctionRelease');
    if (release?.type === 'suctionRelease') releaseReason = release.reason;
    if (options.noInputFromQuarter && state.x > ceiling.x1 && simulation.state.grounded) break;
    if (engaged && releaseReason && simulation.state.grounded && simulation.state.x >= ceiling.x1) break;
  }
  return {
    engaged,
    releaseReason,
    alive: !simulation.state.crashed,
    grounded: simulation.state.grounded,
    flips: simulation.state.stats.totalFlips,
    fanMinimum,
  };
}

function prepareRailLanding(
  seed: number,
  options: { xBeforeZoneEnd?: number; angle?: number; vy?: number } = {},
): { simulation: Simulation; zone: RailZone } {
  const simulation = new Simulation(seed);
  const ceiling = simulation.course.ceilingsInRange(0, distanceAtTime(90))[0];
  if (!ceiling) throw new Error(`seed ${seed} has no suction section`);
  const zone = simulation.course.railZoneAt(ceiling.x0);
  if (!zone) throw new Error(`seed ${seed} has no rail zone`);
  const x = zone.x1 - (options.xBeforeZoneEnd ?? 350);
  const surface = simulation.course.surfaceAt(x);
  if (!surface) throw new Error(`seed ${seed} rail landing point has no surface`);
  const state = simulation.state;
  const elapsed = timeAtDistance(x);
  const speed = speedAtTime(elapsed);
  state.x = x;
  state.y = surface.y - 100;
  state.speed = speed;
  state.vx = speed;
  state.elapsed = elapsed;
  state.airtime = 0.5;
  state.vy = options.vy ?? 400;
  state.angle = options.angle ?? Math.PI;
  state.angularVelocity = 0;
  state.grounded = false;
  state.inverted = false;
  state.stats.distance = Math.floor(x / 10);
  state.stats.score = state.stats.distance;
  (simulation as unknown as { previousX: number }).previousX = x;
  return { simulation, zone };
}

function captureLandingContacts(
  simulation: Simulation,
): Array<{
  angle: number;
  slope: number;
  recovering: boolean;
  recoveryTarget: number;
}> {
  const internals = simulation as unknown as {
    checkLanding: () => void;
    wheelPoint: (offset: number) => { bottom: number; surface: Surface | null };
    previousWheelBottoms: [number, number];
    recovering: boolean;
    recoveryTarget: number;
    railPhase: boolean;
  };
  const captured: Array<{
    angle: number;
    slope: number;
    recovering: boolean;
    recoveryTarget: number;
  }> = [];
  const checkLanding = internals.checkLanding.bind(simulation);
  internals.checkLanding = () => {
    const { state } = simulation;
    let angle: number | null = null;
    let slope: number | null = null;
    if (state.vy >= 0) {
      const wheels = [internals.wheelPoint(WHEELBASE / 2), internals.wheelPoint(-WHEELBASE / 2)];
      const snapLimit = SNAP_TOLERANCE + Math.abs(state.vy) * FIXED_DT;
      const contacts = wheels.filter((wheel, index) => (
        wheel.surface
        && wheel.bottom >= wheel.surface.y
        && (
          internals.recovering
          || internals.railPhase
          || internals.previousWheelBottoms[index]! <= wheel.surface.y + snapLimit
        )
      ));
      if (contacts.length > 0) {
        angle = state.angle;
        slope = contacts.reduce((highest, wheel) => (
          (wheel.surface?.y ?? Infinity) < (highest.surface?.y ?? Infinity) ? wheel : highest
        )).surface!.slope;
      }
    }
    const recovering = internals.recovering;
    const recoveryTarget = internals.recoveryTarget;
    checkLanding();
    if (slope !== null && simulation.events.some((event) => event.type === 'land' || event.type === 'touchdown')) {
      const hardSnap = simulation.events.some((event) => (
        event.type === 'railRecovery' && event.hardSnap === true
      ));
      captured.push({
        angle: angle!,
        slope,
        recovering: recovering || hardSnap,
        recoveryTarget: hardSnap ? slope : recoveryTarget,
      });
    }
  };
  return captured;
}

function captureCeilingBounces(simulation: Simulation): () => boolean {
  const internals = simulation as unknown as { checkCeilingContact: () => void };
  const checkCeilingContact = internals.checkCeilingContact.bind(simulation);
  let bounced = false;
  internals.checkCeilingContact = () => {
    const { state } = simulation;
    const previousY = state.y;
    const previousVy = state.vy;
    const wasInverted = state.inverted;
    checkCeilingContact();
    bounced = !wasInverted
      && !state.inverted
      && state.y !== previousY
      && Math.abs(state.vy - Math.abs(previousVy) * 0.3) < 1e-9;
  };
  return () => {
    const result = bounced;
    bounced = false;
    return result;
  };
}

function runAcrossFirstPlainGap(seed: number, jumpGap: boolean): { simulation: Simulation; gap: Hazard } {
  const simulation = new Simulation(seed);
  const segments = simulation.course.segmentsInRange(0, DISTANCE_150_SECONDS);
  const gapSegment = segments.find((segment, index) => (
    segment.kind === 'gap' && segments[index - 1]?.kind !== 'launch'
  ));
  if (!gapSegment) throw new Error(`seed ${seed} has no plain gap`);
  const gap = simulation.course.hazardsAhead(0, DISTANCE_150_SECONDS).find((hazard) => (
    hazard.kind === 'gap' && hazard.x === gapSegment.x0
  ));
  if (!gap) throw new Error(`seed ${seed} plain gap has no hazard`);
  const jumpX = gap.x - gap.safeJumpReach * 0.08;

  for (let tick = 0; tick < 60 * 120 && !simulation.state.crashed; tick += 1) {
    const state = simulation.state;
    if (state.x >= gap.x + gap.width + CAR_LENGTH / 2) break;
    let held = false;
    if (state.x < gap.x - state.speed * 0.5) {
      held = lookaheadJump(simulation);
    } else if (
      jumpGap
      && state.grounded
      && state.x < jumpX
      && state.x + state.speed * FIXED_DT >= jumpX
    ) {
      held = true;
    }
    simulation.step(held);
  }
  return { simulation, gap };
}

interface LaunchAttemptResult {
  attempted: boolean;
  successful: boolean;
  crashReason: Simulation['state']['crashReason'];
}

function runLaunchFlip(seed: number, targetFlips: 1 | 2, seconds = 45): LaunchAttemptResult {
  const simulation = new Simulation(seed);
  let mode: 'idle' | 'release' | 'rotate' = 'idle';
  let rotationStart = 0;
  let attempts = 0;
  const maxTicks = Math.ceil(seconds / FIXED_DT);
  for (let tick = 0; tick < maxTicks && !simulation.state.crashed; tick += 1) {
    const { state } = simulation;
    const surface = simulation.course.surfaceAt(state.x);
    let held = mode === 'rotate'
      ? state.angle - rotationStart < targetFlips * Math.PI * 2 - 1.15
      : false;
    if (mode === 'idle' && targetFlips === 2 && state.grounded && surface?.segment.kind === 'launch') {
      const ramp = surface.segment;
      held = state.x >= ramp.x1 - (ramp.x1 - ramp.x0) * LAUNCH_WINDOW;
    } else if (mode === 'idle' && state.grounded && !(
      targetFlips === 1 && surface?.segment.kind === 'launch'
    )) {
      held = lookaheadJump(simulation);
    }

    simulation.step(held);
    const events = simulation.events;
    if (mode === 'idle' && events.some((event) => event.type === 'superLaunch')) {
      attempts += 1;
      rotationStart = simulation.state.angle;
      mode = 'release';
    } else if (mode === 'idle' && surface?.segment.kind === 'launch' && events.some((event) => event.type === 'takeoff')) {
      attempts += 1;
      rotationStart = simulation.state.angle;
      mode = 'rotate';
    } else if (mode === 'release') {
      mode = 'rotate';
    }

    const landing = events.find((event) => event.type === 'land');
    if (attempts > 0 && landing?.type === 'land') {
      return {
        attempted: true,
        successful: landing.flips >= targetFlips && !simulation.state.crashed,
        crashReason: simulation.state.crashReason,
      };
    }
  }
  return {
    attempted: attempts > 0,
    successful: false,
    crashReason: simulation.state.crashReason,
  };
}

function plainJumpFlipCompleted(seed: number): boolean {
  const simulation = new Simulation(seed);
  simulation.step(true);
  for (let tick = 0; tick < 12; tick += 1) simulation.step(false);
  for (let tick = 0; tick < 160 && !simulation.state.crashed && !simulation.state.grounded; tick += 1) {
    simulation.step(true);
    if (simulation.events.some((event) => event.type === 'flipComplete')) return true;
  }
  return false;
}

describe('contiguous deterministic course generator', () => {
  it('uses the specified 430-to-980 ease-out ramp over 90 seconds', () => {
    expect([START_SPEED, MAX_SPEED, SPEED_RAMP_SECONDS]).toEqual([430, 980, 90]);
    expect(speedAtTime(0)).toBe(430);
    expect(speedAtTime(90)).toBe(980);
    expect(distanceAtTime(90)).toBeGreaterThan(START_SPEED * 90);
  });

  it('preserves contiguous coverage, spacing, jump limits, and launch landing zones across 500 seeds', () => {
    for (let seed = 0; seed < 500; seed += 1) checkFairness(seed);
  }, 120_000);

  it('does not depend on query order when lazily extending a seeded course', () => {
    const ranges = [[0, 2_000], [7_500, 16_000], [1_500, 8_500], [34_000, 46_000]] as const;
    const inOrder = createCourse(0x5eed);
    const inOrderSegments = ranges.map(([start, end]) => inOrder.segmentsInRange(start, end));
    const inOrderHazards = ranges.map(([start, end]) => inOrder.hazardsAhead(start, end - start));
    const inOrderCeilings = ranges.map(([start, end]) => inOrder.ceilingsInRange(start, end));
    const reverseOrder = createCourse(0x5eed);
    const reverseResults = new Map<number, {
      segments: ReturnType<Course['segmentsInRange']>;
      hazards: Hazard[];
      ceilings: ReturnType<Course['ceilingsInRange']>;
    }>();
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [start, end] = ranges[index];
      reverseResults.set(index, {
        segments: reverseOrder.segmentsInRange(start, end),
        hazards: reverseOrder.hazardsAhead(start, end - start),
        ceilings: reverseOrder.ceilingsInRange(start, end),
      });
    }
    ranges.forEach((_, index) => {
      expect(reverseResults.get(index)?.segments).toEqual(inOrderSegments[index]);
      expect(reverseResults.get(index)?.hazards).toEqual(inOrderHazards[index]);
      expect(reverseResults.get(index)?.ceilings).toEqual(inOrderCeilings[index]);
    });
    expect(inOrder.surfaceAt(0)?.y).toBe(BASE_Y);
  });

  it('keeps feature and hazard density in the intended bands after the runway', () => {
    let earlyLegacyTotal = 0;
    let earlyAfterRunwayTotal = 0;
    let midTotal = 0;
    let lateTotal = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const course = createCourse(seed);
      earlyLegacyTotal += eventsPerTenSeconds(course, 0, 3).reduce((sum, value) => sum + value, 0);
      earlyAfterRunwayTotal += eventsPerTenSeconds(course, 4, 2).reduce((sum, value) => sum + value, 0);
      midTotal += eventsPerTenSeconds(course, 30, 6).reduce((sum, value) => sum + value, 0);
      lateTotal += eventsPerTenSeconds(course, 90, 6).reduce((sum, value) => sum + value, 0);
    }
    const earlyLegacy = earlyLegacyTotal / (40 * 3);
    const earlyAfterRunway = earlyAfterRunwayTotal / (40 * 2);
    const mid = midTotal / (40 * 6);
    const late = lateTotal / (40 * 6);
    console.info(
      `course features + hazards per 10s: early 0–30s ${earlyLegacy.toFixed(2)}, `
      + `after runway 4–24s ${earlyAfterRunway.toFixed(2)}, mid ${mid.toFixed(2)}, late ${late.toFixed(2)}`,
    );
    expect(earlyAfterRunway).toBeGreaterThanOrEqual(3.5);
    expect(earlyAfterRunway).toBeLessThanOrEqual(12);
    expect(mid).toBeGreaterThanOrEqual(4);
    expect(mid).toBeLessThanOrEqual(16);
    expect(late).toBeGreaterThanOrEqual(5);
    expect(late).toBeLessThanOrEqual(22);
  });

  it('generates every briefed pattern family across seeded courses', () => {
    const found = new Set<string>();
    for (let seed = 0; seed < 100; seed += 1) {
      const course = createCourse(seed);
      const segments = course.segmentsInRange(0, DISTANCE_150_SECONDS);
      const hazards = course.hazardsAhead(0, DISTANCE_150_SECONDS);
      if (segments.some((segment) => segment.kind === 'flat')) found.add('flat');
      if (segments.some((segment) => segment.kind === 'slope')) found.add('hill');
      if (segments.some((segment) => segment.kind === 'kicker')) found.add('kicker');
      if (hazards.some((hazard) => hazard.kind !== 'gap')) found.add('single obstacle');
      if (hazards.some((hazard) => hazard.kind === 'beam')) found.add('beam');
      if (hazards.some((hazard) => hazard.kind === 'piston')) found.add('piston');
      if (hazards.some((hazard) => hazard.kind === 'gap')) found.add('gap');
      if (segments.some((segment) => segment.kind === 'launch')) found.add('launch');
      if (segments.some((segment, index) => segment.kind === 'launch' && segments[index + 1]?.kind === 'gap')) {
        found.add('launch over gap');
      }
      if (segments.some((segment) => segment.kind === 'platform')) found.add('platform');
      if (segments.some((segment) => segment.kind === 'quarter')) found.add('quarter');
      for (let index = 0; index < hazards.length - 1; index += 1) {
        const current = hazards[index];
        const next = hazards[index + 1];
        const adjacent = next.x - current.x - current.width <= current.minSpacing * 1.15 + 1;
        if (adjacent && current.kind !== 'gap' && next.kind !== 'gap') found.add('double');
        if (adjacent && current.kind !== 'gap' && next.kind === 'gap') found.add('obstacle-gap');
        if (adjacent && current.kind === 'gap' && next.kind !== 'gap') found.add('gap-obstacle');
        if (adjacent && current.kind === 'barrier' && next.kind === 'beam') found.add('barrier-beam');
        if (adjacent && current.kind === 'gap' && next.kind === 'gap') {
          const between = segments.filter((segment) => segment.x0 >= current.x + current.width && segment.x1 <= next.x);
          if (between.some((segment) => segment.kind === 'platform')) found.add('narrow landing');
        }
      }
    }
    expect([...found].sort()).toEqual([
      'barrier-beam', 'beam', 'double', 'flat', 'gap', 'gap-obstacle', 'hill', 'kicker',
      'launch', 'launch over gap', 'narrow landing', 'obstacle-gap', 'piston', 'platform',
      'quarter', 'single obstacle',
    ]);
  }, 120_000);
});

describe('procedural gameplay fairness', () => {
  it('ignores ground presses on quarter ramps', () => {
    const simulation = new Simulation(0);
    const quarter = simulation.course.segmentsInRange(0, distanceAtTime(90))
      .filter((segment) => segment.kind === 'quarter')
      .at(-1);
    expect(quarter).toBeDefined();
    const x = quarter!.x0 + (quarter!.x1 - quarter!.x0) * 0.5;
    const speed = speedAtTime(timeAtDistance(x));
    expect(x + speed * FIXED_DT).toBeLessThan(quarter!.x1);
    const surface = simulation.course.surfaceAt(x);
    expect(surface?.segment.kind).toBe('quarter');

    const state = simulation.state;
    state.x = x;
    state.y = surface!.y - WHEEL_VERTICAL_OFFSET - WHEEL_RADIUS;
    state.speed = speed;
    state.vx = speed;
    state.elapsed = timeAtDistance(x);
    state.grounded = true;
    state.vy = 0;
    state.angle = surface!.slope;
    (simulation as unknown as { previousX: number }).previousX = x;

    simulation.step(true);

    expect(simulation.state.grounded).toBe(true);
    expect(simulation.events.some((event) => event.type === 'jump')).toBe(false);
    expect(simulation.events.some((event) => event.type === 'superLaunch')).toBe(false);

    let automaticTakeoff = false;
    for (let tick = 0; tick < 180 && simulation.state.grounded; tick += 1) {
      simulation.step(true);
      automaticTakeoff ||= simulation.events.some((event) => event.type === 'takeoff');
    }
    expect(automaticTakeoff).toBe(true);
    expect((simulation as unknown as { airbornePressEligible: boolean }).airbornePressEligible).toBe(false);
  });

  it('keeps a 50ms lookahead search bot alive for 150 seconds on 200 seeds', () => {
    const survivals = Array.from({ length: 200 }, (_, seed) => runSearchBot(seed, 150).state.elapsed)
      .sort((a, b) => a - b);
    const minSurvival = survivals[0]!;
    const p10Survival = survivals[Math.floor(survivals.length * 0.1)]!;
    const medianSurvival = survivals[Math.floor(survivals.length / 2)]!;
    console.info(
      `150s search bot survival: min ${minSurvival.toFixed(2)}s, `
      + `p10 ${p10Survival.toFixed(2)}s, median ${medianSurvival.toFixed(2)}s`,
    );
    expect(minSurvival).toBeGreaterThanOrEqual(150);
  }, 120_000);

  it('keeps pistons deterministic and within their configured travel', () => {
    const hazard = Array.from({ length: 100 }, (_, seed) => (
      createCourse(seed).hazardsAhead(0, distanceAtTime(90)).find((item) => item.kind === 'piston')
    )).find((item): item is Hazard => item !== undefined);
    expect(hazard).toBeDefined();
    expect(hazard?.motion).toBeDefined();
    expect(hazard!.motion!.phase).toBeGreaterThanOrEqual(0);
    expect(hazard!.motion!.phase).toBeLessThan(1);
    for (let tick = 0; tick <= 240; tick += 1) {
      const elapsed = tick / 60;
      const height = pistonHeight(hazard!, elapsed);
      expect(height).toBeGreaterThanOrEqual(0);
      expect(height).toBeLessThanOrEqual(hazard!.height);
      expect(pistonHeight(hazard!, elapsed)).toBe(height);
    }
    expect(pistonHeight(hazard!, hazard!.motion!.period)).toBeCloseTo(
      pistonHeight(hazard!, 0),
      10,
    );
  });

  it('passes under a beam without input and crashes a just-before jump', () => {
    const candidate = Array.from({ length: 100 }, (_, seed) => {
      const course = createCourse(seed);
      const beam = course.hazardsAhead(0, distanceAtTime(45)).find((item) => item.kind === 'beam');
      return beam ? { seed, beam } : undefined;
    }).find((item) => item !== undefined)!;

    const trial = (jump: boolean): Simulation => {
      const simulation = new Simulation(candidate.seed);
      const target = candidate.beam.x - candidate.beam.safeJumpReach * 0.08;
      const startX = jump ? target - 0.1 : candidate.beam.x - CAR_LENGTH;
      const surface = simulation.course.surfaceAt(startX)!;
      const speed = speedAtTime(timeAtDistance(startX));
      simulation.state.x = startX;
      simulation.state.y = surface.y - 20;
      simulation.state.speed = speed;
      simulation.state.vx = speed;
      simulation.state.elapsed = timeAtDistance(startX);
      (simulation as unknown as { previousX: number }).previousX = startX;
      for (let tick = 0; tick < 100 && !simulation.state.crashed; tick += 1) {
        const press = jump && simulation.state.grounded
          && simulation.state.x < target
          && simulation.state.x + simulation.state.speed * FIXED_DT >= target;
        simulation.step(press);
        if (!jump && simulation.state.x > candidate.beam.x + candidate.beam.width + CAR_LENGTH) break;
      }
      return simulation;
    };

    const pass = trial(false);
    expect(pass.state.crashed).toBe(false);
    expect(pass.state.x).toBeGreaterThan(candidate.beam.x + candidate.beam.width);
    const jump = trial(true);
    expect(jump.state.crashed).toBe(true);
    expect(jump.state.crashReason).toBe('obstacle');
  });

  it('builds reachable suction rails over a safe flat route', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const course = createCourse(seed);
      const ceiling = course.ceilingsInRange(0, distanceAtTime(90))[0];
      expect(ceiling).toBeDefined();
      const zone = course.railZoneAt(ceiling!.x0);
      expect(zone).toBeDefined();
      expect(zone?.ceiling).toEqual(ceiling);
      const speed = speedAtTime(timeAtDistance(ceiling!.x0));
      expect((ceiling!.x1 - ceiling!.x0) / speed).toBeLessThanOrEqual(1.5);
      const floor = course.segmentsInRange(ceiling!.x0, ceiling!.x1)
        .find((segment) => segment.x0 <= ceiling!.x0 && segment.x1 >= ceiling!.x1);
      expect(floor?.kind).toBe('flat');
      const quarter = course.segmentsInRange(0, ceiling!.x0)
        .find((segment) => segment.kind === 'quarter' && segment.x0 >= zone!.x0);
      expect(quarter).toBeDefined();
      expect(zone?.x0).toBe(quarter?.x0);
      const zoneSegments = course.segmentsInRange(zone!.x0, zone!.x1);
      const runout = zoneSegments.find((segment) => segment.x1 === zone!.x1);
      expect(runout?.kind).toBe('flat');
      const exitSlope = zoneSegments.find((segment) => segment.kind === 'slope' && segment.x1 === runout?.x0);
      expect(exitSlope?.kind).toBe('slope');
      expect(exitSlope?.x1).toBe(runout?.x0);
      expect(runout && exitSlope && (runout.x1 - runout.x0) / (exitSlope.x1 - exitSlope.x0))
        .toBeCloseTo(0.9 / 0.25, 6);
      expect(zoneSegments.some((segment) => segment.kind === 'gap')).toBe(false);
      expect(course.hazardsAhead(zone!.x0, zone!.x1 - zone!.x0)
        .filter((hazard) => hazard.x < zone!.x1 && hazard.x + hazard.width > zone!.x0)).toEqual([]);
      expect(course.railZoneAt(zone!.x1 + 1)).toBeNull();
    }
  });

  it('keeps 2,000 deterministic input policies alive and aligned through rail zones', () => {
    let runs = 0;
    let runsWithRecovery = 0;
    let recoveryTriggers = 0;
    let hardSnaps = 0;
    let landingContacts = 0;
    let minimumMargin = Infinity;
    let recoveryTouchdowns = 0;
    let maximumPreSnapRecoveryError = 0;
    type AirborneStart = 'ground-jump' | 'quarter-lip' | 'ceiling-bounce' | 'rail-release' | 'other';
    const hardSnapBreakdown: Record<AirborneStart, number> = {
      'ground-jump': 0,
      'quarter-lip': 0,
      'ceiling-bounce': 0,
      'rail-release': 0,
      other: 0,
    };
    const hardSnapCases: Array<{
      seed: number;
      policy: number;
      x: number;
      angle: number;
      target: number;
      contactSlope: number;
      error: number;
      airborneStart: AirborneStart;
    }> = [];

    for (let seed = 0; seed < 100; seed += 1) {
      const template = new Simulation(seed);
      const ceiling = template.course.ceilingsInRange(0, distanceAtTime(90))[0];
      expect(ceiling, `seed ${seed} has a suction section`).toBeDefined();
      const zone = template.course.railZoneAt(ceiling!.x0);
      expect(zone, `seed ${seed} has a rail zone`).toBeDefined();
      const startSpeed = speedAtTime(timeAtDistance(zone!.x0));
      const estimatedStartX = zone!.x0 - startSpeed * 2;
      const approachHazards = template.course.hazardsAhead(estimatedStartX, zone!.x0 - estimatedStartX);
      const candidateStartX = approachHazards.reduce((start, hazard) => {
        if (hazard.kind === 'beam') return start;
        const lead = hazard.kind === 'gap' ? hazard.safeJumpReach * 0.08 : hazard.safeJumpReach * 0.35;
        return Math.min(start, hazard.x - lead - startSpeed * 0.12);
      }, estimatedStartX);
      const approachSegments = template.course.segmentsInRange(0, zone!.x0);
      const safeStartSegment = approachSegments.find((segment) => (
        segment.kind !== 'gap' && candidateStartX >= segment.x0 && candidateStartX < segment.x1
      ));
      const previousGroundSegment = approachSegments
        .filter((segment) => segment.kind !== 'gap' && segment.x1 <= candidateStartX)
        .at(-1);
      const startX = safeStartSegment
        ? candidateStartX
        : previousGroundSegment
          ? Math.max(previousGroundSegment.x0, previousGroundSegment.x1 - startSpeed * 0.12)
          : approachSegments.find((segment) => segment.kind !== 'gap')?.x0 ?? candidateStartX;
      const startSurface = template.course.surfaceAt(startX);
      expect(startSurface, `seed ${seed} has a safe rail approach`).not.toBeNull();

      for (let policy = 0; policy < 20; policy += 1) {
        const simulation = template.clone();
        runs += 1;
        const state = simulation.state;
        const startTime = timeAtDistance(startX);
        const speed = speedAtTime(startTime);
        state.x = startX;
        state.y = startSurface!.y - 20;
        state.speed = speed;
        state.vx = speed;
        state.elapsed = startTime;
        state.grounded = true;
        state.inverted = false;
        state.recovering = false;
        state.vy = 0;
        state.angle = 0;
        state.stats.distance = Math.floor(startX / 10);
        state.stats.score = state.stats.distance;
        (simulation as unknown as { previousX: number }).previousX = startX;
        const contactSnapshots = captureLandingContacts(simulation);
        const didCeilingBounce = captureCeilingBounces(simulation);

        const rng = new SeededRng(0x5eed + seed * 101 + policy * 7919);
        let held = false;
        let policyStarted = false;
        let ticksUntilToggle = Number.POSITIVE_INFINITY;
        let runTriggeredRecovery = false;
        let holdAfterTakeoff = false;
        let holdAfterRailRelease = false;
        let touchdownSeen = false;
        let airborneStart: AirborneStart = 'other';
        let recoveryStart: { x: number; angle: number; vy: number; target: number } | null = null;
        const deadline = timeAtDistance(zone!.x1) + 6;
        const maxTicks = Math.ceil((deadline - startTime) / FIXED_DT);
        for (
          let tick = 0;
          tick < maxTicks
            && !state.crashed
            && !(state.grounded && state.x > zone!.x1);
          tick += 1
        ) {
          const inPolicyWindow = state.x >= zone!.x0;
          const wasGrounded = state.grounded;
          if (policy === 0) {
            held = holdAfterTakeoff && !state.grounded;
          } else if (policy === 1) {
            held = false;
          } else if (policy === 2) {
            if (holdAfterRailRelease) {
              held = !state.grounded;
            } else if (inPolicyWindow) {
              held = !state.grounded && !state.inverted
                && (state.x < ceiling!.x0 || (state.angle < Math.PI * 2 - 0.6 && state.angle > 0.3));
            } else {
              held = false;
            }
          } else if (inPolicyWindow) {
            if (!policyStarted) {
              policyStarted = true;
              held = rng.next() >= 0.5;
              ticksUntilToggle = rng.int(6, 48);
            } else if (ticksUntilToggle === 0) {
              held = !held;
              ticksUntilToggle = rng.int(6, 48);
            }
          }
          const xBeforeStep = state.x;
          const previousSurface = simulation.course.surfaceAt(xBeforeStep);
          const controlledAfterTakeoff = policy === 0 && holdAfterTakeoff && !state.grounded;
          const botControl = policy === 2 && inPolicyWindow;
          const hasPolicyControl = inPolicyWindow || controlledAfterTakeoff || botControl;
          simulation.step(hasPolicyControl
            ? state.grounded && touchdownSeen ? false : held
            : lookaheadJump(simulation));
          if (wasGrounded && !state.grounded) holdAfterTakeoff = true;
          if (wasGrounded && !state.grounded) {
            if (simulation.events.some((event) => event.type === 'jump' || event.type === 'superLaunch')) {
              airborneStart = 'ground-jump';
            } else if (
              simulation.events.some((event) => event.type === 'takeoff')
              && previousSurface?.segment.kind === 'quarter'
            ) {
              airborneStart = 'quarter-lip';
            } else {
              airborneStart = 'other';
            }
          }
          if (policy >= 3 && inPolicyWindow && policyStarted) ticksUntilToggle -= 1;
          if (policy === 2 && simulation.events.some((event) => event.type === 'suctionRelease')) {
            holdAfterRailRelease = true;
          }
          if (simulation.events.some((event) => event.type === 'suctionRelease')) {
            airborneStart = 'rail-release';
          }
          if (didCeilingBounce()) airborneStart = 'ceiling-bounce';
          const recoveryEvent = simulation.events.find((event) => event.type === 'railRecovery');
          if (recoveryEvent?.type === 'railRecovery') {
            if (!recoveryEvent.hardSnap) {
              recoveryTriggers += 1;
            }
            runTriggeredRecovery = true;
            const internals = simulation as unknown as { recoveryTarget: number };
            recoveryStart = {
              x: state.x,
              angle: state.angle,
              vy: state.vy,
              target: internals.recoveryTarget,
            };
          }
          if (simulation.events.some((event) => event.type === 'land' || event.type === 'touchdown')) {
            touchdownSeen = true;
          }
          const simulationInternals = simulation as unknown as {
            recovering: boolean;
            recoveryTarget: number;
            railPhase: boolean;
          };
          expect(state.crashed && state.x >= zone!.x0,
            `seed ${seed}, policy ${policy} crashes before post-zone grounding at ${state.x.toFixed(1)} `
            + `(${state.crashReason}) ${JSON.stringify({
              y: state.y,
              angle: state.angle,
              vy: state.vy,
              recovering: simulationInternals.recovering,
              recoveryTarget: simulationInternals.recoveryTarget,
              railPhase: simulationInternals.railPhase,
              runTriggeredRecovery,
              recoveryStart,
            })}`).toBe(false);
          if (simulation.events.some((event) => event.type === 'land' || event.type === 'touchdown')) {
            const contactX = state.x;
            const contact = contactSnapshots.at(-1);
            const hardSnapEvent = simulation.events.some(
              (event) => event.type === 'railRecovery' && event.hardSnap === true,
            );
            if (contactX >= zone!.x0 && contactX <= zone!.x1) {
              expect(contact, `landing at ${contactX.toFixed(1)} has a contact snapshot`).toBeDefined();
              const angleOff = Math.abs(normalizeAngle(contact!.angle - contact!.slope));
              if (!contact!.recovering && !hardSnapEvent) {
                const margin = LANDING_LIMIT - angleOff;
                landingContacts += 1;
                minimumMargin = Math.min(minimumMargin, margin);
                expect(
                  angleOff,
                  `seed ${seed}, policy ${policy} contact at ${xBeforeStep.toFixed(1)}→${contactX.toFixed(1)}: `
                  + `angle=${contact!.angle}, slope=${contact!.slope}, recovering=${contact!.recovering}, `
                  + `target=${contact!.recoveryTarget}, recoveryStart=${JSON.stringify(recoveryStart)}`,
                ).toBeLessThanOrEqual(LANDING_LIMIT + 1e-9);
              }
            }
            if (
              simulation.events.some((event) => event.type === 'touchdown')
              && (contact?.recovering || hardSnapEvent)
            ) {
              const angleOff = Math.abs(normalizeAngle(contact!.angle - contact!.slope));
              recoveryTouchdowns += 1;
              maximumPreSnapRecoveryError = Math.max(maximumPreSnapRecoveryError, angleOff);
              if (angleOff > LANDING_LIMIT) {
                hardSnaps += 1;
                hardSnapCases.push({
                  seed,
                  policy,
                  x: contactX,
                  angle: contact!.angle,
                  target: contact!.recoveryTarget,
                  contactSlope: contact!.slope,
                  error: angleOff,
                  airborneStart,
                });
                hardSnapBreakdown[airborneStart] += 1;
              }
            }
            if (state.grounded) airborneStart = 'other';
          }
        }
        if (runTriggeredRecovery) runsWithRecovery += 1;
        expect(state.crashed, `seed ${seed}, policy ${policy} survives rail landing`).toBe(false);
        expect(state.grounded && state.x > zone!.x1,
          `seed ${seed}, policy ${policy} grounds after rail zone before the six-second cap`).toBe(true);
      }
    }

    console.info(
      `rail-recovery fuzz: ${runs} runs, ${runsWithRecovery} triggered recovery `
      + `(${recoveryTriggers} predictor triggers), `
      + `${hardSnaps} hard snaps, `
      + `hard snaps by phase ${JSON.stringify(hardSnapBreakdown)}, `
      + `${landingContacts} rail contacts, minimum angle margin ${(minimumMargin * 180 / Math.PI).toFixed(3)}°, `
      + `${recoveryTouchdowns} recovery touchdowns, max pre-snap error `
      + `${(maximumPreSnapRecoveryError * 180 / Math.PI).toFixed(3)}°`,
    );
    expect(runs).toBe(2_000);
    expect(landingContacts).toBeGreaterThan(0);
    const topHardSnaps = hardSnapCases
      .sort((a, b) => b.error - a.error)
      .slice(0, 5);
    expect(
      hardSnaps,
      `hard snaps exceeded 5% of recovery touchdowns; breakdown=${JSON.stringify(hardSnapBreakdown)}; `
      + `top cases: ${JSON.stringify(topHardSnaps)}`,
    ).toBeLessThanOrEqual(recoveryTouchdowns * 0.05);
  }, 120_000);

  it('auto-recovers a held, misaligned rail miss with an unrewarded touchdown and cloned state', () => {
    const { simulation, zone } = prepareRailLanding(5, { angle: Math.PI });
    simulation.step(true);
    expect(simulation.events.some((event) => event.type === 'railRecovery')).toBe(true);
    expect(simulation.events.some((event) => event.type === 'thrusterBurst')).toBe(false);
    expect(simulation.state.recovering).toBe(true);
    expect((simulation as unknown as { railPhase: boolean }).railPhase).toBe(true);

    const clone = simulation.clone();
    expect(clone.state.recovering).toBe(true);
    expect((clone as unknown as { railPhase: boolean }).railPhase).toBe(true);
    const initialScore = simulation.state.stats.score;
    const initialDistance = simulation.state.stats.distance;
    const initialCombo = simulation.state.combo;
    let touchdown = false;
    for (let tick = 0; tick < 240 && !simulation.state.grounded && !simulation.state.crashed; tick += 1) {
      simulation.step(true);
      clone.step(true);
      expect(clone.state).toEqual(simulation.state);
      expect(clone.events).toEqual(simulation.events);
      if (simulation.events.some((event) => event.type === 'touchdown')) touchdown = true;
      expect(simulation.events.some((event) => event.type === 'land')).toBe(false);
      expect(
        !simulation.state.crashed
        || simulation.state.x < zone.x0
        || simulation.state.x > zone.x1,
      ).toBe(true);
    }
    expect(touchdown).toBe(true);
    expect(simulation.state.grounded).toBe(true);
    expect(simulation.state.crashed).toBe(false);
    expect(simulation.state.recovering).toBe(false);
    expect((simulation as unknown as { railPhase: boolean }).railPhase).toBe(false);
    expect(simulation.state.combo).toBe(initialCombo);
    expect(simulation.state.stats.score - initialScore)
      .toBe(simulation.state.stats.distance - initialDistance);
  });

  it('recovers after a misaligned bounce from the rail ceiling', () => {
    const simulation = new Simulation(5);
    const ceiling = simulation.course.ceilingsInRange(0, distanceAtTime(90))[0]!;
    const zone = simulation.course.railZoneAt(ceiling.x0)!;
    const x = (ceiling.x0 + ceiling.x1) / 2;
    const speed = speedAtTime(timeAtDistance(x));
    const angle = 0.8;
    const state = simulation.state;
    state.x = x;
    state.y = ceiling.y + CAR_LENGTH * 0.32 * Math.sin(angle) + CAR_HEIGHT * 0.3 + 1;
    state.speed = speed;
    state.vx = speed;
    state.elapsed = timeAtDistance(x);
    state.grounded = false;
    state.inverted = false;
    state.airtime = 0.5;
    state.vy = -240;
    state.angle = angle;
    state.stats.distance = Math.floor(x / 10);
    state.stats.score = state.stats.distance;
    (simulation as unknown as { previousX: number }).previousX = x;

    simulation.step(false);
    expect(simulation.state.vy).toBeGreaterThan(0);
    let recovered = simulation.events.some((event) => event.type === 'railRecovery');
    let touchdown = simulation.events.some((event) => event.type === 'touchdown');
    for (let tick = 0; tick < 240 && !touchdown && !simulation.state.crashed; tick += 1) {
      simulation.step(false);
      recovered ||= simulation.events.some((event) => event.type === 'railRecovery');
      touchdown ||= simulation.events.some((event) => event.type === 'touchdown');
      expect(
        !simulation.state.crashed || simulation.state.x < zone.x0 || simulation.state.x > zone.x1,
      ).toBe(true);
    }
    expect(recovered).toBe(true);
    expect(touchdown).toBe(true);
    expect(simulation.state.crashed).toBe(false);
  });

  it('preserves a self-righted rail landing and its normal reward', () => {
    const { simulation } = prepareRailLanding(5, { angle: 0, xBeforeZoneEnd: 350 });
    const initialScore = simulation.state.stats.score;
    let landing: Extract<Simulation['events'][number], { type: 'land' }> | undefined;
    let recovered = false;
    for (let tick = 0; tick < 120 && !simulation.state.grounded && !simulation.state.crashed; tick += 1) {
      simulation.step(false);
      recovered ||= simulation.events.some((event) => event.type === 'railRecovery');
      landing = simulation.events.find((event): event is Extract<Simulation['events'][number], { type: 'land' }> => event.type === 'land') ?? landing;
    }
    expect(recovered).toBe(false);
    expect(landing).toBeDefined();
    expect(simulation.state.crashed).toBe(false);
    expect(simulation.state.stats.score).toBeGreaterThan(initialScore);
  });

  it('rewards a 34-degree rail landing with a flip instead of recovering', () => {
    const { simulation } = prepareRailLanding(5, {
      angle: 34 * Math.PI / 180,
      xBeforeZoneEnd: 350,
    });
    simulation.state.flips = 1;
    (simulation as unknown as { railPhase: boolean }).railPhase = true;

    let landing: Extract<Simulation['events'][number], { type: 'land' }> | undefined;
    let recovered = false;
    for (let tick = 0; tick < 120 && !simulation.state.grounded && !simulation.state.crashed; tick += 1) {
      simulation.step(false);
      recovered ||= simulation.events.some((event) => event.type === 'railRecovery');
      landing = simulation.events.find((event): event is Extract<Simulation['events'][number], { type: 'land' }> => event.type === 'land') ?? landing;
    }

    expect(recovered).toBe(false);
    expect(landing?.flips).toBe(1);
    expect(simulation.state.crashed).toBe(false);
  });

  it('lets a scripted half-flip bot clear at least 85 of 100 suction sections', () => {
    const results = Array.from({ length: 100 }, (_, seed) => runSuctionTrial(seed));
    const successes = results.filter((result) => (
      result.engaged && result.releaseReason === 'end' && result.alive && result.grounded && result.flips >= 1
    )).length;
    console.info(`suction-section bot success: ${successes}/100`);
    expect(successes).toBeGreaterThanOrEqual(85);
  }, 120_000);

  it('survives a no-input rail miss and releases suction when the fan empties', () => {
    const miss = runSuctionTrial(5, { noInputFromQuarter: true });
    expect(miss.alive).toBe(true);
    expect(miss.grounded).toBe(true);

    const empty = runSuctionTrial(5, { lowFan: true });
    expect(empty.engaged).toBe(true);
    expect(empty.releaseReason).toBe('empty');
    expect(empty.fanMinimum).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('falls into a plain gap without input and clears it with a lead-distance jump', () => {
    const noJump = runAcrossFirstPlainGap(0, false);
    expect(noJump.simulation.state.crashed).toBe(true);
    expect(noJump.simulation.state.crashReason).toBe('fell');
    expect(noJump.simulation.state.x).toBeGreaterThan(noJump.gap.x);

    const jumped = runAcrossFirstPlainGap(0, true);
    expect(jumped.simulation.state.crashed).toBe(false);
    expect(jumped.simulation.state.x).toBeGreaterThanOrEqual(jumped.gap.x + jumped.gap.width + CAR_LENGTH / 2);
  }, 30_000);

  it('keeps the opening safe and spaces onboarding hazards across 200 seeds', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const course = createCourse(seed);
      const runwaySegments = course.segmentsInRange(0, OPENING_RUNWAY_DISTANCE)
        .filter((segment) => segment.x0 < OPENING_RUNWAY_DISTANCE);
      const runwayHazards = course.hazardsAhead(0, OPENING_RUNWAY_DISTANCE)
        .filter((hazard) => hazard.x < OPENING_RUNWAY_DISTANCE);
      expect(runwaySegments.every((segment) => ['flat', 'slope', 'kicker'].includes(segment.kind))).toBe(true);
      expect(runwayHazards).toEqual([]);

      const onboardingSegments = course.segmentsInRange(0, ONBOARDING_DISTANCE);
      const onboardingHazards = course.hazardsAhead(0, ONBOARDING_DISTANCE);
      expect(onboardingSegments.every((segment) => (
        ['flat', 'slope', 'kicker', 'launch', 'gap'].includes(segment.kind)
      ))).toBe(true);
      const onboardingLaunches = onboardingSegments.filter(
        (segment) => segment.kind === 'launch' && timeAtDistance(segment.x0) < ONBOARDING_END_SECONDS,
      );
      expect(onboardingSegments.some((segment) => segment.kind === 'platform')).toBe(false);
      expect(onboardingLaunches.length).toBeLessThanOrEqual(1);
      for (const launch of onboardingLaunches) {
        const landingSegment = onboardingSegments.find((segment) => segment.x0 === launch.x1);
        expect(landingSegment?.kind).not.toBe('gap');
      }

      for (let index = 1; index < onboardingHazards.length; index += 1) {
        const previous = onboardingHazards[index - 1];
        const current = onboardingHazards[index];
        if (timeAtDistance(current.x) < ONBOARDING_END_SECONDS) {
          expect(timeAtDistance(current.x) - timeAtDistance(previous.x)).toBeGreaterThanOrEqual(1.8);
        }
        if (current.kind === 'gap') {
          expect(current.width).toBeLessThanOrEqual(current.safeJumpReach * 0.55);
        }
        const adjacent = current.x - previous.x - previous.width <= previous.minSpacing + 1;
        expect(
          adjacent && previous.kind !== 'gap',
          `${previous.id} → ${current.id} is not an obstacle combo`,
        ).toBe(false);
      }

      const firstHazard = course.hazardsAhead(0, distanceAtTime(60))[0];
      expect(firstHazard, `seed ${seed} has a generated first hazard`).toBeDefined();
      expect(firstHazard?.x, `seed ${seed} first hazard starts after the runway`).toBeGreaterThanOrEqual(
        OPENING_RUNWAY_DISTANCE,
      );
    }
  }, 120_000);

  it('keeps no-input first crashes at or after three seconds for 300 seeds', () => {
    const crashTimes = Array.from({ length: 300 }, (_, index) => firstNoInputCrashTime(index + 1));
    const sorted = [...crashTimes].sort((left, right) => left - right);
    const minimum = sorted[0];
    const p10 = sorted[Math.ceil(sorted.length * 0.1) - 1];
    const median = (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    console.info(
      `no-input first crash times (seeds 1–300): min ${minimum.toFixed(2)}s, `
      + `p10 ${p10.toFixed(2)}s, median ${median.toFixed(2)}s`,
    );
    expect(minimum).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('lets a no-flip lookahead bot survive 150 seconds on 200 seeds', () => {
    const failures: string[] = [];
    const features = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const simulation = runNoFlipBot(seed, 150);
      if (simulation.state.crashed || simulation.state.elapsed < 150 - FIXED_DT) {
        failures.push(`seed ${seed}: ${simulation.state.crashReason} at ${simulation.state.elapsed.toFixed(2)}s/${simulation.state.x.toFixed(0)}px`);
      }
      const segments = simulation.course.segmentsInRange(0, simulation.state.x);
      if (segments.some((segment) => segment.kind === 'platform')) features.add('platform');
      if (segments.some((segment, index) => segment.kind === 'platform' && segments[index + 1]?.kind === 'gap')) {
        features.add('drop');
      }
      if (segments.some((segment, index) => segment.kind === 'launch' && segments[index + 1]?.kind === 'gap')) {
        features.add('launch over gap');
      }
    }
    expect(failures.slice(0, 8), `${failures.length} bot failures`).toEqual([]);
    expect([...features].sort()).toEqual(['drop', 'launch over gap', 'platform']);
  }, 120_000);

  it('keeps launch-ramp single flips comfortable and super-launch double flips achievable', () => {
    const singleResults = Array.from({ length: 40 }, (_, seed) => runLaunchFlip(seed, 1));
    const doubleResults = Array.from({ length: 40 }, (_, seed) => runLaunchFlip(seed, 2));
    const singleAttempts = singleResults.filter((result) => result.attempted).length;
    const singleSuccesses = singleResults.filter((result) => result.successful).length;
    const doubleAttempts = doubleResults.filter((result) => result.attempted).length;
    const doubleSuccesses = doubleResults.filter((result) => result.successful).length;
    console.info(`launch-flip bots: single ${singleSuccesses}/${singleAttempts}, double ${doubleSuccesses}/${doubleAttempts}`);
    expect(singleAttempts).toBeGreaterThanOrEqual(36);
    expect(singleSuccesses).toBeGreaterThanOrEqual(singleAttempts * 0.9);
    expect(doubleAttempts).toBeGreaterThanOrEqual(36);
    expect(doubleSuccesses).toBeGreaterThanOrEqual(doubleAttempts * 0.6);
  }, 120_000);

  it('makes a late plain-jump flip fail at least 80 percent of the time', () => {
    let failed = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      if (!plainJumpFlipCompleted(seed)) failed += 1;
    }
    console.info(`plain-jump late-start flip failures: ${failed}/40`);
    expect(failed).toBeGreaterThanOrEqual(32);
  }, 30_000);
});
