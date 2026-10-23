/** Celebration art for the score milestones: confetti, flyby rockets, and the dancing mogul. */

export const CONFETTI_ART = { width: 14, height: 20 } as const;
export const ROCKET_ART = { width: 200, height: 60 } as const;
export const DANCER_ART = { width: 160, height: 200 } as const;

/** White confetti tile — particles tint it per piece. */
export function drawConfetti(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.98)';
  ctx.beginPath();
  ctx.roundRect(1, 1, width - 2, height - 2, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.roundRect(2.5, 2.5, width - 5, height * 0.35, 2);
  ctx.fill();
}

/** Booster pointing right: white body, interstage band, grid fins, engine flame. */
export function drawRocket(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const cy = height / 2;

  const flame = ctx.createLinearGradient(0, cy, 52, cy);
  flame.addColorStop(0, 'rgba(255,107,74,0)');
  flame.addColorStop(0.35, 'rgba(255,140,80,0.9)');
  flame.addColorStop(0.8, 'rgba(255,220,140,0.95)');
  flame.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(4, cy);
  ctx.quadraticCurveTo(34, cy - 14, 52, cy - 7);
  ctx.lineTo(52, cy + 7);
  ctx.quadraticCurveTo(34, cy + 14, 4, cy);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#20263e';
  ctx.beginPath();
  ctx.moveTo(48, cy - 9);
  ctx.lineTo(60, cy - 13);
  ctx.lineTo(60, cy + 13);
  ctx.lineTo(48, cy + 9);
  ctx.closePath();
  ctx.fill();

  // Grid fins.
  ctx.fillStyle = '#39406b';
  ctx.beginPath();
  ctx.moveTo(66, cy - 13);
  ctx.lineTo(84, cy - 30);
  ctx.lineTo(90, cy - 30);
  ctx.lineTo(78, cy - 13);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(66, cy + 13);
  ctx.lineTo(84, cy + 30);
  ctx.lineTo(90, cy + 30);
  ctx.lineTo(78, cy + 13);
  ctx.closePath();
  ctx.fill();

  const body = ctx.createLinearGradient(0, cy - 13, 0, cy + 13);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.55, '#e8ecf6');
  body.addColorStop(1, '#aab2cc');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(58, cy - 13, 100, 26, 6);
  ctx.fill();

  // Nose cone.
  ctx.beginPath();
  ctx.moveTo(156, cy - 13);
  ctx.quadraticCurveTo(190, cy - 10, 196, cy);
  ctx.quadraticCurveTo(190, cy + 10, 156, cy + 13);
  ctx.closePath();
  ctx.fill();

  // Interstage band + raceway stripe.
  ctx.fillStyle = '#161a30';
  ctx.fillRect(138, cy - 13, 16, 26);
  ctx.fillStyle = 'rgba(46,242,255,0.85)';
  ctx.fillRect(86, cy - 13, 4, 26);

  // Portholes.
  for (const px of [104, 120]) {
    ctx.fillStyle = '#0c0f1c';
    ctx.beginPath();
    ctx.arc(px, cy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#9ffbff';
    ctx.beginPath();
    ctx.arc(px, cy, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(12,14,28,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(58, cy - 13, 100, 26, 6);
  ctx.stroke();
}

export type DancerPose = 'jump' | 'pump';

/** Cartoon mogul in a dark suit. 'jump' is the famous spread-eagle leap; 'pump' is raise-the-roof. */
export function drawDancer(ctx: CanvasRenderingContext2D, scale: number, pose: DancerPose): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const skin = '#f2c9a4';
  const suit = '#1a1e33';
  const lapel = '#2a3050';
  const pants = '#141729';
  const shoe = '#e8ecf6';
  const hair = '#54402e';

  const limb = (x1: number, y1: number, x2: number, y2: number, w: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const blob = (x: number, y: number, rx: number, ry: number, color: string, rot = 0): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    ctx.fill();
  };

  // Legs (drawn first so the jacket overlaps the hips).
  if (pose === 'jump') {
    limb(72, 126, 46, 178, 16, pants);
    limb(88, 126, 114, 178, 16, pants);
    blob(41, 184, 13, 6.5, shoe, -0.45);
    blob(119, 184, 13, 6.5, shoe, 0.45);
  } else {
    limb(72, 126, 62, 166, 16, pants);
    limb(62, 166, 54, 188, 16, pants);
    limb(88, 126, 98, 166, 16, pants);
    limb(98, 166, 106, 188, 16, pants);
    blob(50, 192, 12, 6, shoe, -0.2);
    blob(110, 192, 12, 6, shoe, 0.2);
  }

  // Jacket torso.
  ctx.fillStyle = suit;
  ctx.beginPath();
  ctx.moveTo(52, 68);
  ctx.quadraticCurveTo(80, 58, 108, 68);
  ctx.lineTo(102, 136);
  ctx.quadraticCurveTo(80, 142, 58, 136);
  ctx.closePath();
  ctx.fill();

  // Open-collar white shirt wedge and lapels.
  ctx.fillStyle = '#f4f7ff';
  ctx.beginPath();
  ctx.moveTo(74, 68);
  ctx.lineTo(86, 68);
  ctx.lineTo(80, 104);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = lapel;
  ctx.beginPath();
  ctx.moveTo(74, 68);
  ctx.lineTo(64, 74);
  ctx.lineTo(72, 102);
  ctx.lineTo(80, 104);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(86, 68);
  ctx.lineTo(96, 74);
  ctx.lineTo(88, 102);
  ctx.lineTo(80, 104);
  ctx.closePath();
  ctx.fill();

  // Tiny rocket pin on the lapel.
  ctx.save();
  ctx.translate(67, 84);
  ctx.rotate(-0.5);
  blob(0, 0, 2.6, 5, '#ff6b4a');
  blob(0, -3.4, 1.6, 2, '#ffd166');
  ctx.restore();

  // Arms.
  if (pose === 'jump') {
    limb(56, 74, 28, 28, 15, suit);
    limb(104, 74, 132, 28, 15, suit);
    blob(24, 21, 8, 8, skin);
    blob(136, 21, 8, 8, skin);
  } else {
    limb(56, 74, 40, 100, 15, suit);
    limb(40, 100, 26, 62, 15, suit);
    limb(104, 74, 120, 100, 15, suit);
    limb(120, 100, 134, 62, 15, suit);
    blob(23, 55, 8, 8, skin);
    blob(137, 55, 8, 8, skin);
  }

  // Head.
  blob(80, 42, 21, 22, skin);
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.ellipse(80, 24, 20, 9, -0.08, 0, Math.PI * 2);
  ctx.fill();
  blob(62, 34, 6, 10, hair, 0.3);
  blob(98, 34, 6, 10, hair, -0.3);

  // Aviator shades.
  ctx.fillStyle = '#0c0f1c';
  ctx.beginPath();
  ctx.roundRect(62, 38, 17, 10, 3);
  ctx.roundRect(81, 38, 17, 10, 3);
  ctx.fill();
  ctx.strokeStyle = '#0c0f1c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(79, 42);
  ctx.lineTo(81, 42);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(159,251,255,0.6)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(65, 41);
  ctx.lineTo(72, 40);
  ctx.stroke();

  // Open-mouth grin.
  ctx.fillStyle = '#7c2f20';
  ctx.beginPath();
  ctx.ellipse(80, 56, 9, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(72.5, 51.5, 15, 4, 2);
  ctx.fill();

  ctx.restore();
}
