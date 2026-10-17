import Phaser from 'phaser';
import { FIXED_DT } from '../sim/constants';
import { encodeInputLog } from '../sim/replay';
import { Simulation } from '../sim/simulation';
import type { SimEvent } from '../sim/simulation';
import { SeededRng } from '../sim/rng';
import { registerArt } from './art/registerArt';

export interface RunFinished {
  state: Simulation['state'];
  inputLog: string;
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    registerArt(this);
    this.scene.start('game');
  }
}

export class GameScene extends Phaser.Scene {
  private simulation = new Simulation(1);
  private accumulator = 0;
  private inputHeld = false;
  private pointerHeld = false;
  private keyboardHeld = false;
  private activeRun = false;
  private finishedRun = false;
  private attractMode = true;
  private readonly inputLog: boolean[] = [];
  private readonly frameEvents: SimEvent[] = [];
  private previousX = 0;
  private previousY = 0;
  private previousAngle = 0;
  private sky!: Phaser.GameObjects.TileSprite;
  private skyline!: Phaser.GameObjects.TileSprite;
  private worldGraphics!: Phaser.GameObjects.Graphics;
  private wheelRear!: Phaser.GameObjects.Image;
  private wheelFront!: Phaser.GameObjects.Image;
  private carBody!: Phaser.GameObjects.Image;
  private flame!: Phaser.GameObjects.Image;
  private carGlow!: Phaser.GameObjects.Arc;
  private carContainer!: Phaser.GameObjects.Container;
  private readonly stars: { x: number; y: number; r: number; a: number }[] = [];

  constructor() {
    super('game');
  }

  create(): void {
    this.sky = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, 'sky-gradient')
      .setOrigin(0).setScrollFactor(0).setDepth(-100);
    this.skyline = this.add.tileSprite(0, this.scale.height * 0.48, this.scale.width * 1.4, this.scale.height * 0.5, 'mountain-ridge')
      .setOrigin(0, 0).setScrollFactor(0).setDepth(-90).setAlpha(0.88);
    this.worldGraphics = this.add.graphics().setDepth(2);
    this.flame = this.add.image(-42, 14, 'thruster-flame').setOrigin(1, 0.5).setScale(0.8).setDepth(5).setVisible(false);
    this.carGlow = this.add.circle(0, 0, 72, 0x2ef2ff, 0.1).setDepth(4);
    this.wheelRear = this.add.image(-42, 17, 'car-wheel').setScale(0.68).setDepth(6);
    this.wheelFront = this.add.image(43, 17, 'car-wheel').setScale(0.68).setDepth(6);
    this.carBody = this.add.image(0, 0, 'car-body').setScale(0.74).setDepth(7);
    this.carContainer = this.add.container(0, 0, [this.carGlow, this.flame, this.wheelRear, this.wheelFront, this.carBody]).setDepth(5);
    const rng = new SeededRng(3041);
    for (let i = 0; i < 72; i += 1) this.stars.push({ x: rng.range(0, 1), y: rng.range(0.04, 0.68), r: rng.range(0.7, 2), a: rng.range(0.2, 0.75) });

    this.scale.on('resize', this.resizeScene, this);
    this.resizeScene(this.scale.gameSize);
    this.game.events.on('run-start', this.startRun, this);
    this.game.events.on('run-pause', this.pauseRun, this);
    this.game.events.on('run-resume', this.resumeRun, this);
    this.game.events.on('run-quit', this.quitRun, this);
    this.game.events.on('run-restart', this.startRun, this);

