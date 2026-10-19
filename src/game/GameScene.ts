import Phaser from 'phaser';
import { CAR_HEIGHT, FIXED_DT, WHEEL_RADIUS, WHEELBASE, timeAtDistance } from '../sim/constants';
import { BASE_Y, pistonHeight, type CeilingSegment, type CourseSegment, type Hazard } from '../sim/course';
import { encodeInputLog } from '../sim/replay';
import { Simulation, WHEEL_VERTICAL_OFFSET } from '../sim/simulation';
import type { SimEvent } from '../sim/simulation';
import { CAR_ART } from './art/carArt';
import { CAR_TEXTURE_SCALE, registerArt } from './art/registerArt';
import { BIOMES, blendBiome } from './biomes';

function readPaint(): string {
  try { return localStorage.getItem('roadstronaut.paint') ?? 'prototype'; } catch { return 'prototype'; }
}

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

/** World-units-per-art-unit so the art wheelbase matches the simulation wheelbase. */
const K = WHEELBASE / (CAR_ART.frontWheelX - CAR_ART.rearWheelX);
const ART_CX = (CAR_ART.frontWheelX + CAR_ART.rearWheelX) / 2;
/** Logical art y that maps to the simulation car centre (wheel bottoms sit this far below it). */
const ART_CY = CAR_ART.wheelY + CAR_ART.wheelRadius - (WHEEL_VERTICAL_OFFSET + WHEEL_RADIUS) / K;
const WHEEL_WORLD_R = CAR_ART.wheelRadius * K;
const artToCar = (ax: number, ay: number): [number, number] => [(ax - ART_CX) * K, (ay - ART_CY) * K];

/** Parked-lineup paint jobs — synthwave palette, assigned per unit index. */
const VEHICLE_PAINTS = [
  0xe8452c, // ember red
  0x2e8fff, // sky blue
  0xffb347, // amber
  0x9b5cff, // violet
  0x2fd08c, // mint green
  0xff5f9e, // hot pink
  0x22c7d6, // teal
  0xd0d4dc, // silver
];
const VEHICLE_GLASS = 0x0d1a33;

