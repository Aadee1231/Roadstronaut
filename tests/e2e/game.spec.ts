import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test } from '@playwright/test';

const screens = join(homedir(), 'artifacts', 'screens');

async function waitForActiveRun(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as Window & { __thrust?: { activeRun: boolean } }).__thrust?.activeRun));
}

async function startRun(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#menu-screen [data-action="play"]').click();
  await waitForActiveRun(page);
}

test('desktop gameplay, verified submission, leaderboard, pause, restart, and mute persistence', async ({ page }) => {
  await mkdir(screens, { recursive: true });
  const consoleErrors: string[] = [];
  const failedAssets: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() === 404 && /\.(?:mp3|woff2?|png|jpe?g|webp|svg)(?:$|\?)/i.test(response.url())) {
      failedAssets.push(response.url());
    }
  });
  page.on('requestfailed', (request) => failedAssets.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`));

  await page.goto('/');
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page).toHaveTitle(/THRUSTSHIFT/);
  await page.screenshot({ path: join(screens, 'desktop-menu.png'), fullPage: true });

  await startRun(page);
  await expect(page.locator('.speed-panel span')).toHaveText('MPH');
  const canvas = page.locator('#game-canvas canvas');
  await expect(canvas).toBeVisible();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { activeRun: boolean; held: boolean; state: { grounded: boolean } } }).__thrust;
    return game && game.activeRun && game.held && !game.state.grounded;
  });
  await page.keyboard.up('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { activeRun: boolean; held: boolean; state: { grounded: boolean } } }).__thrust;
    return game && game.activeRun && !game.held && !game.state.grounded;
  });
  await page.keyboard.down('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { activeRun: boolean; held: boolean; state: { angle: number } } }).__thrust;
    return game && game.activeRun && game.held;
  }, undefined, { timeout: 2_000 });
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { state: { angle: number } } }).__thrust;
    return game && Math.abs(game.state.angle) > 0.5;
  }, undefined, { timeout: 5_000 });
  await page.screenshot({ path: join(screens, 'gameplay-midair-flip.png'), fullPage: true });
  await page.keyboard.up('Space');

  await expect(page.locator('#gameover-screen')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#final-score')).not.toHaveText('0');
  await expect(page.locator('#submit-status')).toContainText('Replay verified', { timeout: 15_000 });
  await page.screenshot({ path: join(screens, 'game-over.png'), fullPage: true });
  await page.locator('#gameover-screen [data-action="leaderboard"]').click();
  await expect(page.locator('#board-mode')).toHaveText('LOCAL DEV LEADERBOARD — NOT GLOBAL');
  // The dev store is shared with a reused dev server, so earlier runs may already be listed.
  await expect(page.locator('#board-entries .board-row').first()).toBeVisible();
  await page.screenshot({ path: join(screens, 'leaderboard.png'), fullPage: true });

  await page.locator('#leaderboard-screen [data-action="close-panel"]').click();
  await startRun(page);
  await page.waitForFunction(() => {
    const score = document.querySelector('#score-value')?.textContent?.replace(/\D/g, '') ?? '0';
    return Number(score) >= 100;
  });
  await page.keyboard.down('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { activeRun: boolean; held: boolean } }).__thrust;
    return game?.activeRun && game.held;
  });
  await page.locator('#hud [data-action="pause"]').click();
  await expect(page.locator('#pause-screen')).toBeVisible();
  await page.locator('#pause-screen [data-action="restart"]').click();
  await waitForActiveRun(page);
  await expect.poll(async () => Number((await page.locator('#score-value').textContent())?.replace(/\D/g, '') ?? 0)).toBeLessThan(100);
  await expect.poll(() => page.evaluate(() => (window as Window & { __thrust?: { held: boolean } }).__thrust?.held)).toBe(false);
  await page.keyboard.up('Space');

  await page.locator('#hud [data-action="mute"]').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('thrustshift.muted'))).toBe('true');
  await page.reload();
  await expect(page.locator('#menu-screen')).toBeVisible();
  await expect(page.locator('#menu-screen [data-action="mute"]')).toHaveClass(/is-muted/);
  expect(failedAssets).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('pausing after an airborne burst stops effects and resumes a single loop', async ({ page }) => {
  await page.goto('/');
  await startRun(page);

  await page.keyboard.down('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { activeRun: boolean; state: { grounded: boolean } } }).__thrust;
    return game?.activeRun && !game.state.grounded;
  });
  await page.keyboard.up('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { held: boolean; state: { grounded: boolean } } }).__thrust;
    return game && !game.held && !game.state.grounded;
  });
  await page.keyboard.down('Space');
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { state: { burstsLeft: number } } }).__thrust;
    return game?.state.burstsLeft === 1;
  });
  await page.keyboard.up('Space');

  await page.locator('#hud [data-action="pause"]').click();
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const audio = (window as Window & { __thrustshiftAudio?: { playing(): string[] } }).__thrustshiftAudio;
    return audio?.playing().filter((key) => ['engine', 'wind', 'rocket'].includes(key)) ?? [];
  })).toEqual([]);

  await page.locator('#pause-screen [data-action="resume"]').click();
  await expect.poll(() => page.evaluate(() => {
    const audio = (window as Window & { __thrustshiftAudio?: { playing(): string[] } }).__thrustshiftAudio;
    return audio?.playing().filter((key) => key === 'engine' || key === 'wind') ?? [];
  })).toEqual(['wind']);
  expect(await page.evaluate(() => {
    const audio = (window as Window & { __thrustshiftAudio?: { playing(): string[] } }).__thrustshiftAudio;
    return audio?.playing().filter((key) => key === 'engine' || key === 'wind').length;
  })).toBe(1);
});

test('About panel opens and closes with the full disclaimer', async ({ page }) => {
  await page.goto('/');
  await page.locator('#menu-screen [data-action="about"]').click();
  await expect(page.locator('#about-screen')).toBeVisible();
  await expect(page.locator('#about-screen')).toContainText('All trademarks belong to their respective owners.');
  await page.locator('#about-screen [data-action="close-panel"]').first().click();
  await expect(page.locator('#about-screen')).toBeHidden();
  await expect(page.locator('#menu-screen')).toBeVisible();
});

test('iPhone-sized portrait and landscape touch play do not scroll the page', async ({ browser }) => {
  await mkdir(screens, { recursive: true });
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto('/');
  await startRun(page);
  await page.touchscreen.tap(195, 420);
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { state: { grounded: boolean } } }).__thrust;
    return game && !game.state.grounded;
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: join(screens, 'mobile-portrait-gameplay.png'), fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#game-canvas canvas');
    return canvas && canvas.clientWidth > canvas.clientHeight;
  });
  const active = await page.evaluate(() => Boolean((window as Window & { __thrust?: { activeRun: boolean } }).__thrust?.activeRun));
  if (!active) {
    await page.locator('#gameover-screen [data-action="play-again"]').click();
    await waitForActiveRun(page);
  } else {
    await page.locator('#hud [data-action="pause"]').click();
    await page.locator('#pause-screen [data-action="restart"]').click();
    await waitForActiveRun(page);
  }
  await page.touchscreen.tap(420, 190);
  await page.waitForFunction(() => {
    const game = (window as Window & { __thrust?: { state: { grounded: boolean } } }).__thrust;
    return game && !game.state.grounded;
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: join(screens, 'mobile-landscape-gameplay.png'), fullPage: true });
  await context.close();
});

test('leaderboard shows an honest offline message when its request fails', async ({ page }) => {
  await page.route('**/api/leaderboard?*', (route) => route.abort());
  await page.goto('/');
  await page.locator('#menu-screen [data-action="leaderboard"]').click();
  await expect(page.locator('#board-entries')).toContainText('Leaderboard unavailable. Check your connection and retry.');
  await expect(page.locator('#board-mode')).toHaveText('LEADERBOARD OFFLINE');
});
