import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const screens = join(homedir(), 'artifacts', 'screens');

interface ThrustDebug {
  activeRun: boolean;
  state: { crashed: boolean; won: boolean; crashReason: string | null; stats: { score: number } };
}

const thrust = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as Window & { __roadstronaut?: ThrustDebug }).__roadstronaut);

async function startRun(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#menu-screen [data-action="play"]').click();
  await page.waitForFunction(() => Boolean((window as Window & { __roadstronaut?: ThrustDebug }).__roadstronaut?.activeRun));
}

async function setScore(page: import('@playwright/test').Page, score: number): Promise<void> {
  await page.evaluate((value) => {
    const game = (window as Window & { __roadstronaut?: ThrustDebug }).__roadstronaut;
    if (game) game.state.stats.score = value;
  }, score);
}

test('score milestones celebrate at 500k and end the run in victory at 1M', async ({ page }) => {
  await mkdir(screens, { recursive: true });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    // The hooked-in score can't be replay-verified, so the API logs a 422 resource error.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  await startRun(page);

  // Half-million milestone: run continues with celebration feedback.
  await setScore(page, 499_990);
  await expect(page.locator('#feedback-stack')).toContainText('HALF A MILLION', { timeout: 10_000 });
  await page.screenshot({ path: join(screens, 'easter-egg-500k.png'), fullPage: true });
  await expect.poll(async () => (await thrust(page))?.activeRun).toBe(true);

  // One million: the run ends as a win, then the results panel lands.
  await setScore(page, 999_990);
  await expect.poll(async () => (await thrust(page))?.state.won, { timeout: 10_000 }).toBe(true);
  await expect(page.locator('#feedback-stack')).toContainText('LEGEND STATUS', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(screens, 'easter-egg-1m-celebration.png'), fullPage: true });
  await expect(page.locator('#gameover-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#gameover-screen')).toHaveClass(/is-victory/);
  await expect(page.locator('#gameover-screen .panel-eyebrow')).toHaveText('LEGEND STATUS');
  await expect(page.locator('#gameover-screen h2')).toContainText('YOU BEAT THE ROAD');
  await page.screenshot({ path: join(screens, 'easter-egg-1m-results.png'), fullPage: true });

  expect(consoleErrors).toEqual([]);
});
