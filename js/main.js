// Wiring: DOM, pointer gestures, the clock, storage, and the `window.fillomino` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/fillomino.js through js/ui/game.js.

import { Palette, DigitFill, Cell, Radius, applyThemeVars, setReduceMotion, systemPrefersReducedMotion, prefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, plantSolution, pruneClues, mix } from './engine/generate.js';
import * as Engine from './engine/fillomino.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Fx, SIM_STEP } from './render/fx.js';
import { Game, digitName, OPEN, NO_CLUE } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('#app'),
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  palette: $('#palette'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  blocks: $('#stat-blocks'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  pauseVeil: $('#pause-veil'),
  pauseMeta: $('#pause-meta'),
  pause: $('#btn-pause'),
  full: $('#btn-fullscreen'),
  help: $('#btn-help'),
  helpVeil: $('#help-veil'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
  fx: $('#fx-layer'),
};

const view = new BoardView(el.canvas);
const fx = new Fx(el.fx);
let game = null;
let pulse = null;
let stroke = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let paused = false;
let raf = 0;
let lastTs = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;
// 暂停与胜利之后，任何改变棋盘输入的路径都要先问这一句。漏掉一处，就是"暂停还在偷写数字"。
const blocked = () => paused || !game || game.status === 'won';

// ---- 动效循环：唯一的推进者是 rAF 的时间戳 ---------------------------------------------------

function frame(ts) {
  raf = 0;
  if (paused || !game) {
    lastTs = 0;
    return;
  }
  const now = ts / 1000;
  // 首帧不白吃：kick() 里已经把 lastTs 摆到当前时刻，所以这里拿到的永远是真实间隔。
  const elapsed = lastTs ? Math.min(0.25, now - lastTs) : 0;
  lastTs = now;
  if (elapsed > 0) fx.advance(elapsed);
  fx.draw((t) => view.cellRect(t));
  if (fx.active()) raf = requestAnimationFrame(frame);
  else lastTs = 0;
}

function kick() {
  if (raf || paused || !fx.active()) return;
  lastTs = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
  raf = requestAnimationFrame(frame);
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  fx.resize(view.geo);
  view.draw(game, { pulse, preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null });
  if (fx.active()) fx.draw((t) => view.cellRect(t));
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  // 已写 counts the ink the *player* put down, out of the cells the author left blank; the givens
  // are already on the paper and crediting them would make every board start at "half done".
  el.filled.textContent = `${st.written}/${st.total - st.clues}`;
  el.remaining.textContent = st.remaining;
  el.blocks.textContent = `${st.full}/${st.blocks}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score.toFixed(1);
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.blocks.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.conflicts > 0);
  el.filled.closest('.stat').classList.toggle('bad', st.stuck);
  el.stateLine.textContent = st.stuck
    ? '这些数字和区域规则已经矛盾了：不管剩下的格怎么写，都不可能每块刚好长满。撤销一步再想。'
    : st.conflicts
      ? `${st.conflicts} 块对不上：它连成的格子数和它写着的数不一样。`
      : '';
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

// The palette is cut from the board: 擦除 plus one button per digit the 最大块 allows. A tier that
// caps regions at 4 must not offer a 5, because a 5 could never be legal on it.
function renderPalette() {
  if (!game) return;
  el.palette.innerHTML = '';
  const mk = (value, label, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = value === OPEN ? 'digit erase' : 'digit';
    b.dataset.digit = String(value);
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.setAttribute('aria-pressed', String(game.digit === value));
    b.addEventListener('click', () => setDigit(value));
    el.palette.appendChild(b);
    return b;
  };
  mk(OPEN, '擦', '擦除这一格的数字');
  for (let k = 1; k <= game.maxK; k++) mk(k, String(k), `写 ${digitName(k)}`);
  el.palette.style.setProperty('--digits', String(game.maxK + 1));
  el.canvas.dataset.digit = String(game.digit);
}

function setDigit(value) {
  if (!game || paused) return false;
  if (!game.setDigit(value)) return false;
  for (const b of el.palette.querySelectorAll('.digit')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.digit) === game.digit));
  }
  el.canvas.dataset.digit = String(game.digit);
  draw();
  return true;
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这一笔对不上';
    el.hintLine.textContent = info.conflict;
    pulse = { cell: info.cell, color: 'rgba(255,92,122,0.9)' };
    setTimeout(() => {
      if (pulse && pulse.cell === info.cell) pulse = null;
      draw();
    }, 1600);
    if (fx.hint([info.cell], 'rgba(255,92,122,0.9)')) kick();
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell };
  const mine = pulse;
  setTimeout(() => {
    if (pulse === mine) pulse = null;
    draw();
  }, 1600);
  // 光晕画在覆盖层上、按虚拟秒淡出；省动效时 hint() 直接返回 false，一个粒子都不会生成。
  const area = game.areas.find((a) => a.cells.includes(info.cell));
  if (fx.hint(area ? area.cells : [info.cell])) kick();
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  if (fx.burst() > 0) kick();
  Sound.win();
  renderRecords();
}

// ---- 暂停 / 全屏 / 教学 ----------------------------------------------------------------------

// 暂停要停三样：走时的钟、动效的推进器、以及一切改棋盘输入的入口。少停一样，就是
// "遮罩盖着、时间在跑、数字还在写"那种假暂停。
function setPaused(v) {
  const on = !!v;
  if (on === paused) return paused;
  // 没有牌局（或已经赢了）就不该被暂停；但"解除暂停"永远放行——回选档、清空存档之后
  // 若把解除也一起挡掉，下一局就开在一颗 paused=true 的死棋上。
  if (on && (!game || game.status === 'won')) return paused;
  paused = on;
  if (on) {
    stopClock();
    flushResume();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    lastTs = 0;
  } else {
    startClock();
    if (fx.active()) kick();
  }
  el.pauseVeil.hidden = !on;
  if (on) el.pauseMeta.textContent = `用时停在 ${fmtMs(clock())}，盘面不会替你多想一步。`;
  el.pause.textContent = on ? '继续' : '暂停';
  el.pause.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('is-paused', on);
  return paused;
}

const fullscreenNode = () => document.fullscreenElement || document.webkitFullscreenElement;

function syncFullscreen() {
  const on = !!fullscreenNode();
  el.full.textContent = on ? '退出全屏' : '全屏';
  el.full.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('is-fullscreen', on);
  draw();
  return on;
}

// 按钮 id 必须挂在真实存在的节点上（el.full），并且拿不到权限时只是不动，不抛。
async function toggleFullscreen() {
  const node = fullscreenNode();
  try {
    if (node) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
    } else {
      const target = el.app || document.documentElement;
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (!req) return syncFullscreen();
      await req.call(target, { navigationUI: 'hide' });
    }
  } catch {
    /* 浏览器拒绝（非用户手势、iframe 没授权）就保持原样，游戏照玩 */
  }
  return syncFullscreen();
}

function toggleHelp(v) {
  const on = v === undefined ? el.helpVeil.hidden : !!v;
  el.helpVeil.hidden = !on;
  el.help.setAttribute('aria-expanded', String(on));
  return on;
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.stuck || game.diag.violated.size) Sound.conflict();
  }
}

function useHint() {
  if (blocked()) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep('place');
  return info;
}

function undo() {
  if (blocked()) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  pulse = null;
  stroke = null;
  // 重开必须把时钟、动效累加器、粒子、暂停态一起清干净：只 new 一个 Game 而留着
  // 上一局的 accum/particles，等于把上一局的时间尾巴带进新的一局。
  paused = false;
  el.pauseVeil.hidden = true;
  el.pause.textContent = '暂停';
  el.pause.setAttribute('aria-pressed', 'false');
  document.body.classList.remove('is-paused');
  fx.reset();
  el.winVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.load(resume.board);
  }
  renderPalette();
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    setPaused(false);
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '数字给得密，一块数一数就长满',
  apprentice: '要开始数「这块还差几格」',
  regular: '五格块来了，光看邻居不够',
  expert: '数字稀了，得看哪格是必经之路',
  master: '盘大数少，一块走错全盘对不上',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.w}×${t.h} · 最大 ${t.maxK} 块 · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  // 省动效不是"把动画调快"：粒子与光晕在这条分支里根本不生成，循环也就一次都不会启动。
  fx.setReducedMotion(reduce);
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer gestures: down picks up the selected digit, up commits one step ------------------

// During a drag the cells are painted ahead of the commit so the picture follows the finger.
// Each preview remembers the state the cell had *before* the gesture, because the committed step
// has to record that as its undo target — restoring to OPEN instead would quietly eat the digit
// the player was about to overwrite.
function preview(t, value) {
  if (!game.writable(t)) return false;
  stroke.items.push({ cell: t, from: game.st.cell[t] });
  game.st.cell[t] = value;
  game.recompute();
  return true;
}

function unpreview() {
  for (const it of stroke.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function strokeStart(ev) {
  if (blocked()) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  stroke = { items: [], value: game.digit };
  preview(t, stroke.value);
  draw();
}

function strokeMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  if (stroke.items.some((it) => it.cell === t) || game.st.cell[t] === stroke.value) return;
  preview(t, stroke.value);
  draw();
}

function strokeEnd() {
  if (!stroke || !game) return null;
  const s = stroke;
  const cells = s.items.map((it) => it.cell);
  unpreview();
  stroke = null;
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(s.value === OPEN ? 'erase' : 'place');
  return step;
}

el.canvas.addEventListener('pointerdown', strokeStart);
el.canvas.addEventListener('pointermove', strokeMove);
el.canvas.addEventListener('pointerup', strokeEnd);
el.canvas.addEventListener('pointercancel', () => {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// 没有 PointerEvent 的老浏览器（iOS Safari < 13 一类）走 touch/mouse 回落。两条路都只喂
// clientX/clientY 给 hitCell，而 hitCell 内部是 getBoundingClientRect 换算的，所以 CSS 缩放
// 下点 A 打 B 这件事在这两个分支里都不成立。
if (typeof window.PointerEvent === 'undefined') {
  // 回落路径上真正带坐标的是 Touch，但 Touch 没有 preventDefault：直接把 ev.touches[0] 当
  // 事件喂给 strokeStart，那一发 ev.preventDefault() 就在第一根手指落下时抛 TypeError，
  // 整条触屏线一笔都写不进去。所以归一化成"坐标 + 代理回原事件的 preventDefault"。
  const touchArgs = (ev) => {
    const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
    return {
      clientX: t.clientX,
      clientY: t.clientY,
      target: ev.target,
      preventDefault: () => { if (ev.preventDefault) ev.preventDefault(); },
    };
  };
  el.canvas.addEventListener('touchstart', (ev) => strokeStart(touchArgs(ev)), { passive: false });
  el.canvas.addEventListener('touchmove', (ev) => strokeMove(touchArgs(ev)), { passive: false });
  el.canvas.addEventListener('touchend', strokeEnd);
  el.canvas.addEventListener('touchcancel', () => {
    if (!stroke) return;
    unpreview();
    stroke = null;
    syncAll();
  });
  el.canvas.addEventListener('mousedown', strokeStart);
  el.canvas.addEventListener('mousemove', (ev) => {
    if (ev.buttons) strokeMove(ev);
  });
  el.canvas.addEventListener('mouseup', strokeEnd);
}

// 重开 = 同一张盘从头再来。它必须走 begin() 这条完整复位的路（时钟、累加器、粒子、笔迹、
// 暂停态、已写数字全部归零），而不是只把格子擦空——那样时间会接着上一局继续走。
function restart() {
  if (!game) return null;
  return begin({ tier: game.puzzle.tier, seed: game.puzzle.originSeed });
}

$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-restart').addEventListener('click', restart);
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-fullscreen').addEventListener('click', () => toggleFullscreen());
$('#btn-help').addEventListener('click', () => toggleHelp());
$('#btn-help-close').addEventListener('click', () => toggleHelp(false));
$('#btn-resume-play').addEventListener('click', () => setPaused(false));
$('#btn-menu-3').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.place();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

function setSoundEnabled(on) {
  const want = on === undefined ? !Store.setting('sound') : !!on;
  Store.setSetting('sound', want);
  applySettings();
  return !!Store.setting('sound');
}

function toggleSound() {
  return setSoundEnabled(!Store.setting('sound'));
}

// 菜单里的 Enter/Space：光标停在某个档上就开那一档，否则开第一档；有未完成的牌局先续牌局。
function startFromMenu() {
  const focused = document.activeElement;
  if (focused && focused.classList && focused.classList.contains('tier')) {
    begin({ tier: focused.dataset.tier });
    return 'tier';
  }
  const r = Store.resume();
  if (r) {
    begin({ tier: r.tier, seed: r.seed, resume: r });
    return 'resume';
  }
  begin({ tier: TIERS[0].key });
  return TIERS[0].key;
}

function onKey(ev) {
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  const inGame = !el.viewGame.hidden;
  if (k === '?' || (k === '/' && ev.shiftKey)) {
    ev.preventDefault();
    toggleHelp();
    return;
  }
  if (k === 'Escape') {
    if (!el.helpVeil.hidden) toggleHelp(false);
    else if (inGame) {
      flushResume();
      show('menu');
    }
    return;
  }
  if (k === 'h' || k === 'H') {
    useHint();
    return;
  }
  if (k === 'z' || k === 'Z') {
    undo();
    return;
  }
  if (k === 'p' || k === 'P') {
    if (inGame) {
      ev.preventDefault();
      setPaused(!paused);
    }
    return;
  }
  if (k === ' ' || k === 'Spacebar') {
    // 焦点在按钮上时让浏览器自己派发 click，别把"回车/空格按下这个钮"抢成"开局"。
    if (ev.target && ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    if (inGame) setPaused(!paused);
    else startFromMenu();
    return;
  }
  if (k === 'Enter') {
    if (ev.target && ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    if (inGame) setPaused(!paused);
    else startFromMenu();
    return;
  }
  if (k === 'r' || k === 'R') {
    if (inGame) {
      ev.preventDefault();
      restart();
    }
    return;
  }
  if (k === 'm' || k === 'M') {
    ev.preventDefault();
    toggleSound();
    return;
  }
  if (k === 'f' || k === 'F') {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (k === '0' || k === 'Backspace' || k === 'Delete') setDigit(OPEN);
  else if (/^[1-8]$/.test(k) && game && Number(k) <= game.maxK) setDigit(Number(k));
}

window.addEventListener('keydown', onKey);

window.addEventListener('resize', draw);
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushResume();
    // 切走就暂停：否则"离开十分钟回来"会白扣十分钟的用时，而用时是同档破纪录的第三把尺。
    setPaused(true);
  }
});
window.addEventListener('pagehide', flushResume);

function registerServiceWorker() {
  // file:// 下（Electron 直接 loadFile 就是这种形态）注册 SW 会抛 SecurityError，
  // 未捕获的 promise rejection 会在控制台里长出一条红字。整段按协议跳过。
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return false;
  const url = new URL('sw.js', document.baseURI).href;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url).catch(() => {
      /* 注册失败只是不可离线，游戏照玩 */
    });
  });
  return true;
}

// manifest 的 shortcuts 指向 ?tier= / ?action=resume，这两条参数不接住的话，
// 桌面图标上写的那两个入口就是假的。
function bootFromUrl() {
  let q;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  if (q.get('action') === 'resume') {
    const r = Store.resume();
    if (r) {
      begin({ tier: r.tier, seed: r.seed, resume: r });
      return 'resume';
    }
  }
  const tier = q.get('tier');
  if (tier && TIERS.some((t) => t.key === tier)) {
    begin({ tier });
    return tier;
  }
  return null;
}

// Resolved off document.baseURI, not relative to this file's import map: the same build is served
// both at / and under a /z-biz-game-fillomino-cos/ prefix, and a hardcoded path breaks only on CI.
const asset = (rel) => new URL(rel, document.baseURI).href;

fx.loadSprite(asset('assets/img/particles.png'));
// The texture decodes async and asks for one repaint; until then the board paints flat.
view.loadPaper(asset('assets/img/paper-grid.png'), draw);
applyThemeVars();
applySettings();
renderMenu();
registerServiceWorker();
bootFromUrl();

window.fillomino = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  useHint,
  undo,
  setDigit,
  digit: () => (game ? game.digit : OPEN),
  // The harness commits through the same path a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  paintDigit(t, value) {
    if (blocked()) return null;
    const step = value === undefined ? game.tap(t) : game.paint(t, value);
    if (step) afterStep(step.value === OPEN ? 'erase' : 'place');
    return step;
  },
  stroke(cells, value) {
    if (blocked()) return null;
    const step = game.stroke(cells, value === undefined ? game.digit : value);
    if (step) afterStep(step.value === OPEN ? 'erase' : 'place');
    return step;
  },
  tap(t, digit) {
    if (blocked()) return null;
    const step = digit === undefined ? game.tap(t) : game.tap(t, digit);
    if (step) afterStep(step.writes[0].to === OPEN ? 'erase' : 'place');
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock() } : null),
  // 窗口状态挂出来给对拍用：暂停态、动效累加器、音频上下文状态、被丢掉的坏记录。
  // 读不到这些，任何"行为成立"的判据都无法复验。
  paused: () => paused,
  setPaused,
  restart,
  running: () => running(),
  fx: () => fx.snapshot(),
  simStep: SIM_STEP,
  looping: () => !!raf,
  sound: () => Sound.stats(),
  setSound: setSoundEnabled,
  toggleSound,
  fullscreen: () => !!fullscreenNode(),
  toggleFullscreen,
  help: () => !el.helpVeil.hidden,
  toggleHelp,
  storeHealth: () => Store.health(),
  cellRect: (t) => (game ? view.cellRect(t) : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : OPEN),
  digitName,
  engine: {
    ...Engine,
    makePuzzle,
    generate,
    mix,
    plantSolution,
    pruneClues,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    theme: { ...Palette, Cell, Radius, DigitFill },
    OPEN,
    NO_CLUE,
  },
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});

// ---- 静音开关（M）-----------------------------------------------------------------
// M 键切静音，与全屏/重开/提示同一套键位。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});
