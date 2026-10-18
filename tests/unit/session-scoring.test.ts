import { describe, expect, it } from 'vitest';
import { CAR_HEIGHT, FIXED_DT, ROTATION_ENERGY_PER_SECOND } from '../../src/sim/constants';
import { Simulation } from '../../src/sim/simulation';
import { GameSession } from '../../src/game-session';
import { airtimePoints, awardLanding, awardNearMiss, comboMultiplier, createRunStats, flipPoints, landingPoints } from '../../src/sim/scoring';

describe('scoring rules', () => {
  it('applies each trick bonus, landing quality, airtime, and bounded combo multiplier', () => {
    const stats = createRunStats();
    expect([0, 1, 2, 3, 4].map(flipPoints)).toEqual([0, 500, 1500, 3000, 5000]);
    expect([0.79, 0.8, 1.3, 20].map(airtimePoints)).toEqual([0, 0, 100, 1000]);
    expect([landingPoints('clean'), landingPoints('great'), landingPoints('perfect')]).toEqual([100, 250, 500]);
    const points = awardLanding(stats, 'perfect', 2, 1.3, 1);
    expect(points).toBe(Math.round((1500 + 500 + 100) * 2));
    expect(stats).toMatchObject({ score: points, totalFlips: 2, bestTrick: 2, perfects: 1, maxCombo: 2 });
    expect(comboMultiplier(100)).toBe(8);
    expect(awardNearMiss(stats, 100)).toBe(2_000);
    expect(stats.nearMisses).toBe(1);
  });

  it('resets an expired combo and on a crash', () => {
    const expired = new Simulation(1);
    expired.state.combo = 4;
    expired.state.comboIdle = 4.999;
    expired.step(false);
    expect(expired.state.combo).toBe(0);

    const crashed = new Simulation(2);
    crashed.state.combo = 5;
    crashed.state.grounded = false;
    crashed.state.y = 2_000;
    crashed.state.angle = crashed.course.surfaceAt(crashed.state.x)!.slope + Math.PI;
    crashed.step(false);
    expect(crashed.state.crashed).toBe(true);
    expect(crashed.state.combo).toBe(0);
  });

  it('drains the final energy tick, damps released rotation, and grades landings safely', () => {
    const energy = new Simulation(3);
    energy.step(true);
    energy.step(false);
    energy.state.energy = ROTATION_ENERGY_PER_SECOND * FIXED_DT;
    energy.step(true);
    expect(energy.state.energy).toBe(0);
    expect(energy.events.some((event) => event.type === 'energyEmpty')).toBe(true);

    const rotation = new Simulation(4);
    rotation.step(true);
    rotation.step(false);
    rotation.step(true);
    for (let index = 0; index < 12; index += 1) rotation.step(true);
    const angularVelocity = rotation.state.angularVelocity;
    rotation.step(false);
    expect(rotation.state.angularVelocity).toBeLessThan(angularVelocity);

    const landed = new Simulation(5);
    const surface = landed.course.surfaceAt(landed.state.x)!;
    landed.state.grounded = false;
    landed.state.y = surface.y - CAR_HEIGHT / 2 + 1;
    landed.state.vy = 10;
    landed.state.angle = surface.slope;
    landed.step(false);
    expect(landed.state.grounded).toBe(true);

    const unsafe = new Simulation(6);
    const unsafeSurface = unsafe.course.surfaceAt(unsafe.state.x)!;
    unsafe.state.grounded = false;
    unsafe.state.y = unsafeSurface.y - CAR_HEIGHT * 0.3 + 1;
    unsafe.state.vy = 10;
    unsafe.state.angle = unsafeSurface.slope + Math.PI;
    unsafe.step(false);
    expect(unsafe.state.crashed).toBe(true);
    expect(unsafe.state.crashReason).toBe('bad-landing');
  });
});

describe('game session state machine', () => {
  it('supports start, pause, resume, finish, restart, and quit transitions', () => {
    const session = new GameSession();
    expect(session.state).toBe('menu');
    session.pause();
    expect(session.state).toBe('menu');
    session.start();
    expect(session.state).toBe('playing');
    session.pause();
    expect(session.state).toBe('paused');
    session.resume();
    expect(session.state).toBe('playing');
    session.finish();
    expect(session.state).toBe('gameover');
    session.restart();
    expect(session.state).toBe('playing');
    session.quit();
    expect(session.state).toBe('menu');
  });
});
