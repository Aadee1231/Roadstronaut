import Phaser from 'phaser';
import '@fontsource/orbitron/400.css';
import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/800.css';
import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import './style.css';
import { AudioManager } from './game/audio/AudioManager';
import { BootScene, GameScene } from './game/GameScene';
import { GameUI } from './ui/GameUI';

document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });

/**
 * Mean RAF cadence in ms. High-refresh phone displays tick at 8.3ms (120Hz) or
 * 11.1ms (90Hz) — running the full engine loop that often costs twice the work
 * per second a 60Hz laptop does, for no visual gain: the game is designed
 * around 60fps.
 */
function measureFrameMs(samples = 10): Promise<number> {
  return new Promise((resolve) => {
    let last = -1;
    let total = 0;
    let count = 0;
    const timer = setTimeout(() => resolve(16.7), 600); // hidden tab → assume 60Hz
    const sample = (t: number): void => {
      if (last >= 0) {
        total += t - last;
        count += 1;
      }
      last = t;
      if (count < samples) {
        requestAnimationFrame(sample);
      } else {
        clearTimeout(timer);
        resolve(total / count);
      }
    };
    requestAnimationFrame(sample);
  });
}

async function boot(): Promise<void> {
  const frameMs = await measureFrameMs();
  let fps: Phaser.Types.Core.FPSConfig | undefined;
  if (frameMs <= 9) {
    // ~120Hz+ displays: let RAF tick, but only run a game step every ~2nd
    // vsync — a clean, vsync-aligned 60fps (update + render both halve).
    fps = { limit: 60 };
  } else if (frameMs < 12.5) {
    // ~90Hz displays: can't halve vsync ticks cleanly, so pace the loop with
    // a 60fps setTimeout instead of RAF.
    fps = { target: 60, forceSetTimeOut: true };
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-canvas',
    backgroundColor: '#0b0a23',
    render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance' },
    fps,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    input: { activePointers: 3, touch: { capture: true } },
    scene: [BootScene, GameScene],
  });

  // Phaser's own resize polling can miss viewport changes (e.g. device rotation), leaving a stretched canvas.
  const refreshScale = (): void => { game.scale.refresh(); };
  window.addEventListener('resize', refreshScale);
  window.addEventListener('orientationchange', () => setTimeout(refreshScale, 150));
  const canvasParent = document.getElementById('game-canvas');
  if (canvasParent && 'ResizeObserver' in window) new ResizeObserver(refreshScale).observe(canvasParent);

  const root = document.querySelector<HTMLElement>('#ui-root');
  if (!root) throw new Error('UI root is missing');
  new GameUI(root, game);
  new AudioManager(game.events);

  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
    Object.defineProperty(window, '__roadstronaut', {
      configurable: true,
      get: () => {
        const scene = game.scene.getScene('game') as GameScene | undefined;
        return scene?.getDebugSnapshot() ?? null;
      },
    });
    Object.defineProperty(window, '__roadstronautDebug', {
      configurable: true,
      get: () => {
        const scene = game.scene.getScene('game') as GameScene | undefined;
        if (!scene) return null;
        return {
          teleport: (x: number) => scene.debugTeleport(x),
          landmarks: () => scene.debugCourseLandmarks(),
          scene: () => scene,
        };
      },
    });
  }
}

void boot();
