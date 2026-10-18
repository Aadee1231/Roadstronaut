# Procedural art module

All artwork is original and drawn procedurally with Canvas2D at boot (`registerArt(scene)`), then uploaded as Phaser textures. Background silhouettes are drawn white and tinted per biome by the renderer (`src/game/biomes.ts`).

| Texture key | Size (px) | Use |
| --- | ---: | --- |
| `car-body` | 512 × 192 | VX-1 body (2× supersampled 256×96 logical, nose right; see `CAR_ART` for wheel anchors) |
| `car-wheel` | 128 × 128 | Rotating turbine wheel |
| `thruster-flame` | 128 × 48 | Rocket flame, nozzle at the right edge |
| `spark`, `smoke`, `glow` | 32 / 64 / 128 | Particle and glow sprites (white, tinted at runtime) |
| `bg-sky-{0..3}` | 8 × 512 | Per-biome sky gradients |
| `bg-stars` | 1024 × 512 | Tileable star field |
| `bg-sun` | 512 × 512 | Striped synth sun |
| `bg-mountains` | 1024 × 256 | Tileable two-ridge mountains |
| `bg-skyline`, `bg-skyline-lights` | 1024 × 320 | Tileable city silhouettes + matching window lights |
| `bg-structures`, `bg-beacons` | 1024 × 320 | Test-facility towers/dishes + beacon glows |
| `bg-haze` | 8 × 256 | Horizon haze gradient |
