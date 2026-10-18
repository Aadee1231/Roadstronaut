# THRUSTSHIFT

**FLIP. FLY. SURVIVE.** THRUSTSHIFT is an original endless rocket-car stunt arcade game. Pilot the VX-1 through a neon night drive, leap over hazards, rotate only while airborne, and release to steady your landing.

## Play

- **Jump:** Space, ↑, or tap/click the playfield.
- **Flip:** Press again after takeoff and hold while airborne.
- **Stabilize:** Release thrust before landing.
- **Pause:** Esc or the pause button.

The takeoff press never rotates the car. A held press cannot flip until it has been released and freshly pressed in the air. The thruster is limited by an energy meter; clean landings restore energy. Build combos with flips and precise landings, but unsafe landings end the run.

## Features

- Deterministic 120 Hz simulation, seeded endless course generation, replay encoding, and server-side replay verification.
- Procedural hazard courses tuned for jump reach and recovery time.
- Phaser 3 rendering with responsive portrait/landscape cameras and original canvas-drawn game art.
- DOM menu, tutorial, HUD, pause, results, share flow, and safe text-only leaderboard rendering.
- Original generated synthwave music and effects; bundled Orbitron and Rajdhani fonts.
- Keyboard, pointer, and touch play, with locally persisted nickname, mute preference, and personal best.
- Supabase-backed global leaderboard for deployments and a clearly labeled in-memory local leaderboard for development.

## Development

```sh
npm install
npm run dev
```

Vite serves the game at `http://localhost:5173` and mounts the same API handlers using an in-memory development store. Local scores are temporary and are not global.

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run audio
```

`npm run audio` regenerates the original tracks and sound effects under `public/audio/`.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/sim/` | Deterministic physics, scoring, seeded course, and replay codec |
| `src/game/` | Phaser scenes, renderer, original art, and audio |
| `src/ui/` | DOM overlays, controls, persistence, and leaderboard UI |
| `src/net/` | Browser API client |
| `server/` | Framework-agnostic handlers, store interface, Supabase and memory adapters |
| `api/` | Thin Vercel serverless function wrappers |
| `supabase/migrations/` | Database schema, RLS, and restricted RPCs |
| `tests/` | Simulation/backend unit tests and Playwright browser coverage |

## Leaderboard modes

The local Vite API uses `MemoryStore`; its leaderboard is process-local, resets when the dev server restarts, and is not shared. Production uses Supabase only when both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured. If production has no database configuration, handlers return `503 leaderboard_not_configured`; they do not silently create a fake global board.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Supabase and Vercel setup. Copy `.env.example` for the required server-only variable names. **Do not use a `VITE_` prefix for credentials.**

## Anti-cheat limits

Run tokens are signed, single-use, time-limited, and bound to the anonymous player ID. The server rate-limits submissions, replays the submitted input against the authoritative simulation, and stores only the verified result. This makes casual score editing harder; it is not a competitive anti-cheat system. A determined attacker can run the simulation offline, craft logs or bots, and create new anonymous IDs. There is no account binding, device attestation, or human verification.

## Credits and affiliation

All game art and audio are original procedural work; see [ASSET_CREDITS.md](ASSET_CREDITS.md) for third-party library and font credits. THRUSTSHIFT is an unofficial fan-inspired game and is not affiliated with any automaker.
