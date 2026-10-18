import type Phaser from 'phaser';
import { getLeaderboard, startRun, submitScore, updateNickname, type LeaderboardResponse } from '../net/api';
import type { RunFinished } from '../game/GameScene';
import type { SimulationState } from '../sim/simulation';
import { formatDistance, unitsPerSecondToMph } from '../sim/units';

const KEYS = {
  playerId: 'roadstronaut.playerId',
  nickname: 'roadstronaut.nickname',
  personalBest: 'roadstronaut.personalBest',
  muted: 'roadstronaut.muted',
  tutorial: 'roadstronaut.tutorialSeen',
};

function storageGet(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Storage can be disabled in private browsing. */ }
}

function getPlayerId(): string {
  let id = storageGet(KEYS.playerId);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? createFallbackUuid();
    storageSet(KEYS.playerId, id);
  }
  return id;
}

function createFallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeNickname(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return /^[A-Za-z0-9 _.-]{3,16}$/.test(cleaned) ? cleaned : '';
}

export function landingFeedbackLabels(
  events: readonly { type: string; quality?: string; flips?: number }[],
  hard = events.some((event) => event.type === 'hardLanding'),
): { eventIndex: number; label: string; perfect: boolean }[] {
  const labels: { eventIndex: number; label: string; perfect: boolean }[] = [];
  events.forEach((event, eventIndex) => {
    if (event.type !== 'land') return;
    const flipName = event.flips === 2 ? 'DOUBLE FLIP' : event.flips === 3 ? 'TRIPLE FLIP' : event.flips ? 'FRONT FLIP' : '';
    labels.push({
      eventIndex,
      label: hard
        ? `${flipName ? `${flipName} · ` : ''}HARD LANDING`
        : event.quality === 'perfect' ? 'PERFECT LANDING' : flipName || 'CLEAN LANDING',
      perfect: !hard && event.quality === 'perfect',
    });
  });
  return labels;
}

export class GameUI {
  private readonly playerId = getPlayerId();
  private nickname = storageGet(KEYS.nickname, 'Starman');
  private personalBest = Number(storageGet(KEYS.personalBest, '0')) || 0;
  private muted = storageGet(KEYS.muted) === 'true';
  private currentRunToken = '';
  private lastRunInput = '';
  private mode: LeaderboardResponse['mode'] = 'dev-memory';
  private period: 'all' | 'week' = 'all';
  private gameOverAt = 0;
  private fanRailMessageShown = false;
  private milestoneCount = 0;
  private scoreAnimationFrame = 0;
  private readonly actions: Record<string, (button: HTMLButtonElement) => void>;
  private readonly onGameFinished = (result: RunFinished): void => { void this.finishRun(result); };
  private readonly onPauseRequest = (): void => { if (!this.root.querySelector('#pause-screen')?.classList.contains('is-hidden')) return; this.pause(); };
  private readonly onRunUpdate = (state: SimulationState, events: Parameters<GameUI['showEvents']>[0]): void => {
    this.updateHud(state);
    this.showEvents(events);
  };

