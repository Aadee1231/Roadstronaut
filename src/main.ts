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

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-canvas',
  backgroundColor: '#0b0a23',
  render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance' },
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
      };
    },
  });
}
