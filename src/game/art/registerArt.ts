import type Phaser from 'phaser';
import { BIOMES } from '../biomes';
import { drawMountains, drawSkyline, drawSkylineLights, drawStars, drawStructureBeacons, drawStructures, drawSun } from './backgroundArt';
import { CAR_ART, drawCarBody, drawWheel } from './carArt';

/** Supersampling factor for the car textures. */
export const CAR_TEXTURE_SCALE = 2;

function canvasTexture(scene: Phaser.Scene, key: string, width: number, height: number, paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
  if (scene.textures.exists(key)) return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Canvas2D unavailable for ${key}`);
  paint(context, width, height);
  const texture = scene.textures.addCanvas(key, canvas);
  if (!texture) throw new Error(`Could not register texture ${key}`);
  texture.refresh();
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function radial(ctx: CanvasRenderingContext2D, size: number, stops: [number, string][]): void {
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

export function registerArt(scene: Phaser.Scene): void {
  const s = CAR_TEXTURE_SCALE;
  canvasTexture(scene, 'car-body', CAR_ART.width * s, CAR_ART.height * s, (ctx) => drawCarBody(ctx, s));
  canvasTexture(scene, 'car-body-coral', CAR_ART.width * s, CAR_ART.height * s, (ctx) => drawCarBody(ctx, s, 'coral'));
  canvasTexture(scene, 'car-wheel', 64 * s, 64 * s, (ctx) => drawWheel(ctx, s));
  canvasTexture(scene, 'thruster-flame', 128, 48, (ctx, w, h) => {
    const g = ctx.createLinearGradient(w, 0, 0, 0);
    g.addColorStop(0, 'rgba(230,255,255,1)');
    g.addColorStop(0.18, 'rgba(46,242,255,0.95)');
    g.addColorStop(0.55, 'rgba(123,44,255,0.55)');
    g.addColorStop(1, 'rgba(255,107,74,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(w, h * 0.22);
    ctx.quadraticCurveTo(w * 0.45, h * 0.1, 0, h / 2);
    ctx.quadraticCurveTo(w * 0.45, h * 0.9, w, h * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const core = ctx.createLinearGradient(w, 0, w * 0.4, 0);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.ellipse(w * 0.85, h / 2, w * 0.18, h * 0.16, 0, 0, Math.PI * 2); ctx.fill();
  });
  canvasTexture(scene, 'spark', 32, 32, (ctx) => radial(ctx, 32, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'smoke', 64, 64, (ctx) => radial(ctx, 64, [[0, 'rgba(255,255,255,0.55)'], [0.5, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'glow', 128, 128, (ctx) => radial(ctx, 128, [[0, 'rgba(255,255,255,0.9)'], [0.35, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'bg-stars', 1024, 512, drawStars);
  canvasTexture(scene, 'bg-sun', 512, 512, (ctx, w) => drawSun(ctx, w));
  canvasTexture(scene, 'bg-mountains', 1024, 256, drawMountains);
  canvasTexture(scene, 'bg-skyline', 1024, 320, drawSkyline);
  canvasTexture(scene, 'bg-skyline-lights', 1024, 320, drawSkylineLights);
  canvasTexture(scene, 'bg-structures', 1024, 320, drawStructures);
  canvasTexture(scene, 'bg-beacons', 1024, 320, drawStructureBeacons);
  canvasTexture(scene, 'bg-haze', 8, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0.9)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  BIOMES.forEach((biome, i) => {
    canvasTexture(scene, `bg-sky-${i}`, 8, 512, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, hex(biome.sky[0]));
      g.addColorStop(0.62, hex(biome.sky[1]));
      g.addColorStop(1, hex(biome.sky[2]));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
  });
}