  constructor(private readonly root: HTMLElement, private readonly game: Phaser.Game) {
    root.innerHTML = `
      <div class="ui-vignette"></div>
      <section class="screen-panel menu-panel" id="menu-screen" aria-label="Main menu">
        <div class="menu-topline"><button class="icon-button sound-button" data-action="mute" aria-label="Toggle sound"></button></div>
        <h1 class="wordmark">ROAD<span>STRONAUT</span></h1>
        <p class="menu-subtitle">UNOFFICIAL ROADSTER STUNT CHALLENGE</p>
        <p class="tagline">FLIP. FLY. SURVIVE.</p>
        <div class="menu-actions">
          <button class="button button-primary" data-action="play"><span class="button-icon">▶</span> START ENGINE</button>
          <div class="secondary-actions"><button class="button button-ghost" data-action="leaderboard">LEADERBOARD</button><button class="button button-ghost" data-action="howto">HOW TO PLAY</button><button class="button button-ghost" data-action="about">ABOUT</button><button class="button button-ghost paint-button" data-action="paint">PAINT · PROTOTYPE</button></div>
        </div>
        <button class="nickname-chip" data-action="nickname"><span class="online-dot"></span><span class="nickname-label"></span><span class="edit-glyph">EDIT ↗</span></button>
        <div class="menu-bottom"><span>UNOFFICIAL FAN-MADE GAME. NOT AFFILIATED WITH TESLA OR SPACEX.</span><span>BEST <b class="menu-best">000000</b></span></div>
      </section>

      <section class="hud is-hidden" id="hud" aria-label="Game status">
        <div class="hud-top">
          <div class="score-block"><span class="hud-label">DISTANCE SCORE</span><strong id="score-value">000000</strong><span class="combo-label" id="combo-value"></span></div>
          <div class="hud-controls"><button class="icon-button" data-action="mute" aria-label="Toggle sound"></button><button class="icon-button pause-button" data-action="pause" aria-label="Pause">Ⅱ</button></div>
        </div>
        <div class="hud-bottom">
          <div class="resource-panels">
            <div class="energy-panel"><div class="meter-heading"><span>THRUSTER</span><b id="energy-value">100</b></div><div class="energy-track"><div class="energy-fill" id="energy-fill"></div></div></div>
            <div class="energy-panel fan-panel is-hidden" id="fan-panel"><div class="meter-heading"><span>FAN</span><b id="fan-value">100</b></div><div class="energy-track"><div class="energy-fill fan-fill" id="fan-fill"></div></div></div>
          </div>
          <div class="speed-panel"><strong id="speed-value">35</strong><span>MPH</span><small id="distance-value">0 FT</small></div>
        </div>
        <div class="tutorial-hint is-hidden" id="tutorial-hint"></div>
        <div class="feedback-stack" id="feedback-stack" aria-live="polite"></div>
      </section>

      <section class="screen-panel modal-panel is-hidden" id="pause-screen" aria-label="Paused">
        <span class="panel-eyebrow">PIT STOP</span><h2>RUN PAUSED</h2><p>Take a breath. The road can wait.</p>
        <button class="button button-primary" data-action="resume">RESUME RUN</button>
        <div class="secondary-actions"><button class="button button-ghost" data-action="restart">RESTART</button><button class="button button-ghost" data-action="quit">QUIT TO MENU</button></div>
      </section>

      <section class="screen-panel modal-panel is-hidden" id="gameover-screen" aria-label="Run complete">
        <span class="panel-eyebrow">RUN COMPLETE</span><h2>THE ROAD ENDS.<br><em>THE LEGEND DOESN'T.</em></h2>
        <div class="result-score"><strong id="final-score">0</strong><span id="new-best" class="is-hidden">✦ NEW PERSONAL BEST</span></div>
        <div class="result-grid"><div><b id="result-flips">0</b><span>FLIPS</span></div><div><b id="result-best-trick">0</b><span>BEST TRICK</span></div><div><b id="result-combo">0</b><span>MAX COMBO</span></div><div><b id="result-distance">0</b><span>DISTANCE</span></div></div>
        <p class="leaderboard-status" id="submit-status">Verifying run…</p>
        <div class="modal-actions"><button class="button button-primary" data-action="play-again">PLAY AGAIN</button><button class="button button-ghost" data-action="share">SHARE SCORE</button><button class="button button-ghost" data-action="leaderboard">LEADERBOARD</button></div>
      </section>

      <section class="screen-panel modal-panel board-panel is-hidden" id="leaderboard-screen" aria-label="Leaderboard">
        <div class="panel-heading"><div><span class="panel-eyebrow">THE FASTEST IN THE GRID</span><h2>LEADERBOARD</h2></div><button class="icon-button close-button" data-action="close-panel" aria-label="Close">×</button></div>
        <div class="board-badge" id="board-mode"></div>
        <div class="board-tabs"><button class="board-tab is-active" data-action="period-all">ALL-TIME</button><button class="board-tab" data-action="period-week">THIS WEEK</button></div>
        <div class="board-self" id="board-self"></div>
        <div class="board-entries" id="board-entries"><p class="board-empty">Loading drivers…</p></div>
        <button class="button button-ghost board-edit" data-action="nickname">EDIT NICKNAME</button>
      </section>

      <section class="screen-panel modal-panel howto-panel is-hidden" id="howto-screen" aria-label="How to play">
        <div class="panel-heading"><div><span class="panel-eyebrow">FLIGHT SCHOOL</span><h2>STAY ON THRUST</h2></div><button class="icon-button close-button" data-action="close-panel" aria-label="Close">×</button></div>
        <div class="howto-row"><span class="control-key">SPACE<br>↑<br>TAP</span><div><b>JUMP THE LINE</b><p>Tap to jump gaps and hazards. Catch a glowing launch ramp for extra airtime.</p></div></div>
        <div class="howto-row"><span class="control-key">AIR<br>TAP + HOLD</span><div><b>BURST & FLIP</b><p>A fresh tap in the air fires a cold-gas burst. Keep holding to rotate; release to level out.</p></div></div>
        <div class="howto-row"><span class="control-key">RELEASE</span><div><b>STICK THE LANDING</b><p>Let go to stabilize. Hit the ground level for a perfect landing bonus.</p></div></div>
        <div class="howto-row"><span class="control-key">STAY LOW<br>HALF-FLIP</span><div><b>BEAMS & FAN RAILS</b><p>Stay low under overhead beams. Aim upside down to engage suction rails, then half-flip to land upright. Miss the rail? Thrusters auto-right the car.</p></div></div>
        <div class="howto-note"><span>⚡</span> Thruster energy refills on the ground. Clean jumps beat reckless flips.</div>
        <button class="button button-primary" data-action="close-panel">GOT IT</button>
      </section>

      <section class="screen-panel modal-panel about-panel is-hidden" id="about-screen" aria-label="About ROADSTRONAUT">
        <div class="panel-heading"><div><span class="panel-eyebrow">INDEPENDENT GAME PROJECT</span><h2>ABOUT ROADSTRONAUT</h2></div><button class="icon-button close-button" data-action="close-panel" aria-label="Close">×</button></div>
        <p class="about-disclaimer">ROADSTRONAUT is an independent fan-made game inspired by the Tesla Roadster demonstration. It is not affiliated with, sponsored by, or endorsed by Tesla, Inc. or SpaceX. All trademarks belong to their respective owners.</p>
        <div class="about-credits">
          <p><b>ART</b> Original procedural car, wheel, thruster, sky, mountain, and star-field artwork.</p>
          <p><b>AUDIO</b> Original synthesized music and sound effects; no third-party samples.</p>
          <p><b>FONTS</b> Orbitron and Rajdhani, SIL Open Font License 1.1.</p>
          <p><b>ENGINE</b> Phaser 3, MIT License.</p>
        </div>
        <button class="button button-primary" data-action="close-panel">GOT IT</button>
      </section>

      <dialog class="nickname-dialog" id="nickname-dialog">
        <form method="dialog" id="nickname-form"><button type="button" class="icon-button dialog-close" data-action="close-dialog" aria-label="Close">×</button><span class="panel-eyebrow">DRIVER PROFILE</span><h2>CHOOSE YOUR CALLSIGN</h2><label for="nickname-input">3–16 letters, numbers, spaces, . _ -</label><input id="nickname-input" maxlength="16" minlength="3" autocomplete="nickname" /><p class="form-error" id="nickname-error"></p><button class="button button-primary" value="save">SAVE CALLSIGN</button></form>
      </dialog>
    `;

    this.actions = {
      play: () => { void this.beginRun(); },
      'play-again': () => { void this.beginRun(); },
      pause: () => this.pause(),
      resume: () => this.resume(),
      restart: () => { this.hideAllPanels(); void this.beginRun(); },
      quit: () => { this.hideAllPanels(); this.show('menu-screen'); this.hide('hud'); this.game.events.emit('run-quit'); },
      mute: () => this.toggleMute(),
      leaderboard: () => { this.showLeaderboard(); },
      howto: () => this.openHowTo(),
      about: () => this.openAbout(),
      'close-panel': () => { this.hideAllPanels(); this.show('menu-screen'); },
      nickname: () => this.openNickname(),
      'close-dialog': () => this.root.querySelector<HTMLDialogElement>('#nickname-dialog')?.close(),
      share: () => { void this.shareScore(); },
      'period-all': () => { this.period = 'all'; void this.loadLeaderboard(); },
      'period-week': () => { this.period = 'week'; void this.loadLeaderboard(); },
      paint: () => {
        storageSet('roadstronaut.paint', storageGet('roadstronaut.paint', 'prototype') === 'coral' ? 'prototype' : 'coral');
        this.updatePaintButton();
        this.game.events.emit('paint-change');
      },
    };

    root.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.screen-panel, .hud, dialog')) event.stopPropagation();
    });
    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
      if (!button) {
        if ((event.target as HTMLElement).closest('#gameover-screen') && performance.now() - this.gameOverAt >= 600) void this.beginRun();
        return;
      }
      event.stopPropagation();
      this.game.events.emit('ui-sound', 'click');
      this.actions[button.dataset.action ?? '']?.(button);
    });
    root.addEventListener('pointerover', (event) => {
      if ((event.target as HTMLElement).closest('button')) this.game.events.emit('ui-sound', 'hover');
    });
    window.addEventListener('keydown', (event) => {
      if ((event.code === 'Space' || event.code === 'ArrowUp') && !this.root.querySelector('#gameover-screen')?.classList.contains('is-hidden') && performance.now() - this.gameOverAt >= 600) {
        event.preventDefault();
        void this.beginRun();
      }
    });
    root.querySelector('#nickname-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveNickname();
    });
    root.querySelector('#nickname-dialog')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) (event.currentTarget as HTMLDialogElement).close();
    });
    this.game.events.on('run-finished', this.onGameFinished);
    this.game.events.on('pause-request', this.onPauseRequest);
    this.game.events.on('run-state', this.onRunUpdate);
    this.updateNicknameLabels();
    this.updateMuteButtons();
    this.updateBestLabels();
    this.updatePaintButton();
    if (storageGet(KEYS.tutorial) !== 'seen') this.root.dataset.tutorial = 'new';
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private updatePaintButton(): void {
    const coral = storageGet('roadstronaut.paint', 'prototype') === 'coral';
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="paint"]');
    if (button) button.textContent = coral ? 'PAINT · CORAL' : 'PAINT · PROTOTYPE';
  }

  private async beginRun(): Promise<void> {
    this.playing = true;
    this.fanRailMessageShown = false;
    this.milestoneCount = 0;
    this.hideAllPanels();
    this.hide('menu-screen');
    this.hide('gameover-screen');
    this.show('hud');
    this.setTutorial('tap');
    this.currentRunToken = '';
    try {
      const run = await startRun(this.playerId);
      this.currentRunToken = run.runToken;
      this.mode = run.mode;
      this.game.events.emit('run-start', { seed: run.seed });
    } catch {
      const seed = new Uint32Array(1);
      globalThis.crypto?.getRandomValues(seed);
      this.game.events.emit('run-start', { seed: seed[0] || 1 });
    }
  }

  private pause(): void {
    if (this.root.querySelector('#hud')?.classList.contains('is-hidden')) return;
    this.hide('hud');
    this.show('pause-screen');
    this.game.events.emit('run-pause');
    this.playing = false;
  }

  private resume(): void {
    this.hide('pause-screen');
    this.show('hud');
    this.game.events.emit('run-resume');
    this.playing = true;
  }

  private async finishRun(result: RunFinished): Promise<void> {
    this.playing = false;
    this.gameOverAt = performance.now();
    this.lastRunInput = result.inputLog;
    const state = result.state;
    this.hide('hud');
    this.show('gameover-screen');
    this.fillResult(state);
    const newBest = state.stats.score > this.personalBest;
    if (newBest) {
      this.personalBest = state.stats.score;
      storageSet(KEYS.personalBest, String(this.personalBest));
      this.root.querySelector('#new-best')?.classList.remove('is-hidden');
      this.updateBestLabels();
      this.game.events.emit('run-new-best');
    }
    const status = this.root.querySelector<HTMLElement>('#submit-status');
    if (!this.currentRunToken) {
      if (status) status.textContent = 'Local run only — leaderboard unavailable.';
      return;
    }
    if (status) status.textContent = 'Verifying replay…';
    try {
      const accepted = await submitScore({
        runToken: this.currentRunToken,
        playerId: this.playerId,
        nickname: this.nickname,
        inputLog: result.inputLog,
        claimed: {
          score: state.stats.score,
          distance: state.stats.distance,
          flips: state.stats.totalFlips,
          durationMs: Math.round(state.elapsed * 1000),
        },
      });
      const boardLabel = this.mode === 'supabase'
        ? 'GLOBAL GRID'
        : this.mode === 'dev-memory' ? 'LOCAL DEV LEADERBOARD — NOT GLOBAL' : 'LEADERBOARD OFFLINE';
      if (status) status.textContent = accepted.verified ? `Replay verified · rank ${accepted.rankAllTime ?? '—'} · ${boardLabel}` : 'Run could not be verified.';
    } catch (error) {
      if (status) status.textContent = error instanceof Error && error.message.includes('not_configured')
        ? 'Leaderboard offline — not configured.'
        : 'Score not submitted. Your personal best is saved on this device.';
    }
  }

  private fillResult(state: SimulationState): void {
    const values: Record<string, string> = {
      '#result-flips': String(state.stats.totalFlips),
      '#result-best-trick': String(state.stats.bestTrick),
      '#result-combo': String(state.stats.maxCombo),
      '#result-distance': formatDistance(state.stats.distance * 10),
    };
    for (const [selector, value] of Object.entries(values)) {
      const element = this.root.querySelector(selector);
      if (element) element.textContent = value;
    }
    this.animateScore(state.stats.score);
    this.root.querySelector('#new-best')?.classList.add('is-hidden');
  }

  private animateScore(score: number): void {
    cancelAnimationFrame(this.scoreAnimationFrame);
    const started = performance.now();
    const render = (now: number): void => {
      const progress = Math.min(1, (now - started) / 900);
      const eased = 1 - (1 - progress) ** 3;
      this.text('#final-score', Math.round(score * eased).toLocaleString('en-US'));
      if (progress < 1) this.scoreAnimationFrame = requestAnimationFrame(render);
    };
    this.scoreAnimationFrame = requestAnimationFrame(render);
  }

  private updateHud(state: SimulationState): void {
    if (this.root.querySelector('#hud')?.classList.contains('is-hidden')) return;
    this.text('#score-value', state.stats.score.toLocaleString('en-US').padStart(6, '0'));
    this.text('#combo-value', state.combo ? `COMBO ×${Math.min(8, 1 + state.combo * 0.5).toFixed(state.combo % 2 ? 1 : 0)}` : '');
    this.text('#energy-value', String(Math.round(state.energy)));
    this.text('#speed-value', String(Math.round(unitsPerSecondToMph(state.speed))));
    this.text('#distance-value', formatDistance(state.stats.distance * 10));
    const fill = this.root.querySelector<HTMLElement>('#energy-fill');
    if (fill) {
      fill.style.width = `${state.energy}%`;
      fill.classList.toggle('is-empty', state.energy < 15);
    }
    const fanFill = this.root.querySelector<HTMLElement>('#fan-fill');
    if (fanFill) {
      fanFill.style.width = `${state.fan}%`;
      fanFill.classList.toggle('is-empty', state.fan < 15);
    }
    this.text('#fan-value', String(Math.round(state.fan)));
    this.root.querySelector('#fan-panel')?.classList.toggle('is-hidden', !state.fanRailVisible && !state.inverted);
    if (state.fanRailVisible && !this.fanRailMessageShown) {
      this.fanRailMessageShown = true;
      this.addFeedback('FAN RAIL AHEAD — HALF-FLIP TO ENGAGE');
    }
    this.updateTutorial(state);
  }

  showEvents(events: readonly { type: string; quality?: string; flips?: number }[]): void {
    const hard = events.some((event) => event.type === 'hardLanding');
    const landingLabels = new Map(landingFeedbackLabels(events, hard).map((feedback) => [feedback.eventIndex, feedback]));
    events.forEach((event, eventIndex) => {
      if (event.type === 'milestone') {
        this.milestoneCount += 1;
        if (this.milestoneCount % 3 === 0) {
          const messages = ['MISSION CONTROL: FLIGHT PATH GREEN', 'TELEMETRY LOOKS GOOD, DRIVER', 'TRACKING A CLEAN BURN', 'BOOST WINDOW CONFIRMED'];
          this.addFeedback(messages[(this.milestoneCount / 3 - 1) % messages.length] ?? messages[0]);
        }
        return;
      }
      if (event.type === 'hardLanding') return;
      const landingFeedback = landingLabels.get(eventIndex);
      const label = landingFeedback?.label
        ?? (event.type === 'nearMiss' ? 'NEAR MISS'
            : event.type === 'superLaunch' ? 'SUPER LAUNCH'
            : event.type === 'suctionEngage' ? 'SUCTION ENGAGED'
              : event.type === 'railRecovery' ? 'AUTO-RECOVER'
              : event.type === 'thrusterBurst' ? 'THRUSTER BURST'
              : event.type === 'verticalRunApproach' ? 'VERTICAL RUN'
              : event.type === 'verticalSuction' ? 'SUCTION ENGAGED'
              : event.type === 'thrustersArmed' ? 'THRUSTERS ARMED'
              : event.type === 'verticalRunLanded' ? 'VERTICAL RUN +1500'
                : event.type === 'crash' ? 'RUN ENDED' : '');
      if (!label) return;
      this.addFeedback(label, landingFeedback?.perfect ?? false);
    });
  }

  private addFeedback(label: string, perfect = false): void {
    const item = document.createElement('div');
    item.className = `feedback-item ${perfect ? 'feedback-perfect' : ''}`;
    item.textContent = label;
    this.root.querySelector('#feedback-stack')?.append(item);
    window.setTimeout(() => item.remove(), 1550);
  }

  private updateTutorial(state: SimulationState): void {
    if (storageGet(KEYS.tutorial) === 'seen') return;
    if (state.elapsed > 2 && state.elapsed < 7 && state.grounded) this.setTutorial('tap');
    if (!state.grounded && state.elapsed > 2) this.setTutorial('hold');
    if (state.elapsed > 8) {
      this.setTutorial('');
      storageSet(KEYS.tutorial, 'seen');
    }
  }

  private setTutorial(which: 'tap' | 'hold' | ''): void {
    const hint = this.root.querySelector<HTMLElement>('#tutorial-hint');
    if (!hint) return;
    hint.textContent = which === 'tap' ? 'TAP / SPACE TO JUMP' : which === 'hold' ? 'IN THE AIR: PRESS & HOLD TO FLIP · RELEASE TO LEVEL' : '';
    hint.classList.toggle('is-hidden', !which);
  }

  private async showLeaderboard(): Promise<void> {
    this.hideAllPanels();
    this.hide('menu-screen');
    this.hide('gameover-screen');
    this.hide('pause-screen');
    this.show('leaderboard-screen');
    await this.loadLeaderboard();
  }

  private async loadLeaderboard(): Promise<void> {
    this.text('#board-entries', '');
    const entries = this.root.querySelector<HTMLElement>('#board-entries');
    if (entries) entries.textContent = 'Loading drivers…';
    try {
      const board = await getLeaderboard(this.period, this.playerId);
      this.mode = board.mode;
      this.text('#board-mode', board.mode === 'supabase'
        ? 'GLOBAL GRID · VERIFIED RUNS'
        : board.mode === 'dev-memory' ? 'LOCAL DEV LEADERBOARD — NOT GLOBAL' : 'LEADERBOARD OFFLINE');
      this.renderLeaderboard(board);
    } catch (error) {
      this.text('#board-mode', 'LEADERBOARD OFFLINE');
      if (entries) entries.textContent = error instanceof Error && error.message.includes('not_configured') ? 'Leaderboard offline — not configured.' : 'Leaderboard unavailable. Check your connection and retry.';
      this.text('#board-self', '');
    }
    this.root.querySelector('[data-action="period-all"]')?.classList.toggle('is-active', this.period === 'all');
    this.root.querySelector('[data-action="period-week"]')?.classList.toggle('is-active', this.period === 'week');
  }

  private renderLeaderboard(board: LeaderboardResponse): void {
    const container = this.root.querySelector<HTMLElement>('#board-entries');
    if (!container) return;
    container.textContent = '';
    if (!board.entries.length) {
      container.textContent = 'No verified runs yet. Set the first record.';
    } else {
      for (const entry of board.entries.slice(0, 50)) {
        const row = document.createElement('div');
        row.className = `board-row${entry.isYou ? ' is-you' : ''}`;
        const rank = document.createElement('span');
        rank.className = 'board-rank';
        rank.textContent = String(entry.rank).padStart(2, '0');
        const name = document.createElement('span');
        name.className = 'board-name';
        name.textContent = entry.nickname;
        const detail = document.createElement('span');
        detail.className = 'board-flips';
        detail.textContent = `${entry.flips} FLIP${entry.flips === 1 ? '' : 'S'}`;
        const score = document.createElement('span');
        score.className = 'board-score';
        score.textContent = entry.score.toLocaleString('en-US');
        row.append(rank, name, detail, score);
        container.append(row);
      }
    }
    this.text('#board-self', board.you ? `YOUR BEST  ${board.you.best.toLocaleString('en-US')}  ·  RANK ${board.you.rank ?? '—'}` : 'YOUR BEST  —');
  }

  private openHowTo(): void {
    this.hide('menu-screen');
    this.show('howto-screen');
  }

  private openAbout(): void {
    this.hide('menu-screen');
    this.show('about-screen');
  }

  private openNickname(): void {
    const dialog = this.root.querySelector<HTMLDialogElement>('#nickname-dialog');
    const input = this.root.querySelector<HTMLInputElement>('#nickname-input');
    const error = this.root.querySelector<HTMLElement>('#nickname-error');
    if (input) input.value = this.nickname;
    if (error) error.textContent = '';
    dialog?.showModal();
    input?.focus();
  }

  private async saveNickname(): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>('#nickname-input');
    const error = this.root.querySelector<HTMLElement>('#nickname-error');
    const nickname = safeNickname(input?.value ?? '');
    if (!nickname) {
      if (error) error.textContent = 'Use 3–16 letters, numbers, spaces, dot, dash, or underscore.';
      return;
    }
    this.nickname = nickname;
    storageSet(KEYS.nickname, nickname);
    this.updateNicknameLabels();
    try { await updateNickname(this.playerId, nickname); } catch { /* Dev play and profile remain available offline. */ }
    this.root.querySelector<HTMLDialogElement>('#nickname-dialog')?.close();
  }

  private async shareScore(): Promise<void> {
    const score = this.root.querySelector('#final-score')?.textContent ?? '0';
    const text = `I scored ${score} in ROADSTRONAUT — FLIP. FLY. SURVIVE.`;
    try {
      if (navigator.share) await navigator.share({ title: 'ROADSTRONAUT', text, url: location.href });
      else {
        await navigator.clipboard.writeText(`${text} ${location.href}`);
        this.text('#submit-status', 'Score link copied to clipboard.');
      }
    } catch { /* Sharing is optional and may be dismissed by the player. */ }
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    storageSet(KEYS.muted, String(this.muted));
    this.updateMuteButtons();
    this.game.events.emit('audio-mute', this.muted);
  }

  private updateMuteButtons(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="mute"]').forEach((button) => {
      button.textContent = this.muted ? '♪̸' : '♪';
      button.classList.toggle('is-muted', this.muted);
      button.setAttribute('aria-label', this.muted ? 'Unmute sound' : 'Mute sound');
    });
  }

  private updateNicknameLabels(): void {
    this.root.querySelectorAll<HTMLElement>('.nickname-label').forEach((element) => { element.textContent = this.nickname; });
  }

  private updateBestLabels(): void {
    this.text('.menu-best', this.personalBest.toLocaleString('en-US').padStart(6, '0'));
  }

  private text(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  }

  private show(id: string): void { this.root.querySelector(`#${id}`)?.classList.remove('is-hidden'); }
  private hide(id: string): void { this.root.querySelector(`#${id}`)?.classList.add('is-hidden'); }

  private hideAllPanels(): void {
    for (const id of ['pause-screen', 'gameover-screen', 'leaderboard-screen', 'howto-screen', 'about-screen']) this.hide(id);
  }

  private playing = false;

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.playing) this.pause();
  };

  private readonly _unusedEventType?: never;
}
