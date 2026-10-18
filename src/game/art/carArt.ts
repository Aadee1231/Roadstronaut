/** Car art in a 256×96 logical space, nose pointing right. Wheel centres at (62,72) and (196,72), radius 21. */
export const CAR_ART = {
  width: 256,
  height: 96,
  rearWheelX: 62,
  frontWheelX: 196,
  wheelY: 72,
  wheelRadius: 21,
} as const;

export type CarPaint = 'prototype' | 'coral';

interface Palette { paint: readonly string[]; line: string; sheen: string }

const PALETTES: Record<CarPaint, Palette> = {
  prototype: { paint: ['#ffffff', '#f2f4f8', '#d4d9e3', '#8d93a6', '#2b2e3a'], line: 'rgba(20,22,34,0.55)', sheen: 'rgba(255,255,255,0.45)' },
  coral: { paint: ['#ffd2b8', '#ff7a52', '#e6402c', '#8e1a2a', '#3a0b1e'], line: 'rgba(255,236,220,0.85)', sheen: 'rgba(255,240,230,0.28)' },
};

/** Low wedge profile, long flat roof, windscreen base pushed forward onto the front fender. */
export function drawCarBody(ctx: CanvasRenderingContext2D, scale: number, paintName: CarPaint = 'prototype'): void {
  const pal = PALETTES[paintName];
  ctx.save();
  ctx.scale(scale, scale);
  const ug = ctx.createRadialGradient(130, 80, 4, 130, 80, 100);
  ug.addColorStop(0, 'rgba(46,242,255,0.3)');
  ug.addColorStop(1, 'rgba(46,242,255,0)');
  ctx.fillStyle = ug;
  ctx.beginPath(); ctx.ellipse(130, 80, 96, 6, 0, 0, Math.PI * 2); ctx.fill();

  const body = new Path2D();
  body.moveTo(10, 64);
  body.lineTo(12, 50);
  body.lineTo(20, 42);
  body.lineTo(58, 36);
  body.bezierCurveTo(84, 30, 104, 25, 128, 24);
  body.lineTo(150, 25);
  body.bezierCurveTo(166, 30, 184, 40, 204, 47);
  body.lineTo(240, 56);
  body.lineTo(249, 61);
  body.lineTo(246, 67);
  body.lineTo(222, 71);
  body.arc(196, 72, 25, -0.05, Math.PI + 0.05, true);
  body.lineTo(88, 73);
  body.arc(62, 72, 25, -0.05, Math.PI + 0.05, true);
  body.lineTo(16, 72);
  body.closePath();

  const paint = ctx.createLinearGradient(0, 22, 0, 74);
  [0, 0.22, 0.55, 0.85, 1].forEach((stop, i) => paint.addColorStop(stop, pal.paint[i]!));
  ctx.fillStyle = paint;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);
  const sheen = ctx.createLinearGradient(20, 0, 250, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, pal.sheen);
  sheen.addColorStop(0.6, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 256, 96);
  // Gloss-black lower aero band (prototype two-tone).
  const sill = ctx.createLinearGradient(0, 56, 0, 74);
  sill.addColorStop(0, 'rgba(10,10,18,0)');
  sill.addColorStop(0.3, 'rgba(10,10,18,0.92)');
  sill.addColorStop(1, '#06060c');
  ctx.fillStyle = sill;
  ctx.beginPath(); ctx.moveTo(0, 62); ctx.lineTo(96, 58); ctx.lineTo(190, 57); ctx.lineTo(256, 63); ctx.lineTo(256, 96); ctx.lineTo(0, 96); ctx.fill();
  // Side intake blade.
  ctx.fillStyle = '#0b0b14';
  ctx.beginPath(); ctx.moveTo(92, 49); ctx.lineTo(140, 47); ctx.lineTo(134, 57); ctx.lineTo(98, 58); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(46,242,255,0.85)'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(98, 58); ctx.lineTo(134, 57); ctx.stroke();
  ctx.restore();

  // Single wrap-around black canopy; windscreen base sits forward on the fender.
  const glass = new Path2D();
  glass.moveTo(56, 37);
  glass.bezierCurveTo(84, 29, 106, 26, 128, 26);
  glass.lineTo(148, 27);
  glass.bezierCurveTo(162, 31, 176, 38, 190, 44);
  glass.bezierCurveTo(160, 42, 110, 42, 64, 41);
  glass.closePath();
  const gg = ctx.createLinearGradient(70, 24, 180, 46);
  gg.addColorStop(0, '#05060c'); gg.addColorStop(0.55, '#141826'); gg.addColorStop(0.78, '#2c3550'); gg.addColorStop(1, '#05060c');
  ctx.fillStyle = gg; ctx.fill(glass);
  ctx.save(); ctx.clip(glass);
  ctx.fillStyle = 'rgba(190,230,255,0.22)';
  ctx.beginPath(); ctx.moveTo(150, 24); ctx.lineTo(160, 24); ctx.lineTo(146, 46); ctx.lineTo(136, 46); ctx.fill();
  ctx.fillStyle = 'rgba(190,230,255,0.1)';
  ctx.beginPath(); ctx.moveTo(166, 26); ctx.lineTo(170, 26); ctx.lineTo(158, 46); ctx.lineTo(154, 46); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(8,8,14,0.9)'; ctx.lineWidth = 1.2; ctx.stroke(glass);

  // One flowing character line from rear haunch to nose.
  ctx.strokeStyle = pal.line; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(18, 47); ctx.bezierCurveTo(90, 44, 170, 46, 240, 58); ctx.stroke();

  // Directional cold-gas nozzle ports (rear, roof, lower front).
  ctx.fillStyle = '#0a0a12';
  for (const [x, y, w, h] of [[8, 54, 7, 4], [8, 60, 7, 4], [116, 23.5, 12, 2.5], [232, 64, 8, 3]] as const) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 1.2); ctx.fill();
  }
  ctx.shadowColor = '#2ef2ff'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#9ffbff';
  ctx.fillRect(7, 55, 1.6, 2); ctx.fillRect(7, 61, 1.6, 2);
  ctx.shadowBlur = 0;

  // Full-width tail light blade.
  ctx.shadowColor = '#ff2e4d'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#ff3b5c'; ctx.beginPath(); ctx.moveTo(11, 47); ctx.lineTo(20, 44); ctx.lineTo(20, 46.5); ctx.lineTo(11, 49.5); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;

  // Thin front light bar.
  ctx.shadowColor = '#bffcff'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#f2feff';
  ctx.beginPath(); ctx.moveTo(214, 53.5); ctx.lineTo(246, 61); ctx.lineTo(245, 62.6); ctx.lineTo(213, 55.4); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = '#2ef2ff'; ctx.shadowBlur = 6;
  ctx.strokeStyle = '#2ef2ff'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(90, 71); ctx.lineTo(170, 71); ctx.stroke();
  ctx.shadowBlur = 0;
  for (const cx of [62, 196]) {
    const wg = ctx.createRadialGradient(cx, 72, 18, cx, 72, 25);
    wg.addColorStop(0, 'rgba(0,0,0,0)'); wg.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = wg; ctx.beginPath(); ctx.arc(cx, 72, 25, Math.PI, 0); ctx.fill();
  }
  ctx.restore();
}

