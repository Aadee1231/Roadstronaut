export interface Biome {
  name: string;
  sky: readonly [number, number, number];
  stars: number;
  sun: number;
  mountain: number;
  skyline: number;
  skylineAlpha: number;
  lights: number;
  structures: number;
  structuresAlpha: number;
  haze: number;
  ground: number;
  groundEdge: number;
  accent: number;
}

export const BIOMES: readonly Biome[] = [
  { name: 'DUSK', sky: [0x1a0b45, 0x6a2a8f, 0xff7a52], stars: 0.3, sun: 1, mountain: 0x3b1a66, skyline: 0x24104a, skylineAlpha: 1, lights: 0xffb347, structures: 0x1c2a66, structuresAlpha: 0, haze: 0xff7a52, ground: 0x150a2e, groundEdge: 0xff6b4a, accent: 0x2ef2ff },
  { name: 'NEON CITY', sky: [0x090a2e, 0x3a1a7a, 0xc23a8f], stars: 0.5, sun: 0.55, mountain: 0x2a1650, skyline: 0x170d3a, skylineAlpha: 1, lights: 0x2ef2ff, structures: 0x1c2a66, structuresAlpha: 0, haze: 0xff3df2, ground: 0x0f0a28, groundEdge: 0xff3df2, accent: 0x2ef2ff },
  { name: 'TEST FACILITY', sky: [0x03041a, 0x0d1442, 0x1f3a7a], stars: 1, sun: 0, mountain: 0x111a40, skyline: 0x0d1433, skylineAlpha: 0, lights: 0x2ef2ff, structures: 0x1c2a66, structuresAlpha: 1, haze: 0x2e8bff, ground: 0x070a1e, groundEdge: 0x2ef2ff, accent: 0xffb347 },
  { name: 'HYPERDRIVE', sky: [0x05010f, 0x3a0a5a, 0xff2e7a], stars: 1, sun: 0, mountain: 0x24083d, skyline: 0x14052a, skylineAlpha: 0.9, lights: 0xff6b4a, structures: 0x1a0530, structuresAlpha: 0.8, haze: 0xff2e7a, ground: 0x0b0216, groundEdge: 0xffb347, accent: 0x2ef2ff },
];

/** World distance per biome and crossfade length. */
export const BIOME_LENGTH = 9000;
export const BIOME_FADE = 1800;

export function biomeIndexAt(x: number): { a: number; b: number; t: number } {
  const span = Math.max(0, x) / BIOME_LENGTH;
  const i = Math.floor(span);
  const local = (span - i) * BIOME_LENGTH;
  const order = (n: number): number => (n < BIOMES.length ? n : 1 + ((n - 1) % (BIOMES.length - 1)));
  const a = order(i);
  const b = order(i + 1);
  const fadeStart = BIOME_LENGTH - BIOME_FADE;
  const t = local > fadeStart ? (local - fadeStart) / BIOME_FADE : 0;
  return { a, b, t: t * t * (3 - 2 * t) };
}

export function lerpColor(c1: number, c2: number, t: number): number {
  const r = ((c1 >> 16) & 255) + ((((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * t);
  const g = ((c1 >> 8) & 255) + ((((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * t);
  const b = (c1 & 255) + (((c2 & 255) - (c1 & 255)) * t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function blendBiome(x: number): Biome & { index: number; next: number; t: number } {
  const { a, b, t } = biomeIndexAt(x);
  const A = BIOMES[a]!;
  const B = BIOMES[b]!;
  return {
    name: t < 0.5 ? A.name : B.name,
    sky: [lerpColor(A.sky[0], B.sky[0], t), lerpColor(A.sky[1], B.sky[1], t), lerpColor(A.sky[2], B.sky[2], t)],
    stars: lerp(A.stars, B.stars, t),
    sun: lerp(A.sun, B.sun, t),
    mountain: lerpColor(A.mountain, B.mountain, t),
    skyline: lerpColor(A.skyline, B.skyline, t),
    skylineAlpha: lerp(A.skylineAlpha, B.skylineAlpha, t),
    lights: lerpColor(A.lights, B.lights, t),
    structures: lerpColor(A.structures, B.structures, t),
    structuresAlpha: lerp(A.structuresAlpha, B.structuresAlpha, t),
    haze: lerpColor(A.haze, B.haze, t),
    ground: lerpColor(A.ground, B.ground, t),
    groundEdge: lerpColor(A.groundEdge, B.groundEdge, t),
    accent: lerpColor(A.accent, B.accent, t),
    index: a,
    next: b,
    t,
  };
}