    this.input.keyboard?.on('keydown-SPACE', this.pressKeyboard, this);
    this.input.keyboard?.on('keyup-SPACE', this.releaseKeyboard, this);
    this.input.keyboard?.on('keydown-UP', this.pressKeyboard, this);
    this.input.keyboard?.on('keyup-UP', this.releaseKeyboard, this);
    this.input.keyboard?.on('keydown-ESC', () => this.game.events.emit('pause-request'), this);
    this.input.on('pointerdown', () => { this.pointerHeld = true; });
    this.input.on('pointerup', () => { this.pointerHeld = false; });
    this.input.on('pointerupoutside', () => { this.pointerHeld = false; });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off('run-start', this.startRun, this);
      this.game.events.off('run-pause', this.pauseRun, this);
      this.game.events.off('run-resume', this.resumeRun, this);
      this.game.events.off('run-quit', this.quitRun, this);
      this.game.events.off('run-restart', this.startRun, this);
    });
    this.startAttractMode();
  }

  update(_time: number, delta: number): void {
    if (!this.activeRun && !this.attractMode) {
      this.drawScene();
      return;
    }
    const cappedDelta = Math.min(80, delta);
    this.accumulator += cappedDelta / 1000;
    this.frameEvents.length = 0;
    while (this.accumulator >= FIXED_DT) {
      this.previousX = this.simulation.state.x;
      this.previousY = this.simulation.state.y;
      this.previousAngle = this.simulation.state.angle;
      const held = this.activeRun ? (this.pointerHeld || this.keyboardHeld) : this.attractInput();
      this.inputHeld = held;
      this.simulation.step(held);
      if (this.activeRun) this.inputLog.push(held);
      for (const event of this.simulation.events) this.frameEvents.push(event);
      this.accumulator -= FIXED_DT;
      if (this.activeRun && this.simulation.state.crashed && !this.finishedRun) {
        this.finishedRun = true;
        this.activeRun = false;
        const result: RunFinished = { state: this.simulation.state, inputLog: encodeInputLog(this.inputLog) };
        this.game.events.emit('run-finished', result);
      }
    }
    if (this.activeRun) this.game.events.emit('run-state', this.simulation.state, this.frameEvents);
    this.drawScene();
  }

  private startRun(options?: { seed?: number }): void {
    const seedArray = new Uint32Array(1);
    globalThis.crypto?.getRandomValues(seedArray);
    const seed = options?.seed ?? seedArray[0] ?? Math.floor(performance.now() * 1000);
    this.simulation = new Simulation(seed);
    this.inputLog.length = 0;
    this.accumulator = 0;
    this.activeRun = true;
    this.finishedRun = false;
    this.attractMode = false;
    this.pointerHeld = false;
    this.keyboardHeld = false;
  }

  private startAttractMode(): void {
    this.simulation = new Simulation(42);
    this.activeRun = false;
    this.finishedRun = false;
    this.attractMode = true;
  }

  private pauseRun(): void {
    this.activeRun = false;
    this.pointerHeld = false;
    this.keyboardHeld = false;
  }

  private resumeRun(): void {
    if (!this.simulation.state.crashed) this.activeRun = true;
  }

  private quitRun(): void {
    this.startAttractMode();
  }

  private pressKeyboard(event: KeyboardEvent): void {
    event.preventDefault();
    this.keyboardHeld = true;
  }

  private releaseKeyboard(): void {
    this.keyboardHeld = false;
  }

  private attractInput(): boolean {
    if (!this.attractMode || !this.simulation.state.grounded) return false;
    const state = this.simulation.state;
    const hazard = this.simulation.course.hazardsAhead(state.x, state.speed * 1.4)[0];
    if (!hazard) return false;
    const target = hazard.kind === 'gap' ? hazard.x - 70 : hazard.x - 250;
    return state.x >= target - state.speed * FIXED_DT && state.x <= target;
  }

  private resizeScene(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    if (!this.sky) return;
    this.sky.setSize(width, height);
    this.skyline.setPosition(0, height * 0.46).setSize(width * 1.5, height * 0.54);
    const visibleWorldWidth = width < height ? 1120 : 1640;
    this.cameras.main.setZoom(width / visibleWorldWidth);
  }

  private drawScene(): void {
    const state = this.simulation.state;
    const t = this.accumulator / FIXED_DT;
    const x = this.previousX + (state.x - this.previousX) * t;
    const y = this.previousY + (state.y - this.previousY) * t;
    const angle = this.previousAngle + (state.angle - this.previousAngle) * t;
    const camera = this.cameras.main;
    const viewWidth = camera.width / camera.zoom;
    const viewHeight = camera.height / camera.zoom;
    camera.scrollX = x - viewWidth * 0.26;
    camera.scrollY = y - viewHeight * 0.56;
    this.sky.tilePositionX = camera.scrollX * 0.08;
    this.skyline.tilePositionX = camera.scrollX * 0.17;

    this.worldGraphics.clear();
    this.worldGraphics.fillStyle(0x090a27, 0.76);
    for (const star of this.stars) {
      const px = camera.scrollX + star.x * viewWidth;
      const py = camera.scrollY + star.y * viewHeight;
      this.worldGraphics.fillStyle(0xe6fbff, star.a * (0.75 + 0.25 * Math.sin(state.elapsed * 1.2 + star.x * 15)));
      this.worldGraphics.fillCircle(px, py, star.r / camera.zoom);
    }
    const left = camera.scrollX - 100;
    const right = camera.scrollX + viewWidth + 250;
    const step = 18;
    this.worldGraphics.fillStyle(0x0b0c26, 0.96);
    this.worldGraphics.beginPath();
    let started = false;
    for (let wx = left; wx <= right; wx += step) {
      const surface = this.simulation.course.surfaceAt(wx);
      if (!surface) {
        if (started) {
          this.worldGraphics.lineTo(wx - step, viewHeight + camera.scrollY + 1600);
          this.worldGraphics.lineTo(wx - step, viewHeight + camera.scrollY + 500);
          this.worldGraphics.closePath();
          this.worldGraphics.fillPath();
          started = false;
        }
        continue;
      }
      if (!started) {
        this.worldGraphics.beginPath();
        this.worldGraphics.moveTo(wx, surface.y);
        started = true;
      } else this.worldGraphics.lineTo(wx, surface.y);
    }
    if (started) {
      this.worldGraphics.lineTo(right, viewHeight + camera.scrollY + 1600);
      this.worldGraphics.lineTo(left, viewHeight + camera.scrollY + 1600);
      this.worldGraphics.closePath();
      this.worldGraphics.fillPath();
    }

    this.worldGraphics.lineStyle(3, 0x2ef2ff, 0.85);
    for (let wx = left; wx <= right; wx += step) {
      const surface = this.simulation.course.surfaceAt(wx);
      if (!surface) continue;
      if (wx === left || !this.simulation.course.surfaceAt(wx - step)) this.worldGraphics.beginPath().moveTo(wx, surface.y);
      else this.worldGraphics.lineTo(wx, surface.y);
      if (!this.simulation.course.surfaceAt(wx + step)) this.worldGraphics.strokePath();
    }

    for (const hazard of this.simulation.course.hazardsAhead(left, right - left)) {
      if (hazard.kind === 'gap') {
        this.worldGraphics.fillStyle(0x120e30, 0.9);
        this.worldGraphics.fillRect(hazard.x, 516, hazard.width, 300);
        this.worldGraphics.lineStyle(2, 0xff6b4a, 0.92);
        this.worldGraphics.lineBetween(hazard.x, 517, hazard.x, 530);
        this.worldGraphics.lineBetween(hazard.x + hazard.width, 517, hazard.x + hazard.width, 530);
      } else {
        const color = hazard.kind === 'barrier' ? 0xff6b4a : 0x7b2cff;
        this.worldGraphics.fillStyle(color, 0.94);
        this.worldGraphics.fillRoundedRect(hazard.x, 520 - hazard.height, hazard.width, hazard.height, 7);
        this.worldGraphics.lineStyle(2, 0xffd98c, 0.7);
        this.worldGraphics.strokeRoundedRect(hazard.x, 520 - hazard.height, hazard.width, hazard.height, 7);
        this.worldGraphics.fillStyle(0xffffff, 0.24);
        this.worldGraphics.fillRect(hazard.x + 8, 520 - hazard.height + 8, 4, Math.max(4, hazard.height - 16));
      }
    }

    const launch = this.simulation.course.surfaceAt(state.x)?.segment.kind === 'launch';
    this.carContainer.setPosition(x, y).setAngle(angle * 180 / Math.PI);
    this.carGlow.setFillStyle(launch ? 0xff6b4a : 0x2ef2ff, launch ? 0.2 : 0.1);
    this.flame.setVisible(this.activeRun && (this.inputHeld || !state.grounded)).setScale(0.58 + 0.1 * Math.sin(state.elapsed * 44), 0.7);
  }

  getDebugSnapshot(): { state: Simulation['state']; activeRun: boolean; held: boolean } {
    return { state: this.simulation.state, activeRun: this.activeRun, held: this.inputHeld };
  }
}