/** Wheel in a 64×64 logical space (tyre radius 30). */
export function drawWheel(ctx: CanvasRenderingContext2D, scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(32, 32);
  const t = ctx.createRadialGradient(0, 0, 14, 0, 0, 30);
  t.addColorStop(0, '#2a2a33'); t.addColorStop(0.8, '#121218'); t.addColorStop(1, '#050507');
  ctx.fillStyle = t; ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 27, -2.4, -0.8); ctx.stroke();
  const r = ctx.createRadialGradient(-4, -4, 2, 0, 0, 21);
  r.addColorStop(0, '#3b3f52'); r.addColorStop(1, '#14141c');
  ctx.fillStyle = r; ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 10; i += 1) {
    ctx.save(); ctx.rotate(i * Math.PI / 5);
    const sg = ctx.createLinearGradient(0, -20, 0, 0);
    sg.addColorStop(0, '#d9dfef'); sg.addColorStop(1, '#6b7189');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.moveTo(-2, -5); ctx.quadraticCurveTo(6, -12, 4, -20); ctx.lineTo(8, -19); ctx.quadraticCurveTo(9, -10, 2, -5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = '#aab2c8'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowColor = '#2ef2ff'; ctx.shadowBlur = 8;
  ctx.strokeStyle = '#2ef2ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#1b1b26'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
