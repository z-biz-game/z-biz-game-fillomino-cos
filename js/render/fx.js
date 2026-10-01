// 动效层：提示光晕与胜利彩带。它画在**另一张覆盖画布**上，而不是画在 #board 上——
// tools/scenarios.js 是按 #board 的像素断言"没写的格就是纸色""这块描蓝边"的，
// 一个会随时间淡出的光晕若画在同一张画布上，就把这些断言变成了跟时间赛跑的抽奖。
//
// 时间推进只走定步长累加器：`accum += 帧dt`，然后按 SIM_STEP 一格一格喂给 step()。
// 于是粒子位置与光晕进度只取决于**过了多少虚拟秒**，与浏览器给了 30、60 还是 144 帧无关。
// 需要"帧率无关"的写法（Math.pow(k, dt*60)、1-Math.pow(1-p, dt*60)）都留在 step() 里，
// 那里 dt 恒等于 SIM_STEP，所以阻尼与重力在任何帧率下都积出同一条轨迹。

import { Palette } from '../theme.js';

export const SIM_STEP = 1 / 120;
// 一次最多补这么多步（0.2s）：标签页切走十分钟回来时不该在恢复的第一帧里跑一万步。
const MAX_CATCHUP = 24;
const GRAVITY = 900;
const HALO_LIFE = 0.9;

export class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.clock = 0;
    this.steps = 0;
    this.accum = 0;
    this.halo = null;
    this.parts = [];
    this.reduced = false;
    this.sprite = null;
    this.geo = null;
  }

  // 精灵条由 assets/gen/gen_art.py 产出（8 个色块一行）。取不到图也不报错：彩带退化成方块，
  // 一张丢失的贴图不该把通关结算一起拖没。
  loadSprite(url) {
    const img = new Image();
    img.onload = () => { this.sprite = img; };
    img.src = url;
    return img;
  }

  setReducedMotion(v) {
    this.reduced = !!v;
    if (this.reduced) {
      this.parts.length = 0;
      this.halo = null;
    }
  }

  // 覆盖画布与棋盘画布共用同一套 CSS 尺寸与 DPR：两套几何一旦漂移，光晕就会盖错格。
  resize(geo) {
    this.geo = geo;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas.style.width = `${geo.w}px`;
    this.canvas.style.height = `${geo.h}px`;
    this.canvas.width = Math.round(geo.w * dpr);
    this.canvas.height = Math.round(geo.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  hint(cells, color) {
    if (this.reduced || !cells || !cells.length) return false;
    this.halo = { cells: cells.slice(), t: 0, life: HALO_LIFE, color: color || null };
    return true;
  }

  burst(count = 46) {
    if (this.reduced || !this.geo) return 0;
    const { w, h } = this.geo;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.31;
      const speed = 260 + (i % 7) * 34;
      this.parts.push({
        x: w / 2,
        y: h * 0.42,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 120,
        rot: a,
        spin: (i % 2 ? 1 : -1) * (2.2 + (i % 5) * 0.4),
        size: 10 + (i % 4) * 3,
        tint: i % 8,
        life: 1.15 + (i % 5) * 0.09,
        age: 0,
      });
    }
    return this.parts.length;
  }

  active() {
    return !!(this.halo || this.parts.length);
  }

  // 唯一吃"帧 dt"的地方，负向对照就钉在这一行：把 `+= elapsed` 换成 `+= SIM_STEP`，1 秒真实时间里
  // 30Hz 只推进 0.25 虚拟秒、120Hz 推进 1.0 虚拟秒——对拍立刻变红。
  advance(elapsed) {
    this.accum += elapsed;
    // 步数从累加时间一次算出，余数也只减一次：逐步 accum -= SIM_STEP 会把浮点亏空攒成"整整一秒
    // 只走出 119 步"，于是 30Hz 与 120Hz 又差开一步——帧率无关就差这最后一步。
    // 那个 1e-9 是给边界留的：1.000s 恰等于 120 步，浮点会留下 1e-16 的亏空，舍入方向就由帧率决定了。
    // 容差 = 1e-9 步 ≈ 8.3ps，比任何一帧都小九个数量级；max(0, …) 保证负的余数买不到额外一步。
    const n = Math.max(0, Math.min(MAX_CATCHUP, Math.floor(this.accum / SIM_STEP + 1e-9)));
    for (let i = 0; i < n; i++) this.step(SIM_STEP);
    this.accum -= n * SIM_STEP;
    if (this.accum > SIM_STEP) this.accum = 0;
    return n;
  }

  step(dt) {
    this.clock += dt;
    this.steps++;
    if (this.halo) {
      this.halo.t += dt;
      if (this.halo.t >= this.halo.life) this.halo = null;
    }
    // 阻尼写成 Math.pow(k, dt*60)：0.985 是"每 1/60 秒"的衰减率，直接 *= 0.985 就只在 60Hz 成立。
    const drag = Math.pow(0.985, dt * 60);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.vy += GRAVITY * dt;
      p.vx *= drag;
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.age >= p.life) this.parts.splice(i, 1);
    }
  }

  reset() {
    this.clock = 0;
    this.steps = 0;
    this.accum = 0;
    this.halo = null;
    this.parts.length = 0;
  }

  draw(cellRect) {
    const ctx = this.ctx;
    if (!this.geo) return;
    ctx.clearRect(0, 0, this.geo.w, this.geo.h);
    if (this.halo) {
      const k = this.halo.t / this.halo.life;
      const grow = (1 - Math.pow(1 - k, 3)) * 7;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.85 * (1 - k));
      ctx.strokeStyle = this.halo.color || Palette.hint;
      ctx.lineWidth = 3;
      for (const t of this.halo.cells) {
        const r = cellRect(t);
        if (!r) continue;
        ctx.strokeRect(r.x + 1 - grow, r.y + 1 - grow, r.size - 2 + grow * 2, r.size - 2 + grow * 2);
      }
      ctx.restore();
    }
    for (const p of this.parts) {
      const k = 1 - p.age / p.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const img = this.sprite;
      if (img && img.complete && img.naturalWidth) {
        const chip = img.naturalWidth / 8;
        ctx.drawImage(img, p.tint * chip, 0, chip, chip, -p.size / 2, -p.size / 2, p.size, p.size);
      } else {
        ctx.fillStyle = [Palette.accent, Palette.success, Palette.info, Palette.error][p.tint % 4];
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  snapshot() {
    return {
      clock: this.clock,
      steps: this.steps,
      accum: this.accum,
      particles: this.parts.length,
      // 只报个数的对拍等于没对拍：粒子数在任何帧率下都一样多。位置与旋转才是"虚拟秒"的证据。
      sumX: this.parts.reduce((s, p) => s + p.x, 0),
      sumY: this.parts.reduce((s, p) => s + p.y, 0),
      spin: this.parts.reduce((s, p) => s + p.rot, 0),
      halo: this.halo ? this.halo.t : -1,
      reduced: this.reduced,
    };
  }
}
