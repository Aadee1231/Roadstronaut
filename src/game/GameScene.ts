import Phaser from 'phaser';
import { CAR_HEIGHT, FIXED_DT, WHEEL_RADIUS, WHEELBASE } from '../sim/constants';
import { BASE_Y, type CourseSegment, type Hazard } from '../sim/course';
import { encodeInputLog } from '../sim/replay';
import { Simulation, WHEEL_VERTICAL_OFFSET } from '../sim/simulation';
import type { SimEvent } from '../sim/simulation';
import { CAR_ART } from './art/carArt';
import { CAR_TEXTURE_SCALE, registerArt } from './art/registerArt';
import { BIOMES, blendBiome } from './biomes';

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

interface ParallaxLayer {
  sprite: Phaser.GameObjects.TileSprite;
  factor: number;
  heightFrac: number;
  lift: number;
}

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
  private camY = BASE_Y;
  private wheelSpin = 0;
  private flameTimer = 0;
  private crashTimer = 0;
  private trail: { x: number; y: number; a: number }[] = [];

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
      blendMode: 'ADD', emitting: false,
    }).setDepth(4);
    this.dust = this.add.particles(0, 0, 'smoke', {
      lifespan: { min: 380, max: 750 }, speedX: { min: -220, max: -40 }, speedY: { min: -90, max: -10 },
      scale: { start: 0.35, end: 1.1 }, alpha: { start: 0.45, end: 0 }, tint: [0xb9a6ff, 0xffb3a0],
      emitting: false,
    }).setDepth(6);
    this.sparks = this.add.particles(0, 0, 'spark', {
      lifespan: { min: 250, max: 650 }, speed: { min: 120, max: 460 }, angle: { min: 180, max: 360 },
      gravityY: 900, scale: { start: 0.5, end: 0 }, alpha: { start: 1, end: 0 }, tint: [0xffb347, 0xff6b4a, 0xfff3b0],
      blendMode: 'ADD', emitting: false,
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
    if (!this.activeRun && !this.attractMode) {
      this.crashTimer += dt;
      this.drawScene(dt);
      return;
    }
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
    this.drawScene(dt);
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
    this.camY = simulation.state.y;
    this.trail.length = 0;
    this.crashTimer = 0;
    this.car.setVisible(true).setAlpha(1);
    this.carBody.clearTint();
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
    const zoom = this.zoom;
    const viewW = this.scale.width / zoom;
    const viewH = this.scale.height / zoom;
    const anchor = this.portrait ? 0.6 : 0.68;

    const ground = this.simulation.course.surfaceAt(x)?.y ?? BASE_Y;
    const restY = Math.min(ground, BASE_Y + 60);
    let targetTop = restY - viewH * anchor;
    targetTop = Math.min(targetTop, y - viewH * 0.3);
    const camTop = Phaser.Math.Linear(this.camY, targetTop, 1 - Math.exp(-dt * 5));
    this.camY = camTop;
    const worldLeft = x - viewW * (this.portrait ? 0.2 : 0.24);
    const worldTop = camTop;
    this.world.setScale(zoom).setPosition(-worldLeft * zoom, -worldTop * zoom);

    this.drawBackground(worldLeft, worldTop, viewH);
    this.drawTrack(worldLeft, worldTop, viewW, viewH, state.elapsed);
    this.drawCar(x, y, angle, dt);
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
    const restTop = BASE_Y - viewH * (this.portrait ? 0.6 : 0.68);
    const liftPx = (restTop - worldTop) * this.zoom;
    const horizon = H * (this.portrait ? 0.6 : 0.68) + liftPx * 0.25;
    this.stars.setAlpha(b.stars).setTilePosition(worldLeft * 0.01, -liftPx * 0.05);
    const sunSize = Math.min(W, H) * (this.portrait ? 0.75 : 0.55);
    this.sun.setDisplaySize(sunSize, sunSize).setPosition(W * (this.portrait ? 0.6 : 0.68), horizon - sunSize * 0.18 + liftPx * 0.05).setAlpha(b.sun).setVisible(b.sun > 0.01);
    const tint: Record<keyof typeof this.layers, [number, number]> = {
      mountains: [b.mountain, 1],
      structures: [b.structures, b.structuresAlpha],
      beacons: [b.accent === 0xffb347 ? 0xff4d6d : 0xff6b4a, b.structuresAlpha * (0.6 + 0.4 * Math.sin(this.time.now / 300))],
      skyline: [b.skyline, b.skylineAlpha],
      lights: [b.lights, b.skylineAlpha * 0.85],
    };
    for (const [name, l] of Object.entries(this.layers) as [keyof typeof this.layers, ParallaxLayer][]) {
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
    for (const seg of segments) {
      if (seg.kind === 'gap') continue;
      g.fillStyle(biome.ground, 1);
      g.fillPoints([{ x: seg.x0, y: seg.y0 }, { x: seg.x1, y: seg.y1 }, { x: seg.x1, y: bottom }, { x: seg.x0, y: bottom }], true);
      // depth strata
      for (const [depth, alpha] of [[16, 0.22], [42, 0.12], [90, 0.06]] as const) {
        g.lineStyle(2, edge, alpha);
        g.lineBetween(seg.x0, seg.y0 + depth, seg.x1, seg.y1 + depth);
      }
    }
    // vertical grid posts
    const spacing = 160;
    for (let gx = Math.floor((left - 200) / spacing) * spacing; gx < right; gx += spacing) {
      const s = course.surfaceAt(gx);
      if (!s) continue;
      g.lineStyle(2, edge, 0.13);
      g.lineBetween(gx, s.y + 4, gx, s.y + 110);
    }
    for (const seg of segments) {
      if (seg.kind === 'gap') {
        this.drawGapRims(seg, elapsed);
        continue;
      }
      const isLaunch = seg.kind === 'launch';
      const isKicker = seg.kind === 'kicker';
      const color = isLaunch ? 0xff6b4a : isKicker ? accent : edge;
      fx.lineStyle(9, color, 0.18);
      fx.lineBetween(seg.x0, seg.y0, seg.x1, seg.y1);
      fx.lineStyle(3, color, 0.95);
      fx.lineBetween(seg.x0, seg.y0, seg.x1, seg.y1);
      if (isLaunch || isKicker) this.drawRampDetail(seg, isLaunch, elapsed);
    }
    for (const hazard of course.hazardsAhead(left - 200, right - left + 200)) {
      if (hazard.kind !== 'gap') this.drawObstacle(hazard, elapsed);
    }
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
    const n = Math.max(2, Math.floor(len / 40));
    for (let i = 1; i < n; i += 1) {
      const px = seg.x0 + (len * i) / n;
      const py = seg.y0 + ((seg.y1 - seg.y0) * i) / n;
      g.lineBetween(px, py + 3, px, lipY + 4);
      if (i % 2) g.lineBetween(px, py + 3, seg.x0 + (len * (i + 1)) / n, lipY + 2);
    }
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
    const topY = h.baseY - h.height;
    if (h.kind === 'barrier') {
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

  private drawCar(x: number, y: number, angle: number, dt: number): void {
    const state = this.simulation.state;
    this.car.setPosition(x, y).setRotation(angle);
    if (!state.crashed) this.wheelSpin += (state.speed * dt) / WHEEL_WORLD_R;
    for (const w of this.wheels) w.setRotation(this.wheelSpin);
    this.flameTimer = Math.max(0, this.flameTimer - dt);
    const rotating = state.rotating && !state.crashed;
    const burning = rotating || this.flameTimer > 0;
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
    const [nx, ny] = artToCar(4, 61);
    const ex = x + nx * cos - ny * sin;
    const ey = y + nx * sin + ny * cos;
    this.exhaust.emitParticleAt(ex, ey, burning ? 3 : 1);
    // speed ghost trail
    this.trail.unshift({ x: ex, y: ey, a: 1 });
    if (this.trail.length > 14) this.trail.pop();
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
    // fast parallax light posts along the bottom edge
    const spacing = 520 * zoom;
    const offset = ((worldLeft * zoom * 1.35) % spacing + spacing) % spacing;
    const biome = blendBiome(worldLeft);
    for (let px = -offset; px < W + spacing; px += spacing) {
      f.fillStyle(0x05040f, 0.9);
      f.fillRect(px, H - 26 * Math.max(1, zoom * 1.6), 10 * zoom + 3, H);
      f.fillStyle(biome.accent, 0.8);
      f.fillRect(px - 6, H - 28 * Math.max(1, zoom * 1.6), 22 * zoom + 12, 3);
    }
    // high-speed streaks
    const fast = Math.min(1, Math.max(0, (speed - 620) / 320));
    if (fast > 0) {
      const t = this.time.now;
      for (let i = 0; i < 10; i += 1) {
        const sy = ((i * 97.13) % 1) * H * 0.85 + H * 0.05;
        const len = 80 + (i % 4) * 50;
        const sx = W - ((t * (1.2 + (i % 3) * 0.4) + i * 211) % (W + len * 2));
        f.lineStyle(1.5, 0xffffff, 0.12 * fast);
        f.lineBetween(sx, sy, sx + len, sy);
      }
    }
  }

  getDebugSnapshot(): { state: Simulation['state']; activeRun: boolean; held: boolean } {
    return { state: this.simulation.state, activeRun: this.activeRun, held: this.inputHeld };
  }
}
