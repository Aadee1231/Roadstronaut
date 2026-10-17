import { describe, expect, it } from 'vitest';
import {
  FIXED_DT, GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY, MAX_RUN_SECONDS,
  LAUNCH_BOOST, MAX_SPEED, SPEED_RAMP_SECONDS, START_SPEED, SUPER_JUMP_VELOCITY,
  distanceAtTime, speedAtTime, timeAtDistance,
} from '../../src/sim/constants';
import { atan2, sin } from '../../src/sim/detmath';
import { BASE_Y, createCourse, type Course, type Hazard } from '../../src/sim/course';
import { Simulation } from '../../src/sim/simulation';

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
  const lead = next.kind === 'gap' ? next.safeJumpReach * 0.08 : next.safeJumpReach * 0.35;
  const targetX = next.x - lead;
  return state.x < targetX && state.x + state.speed * FIXED_DT >= targetX;
}

function runNoFlipBot(seed: number, seconds: number): Simulation {
  const simulation = new Simulation(seed);
  const ticks = Math.ceil(seconds / FIXED_DT);
  for (let tick = 0; tick < ticks && !simulation.state.crashed; tick += 1) {
    simulation.step(lookaheadJump(simulation));
  }
  return simulation;
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
    const reverseOrder = createCourse(0x5eed);
    const reverseResults = new Map<number, { segments: ReturnType<Course['segmentsInRange']>; hazards: Hazard[] }>();
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [start, end] = ranges[index];
      reverseResults.set(index, {
        segments: reverseOrder.segmentsInRange(start, end),
        hazards: reverseOrder.hazardsAhead(start, end - start),
      });
    }
    ranges.forEach((_, index) => {
      expect(reverseResults.get(index)?.segments).toEqual(inOrderSegments[index]);
      expect(reverseResults.get(index)?.hazards).toEqual(inOrderHazards[index]);
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
      if (hazards.some((hazard) => hazard.kind === 'gap')) found.add('gap');
      if (segments.some((segment) => segment.kind === 'launch')) found.add('launch');
      if (segments.some((segment, index) => segment.kind === 'launch' && segments[index + 1]?.kind === 'gap')) {
        found.add('launch over gap');
      }
      if (segments.some((segment) => segment.kind === 'platform')) found.add('platform');
      for (let index = 0; index < hazards.length - 1; index += 1) {
        const current = hazards[index];
        const next = hazards[index + 1];
        const adjacent = next.x - current.x - current.width <= current.minSpacing + 1;
        if (adjacent && current.kind !== 'gap' && next.kind !== 'gap') found.add('double');
        if (adjacent && current.kind !== 'gap' && next.kind === 'gap') found.add('obstacle-gap');
        if (adjacent && current.kind === 'gap' && next.kind === 'gap') {
          const between = segments.filter((segment) => segment.x0 >= current.x + current.width && segment.x1 <= next.x);
          if (between.some((segment) => segment.kind === 'platform')) found.add('narrow landing');
        }
      }
    }
    expect([...found].sort()).toEqual([
      'double', 'flat', 'gap', 'hill', 'kicker', 'launch', 'launch over gap',
      'narrow landing', 'obstacle-gap', 'platform', 'single obstacle',
    ]);
  }, 120_000);
});

describe('procedural gameplay fairness', () => {
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
