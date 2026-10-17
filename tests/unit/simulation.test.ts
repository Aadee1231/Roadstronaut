import { describe, expect, it } from 'vitest';
import { COURSE_CHUNK_LENGTH, FIXED_DT, GRAVITY, HAZARD_RECOVERY_SECONDS, JUMP_VELOCITY, MAX_SPEED, START_SPEED } from '../../src/sim/constants';
import { atan2, cos, normalizeAngle, sin } from '../../src/sim/detmath';
import { createCourse } from '../../src/sim/course';
import { decodeInputLog, encodeInputLog, replayRun } from '../../src/sim/replay';
import { Simulation } from '../../src/sim/simulation';
import { airtimePoints, comboMultiplier, flipPoints, landingPoints } from '../../src/sim/scoring';
import { SeededRng } from '../../src/sim/rng';

describe('deterministic math and random numbers', () => {
  it('approximates trigonometry within arcade-physics tolerances', () => {
    for (let index = -1200; index <= 1200; index += 1) {
      const angle = index / 100;
      expect(Math.abs(sin(angle) - Math.sin(angle))).toBeLessThan(0.00001);
      expect(Math.abs(cos(angle) - Math.cos(angle))).toBeLessThan(0.00001);
      expect(Math.abs(normalizeAngle(angle))).toBeLessThanOrEqual(Math.PI);
    }
    for (const [y, x] of [[1, 1], [-3, 1], [2, -4], [-4, -3], [0, -1], [1, 0]]) {
      expect(Math.abs(atan2(y, x) - Math.atan2(y, x))).toBeLessThan(0.002);
    }
  });

  it('repeats seeded RNG streams', () => {
    const first = new SeededRng(77);
    const second = new SeededRng(77);
    expect(Array.from({ length: 100 }, () => first.nextUint32())).toEqual(Array.from({ length: 100 }, () => second.nextUint32()));
  });
});

describe('scoring', () => {
  it('applies the settled flip, landing, airtime, and combo values', () => {
    expect([1, 2, 3, 4].map(flipPoints)).toEqual([500, 1500, 3000, 5000]);
    expect(['clean', 'great', 'perfect'].map((quality) => landingPoints(quality as 'clean' | 'great' | 'perfect'))).toEqual([100, 250, 500]);
    expect(airtimePoints(0.8)).toBe(0);
    expect(airtimePoints(1.3)).toBe(100);
    expect(comboMultiplier(1)).toBe(1.5);
    expect(comboMultiplier(20)).toBe(8);
  });
});

describe('simulation input and replay', () => {
  it('does not rotate on the press that jumps, but accepts a fresh airborne press', () => {
    const simulation = new Simulation(4);
    simulation.step(true);
    expect(simulation.events.some((event) => event.type === 'jump')).toBe(true);
    expect(simulation.state.angularVelocity).toBe(0);
    const energy = simulation.state.energy;
    simulation.step(false);
    simulation.step(true);
    expect(simulation.state.angularVelocity).toBeGreaterThan(0);
    expect(simulation.state.energy).toBeLessThan(energy);
  });

  it('does not rotate when a jump press is held through takeoff', () => {
    const simulation = new Simulation(7);
    simulation.step(true);
    for (let i = 0; i < 12; i += 1) simulation.step(true);
    expect(simulation.state.angularVelocity).toBe(0);
  });

  it('disables rotation at zero energy and provides a deterministic replay round-trip', () => {
    const simulation = new Simulation(8);
    simulation.state.energy = 0;
    simulation.step(true);
    simulation.step(false);
    simulation.step(true);
    expect(simulation.state.angularVelocity).toBe(0);
    const inputs = Array.from({ length: 480 }, (_, index) => index % 70 < 4);
    expect(decodeInputLog(encodeInputLog(inputs))).toEqual(inputs);
    expect(replayRun(12, encodeInputLog(inputs))).toEqual(replayRun(12, inputs));
  });

  it('produces identical authoritative outcomes for the same seed and inputs', () => {
    const inputs = Array.from({ length: 3200 }, (_, index) => index % 130 > 30 && index % 130 < 80);
    expect(replayRun(991, inputs)).toEqual(replayRun(991, inputs));
  });
});

function autopilot(seed: number, durationSeconds: number): Simulation {
  const simulation = new Simulation(seed);
  const ticks = Math.ceil(durationSeconds / FIXED_DT);
  for (let tick = 0; tick < ticks && !simulation.state.crashed; tick += 1) {
    const state = simulation.state;
    let jump = false;
    if (state.grounded) {
      const hazards = simulation.course.hazardsAhead(state.x, state.speed * 1.4);
      const next = hazards[0];
      if (next) {
        const jumpX = next.kind === 'gap' ? next.x - 70 : next.x - 250;
        jump = state.x >= jumpX - state.speed * FIXED_DT && state.x <= jumpX;
      }
    }
    simulation.step(jump);
  }
  return simulation;
}

describe('procedural course fairness', () => {
  it('keeps generated hazard clearances within physics limits over 500 seeds', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const course = createCourse(seed);
      const hazards = course.hazardsAhead(0, COURSE_CHUNK_LENGTH * 24).sort((a, b) => a.x - b.x);
      let previous: typeof hazards[number] | undefined;
      for (const hazard of hazards) {
        expect(hazard.safeJumpReach).toBeGreaterThan(0);
        if (hazard.kind === 'gap') expect(hazard.width).toBeLessThanOrEqual(hazard.safeJumpReach * 0.72);
        else expect(hazard.height).toBeLessThanOrEqual((JUMP_VELOCITY ** 2 / (2 * GRAVITY)) * 0.65);
        if (previous) {
          const travelTime = (hazard.x - (previous.x + previous.width)) / Math.max(START_SPEED, (START_SPEED + MAX_SPEED) / 2);
          expect(travelTime).toBeGreaterThanOrEqual(HAZARD_RECOVERY_SECONDS);
        }
        previous = hazard;
      }
    }
  });

  it('lets a no-flip lookahead bot survive 120 seconds across 200 seeds', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const simulation = autopilot(seed, 120);
      expect(simulation.state.crashed, `seed ${seed}: ${simulation.state.crashReason} at ${simulation.state.x}`).toBe(false);
      expect(simulation.state.elapsed).toBeGreaterThanOrEqual(120 - FIXED_DT);
    }
  });

  it('allows a clean front flip from launch ramps', () => {
    let attempts = 0;
    let successful = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const simulation = new Simulation(seed);
      let rotationMode = false;
      let releaseLaunchPress = false;
      let hadLaunch = false;
      let landedWithFlip = false;
      for (let tick = 0; tick < 18_000 && !landedWithFlip && !simulation.state.crashed; tick += 1) {
        const state = simulation.state;
        const surface = simulation.course.surfaceAt(state.x);
        let held = false;
        if (!rotationMode && state.grounded && surface?.segment.kind === 'launch' && state.x >= surface.segment.x1 - 28) {
          held = true;
          hadLaunch = true;
          releaseLaunchPress = true;
          attempts += 1;
        } else if (hadLaunch && !state.grounded) {
          if (releaseLaunchPress) {
            releaseLaunchPress = false;
          } else if (state.flips === 0 && !rotationMode) {
            rotationMode = true;
          }
          held = rotationMode && state.flips === 0;
        }
        simulation.step(held);
        if (simulation.events.some((event) => event.type === 'land' && event.flips >= 1)) landedWithFlip = true;
      }
      if (landedWithFlip) successful += 1;
    }
    expect(attempts).toBeGreaterThan(0);
    expect(successful).toBeGreaterThanOrEqual(attempts * 0.8);
  });
});
