/** Car art in a 256×96 logical space, nose pointing right. Wheel centres at (62,72) and (196,72), radius 21. */
export const CAR_ART = {
  width: 256,
  height: 96,
  rearWheelX: 62,
  frontWheelX: 196,
  wheelY: 72,
  wheelRadius: 21,
} as const;

export function drawCarBody(ctx: CanvasRenderingContext2D, scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  const ug = ctx.createRadialGradient(130, 80, 4, 130, 80, 100);
  ug.addColorStop(0, 'rgba(46,242,255,0.3)');
  ug.addColorStop(1, 'rgba(46,242,255,0)');
  ctx.fillStyle = ug;
  ctx.beginPath(); ctx.ellipse(130, 80, 96, 6, 0, 0, Math.PI * 2); ctx.fill();

  const body = new Path2D();
  body.moveTo(12, 66);
  body.bezierCurveTo(10, 56, 12, 48, 18, 44);
  body.lineTo(40, 41);
  body.bezierCurveTo(70, 36, 92, 24, 124, 22);
  body.bezierCurveTo(146, 21, 160, 26, 178, 36);
  body.bezierCurveTo(204, 44, 230, 50, 246, 57);
  body.bezierCurveTo(250, 59, 250, 65, 245, 67);
  body.lineTo(222, 71);
  body.arc(196, 72, 25, -0.05, Math.PI + 0.05, true);
  body.lineTo(88, 73);
  body.arc(62, 72, 25, -0.05, Math.PI + 0.05, true);
  body.lineTo(18, 72);
  body.closePath();

  const paint = ctx.createLinearGradient(0, 20, 0, 74);
  paint.addColorStop(0, '#ffd2b8');
  paint.addColorStop(0.18, '#ff7a52');
  paint.addColorStop(0.55, '#e6402c');
  paint.addColorStop(0.85, '#8e1a2a');
  paint.addColorStop(1, '#3a0b1e');
  ctx.fillStyle = paint;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);
  const sheen = ctx.createLinearGradient(20, 0, 250, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,240,230,0.28)');
  sheen.addColorStop(0.58, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 256, 96);
  const sill = ctx.createLinearGradient(0, 58, 0, 74);
  sill.addColorStop(0, 'rgba(20,6,30,0)');
  sill.addColorStop(0.35, 'rgba(20,6,30,0.85)');
  sill.addColorStop(1, '#0d0618');
  ctx.fillStyle = sill;
  ctx.beginPath(); ctx.moveTo(0, 64); ctx.bezierCurveTo(90, 58, 170, 58, 256, 64); ctx.lineTo(256, 96); ctx.lineTo(0, 96); ctx.fill();
  ctx.fillStyle = '#12061c';
  ctx.beginPath(); ctx.moveTo(96, 50); ctx.bezierCurveTo(112, 46, 130, 46, 142, 50); ctx.lineTo(136, 60); ctx.bezierCurveTo(124, 57, 110, 57, 100, 60); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(46,242,255,0.9)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(100, 60); ctx.bezierCurveTo(110, 57, 124, 57, 136, 60); ctx.stroke();
  ctx.restore();

  const glass = new Path2D();
  glass.moveTo(70, 38);
  glass.bezierCurveTo(90, 28, 106, 25, 124, 25);
  glass.bezierCurveTo(144, 24, 158, 29, 172, 37);
  glass.bezierCurveTo(150, 40, 110, 42, 78, 42);
  glass.closePath();
  const gg = ctx.createLinearGradient(80, 24, 150, 44);
  gg.addColorStop(0, '#1a0f3d'); gg.addColorStop(0.45, '#3b2a8a'); gg.addColorStop(0.7, '#6fd6ff'); gg.addColorStop(1, '#14103a');
  ctx.fillStyle = gg; ctx.fill(glass);
  ctx.save(); ctx.clip(glass);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.moveTo(98, 24); ctx.lineTo(112, 24); ctx.lineTo(96, 44); ctx.lineTo(84, 44); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.moveTo(118, 24); ctx.lineTo(124, 24); ctx.lineTo(108, 44); ctx.lineTo(102, 44); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(10,4,20,0.9)'; ctx.lineWidth = 1.5; ctx.stroke(glass);
  ctx.strokeStyle = 'rgba(10,4,20,0.8)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(134, 25); ctx.lineTo(128, 41); ctx.stroke();

  ctx.strokeStyle = 'rgba(255,236,220,0.85)'; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(24, 46); ctx.bezierCurveTo(80, 44, 160, 42, 238, 56); ctx.stroke();
  ctx.strokeStyle = 'rgba(60,8,20,0.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(150, 41); ctx.bezierCurveTo(152, 52, 150, 62, 146, 70); ctx.stroke();

  ctx.fillStyle = '#16081f';
  ctx.beginPath(); ctx.moveTo(26, 42); ctx.lineTo(30, 34); ctx.lineTo(33, 34); ctx.lineTo(33, 42); ctx.fill();
  const wing = ctx.createLinearGradient(0, 28, 0, 36);
  wing.addColorStop(0, '#2a1240'); wing.addColorStop(1, '#0d0618');
  ctx.fillStyle = wing;
  ctx.beginPath(); ctx.moveTo(8, 32); ctx.bezierCurveTo(20, 28, 40, 28, 52, 31); ctx.lineTo(50, 35); ctx.bezierCurveTo(36, 33, 20, 34, 9, 36); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#ff6b4a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, 32.5); ctx.bezierCurveTo(22, 29, 40, 29, 51, 31.5); ctx.stroke();

  ctx.shadowColor = '#ff2e4d'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#ff3b5c'; ctx.beginPath(); ctx.roundRect(12, 47, 6, 9, 2); ctx.fill();
  ctx.shadowBlur = 0;
  const nz = ctx.createLinearGradient(0, 54, 0, 66);
  nz.addColorStop(0, '#5a5f73'); nz.addColorStop(0.5, '#c9d2e6'); nz.addColorStop(1, '#3a3e4f');
  ctx.fillStyle = nz; ctx.beginPath(); ctx.moveTo(4, 55); ctx.lineTo(16, 57); ctx.lineTo(16, 65); ctx.lineTo(4, 67); ctx.closePath(); ctx.fill();
  ctx.shadowColor = '#2ef2ff'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#9ffbff'; ctx.beginPath(); ctx.ellipse(4.5, 61, 1.8, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  ctx.shadowColor = '#bffcff'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#e9feff';
  ctx.beginPath(); ctx.moveTo(222, 52); ctx.lineTo(244, 58); ctx.lineTo(242, 60.5); ctx.lineTo(220, 54.5); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = '#2ef2ff'; ctx.shadowBlur = 6;
  ctx.strokeStyle = '#2ef2ff'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(90, 71); ctx.lineTo(170, 71); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(224, 69); ctx.lineTo(244, 65.5); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = 'italic 700 8px Orbitron, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,240,230,0.85)';
  ctx.fillText('VX-1', 160, 62);
  for (const cx of [62, 196]) {
    const wg = ctx.createRadialGradient(cx, 72, 18, cx, 72, 25);
    wg.addColorStop(0, 'rgba(0,0,0,0)'); wg.addColorStop(1, 'rgba(0,0,0,0.55)');
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
