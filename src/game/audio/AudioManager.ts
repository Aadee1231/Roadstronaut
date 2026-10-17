import type Phaser from 'phaser';
import type { SimEvent, SimulationState } from '../../sim/simulation';

const MUSIC: Record<'menu' | 'game', string> = {
  menu: '/audio/music-menu.mp3',
  game: '/audio/music-main.mp3',
};

const SOUND: Record<string, string> = {
  engine: '/audio/sfx-engine-loop.mp3',
  wind: '/audio/sfx-air-wind-loop.mp3',
  jump: '/audio/sfx-jump.mp3',
  superLaunch: '/audio/sfx-super-launch.mp3',
  rocket: '/audio/sfx-rocket.mp3',
  flip: '/audio/sfx-flip.mp3',
  land: '/audio/sfx-land.mp3',
  perfect: '/audio/sfx-perfect.mp3',
  combo: '/audio/sfx-combo-up.mp3',
  nearMiss: '/audio/sfx-near-miss.mp3',
  crash: '/audio/sfx-crash.mp3',
  click: '/audio/sfx-ui-click.mp3',
  hover: '/audio/sfx-ui-hover.mp3',
  newBest: '/audio/sfx-new-best.mp3',
};

export class AudioManager {
  private unlocked = false;
  private muted = false;
  private currentMusic: HTMLAudioElement | null = null;
  private engine: HTMLAudioElement | null = null;
  private wind: HTMLAudioElement | null = null;
  private readonly effects = new Map<string, HTMLAudioElement>();
  private readonly activeEffects = new Set<HTMLAudioElement>();
  private readonly onUnlock = (): void => { void this.unlock(); };

  constructor(private readonly events: Phaser.Events.EventEmitter) {
    try { this.muted = localStorage.getItem('thrustshift.muted') === 'true'; } catch { this.muted = false; }
    document.addEventListener('pointerdown', this.onUnlock, { once: true, passive: true, capture: true });
    document.addEventListener('keydown', this.onUnlock, { once: true });
    this.events.on('run-start', () => this.playMusic('game'));
    this.events.on('run-quit', () => this.playMusic('menu'));
    this.events.on('audio-mute', (muted: boolean) => this.setMuted(muted));
    this.events.on('ui-sound', (key: string) => this.play(key));
    this.events.on('run-new-best', () => this.play('newBest'));
    this.events.on('run-state', (state: SimulationState, list: readonly SimEvent[]) => this.onSimulation(state, list));
    this.events.on('run-finished', () => {
      this.stopLoop(this.engine);
      this.stopLoop(this.wind);
      this.play('crash');
    });
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onUnlock, true);
    document.removeEventListener('keydown', this.onUnlock);
    this.currentMusic?.pause();
    this.stopLoop(this.engine);
    this.stopLoop(this.wind);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.currentMusic) this.currentMusic.volume = muted ? 0 : 0.28;
    if (this.engine) this.engine.volume = muted ? 0 : 0.12;
    if (this.wind) this.wind.volume = muted ? 0 : 0.1;
    for (const effect of this.activeEffects) effect.volume = muted ? 0 : Number(effect.dataset.level ?? 0.42);
  }

  private async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;
    await this.playMusic('menu');
  }

  private async playMusic(which: 'menu' | 'game'): Promise<void> {
    if (!this.unlocked || this.currentMusic?.src.endsWith(MUSIC[which])) return;
    this.currentMusic?.pause();
    const music = new Audio(MUSIC[which]);
    music.loop = true;
    music.preload = 'auto';
    music.volume = this.muted ? 0 : 0.28;
    this.currentMusic = music;
    try { await music.play(); } catch { this.unlocked = false; }
  }

  private onSimulation(state: SimulationState, events: readonly SimEvent[]): void {
    if (this.unlocked) {
      if (!state.grounded && !state.crashed) {
        this.startLoop('wind');
        if (this.wind) this.wind.volume = this.muted ? 0 : Math.min(0.18, 0.06 + state.airtime * 0.025);
      } else this.stopLoop(this.wind);
      if (state.grounded && !state.crashed) {
        this.startLoop('engine');
        if (this.engine) {
          this.engine.playbackRate = Math.min(1.55, Math.max(0.75, state.speed / 570));
          this.engine.volume = this.muted ? 0 : 0.12;
        }
      } else this.stopLoop(this.engine);
    }
    for (const event of events) {
      if (event.type === 'jump') this.play('jump');
      else if (event.type === 'superLaunch') { this.play('superLaunch'); this.play('rocket'); }
      else if (event.type === 'flipComplete') this.play('flip');
      else if (event.type === 'land') this.play(event.quality === 'perfect' ? 'perfect' : 'land');
      else if (event.type === 'nearMiss') this.play('nearMiss');
      else if (event.type === 'comboUp') this.play('combo');
      else if (event.type === 'crash') this.play('crash');
    }
  }

  private play(key: string): void {
    if (!this.unlocked || this.muted) return;
    const base = this.effects.get(key) ?? new Audio(SOUND[key]);
    this.effects.set(key, base);
    const effect = base.cloneNode(true) as HTMLAudioElement;
    const volume = key === 'crash' ? 0.62 : 0.42;
    effect.dataset.level = String(volume);
    effect.volume = this.muted ? 0 : volume;
    this.activeEffects.add(effect);
    effect.addEventListener('ended', () => this.activeEffects.delete(effect), { once: true });
    void effect.play().catch(() => undefined);
  }

  private startLoop(key: 'engine' | 'wind'): void {
    const url = SOUND[key];
    let audio = key === 'engine' ? this.engine : this.wind;
    if (!audio) {
      audio = new Audio(url);
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = this.muted ? 0 : key === 'engine' ? 0.12 : 0.1;
      if (key === 'engine') this.engine = audio;
      else this.wind = audio;
    }
    if (audio.paused) void audio.play().catch(() => undefined);
  }

  private stopLoop(audio: HTMLAudioElement | null): void {
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
    }
  }
}
