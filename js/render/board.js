// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no block is
// "full" here, no number is judged wrong here — so the picture cannot disagree with the solver the
// hints and the win check both use. Every verdict on screen comes from js/engine/fillomino.js:
// `regions()` says which cells are one block, `diagnose()` says which of them read wrong.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitCell has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, DigitFill, Font } from '../theme.js';
import { OPEN, NO_CLUE } from '../engine/fillomino.js';

export function layoutFor(w, h, availW, availH) {
  const pad = Cell.pad; // the blobs' outlines are drawn on the grid lines, so they need a margin
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.scale at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: (t % this.game.w) * cell + x, y: ((t / this.game.w) | 0) * cell + y, size: cell };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const won = game.status === 'won';
    // Everything below reads these three engine answers: the merged number board, the blocks cut
    // out of it, and which of those blocks the rulebook calls wrong.
    const ink = game.ink;
    const areas = game.areas;
    const violated = game.diag.violated;

    ctx.clearRect(0, 0, geo.w, geo.h);
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // The paper. A cell with no number on it stays the colour of an empty square, so "not written
    // yet" is never confused with "written as 0" — there is no such thing as a 0 in 埋方块.
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = ink[t] === OPEN ? Palette.bgBottom : Palette.surfaceLift;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // One id per cell, straight out of regions(): same id means the engine already says these
    // cells are one block, and the painting below only ever asks whether two neighbours agree.
    const idOf = new Int16Array(b.n).fill(-1);
    areas.forEach((a, i) => {
      for (const t of a.cells) idOf[t] = i;
    });

    // Shared fill per block: every cell of one block wears one colour, so a pentomino reads as one
    // shape rather than five separate squares that happen to match.
    for (const a of areas) {
      const bad = violated.has(a.cells[0]);
      ctx.fillStyle = bad ? Palette.errorFill : DigitFill[(a.value - 1) % DigitFill.length];
      for (const t of a.cells) {
        const r = this.cellRect(t);
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // The blob outlines. Only a side whose neighbour belongs to another block (or to none) is
    // drawn, which is what makes a connected block look like one thick-edged shape.
    //
    // The rim is pulled half a line width *inside* the block instead of being centred on the grid
    // line, because the colour is this block's verdict (`full` / violated) and a grid line is shared
    // by two blocks. Centred on the line, one block's verdict physically overwrote the neighbour's:
    // a finished block lost the side it shared with a still-growing one, and a growing block wore
    // green where its neighbour had finished. Painted inside its own cells, every outer side of a
    // full block is green and no side of a growing block ever is.
    const w = b.w;
    const h = b.h;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.5, cell * Cell.lineScale);
    const ins = ctx.lineWidth / 2;
    for (const a of areas) {
      const root = a.cells[0];
      const bad = violated.has(root);
      ctx.strokeStyle = won || a.full ? Palette.success : bad ? Palette.error : Palette.info;
      ctx.beginPath();
      for (const t of a.cells) {
        const r = this.cellRect(t);
        const row = (t / w) | 0;
        const col = t % w;
        const up = row > 0 ? t - w : -1;
        const down = row + 1 < h ? t + w : -1;
        const left = col > 0 ? t - 1 : -1;
        const right = col + 1 < w ? t + 1 : -1;
        if (up < 0 || idOf[up] !== idOf[t]) line(ctx, r.x, r.y + ins, r.x + cell, r.y + ins);
        if (down < 0 || idOf[down] !== idOf[t]) line(ctx, r.x, r.y + cell - ins, r.x + cell, r.y + cell - ins);
        if (left < 0 || idOf[left] !== idOf[t]) line(ctx, r.x + ins, r.y, r.x + ins, r.y + cell);
        if (right < 0 || idOf[right] !== idOf[t]) line(ctx, r.x + cell - ins, r.y, r.x + cell - ins, r.y + cell);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // Grid, under the digits and over the fills.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, geo.x, geo.y + j * cell, geo.x + game.w * cell, geo.y + j * cell);

    // The box under the finger, before it is committed: a preview is paint, never ink.
    if (preview && preview.cells) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // The numbers. A printed one is bright white and heavier than the player's amber, so "whose 4
    // is this" is answerable without reading the hint box. A wrong block turns its own number red.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const digit = Math.round(cell * Cell.digitScale);
    for (let t = 0; t < b.n; t++) {
      const v = ink[t];
      if (v === OPEN) continue;
      const r = this.cellRect(t);
      const given = b.clue[t] !== NO_CLUE;
      const bad = violated.has(idOf[t] >= 0 ? areas[idOf[t]].cells[0] : t);
      ctx.font = `${given ? 800 : 700} ${digit}px ${Font.sans}`;
      ctx.fillStyle = bad ? Palette.error : given ? Palette.ink : Palette.accent;
      ctx.fillText(String(v), r.x + cell / 2, r.y + cell / 2 + 1);
    }

    // What a hint just named — the only place the UI is allowed to say "look here". The ring goes
    // round the whole block, because the rule that fired talks about the block, not the cell.
    if (pulse && pulse.cell != null && pulse.cell >= 0) {
      const mine = idOf[pulse.cell];
      const cells = mine >= 0 ? areas[mine].cells : [pulse.cell];
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      for (const t of cells) {
        const r = this.cellRect(t);
        roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
        ctx.stroke();
      }
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
