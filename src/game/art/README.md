# Procedural art module

All generated canvas textures are registered by `registerArt(scene)` in `registerArt.ts`. Scene code uses these keys only; replace or polish drawings here without changing the renderer.

| Texture key | Canvas size | Intended use |
| --- | ---: | --- |
| `car-body` | 180 × 76 | VX-1 body, nose points right |
| `car-wheel` | 44 × 44 | Shared rear/front wheel |
| `thruster-flame` | 90 × 36 | Cyan/coral boost trail |
| `sky-gradient` | 1024 × 720 | Dusk sky backdrop |
| `mountain-ridge` | 1024 × 260 | Parallax skyline and city silhouette |

Textures are original, procedurally drawn Canvas2D artwork.
