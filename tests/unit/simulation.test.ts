import { describe, expect, it } from 'vitest';
import {
  BURST_COOLDOWN, BURST_COUNT_PER_AIR_PHASE, CRASH_IMPACT, GRAVITY, HARD_IMPACT,
  JUMP_VELOCITY, MAX_SPEED, SPEED_RAMP_SECONDS, START_SPEED, WHEEL_RADIUS,
  distanceAtTime, speedAtTime, timeAtDistance,
} from '../../src/sim/constants';
import { atan2, cos, normalizeAngle, sin } from '../../src/sim/detmath';
import { decodeInputLog, encodeInputLog, replayRun } from '../../src/sim/replay';
import { Simulation, WHEEL_VERTICAL_OFFSET } from '../../src/sim/simulation';
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

  it('integrates the quadratic ease-out speed curve and inverts distance deterministically', () => {
    expect(speedAtTime(0)).toBe(START_SPEED);
    expect(speedAtTime(SPEED_RAMP_SECONDS)).toBe(MAX_SPEED);
    expect(speedAtTime(15)).toBeGreaterThan(START_SPEED + (MAX_SPEED - START_SPEED) * 15 / SPEED_RAMP_SECONDS);
    for (const time of [0, 1, 12, 45, 90, 150]) {
      expect(timeAtDistance(distanceAtTime(time))).toBeCloseTo(time, 8);
    }
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
    expect(simulation.events.some((event) => event.type === 'thrusterBurst')).toBe(false);
    expect(simulation.state.angularVelocity).toBe(0);
    expect(simulation.state.rotating).toBe(false);
    const energy = simulation.state.energy;
    simulation.step(false);
    simulation.step(true);
    expect(simulation.state.angularVelocity).toBeGreaterThan(0);
    expect(simulation.state.energy).toBeLessThan(energy);
    expect(simulation.state.rotating).toBe(true);
    expect(simulation.events.some((event) => event.type === 'thrusterBurst')).toBe(true);
    expect(simulation.state.burstsLeft).toBe(BURST_COUNT_PER_AIR_PHASE - 1);
  });

  it('does not rotate when a jump press is held through takeoff', () => {
    const simulation = new Simulation(7);
    simulation.step(true);
    for (let i = 0; i < 12; i += 1) simulation.step(true);
    expect(simulation.state.angularVelocity).toBe(0);
    expect(simulation.state.burstsLeft).toBe(BURST_COUNT_PER_AIR_PHASE);
    expect(simulation.events.some((event) => event.type === 'thrusterBurst')).toBe(false);
  });

  it('keeps a plain flat jump within the airtime and apex targets', () => {
    const simulation = new Simulation(9);
    const startingY = simulation.state.y;
    let apex = startingY;
    let landedAirtime = 0;
    simulation.step(true);
    for (let tick = 0; tick < 240 && !simulation.state.crashed; tick += 1) {
      simulation.step(false);
      apex = Math.min(apex, simulation.state.y);
      const landing = simulation.events.find((event) => event.type === 'land');
      if (landing?.type === 'land') {
        landedAirtime = landing.airtime;
        break;
      }
    }
    expect(-2 * JUMP_VELOCITY / GRAVITY).toBeGreaterThanOrEqual(0.8);
    expect(-2 * JUMP_VELOCITY / GRAVITY).toBeLessThanOrEqual(0.9);
    expect(JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY)).toBeGreaterThanOrEqual(110);
    expect(JUMP_VELOCITY * JUMP_VELOCITY / (2 * GRAVITY)).toBeLessThanOrEqual(140);
    expect(apex).toBeLessThanOrEqual(startingY - 110);
    expect(apex).toBeGreaterThanOrEqual(startingY - 140);
    expect(landedAirtime).toBeGreaterThanOrEqual(0.8);
    expect(landedAirtime).toBeLessThanOrEqual(0.9);
  });

  it('emits a non-rewarding touchdown for a short contact', () => {
    const simulation = new Simulation(5);
    const surface = simulation.course.surfaceAt(0)!;
    simulation.state.grounded = false;
    simulation.state.airtime = 0.05;
    simulation.state.vy = 100;
    simulation.state.y = surface.y - WHEEL_VERTICAL_OFFSET - WHEEL_RADIUS + 2;
    simulation.step(false);

    expect(simulation.events.some((event) => event.type === 'touchdown')).toBe(true);
    expect(simulation.events.some((event) => event.type === 'land')).toBe(false);
    expect(simulation.state.stats.perfects).toBe(0);
    expect(simulation.state.stats.totalFlips).toBe(0);
  });

  it('limits fresh airborne bursts and keeps their added airtime below the jump cap', () => {
    const measureAirtime = (useBursts: boolean): { airtime: number; count: number } => {
      const simulation = new Simulation(8);
      let count = 0;
      simulation.step(true);
      simulation.step(false);
      for (let tick = 0; tick < 240 && !simulation.state.grounded && !simulation.state.crashed; tick += 1) {
        const state = simulation.state;
        const burst = useBursts
          && state.burstsLeft > 0
          && state.burstCooldown === 0
          && state.vy > -200;
        simulation.step(burst);
        if (simulation.events.some((event) => event.type === 'thrusterBurst')) count += 1;
      }
      return { airtime: simulation.state.airtime, count };
    };
    const baseline = measureAirtime(false);
    const spammed = measureAirtime(true);
    expect(spammed.count).toBe(BURST_COUNT_PER_AIR_PHASE);
    expect(spammed.airtime - baseline.airtime).toBeLessThan(0.35);
    expect(spammed.airtime).toBeGreaterThan(baseline.airtime);
    expect(BURST_COOLDOWN).toBe(0.4);
  });

  it('downgrades hard impacts and crashes impacts above the limit', () => {
    const makeFalling = (impact: number): Simulation => {
      const simulation = new Simulation(9);
      const surface = simulation.course.surfaceAt(simulation.state.x)!;
      simulation.state.grounded = false;
      simulation.state.airtime = 0.3;
      simulation.state.y = surface.y - WHEEL_VERTICAL_OFFSET - WHEEL_RADIUS - 4;
      simulation.state.vy = impact;
      return simulation;
    };

    const hard = makeFalling(HARD_IMPACT + 50);
    hard.step(false);
    expect(hard.events.some((event) => event.type === 'hardLanding')).toBe(true);
    expect(hard.events.find((event) => event.type === 'land')).toMatchObject({ quality: 'great' });
    expect(hard.state.stats.perfects).toBe(0);

    const crash = makeFalling(CRASH_IMPACT + 50);
    crash.step(false);
    expect(crash.state.crashed).toBe(true);
    expect(crash.state.crashReason).toBe('bad-landing');
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
