import type Phaser from 'phaser';

function canvasTexture(scene: Phaser.Scene, key: string, width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): void {
  if (scene.textures.exists(key)) return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Canvas2D unavailable for ${key}`);
  paint(context);
  const texture = scene.textures.addCanvas(key, canvas);
  texture.refresh();
}

export function registerArt(scene: Phaser.Scene): void {
  canvasTexture(scene, 'car-body', 180, 76, (ctx) => {
    ctx.save();
    ctx.shadowColor = '#2ef2ff';
    ctx.shadowBlur = 16;
    const body = ctx.createLinearGradient(12, 20, 160, 60);
    body.addColorStop(0, '#e5fbff');
    body.addColorStop(0.24, '#8feeff');
    body.addColorStop(0.58, '#526fca');
    body.addColorStop(1, '#20284e');
    ctx.beginPath();
    ctx.moveTo(12, 50);
    ctx.lineTo(24, 36);
    ctx.quadraticCurveTo(43, 32, 58, 17);
    ctx.quadraticCurveTo(77, 7, 112, 12);
    ctx.lineTo(145, 22);
    ctx.quadraticCurveTo(164, 27, 169, 41);
    ctx.lineTo(168, 52);
    ctx.lineTo(142, 58);
    ctx.lineTo(48, 60);
    ctx.lineTo(20, 57);
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#c2fcff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(66, 20);
    ctx.quadraticCurveTo(82, 10, 109, 17);
    ctx.lineTo(130, 26);
    ctx.lineTo(59, 28);
    ctx.closePath();
    ctx.fillStyle = '#101a38';
    ctx.fill();
    ctx.strokeStyle = '#72f4ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ff6b4a';
    ctx.fillRect(136, 40, 22, 4);
    ctx.fillStyle = '#efffff';
    ctx.fillRect(14, 43, 11, 5);
    ctx.beginPath();
    ctx.moveTo(40, 52);
    ctx.lineTo(125, 52);
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  });

  canvasTexture(scene, 'car-wheel', 44, 44, (ctx) => {
    ctx.beginPath();
    ctx.arc(22, 22, 19, 0, Math.PI * 2);
    ctx.fillStyle = '#080b18';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9caac9';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(22, 22, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#5f719d';
    ctx.fill();
    ctx.strokeStyle = '#d7fbff';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i += 1) {
      const a = i * Math.PI * 0.4;
      ctx.beginPath();
      ctx.moveTo(22 + Math.cos(a) * 3, 22 + Math.sin(a) * 3);
      ctx.lineTo(22 + Math.cos(a) * 9, 22 + Math.sin(a) * 9);
      ctx.stroke();
    }
  });

  canvasTexture(scene, 'thruster-flame', 90, 36, (ctx) => {
    const gradient = ctx.createLinearGradient(2, 18, 86, 18);
    gradient.addColorStop(0, 'rgba(255,107,74,0)');
    gradient.addColorStop(0.32, '#ffb347');
    gradient.addColorStop(0.72, '#2ef2ff');
    gradient.addColorStop(1, 'rgba(46,242,255,0)');
    ctx.beginPath();
    ctx.moveTo(4, 18);
    ctx.lineTo(82, 4);
    ctx.lineTo(68, 18);
    ctx.lineTo(82, 32);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  });

  canvasTexture(scene, 'sky-gradient', 1024, 720, (ctx) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, 720);
    gradient.addColorStop(0, '#090a27');
    gradient.addColorStop(0.48, '#28205d');
    gradient.addColorStop(0.78, '#743663');
    gradient.addColorStop(1, '#f27669');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1024, 720);
    const glow = ctx.createRadialGradient(780, 475, 10, 780, 475, 380);
    glow.addColorStop(0, 'rgba(255,167,126,.58)');
    glow.addColorStop(1, 'rgba(255,107,74,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(300, 140, 724, 580);
  });

  canvasTexture(scene, 'mountain-ridge', 1024, 260, (ctx) => {
    ctx.fillStyle = '#15183e';
    ctx.beginPath();
    ctx.moveTo(0, 260);
    for (let x = 0; x <= 1024; x += 128) ctx.lineTo(x, 82 + ((x * 37) % 96));
    ctx.lineTo(1024, 260);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,242,255,.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(11,10,35,.7)';
    for (let x = 20; x < 1024; x += 62) {
      const h = 55 + ((x * 13) % 115);
      ctx.fillRect(x, 260 - h, 28 + (x % 19), h);
      ctx.fillStyle = 'rgba(255,179,71,.24)';
      for (let wy = 260 - h + 12; wy < 250; wy += 23) ctx.fillRect(x + 7, wy, 3, 5);
      ctx.fillStyle = 'rgba(11,10,35,.7)';
    }
  });
}
