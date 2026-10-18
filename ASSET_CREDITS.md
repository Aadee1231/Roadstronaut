# Asset credits

## Original game assets

- `src/game/art/registerArt.ts` draws the car, wheels, thruster, sky gradient, and mountain ridge procedurally; the Phaser scene draws the star field. The registration function and texture keys/sizes are documented in `src/game/art/README.md`.
- `scripts/generate-audio.mjs` synthesizes the music and sound effects used under `public/audio/`. The generated audio uses no third-party samples.
- No external car photography, logos, or hot-linked assets are used.

## Third-party software and fonts

- **Phaser 3** — MIT License.
- **Orbitron** and **Rajdhani** — bundled through `@fontsource`; SIL Open Font License 1.1. Fonts are served from the project bundle, not Google Fonts.
- **Supabase JavaScript client** — MIT License; used by server-side code only.
- **Vite**, **Vitest**, and **Playwright** — open-source development/build/test tools; see their package licenses for details.

ROADSTRONAUT is an unofficial fan-inspired game and is not affiliated with any automaker.
