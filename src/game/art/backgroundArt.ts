/** Tileable background layers. Silhouettes are drawn white so the renderer can tint them per biome. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drawStars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = rng(7);
  for (let i = 0; i < 240; i += 1) {
    const x = r() * w;
    const y = r() * h;
    const s = r();
    ctx.fillStyle = `rgba(255,255,255,${0.25 + s * 0.75})`;
    const rad = s > 0.93 ? 1.6 : s > 0.7 ? 1.0 : 0.6;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    if (s > 0.975) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
    }
  }
}

export function drawSun(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2;
  const halo = ctx.createRadialGradient(c, c, size * 0.3, c, c, size * 0.5);
  halo.addColorStop(0, 'rgba(255,140,90,0.45)');
  halo.addColorStop(1, 'rgba(255,90,120,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, size, size);
  const g = ctx.createLinearGradient(0, c - size * 0.32, 0, c + size * 0.32);
  g.addColorStop(0, '#fff3b0'); g.addColorStop(0.45, '#ffb347'); g.addColorStop(1, '#ff3d7f');
  ctx.save();
  ctx.beginPath(); ctx.arc(c, c, size * 0.32, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i += 1) ctx.fillRect(0, c + size * 0.03 + i * size * 0.042, size, 1.5 + i * 1.7);
  ctx.restore();
}

type Wave = readonly [freq: number, amp: number, phase: number];
function ridge(x: number, w: number, waves: readonly Wave[]): number {
  let y = 0;
  for (const [f, a, p] of waves) y += Math.sin((x / w) * Math.PI * 2 * f + p) * a;
  return y;
}

export function drawMountains(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const back: Wave[] = [[1, 0.5, 0], [3, 0.3, 1.3], [7, 0.15, 2.1], [13, 0.06, 0.4]];
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(x, h * 0.45 - ridge(x, w, back) * h * 0.32);
  ctx.lineTo(w, h); ctx.fill();
  const front: Wave[] = [[2, 0.5, 0.7], [5, 0.3, 2.0], [11, 0.12, 1.0], [23, 0.05, 0.2]];
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(x, h * 0.68 - ridge(x, w, front) * h * 0.25);
  ctx.lineTo(w, h); ctx.fill();
}

interface Building { x: number; w: number; h: number; v: number; seed: number }
function buildings(w: number, h: number): Building[] {
  const r = rng(11);
  const list: Building[] = [];
  let x = 0;
  while (x < w) {
    const bw = 30 + r() * 70;
    list.push({ x, w: bw, h: h * (0.22 + r() * 0.68), v: r(), seed: Math.floor(r() * 1e9) });
    x += bw + 2 + r() * 6;
  }
  const squeeze = w / x;
  for (const b of list) { b.x *= squeeze; b.w *= squeeze; }
  return list;
}

export function drawSkyline(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#fff';
  for (const b of buildings(w, h)) {
    const y = h - b.h;
    ctx.fillRect(b.x, y, b.w, b.h);
    if (b.v > 0.7) ctx.fillRect(b.x + b.w * 0.45, y - h * 0.08, 2, h * 0.08);
    if (b.v < 0.25) { ctx.beginPath(); ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w / 2, y - h * 0.06); ctx.lineTo(b.x + b.w, y); ctx.fill(); }
  }
}

export function drawSkylineLights(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (const b of buildings(w, h)) {
    const y = h - b.h;
    const r = rng(b.seed);
    for (let wy = y + 6; wy < h - 4; wy += 7) {
      for (let wx = b.x + 4; wx < b.x + b.w - 4; wx += 6) {
        if (r() < 0.3) { ctx.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`; ctx.fillRect(wx, wy, 3, 3); }
      }
    }
    if (b.v > 0.7) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x + b.w * 0.45 + 1, y - h * 0.08, 2.4, 0, Math.PI * 2); ctx.fill(); }
  }
}

export function drawStructures(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  const n = 4;
  const seg = w / n;
  for (let i = 0; i < n; i += 1) {
    const ox = i * seg;
    const tx = ox + seg * 0.15;
    const th = h * (0.7 + (i % 2) * 0.18);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(tx, h); ctx.lineTo(tx + 10, h - th); ctx.moveTo(tx + 40, h); ctx.lineTo(tx + 30, h - th); ctx.stroke();
    ctx.lineWidth = 1.5;
    for (let y = h; y > h - th + 22; y -= 22) {
      ctx.beginPath(); ctx.moveTo(tx + 2, y); ctx.lineTo(tx + 38, y - 22); ctx.moveTo(tx + 38, y); ctx.lineTo(tx + 2, y - 22); ctx.stroke();
    }
    ctx.fillRect(tx + 4, h - th - 8, 32, 8);
    const dx = ox + seg * 0.55;
    const dy = h - h * 0.3;
    ctx.fillRect(dx - 3, dy, 6, h * 0.3);
    ctx.beginPath(); ctx.ellipse(dx, dy - 10, 34, 14, -0.5, 0, Math.PI); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ox + seg * 0.68, h); ctx.quadraticCurveTo(ox + seg * 0.84, h - h * 0.55, ox + seg, h); ctx.fill();
  }
}

/** Beacon dots on top of facility towers, for an additive blinking layer. */
export function drawStructureBeacons(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const n = 4;
  const seg = w / n;
  for (let i = 0; i < n; i += 1) {
    const tx = i * seg + seg * 0.15;
    const th = h * (0.7 + (i % 2) * 0.18);
    const g = ctx.createRadialGradient(tx + 20, h - th - 14, 0, tx + 20, h - th - 14, 12);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(tx + 8, h - th - 26, 24, 24);
  }
}