function shadePaint(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

interface ParallaxLayer {
  sprite: Phaser.GameObjects.TileSprite;
  factor: number;
  heightFrac: number;
  lift: number;
}

/** Minimum seconds between scene redraws: 90-120Hz phone displays fire RAF far more often than the 60fps the scene needs. */
const DRAW_INTERVAL = 1 / 63;
/** RAF cadence below this implies a >80Hz display, where redraws are decimated to ~60fps. */
const HIGH_REFRESH_FRAME_MS = 1000 / 80;
/** Seconds after a run stops moving (pause/game-over) before the static scene stops being retessellated. */
const IDLE_FREEZE_SECONDS = 2.5;
/** Under-surface contour lines: [depth below surface, alpha]. */
const GROUND_STRATA: readonly (readonly [number, number])[] = [
  [16, 0.22], [42, 0.14], [90, 0.09], [170, 0.06], [290, 0.04],
];

export class GameScene extends Phaser.Scene {
  private simulation = new Simulation(1);
  private accumulator = 0;
  private inputHeld = false;
  private pointerHeld = false;
  private keyboardHeld = false;
  /** Guarantees a tap shorter than one simulation step still registers as a press. */
  private pressLatch = false;
  private activeRun = false;
  private finishedRun = false;
  private attractMode = true;
  private readonly inputLog: boolean[] = [];
  private readonly frameEvents: SimEvent[] = [];
  private previousX = 0;
  private previousY = 0;
  private previousAngle = 0;
  private displayedAngle = 0;
  private angleBlendFrom = 0;
  private angleBlendTo = 0;
  private angleBlendElapsed = 0;
  private angleBlendActive = false;

  private skies: Phaser.GameObjects.Image[] = [];
  private stars!: Phaser.GameObjects.TileSprite;
  private sun!: Phaser.GameObjects.Image;
  private haze!: Phaser.GameObjects.Image;
  private layers: Record<'mountains' | 'structures' | 'beacons' | 'skyline' | 'lights', ParallaxLayer> = {} as never;
  private track!: Phaser.GameObjects.Graphics;
  private fx!: Phaser.GameObjects.Graphics;
  private foreground!: Phaser.GameObjects.Graphics;
  private car!: Phaser.GameObjects.Container;
  private carBody!: Phaser.GameObjects.Image;
  private wheels: Phaser.GameObjects.Image[] = [];
  private flame!: Phaser.GameObjects.Image;
  private flameGlow!: Phaser.GameObjects.Image;
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private dust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private exhaust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private world!: Phaser.GameObjects.Container;
  private zoom = 1;
  private vrunZoom = 1;
  private camY = BASE_Y;
  private wheelSpin = 0;
  private flameTimer = 0;
  private crashTimer = 0;
  private trail: { x: number; y: number; a: number }[] = [];
  private drawElapsed = Number.POSITIVE_INFINITY;
  private idleElapsed = 0;
  private sceneDirty = true;
  /** vramp curve point lists are pure functions of the (immutable) segment — cache per segment. */
  private readonly vrampCache = new WeakMap<CourseSegment, { x: number; y: number }[]>();
  private layerEntries: [keyof GameScene['layers'], ParallaxLayer][] = [];
  /** Exhaust nozzle offset in car-local space (recomputed once, was allocated per frame). */
  private nozzleX = 0;
  private nozzleY = 0;

  constructor() {
    super('game');
  }

  create(): void {
    this.skies = BIOMES.map((_, i) => this.add.image(0, 0, `bg-sky-${i}`).setOrigin(0).setScrollFactor(0).setDepth(-100));
    this.stars = this.add.tileSprite(0, 0, 1024, 512, 'bg-stars').setOrigin(0).setScrollFactor(0).setDepth(-95);
    this.sun = this.add.image(0, 0, 'bg-sun').setScrollFactor(0).setDepth(-92);
    const layer = (key: string, depth: number, factor: number, heightFrac: number, lift: number, add = false): ParallaxLayer => {
      const sprite = this.add.tileSprite(0, 0, 1024, this.textures.get(key).getSourceImage().height, key)
        .setOrigin(0, 1).setScrollFactor(0).setDepth(depth);
      if (add) sprite.setBlendMode(Phaser.BlendModes.ADD);
      return { sprite, factor, heightFrac, lift };
    };
    this.layers = {
      mountains: layer('bg-mountains', -90, 0.06, 0.34, 0.06),
      structures: layer('bg-structures', -86, 0.16, 0.42, 0.015),
      beacons: layer('bg-beacons', -85, 0.16, 0.42, 0.015, true),
      skyline: layer('bg-skyline', -84, 0.22, 0.4, 0.0),
      lights: layer('bg-skyline-lights', -83, 0.22, 0.4, 0.0, true),
    };
    this.haze = this.add.image(0, 0, 'bg-haze').setOrigin(0, 1).setScrollFactor(0).setDepth(-80).setBlendMode(Phaser.BlendModes.ADD);
    this.layerEntries = Object.entries(this.layers) as [keyof GameScene['layers'], ParallaxLayer][];
    [this.nozzleX, this.nozzleY] = artToCar(4, 61);

    this.track = this.add.graphics().setDepth(0);
    this.fx = this.add.graphics().setDepth(4).setBlendMode(Phaser.BlendModes.ADD);

    const [fx, fy] = artToCar(6, 61);
    this.flameGlow = this.add.image(fx, fy, 'glow').setScale(0.5).setTint(0x2ef2ff).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.flame = this.add.image(fx, fy, 'thruster-flame').setOrigin(1, 0.5).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);
    const bodyScale = K / CAR_TEXTURE_SCALE;
    this.carBody = this.add.image(0, 0, 'car-body').setOrigin(ART_CX / CAR_ART.width, ART_CY / CAR_ART.height).setScale(bodyScale);
    const wheelScale = (WHEEL_WORLD_R * 2) / (60 * CAR_TEXTURE_SCALE);
    this.wheels = [CAR_ART.rearWheelX, CAR_ART.frontWheelX].map((ax) => {
      const [wx, wy] = artToCar(ax, CAR_ART.wheelY);
      return this.add.image(wx, wy, 'car-wheel').setScale(wheelScale);
    });
    this.car = this.add.container(0, 0, [this.flameGlow, this.flame, ...this.wheels, this.carBody]).setDepth(5);

    this.exhaust = this.add.particles(0, 0, 'spark', {
      lifespan: { min: 180, max: 380 }, speedX: { min: -160, max: -60 }, speedY: { min: -30, max: 30 },
      scale: { start: 0.55, end: 0 }, alpha: { start: 0.9, end: 0 }, tint: [0x2ef2ff, 0x7b2cff, 0x9ffbff],
      blendMode: 'ADD', emitting: false, maxParticles: 200,
    }).setDepth(4);
    this.dust = this.add.particles(0, 0, 'smoke', {
      lifespan: { min: 380, max: 750 }, speedX: { min: -220, max: -40 }, speedY: { min: -90, max: -10 },
      scale: { start: 0.35, end: 1.1 }, alpha: { start: 0.45, end: 0 }, tint: [0xb9a6ff, 0xffb3a0],
      emitting: false, maxParticles: 140,
    }).setDepth(6);
    this.sparks = this.add.particles(0, 0, 'spark', {
      lifespan: { min: 250, max: 650 }, speed: { min: 120, max: 460 }, angle: { min: 180, max: 360 },
      gravityY: 900, scale: { start: 0.5, end: 0 }, alpha: { start: 1, end: 0 }, tint: [0xffb347, 0xff6b4a, 0xfff3b0],
      blendMode: 'ADD', emitting: false, maxParticles: 220,
    }).setDepth(7);
    this.world = this.add.container(0, 0, [this.track, this.exhaust, this.fx, this.car, this.dust, this.sparks]).setDepth(0);
    this.foreground = this.add.graphics().setScrollFactor(0).setDepth(20);

    this.scale.on('resize', this.resizeScene, this);
    this.resizeScene(this.scale.gameSize);
    this.game.events.on('run-start', this.startRun, this);
    this.game.events.on('run-pause', this.pauseRun, this);
    this.game.events.on('run-resume', this.resumeRun, this);
    this.game.events.on('run-quit', this.quitRun, this);
    this.game.events.on('run-restart', this.startRun, this);
    this.game.events.on('paint-change', () => this.carBody.setTexture(readPaint() === 'coral' ? 'car-body-coral' : 'car-body'));

    this.input.keyboard?.on('keydown-SPACE', this.pressKeyboard, this);
    this.input.keyboard?.on('keyup-SPACE', this.releaseKeyboard, this);
    this.input.keyboard?.on('keydown-UP', this.pressKeyboard, this);
    this.input.keyboard?.on('keyup-UP', this.releaseKeyboard, this);
    this.input.keyboard?.on('keydown-ESC', () => this.game.events.emit('pause-request'), this);
    this.input.on('pointerdown', () => { this.pointerHeld = true; this.pressLatch = true; });
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
    const dt = Math.min(80, delta) / 1000;
    this.drawElapsed += dt;
    if (!this.activeRun && !this.attractMode) {
      this.crashTimer += dt;
      this.idleElapsed += dt;
      const shouldDraw = (this.idleElapsed < IDLE_FREEZE_SECONDS && (this.drawElapsed >= DRAW_INTERVAL || delta >= HIGH_REFRESH_FRAME_MS)) || this.sceneDirty;
      if (shouldDraw) {
        this.drawScene(Math.min(this.drawElapsed, 0.1));
        this.drawElapsed = 0;
        this.sceneDirty = false;
      }
      return;
    }
    this.idleElapsed = 0;
    this.accumulator += dt;
    this.frameEvents.length = 0;
    while (this.accumulator >= FIXED_DT) {
      this.previousX = this.simulation.state.x;
      this.previousY = this.simulation.state.y;
      this.previousAngle = this.simulation.state.angle;
      const held = this.activeRun ? (this.pointerHeld || this.keyboardHeld || this.pressLatch) : this.attractInput();
      if (this.activeRun) this.pressLatch = false;
      this.inputHeld = held;
      this.simulation.step(held);
      if (this.activeRun) this.inputLog.push(held);
      const railRecoveryIndex = this.simulation.events.findIndex((event) => event.type === 'railRecovery');
      const touchdownIndex = this.simulation.events.findIndex((event) => event.type === 'touchdown');
      const snappedRecovery = railRecoveryIndex >= 0 && touchdownIndex > railRecoveryIndex;
      const angleDifference = Math.atan2(
        Math.sin(this.simulation.state.angle - this.displayedAngle),
        Math.cos(this.simulation.state.angle - this.displayedAngle),
      );
      if (snappedRecovery || (touchdownIndex >= 0 && Math.abs(angleDifference) > 0.6)) {
        this.beginCarAngleBlend(this.simulation.state.angle);
      }
      for (const event of this.simulation.events) this.frameEvents.push(event);
      this.accumulator -= FIXED_DT;
      if (this.simulation.state.crashed) {
        if (this.activeRun && !this.finishedRun) {
          this.finishedRun = true;
          this.activeRun = false;
          this.crashTimer = 0;
          const result: RunFinished = { state: this.simulation.state, inputLog: encodeInputLog(this.inputLog) };
          this.game.events.emit('run-finished', result);
        } else if (this.attractMode) {
          this.handleEvents(this.frameEvents);
          this.frameEvents.length = 0;
          this.startAttractMode();
        }
        break;
      }
    }
    this.handleEvents(this.frameEvents);
    if (this.activeRun || this.finishedRun) this.game.events.emit('run-state', this.simulation.state, this.frameEvents);
    if (this.drawElapsed >= DRAW_INTERVAL || delta >= HIGH_REFRESH_FRAME_MS) {
      this.drawScene(Math.min(this.drawElapsed, 0.1));
      this.drawElapsed = 0;
      this.sceneDirty = false;
    }
  }

  private startRun(options?: { seed?: number }): void {
    const seedArray = new Uint32Array(1);
    globalThis.crypto?.getRandomValues(seedArray);
    const seed = options?.seed ?? seedArray[0] ?? Math.floor(performance.now() * 1000);
    this.resetSimulation(new Simulation(seed));
    this.inputLog.length = 0;
    this.activeRun = true;
    this.finishedRun = false;
    this.attractMode = false;
    this.pointerHeld = false;
    this.keyboardHeld = false;
    this.pressLatch = false;
  }

  private startAttractMode(): void {
    this.resetSimulation(new Simulation(42 + Math.floor(Math.random() * 1000)));
    this.activeRun = false;
    this.finishedRun = false;
    this.attractMode = true;
  }

  private resetSimulation(simulation: Simulation): void {
    this.simulation = simulation;
    this.accumulator = 0;
    this.previousX = simulation.state.x;
    this.previousY = simulation.state.y;
    this.previousAngle = simulation.state.angle;
    this.displayedAngle = simulation.state.angle;
    this.angleBlendFrom = simulation.state.angle;
    this.angleBlendTo = simulation.state.angle;
    this.angleBlendElapsed = 0;
    this.angleBlendActive = false;
    this.camY = Number.NaN;
    this.trail.length = 0;
    this.crashTimer = 0;
    // The course is regenerated per run — baked lineup textures belong to the old one
    for (const { rt } of this.lineupCache.values()) rt.destroy();
    this.lineupCache.clear();
    this.car.setVisible(true).setAlpha(1);
    this.carBody.clearTint();
    this.carBody.setTexture(readPaint() === 'coral' ? 'car-body-coral' : 'car-body');
    this.sceneDirty = true;
  }

  private beginCarAngleBlend(targetAngle: number): void {
    this.angleBlendFrom = this.displayedAngle;
    this.angleBlendTo = targetAngle;
    this.angleBlendElapsed = 0;
    this.angleBlendActive = true;
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
    if (!event.repeat) this.pressLatch = true;
    this.keyboardHeld = true;
  }

  private releaseKeyboard(): void {
    this.keyboardHeld = false;
  }

  private attractInput(): boolean {
    if (!this.attractMode || !this.simulation.state.grounded) return false;
    const state = this.simulation.state;
    const hazard = this.simulation.course.hazardsAhead(state.x, state.speed * 1.4).find((h) => h.x + h.width > state.x);
    if (!hazard) return false;
    const target = hazard.kind === 'gap' ? hazard.x - 70 : hazard.x - 250;
    return state.x >= target - state.speed * FIXED_DT && state.x <= target;
  }

  private get portrait(): boolean {
    return this.scale.width < this.scale.height;
  }

  private resizeScene(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    if (!this.stars) return;
    const visibleWorldWidth = width < height ? 780 : Math.max(1100, Math.min(1450, width));
    this.zoom = width / visibleWorldWidth;
    for (const sky of this.skies) sky.setDisplaySize(width, height);
    this.stars.setSize(width, height);
    this.haze.setDisplaySize(width, height * 0.35);
    for (const l of Object.values(this.layers)) {
      const texHeight = l.sprite.height;
      const scale = Math.max(0.45, (height * l.heightFrac) / texHeight);
      l.sprite.setScale(scale).setSize(width / scale + 2, texHeight);
    }
    this.sceneDirty = true;
  }

  private handleEvents(events: readonly SimEvent[]): void {
    const state = this.simulation.state;
    const cam = this.cameras.main;
    const rear = this.wheelWorld(0);
    const front = this.wheelWorld(1);
    for (const event of events) {
      switch (event.type) {
        case 'jump':
          this.flameTimer = 0.3;
          this.dust.explode(10, rear.x, rear.y);
          cam.shake(90, 0.002);
          break;
        case 'superLaunch':
          this.flameTimer = 0.6;
          this.dust.explode(16, rear.x, rear.y);
          this.sparks.explode(26, rear.x, rear.y);
          cam.shake(220, 0.007);
          cam.flash(140, 255, 140, 90, true);
          break;
        case 'takeoff':
          this.dust.explode(5, rear.x, rear.y);
          break;
        case 'flipComplete':
          this.exhaust.explode(24, state.x, state.y);
          break;
        case 'land': {
          const strong = event.quality === 'perfect' || event.flips > 0;
          this.dust.explode(strong ? 18 : 10, (rear.x + front.x) / 2, (rear.y + front.y) / 2);
          this.sparks.explode(event.quality === 'perfect' ? 30 : 12, rear.x, rear.y);
          if (event.quality === 'perfect') this.exhaust.explode(30, state.x, state.y + CAR_HEIGHT / 2);
          cam.shake(strong ? 160 : 90, strong ? 0.005 : 0.0025);
          break;
        }
        case 'nearMiss':
          this.exhaust.explode(14, state.x, state.y);
          break;
        case 'thrusterBurst':
        case 'railRecovery':
          this.flameTimer = Math.max(this.flameTimer, 0.22);
          this.exhaust.explode(18, rear.x, rear.y - CAR_HEIGHT / 2);
          cam.shake(70, 0.0018);
          break;
        case 'suctionEngage':
          this.sparks.explode(22, state.x, state.y - CAR_HEIGHT / 2);
          cam.shake(120, 0.004);
          break;
        case 'suctionRelease':
          this.exhaust.explode(12, state.x, state.y);
          break;
        case 'verticalSuction':
          this.sparks.explode(28, state.x, state.y + CAR_HEIGHT / 2);
          cam.shake(150, 0.005);
          break;
        case 'thrustersArmed':
          this.flameTimer = Math.max(this.flameTimer, 0.5);
          this.exhaust.explode(16, rear.x, rear.y);
          break;
        case 'verticalLaunch':
          this.flameTimer = Math.max(this.flameTimer, 0.9);
          this.dust.explode(24, state.x, state.y + CAR_HEIGHT);
          this.sparks.explode(34, state.x, state.y);
          this.exhaust.explode(26, state.x, state.y);
          cam.shake(260, 0.009);
          cam.flash(140, 160, 240, 255, true);
          break;
        case 'verticalRunLanded':
          this.sparks.explode(40, state.x, state.y);
          this.exhaust.explode(36, state.x, state.y);
          cam.shake(180, 0.006);
          cam.flash(120, 255, 210, 120, true);
          break;
        case 'vehicleFlip':
        case 'stuntFlip':
          this.flameTimer = Math.max(this.flameTimer, 0.45);
          this.exhaust.explode(16, state.x, state.y);
          this.dust.explode(10, state.x, state.y);
          cam.shake(90, 0.003);
          break;
        case 'airBurst': {
          // Compressed-air jets firing from the car's SIDES — the alternating
          // perpendicular puffs are what shove it around the barrel roll.
          const side = Math.floor(state.elapsed * 11) % 2 ? 1 : -1;
          const c = Math.cos(state.angle);
          const s = Math.sin(state.angle);
          this.exhaust.explode(7, state.x - s * side * 42, state.y + c * side * 42);
          this.exhaust.explode(3, state.x + s * side * 42, state.y - c * side * 42);
          this.dust.explode(4, state.x + c * side * 24, state.y + s * side * 24);
          break;
        }
        case 'win': {
          this.sparks.explode(60, state.x, state.y);
          this.exhaust.explode(40, state.x, state.y);
          this.dust.explode(24, state.x, state.y);
          cam.shake(200, 0.006);
          cam.flash(300, 255, 220, 120, true);
          break;
        }
        case 'hardLanding':
          cam.shake(220, 0.008);
          this.dust.explode(14, (rear.x + front.x) / 2, (rear.y + front.y) / 2);
          break;
        case 'crash':
          this.sparks.explode(70, state.x, state.y);
          this.dust.explode(26, state.x, state.y);
          this.exhaust.explode(30, state.x, state.y);
          cam.shake(420, 0.014);
          cam.flash(180, 255, 90, 70, true);
          this.carBody.setTint(0x6a5870);
          break;
        default:
          break;
      }
    }
  }

  private wheelWorld(index: 0 | 1): { x: number; y: number } {
    const wheel = this.wheels[index]!;
    const cos = Math.cos(this.car.rotation);
    const sin = Math.sin(this.car.rotation);
    return { x: this.car.x + wheel.x * cos - wheel.y * sin, y: this.car.y + wheel.x * sin + wheel.y * cos + WHEEL_WORLD_R };
  }

  private drawScene(dt: number): void {
    const state = this.simulation.state;
    const t = state.crashed ? 1 : this.accumulator / FIXED_DT;
    const x = this.previousX + (state.x - this.previousX) * t;
    const y = this.previousY + (state.y - this.previousY) * t;
    const angle = this.previousAngle + (state.angle - this.previousAngle) * t;
    let displayedAngle = angle;
    if (this.angleBlendActive) {
      this.angleBlendElapsed += dt;
      const blend = Math.min(1, this.angleBlendElapsed / 0.09);
      const angleDelta = Math.atan2(
        Math.sin(this.angleBlendTo - this.angleBlendFrom),
        Math.cos(this.angleBlendTo - this.angleBlendFrom),
      );
      displayedAngle = this.angleBlendFrom + angleDelta * blend;
      if (blend >= 1) this.angleBlendActive = false;
    }
    const viewGuess = this.scale.width / this.zoom;
    const runs = this.simulation.course.verticalRunsInRange(x - viewGuess, x + viewGuess * 1.4);
    const inRun = runs.some((run) => x >= run.x0 - 40 && x <= run.landingX1);
    this.vrunZoom = Phaser.Math.Linear(this.vrunZoom, inRun ? 0.58 : 1, 1 - Math.exp(-dt * 1.8));
    const zoom = this.zoom * this.vrunZoom;
    const viewW = this.scale.width / zoom;
    const viewH = this.scale.height / zoom;
    const anchor = this.portrait ? 0.66 : 0.68;

    const ground = this.simulation.course.surfaceAt(x)?.y ?? BASE_Y;
    const restY = Math.min(ground, BASE_Y + 60);
    let targetTop = restY - viewH * anchor;
    targetTop = Math.min(targetTop, y - viewH * 0.3);
    const camTop = Number.isNaN(this.camY) ? targetTop : Phaser.Math.Linear(this.camY, targetTop, 1 - Math.exp(-dt * 5));
    this.camY = camTop;
    const worldLeft = x - viewW * (this.portrait ? 0.2 : 0.24);
    const worldTop = camTop;
    this.world.setScale(zoom).setPosition(-worldLeft * zoom, -worldTop * zoom);

    this.drawBackground(worldLeft, worldTop, viewH);
    this.drawTrack(worldLeft, worldTop, viewW, viewH, state.elapsed);
    this.drawCar(x, y, angle, dt, displayedAngle);
    this.displayedAngle = displayedAngle;
    this.drawForeground(worldLeft, state.speed, dt);
  }

  private drawBackground(worldLeft: number, worldTop: number, viewH: number): void {
    const b = blendBiome(worldLeft);
    const W = this.scale.width;
    const H = this.scale.height;
    this.skies.forEach((sky, i) => {
      sky.setVisible(i === b.index || (i === b.next && b.t > 0));
      sky.setAlpha(i === b.index ? 1 : b.t);
      sky.setDepth(i === b.index ? -100 : -99);
    });
    const restTop = BASE_Y - viewH * (this.portrait ? 0.66 : 0.68);
    const liftPx = (restTop - worldTop) * this.zoom;
    const horizon = H * (this.portrait ? 0.66 : 0.68) + liftPx * 0.25;
    this.stars.setAlpha(b.stars).setTilePosition(worldLeft * 0.01, -liftPx * 0.05);
    const sunSize = Math.min(W, H) * (this.portrait ? 0.75 : 0.55);
    this.sun.setDisplaySize(sunSize, sunSize).setPosition(W * (this.portrait ? 0.66 : 0.68), horizon - sunSize * 0.18 + liftPx * 0.05).setAlpha(b.sun).setVisible(b.sun > 0.01);
    const tint: Record<keyof typeof this.layers, [number, number]> = {
      mountains: [b.mountain, 1],
      structures: [b.structures, b.structuresAlpha],
      beacons: [b.accent === 0xffb347 ? 0xff4d6d : 0xff6b4a, b.structuresAlpha * (0.6 + 0.4 * Math.sin(this.time.now / 300))],
      skyline: [b.skyline, b.skylineAlpha],
      lights: [b.lights, b.skylineAlpha * 0.85],
    };
    for (const [name, l] of this.layerEntries) {
      const [color, alpha] = tint[name];
      l.sprite.setTint(color).setAlpha(alpha).setVisible(alpha > 0.01)
        .setPosition(0, horizon + 2 - H * l.lift + liftPx * l.factor * 0.6)
        .setTilePosition((worldLeft * l.factor * this.zoom) / l.sprite.scaleX, 0);
    }
    this.haze.setTint(b.haze).setAlpha(0.32).setPosition(0, horizon + 4);
  }

  private drawTrack(left: number, top: number, viewW: number, viewH: number, elapsed: number): void {
    const g = this.track;
    const fx = this.fx;
    g.clear();
    fx.clear();
    const right = left + viewW + 200;
    const bottom = top + viewH + 400;
    const course = this.simulation.course;
    const biome = blendBiome(left);
    const segments: CourseSegment[] = course.segmentsInRange(left - 200, right);
    const edge = biome.groundEdge;
    const accent = biome.accent;

    if (left < 0) {
      g.fillStyle(biome.ground, 1);
      g.fillRect(left - 200, BASE_Y, -left + 200, bottom - BASE_Y);
      this.fx.lineStyle(3, edge, 0.95);
      this.fx.lineBetween(left - 200, BASE_Y, 0, BASE_Y);
    }
    // Ground fill: one polygon per contiguous run of drivable segments —
    // the same silhouette as the old per-segment quads, in far fewer ops.
    // (Each run needs a fresh point list: fillPoints stores the array by
    // reference in the Graphics command buffer.)
    g.fillStyle(biome.ground, 1);
    let run: CourseSegment[] = [];
    const edgeRuns = new Map<number, CourseSegment[]>();
    const flat: CourseSegment[] = [];
    const flushGround = (): void => {
      if (run.length) {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const pts: { x: number; y: number }[] = [{ x: first.x0, y: first.y0 }];
        for (const seg of run) pts.push({ x: seg.x1, y: seg.y1 });
        pts.push({ x: last.x1, y: bottom }, { x: first.x0, y: bottom });
        g.fillPoints(pts, true);
        run = [];
      }
    };
    for (const seg of segments) {
      if (seg.kind === 'gap') {
        flushGround();
        continue;
      }
      if (seg.kind === 'vramp') {
        flushGround();
        this.drawVRampFill(seg, bottom, biome.ground, edge);
        continue;
      }
      // Guard against non-adjacent flat segments — a merged polygon must not
      // span a hole the old per-segment quads left empty.
      if (run.length && Math.abs(seg.x0 - run[run.length - 1]!.x1) > 0.5) flushGround();
      run.push(seg);
      flat.push(seg);
      const isLaunch = seg.kind === 'launch';
      const isKicker = seg.kind === 'kicker' || seg.kind === 'quarter';
      const color = isLaunch ? 0xff6b4a : isKicker ? accent : edge;
      const bucket = edgeRuns.get(color);
      if (bucket) bucket.push(seg); else edgeRuns.set(color, [seg]);
    }
    flushGround();
    // depth strata — one stroked path per depth across every segment
    for (const [depth, alpha] of GROUND_STRATA) {
      g.lineStyle(2, edge, alpha);
      g.beginPath();
      for (const seg of flat) {
        g.moveTo(seg.x0, seg.y0 + depth);
        g.lineTo(seg.x1, seg.y1 + depth);
      }
      g.strokePath();
    }
    // vertical grid posts — one stroked path keeps Graphics tessellation cheap
    const spacing = 160;
    g.lineStyle(2, edge, 0.13);
    g.beginPath();
    for (let gx = Math.floor((left - 200) / spacing) * spacing; gx < right; gx += spacing) {
      const s = course.surfaceAt(gx);
      if (!s) continue;
      g.moveTo(gx, s.y + 4);
      g.lineTo(gx, s.y + 300);
    }
    g.strokePath();
    // surface edges — two stroked paths (glow + core) per color group
    for (const [color, segs] of edgeRuns) {
      for (const [width, alpha] of [[9, 0.18], [3, 0.95]] as const) {
        fx.lineStyle(width, color, alpha);
        fx.beginPath();
        for (const seg of segs) {
          fx.moveTo(seg.x0, seg.y0);
          fx.lineTo(seg.x1, seg.y1);
        }
        fx.strokePath();
      }
    }
    for (const seg of segments) {
      if (seg.kind === 'gap') {
        this.drawGapRims(seg, elapsed);
        continue;
      }
      if (seg.kind === 'vramp') {
        this.drawVRampEdge(seg, elapsed);
        continue;
      }
      if (seg.kind === 'launch') this.drawRampDetail(seg, true, elapsed);
      else if (seg.kind === 'kicker' || seg.kind === 'quarter') this.drawRampDetail(seg, false, elapsed);
    }
    for (const ceiling of course.ceilingsInRange(left - 200, right)) this.drawFanRail(ceiling, top, elapsed);
    for (const hazard of course.hazardsAhead(left - 200, right - left + 200)) {
      if (hazard.kind !== 'gap') this.drawObstacle(hazard, elapsed);
    }
    // Free baked lineup textures once their hazard is well behind the camera
    for (const [id, entry] of this.lineupCache) {
      if (entry.right < left - 600) {
        entry.rt.destroy();
        this.lineupCache.delete(id);
      }
    }
  }

  private drawFanRail(c: CeilingSegment, top: number, elapsed: number): void {
    const g = this.track;
    const fx = this.fx;
    const state = this.simulation.state;
    const engaged = state.inverted && state.x >= c.x0 && state.x <= c.x1;
    const slabTop = c.y - 34;
    const skyTop = Math.min(top - 50, slabTop - 40);
    g.fillStyle(0x0c0a24, 1);
    for (let px = c.x0 + 40; px < c.x1; px += 260) {
      g.fillRect(px - 5, skyTop, 10, slabTop - skyTop);
    }
    // diagonal bracing on every post — one stroked path for the whole rail
    g.lineStyle(1.5, 0x7b2cff, 0.4);
    g.beginPath();
    for (let px = c.x0 + 40; px < c.x1; px += 260) {
      for (let y = slabTop; y > skyTop; y -= 28) {
        g.moveTo(px - 5, y);
        g.lineTo(px + 5, y - 28);
      }
    }
    g.strokePath();
    g.fillStyle(0x120c30, 1);
    g.fillRect(c.x0, slabTop, c.x1 - c.x0, 34);
    g.fillStyle(0x1d1446, 1);
    g.fillRect(c.x0, slabTop, c.x1 - c.x0, 6);
    const spin = elapsed * (engaged ? 22 : 7);
    const cy = slabTop + 18;
    g.fillStyle(0x05040f, 1);
    for (let vx = c.x0 + 30; vx < c.x1 - 20; vx += 70) {
      g.fillCircle(vx, cy, 11);
    }
    fx.lineStyle(1.5, 0x2ef2ff, engaged ? 0.9 : 0.45);
    for (let vx = c.x0 + 30; vx < c.x1 - 20; vx += 70) {
      fx.strokeCircle(vx, cy, 11);
    }
    // fan blades — one stroked path
    fx.beginPath();
    for (let vx = c.x0 + 30; vx < c.x1 - 20; vx += 70) {
      for (let b = 0; b < 3; b += 1) {
        const a = spin + (b * Math.PI * 2) / 3;
        fx.moveTo(vx, cy);
        fx.lineTo(vx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
      }
    }
    fx.strokePath();
    const glow = engaged ? 0.95 : 0.6 + 0.25 * Math.sin(elapsed * 6);
    fx.lineStyle(12, 0x2ef2ff, engaged ? 0.3 : 0.12);
    fx.lineBetween(c.x0, c.y, c.x1, c.y);
    fx.lineStyle(3, 0x2ef2ff, glow);
    fx.lineBetween(c.x0, c.y, c.x1, c.y);
    for (const ex of [c.x0, c.x1]) {
      fx.fillStyle(0xffb347, 0.9);
      fx.fillRect(ex - 3, slabTop, 6, 34);
    }
    if (engaged) {
      const [cx, cy] = [state.x, state.y];
      for (let i = 0; i < 6; i += 1) {
        const u = ((elapsed * 3 + i / 6) % 1);
        const lx = cx - 70 + i * 28;
        fx.lineStyle(2, 0x9ffbff, 0.6 * (1 - u));
        fx.lineBetween(lx, c.y + 4 + (cy - c.y) * (1 - u), lx, c.y + 4 + (cy - c.y) * (1 - u) - 10);
      }
    }
  }

  private vrampCurve(seg: CourseSegment, steps = 40): { x: number; y: number }[] {
    const cached = this.vrampCache.get(seg);
    if (cached) return cached;
    const course = this.simulation.course;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = seg.x0 + (seg.x1 - seg.x0) * (i / steps);
      pts.push({ x, y: course.surfaceAt(x)?.y ?? seg.y0 });
    }
    // Decorative overhang: the drawn structure curls past vertical like a
    // stunt-ramp hook. Visual only — the rideable curve ends at the lip.
    const curlR = (seg.y0 - seg.y1) * 0.55;
    for (let k = 1; k <= 8; k += 1) {
      const phi = (k / 8) * 0.55;
      pts.push({ x: seg.x1 - curlR * (1 - Math.cos(phi)), y: seg.y1 - curlR * Math.sin(phi) });
    }
    this.vrampCache.set(seg, pts);
    return pts;
  }

  private drawVRampFill(seg: CourseSegment, bottom: number, ground: number, edge: number): void {
    const g = this.track;
    const pts = this.vrampCurve(seg);
    g.fillStyle(ground, 1);
    const poly = [...pts, { x: seg.x1, y: bottom }, { x: seg.x0, y: bottom }];
    g.fillPoints(poly, true);
    // depth strata following the curve — one stroked path per depth
    for (const [depth, alpha] of [[16, 0.22], [42, 0.14], [90, 0.09], [170, 0.06]] as const) {
      g.lineStyle(2, edge, alpha);
      g.beginPath();
      g.moveTo(pts[0]!.x, pts[0]!.y + depth);
      for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i]!.x, pts[i]!.y + depth);
      g.strokePath();
    }
  }

  private drawVRampEdge(seg: CourseSegment, elapsed: number): void {
    const fx = this.fx;
    const g = this.track;
    const state = this.simulation.state;
    const pts = this.vrampCurve(seg);
    const color = 0x2ef2ff;
    const climbing = state.grounded && state.x >= seg.x0 && state.x <= seg.x1;
    // glow + core edge along the curve — each a single stroked polyline
    for (const [width, alpha] of [[10, climbing ? 0.3 : 0.18], [3, 0.95]] as const) {
      fx.lineStyle(width, color, alpha);
      fx.beginPath();
      fx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i += 1) fx.lineTo(pts[i]!.x, pts[i]!.y);
      fx.strokePath();
    }
    // suction rail markers: animated chevrons riding up the curve
    const phase = (elapsed * (climbing ? 3.2 : 1.6)) % 1;
    for (let i = 0; i < 7; i += 1) {
      const u = (i + phase) / 7;
      const idx = Math.min(pts.length - 2, Math.floor(u * (pts.length - 1)));
      const p0 = pts[idx]!;
      const p1 = pts[idx + 1]!;
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const nx = -Math.sin(ang);
      const ny = Math.cos(ang);
      const cx = p0.x + (p1.x - p0.x) * 0.5 + nx * 12;
      const cy = p0.y + (p1.y - p0.y) * 0.5 + ny * 12;
      const fade = 0.5 + 0.5 * Math.sin(u * Math.PI);
      fx.lineStyle(3, color, fade * (climbing ? 1 : 0.7));
      fx.beginPath();
      fx.moveTo(cx - Math.cos(ang) * 8, cy - Math.sin(ang) * 8);
      fx.lineTo(cx + Math.cos(ang) * 3, cy + Math.sin(ang) * 3);
      fx.lineTo(cx - Math.cos(ang) * 8 - Math.sin(ang) * -8, cy - Math.sin(ang) * 8 - Math.cos(ang) * -8);
      fx.strokePath();
    }
    // lip beacon
    const lip = pts[pts.length - 1]!;
    const pulse = 0.6 + 0.4 * Math.sin(elapsed * 10);
    fx.fillStyle(0xffb347, 0.9 * pulse);
    fx.fillCircle(lip.x, lip.y - 4, 6);
    fx.fillStyle(0xff6b4a, 0.3 * pulse);
    fx.fillCircle(lip.x, lip.y - 4, 20);
    // support struts under the low half of the curve — one stroked path
    g.lineStyle(2, 0x2ef2ff, 0.25);
    g.beginPath();
    for (let i = 2; i < pts.length * 0.5; i += 4) {
      g.moveTo(pts[i]!.x, pts[i]!.y + 4);
      g.lineTo(pts[i]!.x + 30, pts[i]!.y + 70);
      g.lineTo(pts[i]!.x + 60, pts[i]!.y + 6);
    }
    g.strokePath();
  }

  /** The parked-vehicle art is identical every frame — bake it once into a
   * RenderTexture so each lineup costs one sprite blit instead of ~15
   * Graphics ops per vehicle, every frame. */
  private readonly lineupCache = new Map<string, { rt: Phaser.GameObjects.RenderTexture; right: number }>();

  private bakeVehicleLineup(h: Hazard): Phaser.GameObjects.RenderTexture {
    const padX = 26;
    const topPad = 40; // room for the tall warning beacons' glow
    const bottomPad = 16;
    const rt = this.add
      .renderTexture(h.x - padX, h.baseY - h.height - topPad, h.width + padX * 2, h.height + topPad + bottomPad)
      .setOrigin(0, 0);
    const scratch = this.add.graphics();
    this.drawVehicleLineupStatic(scratch, h);
    rt.draw(scratch, padX - h.x, topPad + h.height - h.baseY);
    scratch.destroy();
    // sit where the track sits inside the world container: below fx/car/dust
    this.world.addAt(rt, 1);
    this.lineupCache.set(h.id, { rt, right: h.x + h.width });
    return rt;
  }

  private drawVehicleLineupStatic(g: Phaser.GameObjects.Graphics, h: Hazard): void {
    // Rotate the palette start per lineup so consecutive rows don't repeat
    // the same paint order.
    const paintOffset = Math.abs(Math.floor(h.x / 97)) % VEHICLE_PAINTS.length;
    for (const [index, unit] of (h.vehicles ?? []).entries()) {
      const paint = VEHICLE_PAINTS[(paintOffset + index) % VEHICLE_PAINTS.length];
      const paintDark = shadePaint(paint, 0.55);
      const x0 = h.x + unit.dx;
      const x1 = x0 + unit.width;
      const base = h.baseY;
      const top = base - unit.height;
      const w = unit.width;
      const hh = unit.height;
      // body silhouette by kind
      if (unit.kind === 'semi') {
        g.fillStyle(paintDark, 1);
        g.fillRect(x0, top + hh * 0.12, w * 0.78, hh * 0.88);          // trailer
        g.fillStyle(paint, 1);
        g.fillRect(x0 + w * 0.78, top + hh * 0.4, w * 0.22, hh * 0.6); // cab
        g.fillStyle(VEHICLE_GLASS, 1);
        g.fillRect(x0 + w * 0.8, top + hh * 0.44, w * 0.16, hh * 0.22); // windshield
      } else if (unit.kind === 'pickup') {
        g.fillStyle(paint, 1);
        g.fillRect(x0, top + hh * 0.45, w, hh * 0.55);                 // bed+body
        g.fillRect(x0 + w * 0.3, top, w * 0.38, hh * 0.5);             // angular cab
        g.fillStyle(VEHICLE_GLASS, 1);
        g.fillRect(x0 + w * 0.34, top + hh * 0.08, w * 0.3, hh * 0.26);
      } else if (unit.kind === 'sport') {
        g.fillStyle(paint, 1);
        g.fillPoints([
          { x: x0, y: base - hh * 0.35 }, { x: x0 + w * 0.12, y: top + hh * 0.3 },
          { x: x0 + w * 0.5, y: top }, { x: x0 + w * 0.82, y: top + hh * 0.28 },
          { x: x1, y: base - hh * 0.3 }, { x: x1, y: base }, { x: x0, y: base },
        ], true);
        g.fillStyle(VEHICLE_GLASS, 1);
        g.fillPoints([
          { x: x0 + w * 0.34, y: top + hh * 0.12 }, { x: x0 + w * 0.5, y: top + hh * 0.02 },
          { x: x0 + w * 0.68, y: top + hh * 0.14 }, { x: x0 + w * 0.62, y: top + hh * 0.3 },
          { x: x0 + w * 0.38, y: top + hh * 0.3 },
        ], true);
      } else {
        // sedan: rounded wedge
        g.fillStyle(paint, 1);
        g.fillPoints([
          { x: x0, y: base - hh * 0.3 }, { x: x0 + w * 0.16, y: top + hh * 0.42 },
          { x: x0 + w * 0.4, y: top + hh * 0.05 }, { x: x0 + w * 0.72, y: top + hh * 0.12 },
          { x: x0 + w * 0.9, y: top + hh * 0.45 }, { x: x1, y: base - hh * 0.22 },
          { x: x1, y: base }, { x: x0, y: base },
        ], true);
        g.fillStyle(VEHICLE_GLASS, 1);
        g.fillPoints([
          { x: x0 + w * 0.42, y: top + hh * 0.14 }, { x: x0 + w * 0.68, y: top + hh * 0.2 },
          { x: x0 + w * 0.78, y: top + hh * 0.42 }, { x: x0 + w * 0.44, y: top + hh * 0.4 },
        ], true);
      }
      // dark rocker panel under the body for depth
      g.fillStyle(paintDark, 1);
      g.fillRect(x0 + w * 0.04, base - hh * 0.18, w * 0.92, hh * 0.18);
      // wheels
      g.fillStyle(0x05040f, 1);
      const wheelR = Math.min(9, hh * 0.16);
      g.fillCircle(x0 + w * 0.2, base - wheelR * 0.4, wheelR);
      g.fillCircle(x0 + w * 0.78, base - wheelR * 0.4, wheelR);
    }
  }

  private drawVehicleLineup(h: Hazard, elapsed: number): void {
    const fx = this.fx;
    if (!this.lineupCache.has(h.id)) this.bakeVehicleLineup(h);
    const blink = 0.5 + 0.5 * Math.sin(elapsed * 7 + h.x);
    for (const unit of h.vehicles ?? []) {
      const x0 = h.x + unit.dx;
      const x1 = x0 + unit.width;
      const top = h.baseY - unit.height;
      const hh = unit.height;
      // neon trim + taillight/headlight blink
      fx.lineStyle(2, 0x2ef2ff, 0.55);
      fx.lineBetween(x0 + 3, top + hh * 0.55, x1 - 3, top + hh * 0.55);
      fx.fillStyle(0xff3b5c, 0.7 + 0.3 * blink);
      fx.fillRect(x1 - 5, top + hh * 0.3, 3, hh * 0.14);
      fx.fillStyle(0x9ffbff, 0.5 + 0.3 * blink);
      fx.fillRect(x0 + 2, top + hh * 0.3, 3, hh * 0.12);
    }
    // hazard outline: orange warning edge along the lineup silhouette
    fx.lineStyle(3, 0xffb347, 0.85);
    fx.lineBetween(h.x - 2, h.baseY, h.x + h.width + 2, h.baseY);
    const tallest = h.height;
    fx.fillStyle(0xff3b5c, 0.5 + 0.5 * blink);
    fx.fillCircle(h.x - 8, h.baseY - tallest + 4, 4);
    fx.fillCircle(h.x + h.width + 8, h.baseY - tallest + 4, 4);
  }

  private drawRampDetail(seg: CourseSegment, launch: boolean, elapsed: number): void {
    const g = this.track;
    const fx = this.fx;
    const color = launch ? 0xff6b4a : 0x2ef2ff;
    const len = seg.x1 - seg.x0;
    const lipY = Math.max(seg.y0, seg.y1);
    // support truss under the ramp
    g.fillStyle(launch ? 0x2a0f2e : 0x10163a, 1);
    g.fillPoints([{ x: seg.x0, y: seg.y0 }, { x: seg.x1, y: seg.y1 }, { x: seg.x1, y: lipY + 4 }, { x: seg.x0, y: lipY + 4 }], true);
    g.lineStyle(2, color, 0.35);
    g.beginPath();
    const n = Math.max(2, Math.floor(len / 40));
    for (let i = 1; i < n; i += 1) {
      const px = seg.x0 + (len * i) / n;
      const py = seg.y0 + ((seg.y1 - seg.y0) * i) / n;
      g.moveTo(px, py + 3);
      g.lineTo(px, lipY + 4);
      if (i % 2) {
        g.moveTo(px, py + 3);
        g.lineTo(seg.x0 + (len * (i + 1)) / n, lipY + 2);
      }
    }
    g.strokePath();
    // animated chevrons along the surface
    const count = launch ? 5 : 3;
    const phase = (elapsed * 2.2) % 1;
    for (let i = 0; i < count; i += 1) {
      const u = (i + phase) / count;
      const cx = seg.x0 + len * u;
      const cy = seg.y0 + (seg.y1 - seg.y0) * u - 10;
      const a = Math.sin(Math.PI * u);
      fx.lineStyle(3, color, 0.85 * a);
      fx.beginPath();
      fx.moveTo(cx - 8, cy - 8);
      fx.lineTo(cx + 2, cy);
      fx.lineTo(cx - 8, cy + 8);
      fx.strokePath();
    }
    if (launch) {
      const pulse = 0.6 + 0.4 * Math.sin(elapsed * 10);
      fx.fillStyle(0xffb347, 0.9 * pulse);
      fx.fillCircle(seg.x1, seg.y1 - 3, 5);
      fx.fillStyle(0xff6b4a, 0.25 * pulse);
      fx.fillCircle(seg.x1, seg.y1 - 3, 16);
    }
  }

  private drawGapRims(seg: CourseSegment, elapsed: number): void {
    const fx = this.fx;
    const blink = 0.55 + 0.45 * Math.sin(elapsed * 8);
    for (const [px, py] of [[seg.x0, seg.y0], [seg.x1, seg.y1]] as const) {
      fx.lineStyle(3, 0xff6b4a, 0.9);
      fx.lineBetween(px, py, px, py + 140);
      fx.lineStyle(10, 0xff6b4a, 0.12);
      fx.lineBetween(px, py, px, py + 140);
      fx.fillStyle(0xff3b5c, blink);
      fx.fillCircle(px, py - 4, 4);
      fx.fillStyle(0xff3b5c, 0.2 * blink);
      fx.fillCircle(px, py - 4, 13);
    }
    // faint glow at the pit floor
    fx.fillStyle(0x7b2cff, 0.08);
    fx.fillRect(seg.x0, seg.y0 + 120, seg.x1 - seg.x0, 260);
  }

  private drawObstacle(h: Hazard, elapsed: number): void {
    const g = this.track;
    const fx = this.fx;
    if (h.kind === 'vehicles') {
      this.drawVehicleLineup(h, elapsed);
      return;
    }
    const topY = h.baseY - (h.kind === 'piston' ? pistonHeight(h, this.simulation.state.elapsed) : h.height);
    if (h.kind === 'beam') {
      const blink = 0.55 + 0.45 * Math.sin(elapsed * 8 + h.x);
      g.fillStyle(0x0c0a24, 1);
      g.fillRect(h.x + 8, topY - 420, 8, 420);
      g.fillRect(h.x + h.width - 16, topY - 420, 8, 420);
      g.fillStyle(0x1a0b24, 1);
      g.fillRect(h.x, topY, h.width, h.height);
      for (let sx = 0; sx < h.width; sx += 24) {
        g.fillStyle(0xffb347, 0.9);
        g.fillPoints([{ x: h.x + sx, y: h.baseY - 4 }, { x: h.x + sx + 12, y: topY + 4 }, { x: h.x + sx + 20, y: topY + 4 }, { x: h.x + sx + 8, y: h.baseY - 4 }], true);
      }
      fx.lineStyle(3, 0xff6b4a, 0.95);
      fx.lineBetween(h.x - 2, h.baseY, h.x + h.width + 2, h.baseY);
      fx.lineStyle(10, 0xff6b4a, 0.18);
      fx.lineBetween(h.x - 2, h.baseY, h.x + h.width + 2, h.baseY);
      fx.fillStyle(0xff3b5c, blink);
      fx.fillCircle(h.x, h.baseY + 2, 4);
      fx.fillCircle(h.x + h.width, h.baseY + 2, 4);
      const floorY = this.simulation.course.surfaceAt(h.x + h.width / 2)?.y;
      if (floorY !== undefined) {
        fx.lineStyle(2, 0xffb347, 0.5);
        fx.beginPath();
        for (let sx = -60; sx < h.width + 60; sx += 18) {
          fx.moveTo(h.x + sx, floorY - 2);
          fx.lineTo(h.x + sx + 9, floorY - 2);
        }
        fx.strokePath();
      }
    } else if (h.kind === 'piston') {
      const cx = h.x + h.width / 2;
      g.fillStyle(0x0c0a24, 1);
      g.fillRect(h.x - 6, h.baseY - 10, h.width + 12, 10);
      const rodGrad = 0x3a3e5a;
      g.fillStyle(rodGrad, 1);
      g.fillRect(cx - 5, topY + 12, 10, Math.max(0, h.baseY - 10 - topY - 12));
      g.fillStyle(0x1a0b24, 1);
      g.fillRect(h.x, topY, h.width, 14);
      g.fillStyle(0xff6b4a, 0.9);
      g.fillRect(h.x + 3, topY + 4, h.width - 6, 4);
      fx.lineStyle(3, 0xffb347, 0.95);
      fx.lineBetween(h.x - 2, topY, h.x + h.width + 2, topY);
      fx.lineStyle(10, 0xff6b4a, 0.16);
      fx.lineBetween(h.x - 2, topY, h.x + h.width + 2, topY);
    } else if (h.kind === 'barrier') {
      g.fillStyle(0x1a0b24, 1);
      g.fillRect(h.x, topY, h.width, h.height);
      const stripe = 12;
      for (let sx = 0; sx < h.width; sx += stripe * 2) {
        g.fillStyle(0xff6b4a, 0.85);
        g.fillRect(h.x + sx, topY + 6, Math.min(stripe, h.width - sx), Math.max(0, h.height - 12));
      }
      fx.lineStyle(3, 0xffb347, 0.95);
      fx.lineBetween(h.x - 2, topY, h.x + h.width + 2, topY);
      fx.lineStyle(10, 0xff6b4a, 0.18);
      fx.lineBetween(h.x - 2, topY, h.x + h.width + 2, topY);
    } else if (h.kind === 'pylon') {
      const cx = h.x + h.width / 2;
      g.fillStyle(0x140a2c, 1);
      g.fillTriangle(h.x, h.baseY, h.x + h.width, h.baseY, cx, topY + 10);
      g.fillRect(h.x - 4, h.baseY - 6, h.width + 8, 6);
      fx.lineStyle(2, 0x7b2cff, 0.9);
      fx.lineBetween(h.x + 4, h.baseY - 6, cx, topY + 12);
      fx.lineBetween(h.x + h.width - 4, h.baseY - 6, cx, topY + 12);
      const pulse = 0.7 + 0.3 * Math.sin(elapsed * 9 + h.x);
      fx.fillStyle(0xd06bff, 0.25 * pulse);
      fx.fillCircle(cx, topY + 8, 20);
      fx.fillStyle(0xf2d9ff, pulse);
      fx.fillCircle(cx, topY + 8, 7);
    } else {
      g.fillStyle(0x0f1636, 1);
      g.fillRect(h.x, topY, h.width, h.height);
      g.lineStyle(2, 0x2ef2ff, 0.45);
      g.lineBetween(h.x, topY, h.x + h.width, h.baseY);
      g.lineBetween(h.x + h.width, topY, h.x, h.baseY);
      fx.lineStyle(2, 0x2ef2ff, 0.95);
      fx.strokeRect(h.x, topY, h.width, h.height);
      fx.lineStyle(8, 0x2ef2ff, 0.12);
      fx.strokeRect(h.x, topY, h.width, h.height);
    }
  }

  private drawCar(x: number, y: number, angle: number, dt: number, displayedAngle = angle): void {
    const state = this.simulation.state;
    this.car.setPosition(x, y).setRotation(displayedAngle);
    // Barrel-roll illusion: squash the car edge-on as it rolls around its
    // long axis, so a scripted spin reads as a sideways 3D turn instead of a
    // flat somersault. roll ≈ π/2 shows the thin side profile.
    const rollSquash = Math.max(0.14, Math.abs(Math.cos(state.roll)));
    this.car.setScale(1, rollSquash);
    if (!state.crashed) this.wheelSpin += (state.speed * dt) / WHEEL_WORLD_R;
    for (const w of this.wheels) w.setRotation(this.wheelSpin);
    this.flameTimer = Math.max(0, this.flameTimer - dt);
    const rotating = state.rotating && !state.crashed;
    const burning = rotating || state.recovering || this.flameTimer > 0;
    const flicker = 0.85 + 0.15 * Math.sin(this.time.now * 0.09);
    this.flame.setVisible(burning).setScale((rotating ? 0.75 : 0.55) * flicker * K * 1.6, (0.7 + 0.15 * flicker) * K * 1.6);
    this.flameGlow.setAlpha(burning ? 0.85 : 0.25).setScale(burning ? 0.7 : 0.3);
    if (state.crashed) {
      this.crashTimer += 0;
      this.car.setAlpha(Math.max(0.35, 1 - this.crashTimer));
      this.flame.setVisible(false);
      return;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ex = x + this.nozzleX * cos - this.nozzleY * sin;
    const ey = y + this.nozzleX * sin + this.nozzleY * cos;
    this.exhaust.emitParticleAt(ex, ey, burning ? 3 : 1);
    // speed ghost trail — recycle the oldest point object instead of
    // allocating a fresh one every frame (GC pressure on low-end phones)
    const head = this.trail.length >= 14 ? this.trail.pop()! : { x: 0, y: 0, a: 1 };
    head.x = ex;
    head.y = ey;
    head.a = 1;
    this.trail.unshift(head);
    const fast = Math.min(1, Math.max(0, (state.speed - 600) / 300));
    if (fast > 0 || burning) {
      for (let i = 1; i < this.trail.length; i += 1) {
        const p0 = this.trail[i - 1]!;
        const p1 = this.trail[i]!;
        this.fx.lineStyle(6 * (1 - i / this.trail.length), 0x2ef2ff, 0.5 * (1 - i / this.trail.length) * Math.max(fast, burning ? 0.7 : 0));
        this.fx.lineBetween(p0.x, p0.y, p1.x - state.speed * dt * 0.0, p1.y);
      }
    }
  }

  private drawForeground(worldLeft: number, speed: number, _dt: number): void {
    const f = this.foreground;
    const W = this.scale.width;
    const H = this.scale.height;
    f.clear();
    const zoom = this.zoom;
    // fast parallax light posts along the bottom edge — the fill height used
    // to be H, painting ~1.7 screens of overdraw per post; clamp to the post.
    const spacing = 520 * zoom;
    const offset = ((worldLeft * zoom * 1.35) % spacing + spacing) % spacing;
    const biome = blendBiome(worldLeft);
    const postScale = Math.max(1, zoom * 1.6);
    const postH = 26 * postScale;
    f.fillStyle(0x05040f, 0.9);
    for (let px = -offset; px < W + spacing; px += spacing) {
      f.fillRect(px, H - postH, 10 * zoom + 3, postH + 2);
    }
    f.fillStyle(biome.accent, 0.8);
    for (let px = -offset; px < W + spacing; px += spacing) {
      f.fillRect(px - 6, H - 28 * postScale, 22 * zoom + 12, 3);
    }
    // high-speed streaks — one stroked path
    const fast = Math.min(1, Math.max(0, (speed - 620) / 320));
    if (fast > 0) {
      const t = this.time.now;
      f.lineStyle(1.5, 0xffffff, 0.12 * fast);
      f.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const sy = ((i * 97.13) % 1) * H * 0.85 + H * 0.05;
        const len = 80 + (i % 4) * 50;
        const sx = W - ((t * (1.2 + (i % 3) * 0.4) + i * 211) % (W + len * 2));
        f.moveTo(sx, sy);
        f.lineTo(sx + len, sy);
      }
      f.strokePath();
    }
  }

  getDebugSnapshot(): { state: Simulation['state']; activeRun: boolean; held: boolean } {
    return { state: this.simulation.state, activeRun: this.activeRun, held: this.inputHeld };
  }

  // Dev-only debug hook (exposed on window as __roadstronautDebug when
  // import.meta.env.DEV): repositions the car along the generated course so
  // playtests can reach deep-course features instantly.
  debugTeleport(x: number): void {
    const state = this.simulation.state;
    const surface = this.simulation.course.surfaceAt(x);
    if (!surface) return;
    state.x = x;
    state.y = surface.y - CAR_HEIGHT;
    state.vy = 0;
    state.grounded = true;
    state.inverted = false;
    state.angle = surface.slope;
    state.angularVelocity = 0;
    state.roll = 0;
    state.elapsed = Math.max(state.elapsed, timeAtDistance(x));
    state.speed = state.vx;
    this.previousX = state.x;
    this.previousY = state.y;
    this.previousAngle = state.angle;
    this.camY = Number.NaN; // snap camera height on next draw instead of lerping
    this.sceneDirty = true;
  }

  debugCourseLandmarks(): { vruns: unknown[]; vehicleRows: unknown[] } {
    const course = this.simulation.course;
    return {
      vruns: course.verticalRunsInRange(0, this.simulation.state.x + 400000),
      vehicleRows: course.hazardsAhead(0, this.simulation.state.x + 400000)
        .filter((hazard) => hazard.kind === 'vehicles')
        .map((hazard) => ({ x: hazard.x, width: hazard.width, requiresRamp: hazard.requiresRamp })),
    };
  }
}
