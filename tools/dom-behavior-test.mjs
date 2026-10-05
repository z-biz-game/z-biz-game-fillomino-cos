#!/usr/bin/env node
/*
 * tools/dom-behavior-test.mjs —— 把「17 项判据里只有行为成立才算数」的那些钉进纯 node 闸。
 *
 *   node tools/dom-behavior-test.mjs
 *
 * 为什么要它：sellability 扫的是字符串，字符串命中不等于行为成立。规范 §2 点名的
 * 静音真停 AudioContext、暂停真不推进、重开真复位、触屏坐标按 CSS 缩放换算、reduceMotion
 * 真分支、键位全覆盖、全屏绑真实存在的 id —— 这些都要跑一遍并读出数。
 * 而 tools/verify.sh 那条线要真 Chrome（本单不许开 GUI），所以这里自带一层最小 DOM/事件/
 * AudioContext 桩，直接把 js/main.js 当真入口装载：测的是那份唯一的源码，不是它的抄本。
 *
 * 三条台架纪律（都是踩过之后钉下来的）：
 *  · 虚拟时钟从 1000ms 起步——从 0 起会被 main.js 里 `lastTs ?` 那颗哨兵吃掉第一帧。
 *  · Math.random 换成 LCG，同一 seed 才可复现。
 *  · 选格必须问 game.writable()：valueOf() 只报玩家自己的笔迹，印上去的线索格读出来也是 0，
 *    照着 0 去选会选中线索格，然后测出"触屏写不进"这种假缺陷（第一版就栽在这里）。
 *  · 每一条"没发生"的断言都配一条"发生过"的对照（省动效前真放过 46 个粒子、开声时真建过
 *    振荡器、缩放不换算真会打错格），否则一条恒真的断言与漏检等价。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// ---- 虚拟时钟 / 定时器 / LCG -----------------------------------------------------------------
let VT = 1000; // ms，从 1000 起步（规矩②）
let seed = 0x2f8bdeca;
const lcg = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
Math.random = lcg;
Date.now = () => VT;

let timerId = 1;
const timeouts = new Map();
const intervals = new Map();
const rafQ = [];
function setTimeoutShim_(fn, ms) { const id = timerId++; timeouts.set(id, { at: VT + ms, fn }); return id; }
globalThis.setTimeout = setTimeoutShim_;
globalThis.setInterval = (fn, ms) => { const id = timerId++; intervals.set(id, { at: VT + ms, every: ms, fn }); return id; };
globalThis.clearTimeout = (id) => timeouts.delete(id);
globalThis.clearInterval = (id) => intervals.delete(id);
function pumpTimers() {
  for (const [id, t] of [...timeouts]) if (t.at <= VT) { timeouts.delete(id); t.fn(); }
  for (const [, t] of [...intervals]) if (t.at <= VT) { t.at = VT + t.every; t.fn(); }
}

// ---- DOM 桩 ----------------------------------------------------------------------------------
const noop = () => { };
function ctx2d() {
  const base = {
    canvas: null, globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    createPattern: () => ({ repeat: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    setTransform: noop, getTransform: () => ({ a: 1, d: 1 }),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string') return (...a) => { t['_calls'] = (t['_calls'] || 0) + 1; return undefined; };
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const listeners = new Map(); // key -> {type -> [fn]}
function on(target, type, fn) {
  const key = target;
  if (!listeners.has(key)) listeners.set(key, {});
  const m = listeners.get(key);
  (m[type] = m[type] || []).push(fn);
}
function emit(target, type, ev = {}) {
  const m = listeners.get(target);
  for (const fn of (m && m[type]) || []) fn({ type, target, preventDefault: noop, stopPropagation: noop, ...ev });
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._text = '';
    this._html = '';
    this.children = [];
    this.classList = mkClassList();
    this.dataset = {};
    this.attrs = {};
    this.style = { setProperty: (k, v) => { this.style['S:' + k] = v; }, getPropertyValue: (k) => this.style['S:' + k] || '' };
    this.hidden = false;
    this.clientWidth = 900;
    this.clientHeight = 700;
    this.width = 0;
    this.height = 0;
    this.type = '';
    this._ctx = null;
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  getContext() { return (this._ctx = this._ctx || ctx2d()); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  addEventListener(t, fn) { on(this, t, fn); }
  removeEventListener(t, fn) { const m = listeners.get(this); if (m) m[t] = (m[t] || []).filter((f) => f !== fn); }
  querySelector(sel) { return reg(sel); }
  querySelectorAll(sel) { return (sel === '.digit') ? this.children.filter((c) => (c.className || '').includes('digit')) : []; }
  closest() { return this; }
  getBoundingClientRect() {
    const g = this.geoRef && this.geoRef.geo;
    const w = g ? g.w : parseFloat(this.style.width) || 300;
    const h = g ? g.h : 300;
    return { left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 };
  }
  setPointerCapture() { }
  focus() { document.activeElement = this; }
}
function mkClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, v) => { const want = v === undefined ? !set.has(c) : !!v; if (want) set.add(c); else set.delete(c); return want; },
    _set: set,
  };
}

const registry = new Map();
function reg(sel) {
  const key = sel.startsWith('#') ? sel.slice(1) : sel;
  if (!registry.has(key)) {
    const e = new El(key === 'canvas' || key === 'board' || key === 'fx' ? 'canvas' : 'div', key);
    if (key === 'board' || key === 'fx-layer') e.tagName = 'CANVAS';
    registry.set(key, e);
  }
  return registry.get(key);
}

const documentShim = {
  querySelector: (sel) => reg(sel),
  querySelectorAll: () => [],
  getElementById: (id) => reg('#' + id),
  createElement: (tag) => new El(tag),
  documentElement: new El('html'),
  body: new El('body'),
  head: new El('head'),
  activeElement: null,
  baseURI: 'https://example.com/z-biz-game-fillomino-cos/index.html',
  visibilityState: 'visible',
  fullscreenElement: null,
  addEventListener: (t, fn) => on(documentShim, t, fn),
  removeEventListener: noop,
};

class ImageShim {
  constructor() { this.onload = null; this.onerror = null; this._src = ''; this.complete = false; this.naturalWidth = 512; this.naturalHeight = 64; }
  set src(v) {
    this._src = v;
    const exists = existsSync(path.join(REPO, v.replace(/^https:\/\/example\.com\/z-biz-game-fillomino-cos\//, '')));
    if (exists) setTimeout(() => { this.complete = true; if (this.onload) this.onload({}); }, 0);
    else if (this.onerror) setTimeout(() => this.onerror({}), 0);
  }
  get src() { return this._src; }
}

const audioStats = { created: 0, resumes: 0, suspends: 0, osc: 0 };
class AudioCtxShim {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; audioStats.created++; }
  createGain() { return { gain: { value: 1, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, connect: () => ({ connect: noop }) }; }
  createOscillator() { audioStats.osc++; const chain = { connect: () => chain }; return { type: 'sine', frequency: { setValueAtTime: noop, exponentialRampToValueAtTime: noop }, connect: chain.connect, start: noop, stop: noop }; }
  resume() { this.state = 'running'; audioStats.resumes++; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; audioStats.suspends++; return Promise.resolve(); }
}

const windowShim = {
  innerWidth: 1280, innerHeight: 900, devicePixelRatio: 2,
  requestAnimationFrame: (cb) => { rafQ.push(cb); return rafQ.length; },
  cancelAnimationFrame: () => { rafQ.length = 0; },
  addEventListener: (t, fn) => on(windowShim, t, fn),
  removeEventListener: noop,
  performance: { now: () => VT },
  PointerEvent: undefined,
  matchMedia: (q) => ({ media: q, matches: false, addEventListener: noop, addListener: noop }),
  AudioContext: AudioCtxShim,
  Image: ImageShim,
  localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _m: m }; })(),
  location: { protocol: 'https:', search: '', href: 'https://example.com/z-biz-game-fillomino-cos/' },
  navigator: { serviceWorker: undefined, userAgent: 'node-harness' },
  document: documentShim,
};
for (const k of ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'matchMedia', 'localStorage', 'location', 'navigator', 'devicePixelRatio', 'innerWidth', 'innerHeight']) {
  Object.defineProperty(globalThis, k, { get: () => windowShim[k], configurable: true });
}
globalThis.window = windowShim;
globalThis.document = documentShim;
globalThis.Image = ImageShim;
globalThis.AudioContext = AudioCtxShim;
globalThis.webkitAudioContext = undefined;
globalThis.self = windowShim;

// 让 #board / #fx-layer 两张 canvas 与 main.js 里的 el.canvas / el.fx 指向同一实例
reg('#board'); reg('#fx-layer'); reg('#app');

await import(pathToFileURL(path.join(REPO, 'js/main.js')).href);
const F = windowShim.fillomino;
if (!F) { console.error('window.fillomino 没挂出来'); process.exit(4); }

// ---- 真进关卡 --------------------------------------------------------------------------------
const boardGeo = () => {
  const g = F.view.geo;
  if (g) { reg('#board').geoRef = F.view; reg('#fx-layer').geoRef = F.view; }
  return g;
};


// ===================== 行为级复验（规范 §2：要行为成立，不是字符串命中） =====================
let pass = 0; const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fails.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
// 虚拟 setTimeout 只在 pump 里被泵；await 异步链要用真宏任务，否则永远挂住。
const tick = () => new Promise((r) => process.nextTick(r));
function pump(seconds, fps = 60) {
  const stepMs = 1000 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    VT += stepMs;
    const cbs = rafQ.splice(0, rafQ.length);
    pumpTimers();
    for (const cb of cbs) { cb(VT); const g = F.view.geo; if (g) { reg('#board').geoRef = F.view; reg('#fx-layer').geoRef = F.view; } }
  }
}
const boardEl = reg('#board');
const origRect = boardEl.getBoundingClientRect.bind(boardEl);

console.log('\n### 1 静音：真停 AudioContext，静音态不得再造振荡器');
F.begin({ tier: 'expert', seed: 'b-mute' });
audioStats.osc = 0;
F.useHint();
const oscOn = audioStats.osc, voicesOn = F.sound().voices;
ok(oscOn > 0 && voicesOn > 0, `开声时确实建了振荡器（osc=${oscOn}, voices=${voicesOn}）`);
ok(F.sound().state === 'running', `开声时上下文 running（${F.sound().state}）`);
F.setSound(false);
const mutedState = F.sound().state, oscMute0 = audioStats.osc, vMute0 = F.sound().voices;
ok(mutedState === 'suspended', `关音效之后上下文真的 suspend（state=${mutedState}）`);
for (let i = 0; i < 8; i++) { F.useHint(); F.tap(i); }
ok(audioStats.osc === oscMute0, `静音态 8 次操作没新建一个振荡器节点（osc ${oscMute0}→${audioStats.osc}）`);
ok(F.sound().voices === vMute0, `静音态 voices 不动（${vMute0}→${F.sound().voices}）`);
ok(F.sound().state === 'suspended', `静音态上下文没有被供应商 resume 救活（${F.sound().state}）`);
F.setSound(true);
ok(F.sound().state === 'running', `重新开声回到 running（${F.sound().state}）`);

console.log('\n### 2 暂停：暂停期间仿真与时钟都不推进，恢复不丢状态');
F.begin({ tier: 'expert', seed: 'b-pause' });
F.useHint();
pump(0.4);
const p0 = F.fx(), e0 = F.state().elapsedMs, w0 = F.state().written;
ok(p0.steps > 0 && p0.halo >= 0 && F.looping(), `进关卡后动效在跑（steps=${p0.steps}, halo=${p0.halo.toFixed(3)}, looping=${F.looping()}）`);
ok(e0 > 0, `时钟在走（elapsed=${e0.toFixed(0)}ms）`);
F.setPaused(true);
// 这一读要抢在喂帧之前：句柄是不是当场被掐掉，只有此刻看得见。等下一帧跑完再读，
// frame() 开头那颗 `if (paused) return` 的守卫会把两种写法洗成同一个结果
// （实测删掉 cancelAnimationFrame 那段，喂帧后再读依然 46 条全绿 —— 等价变异检不出来）。
ok(F.looping() === false, `暂停的那一瞬间 rAF 句柄就被掐掉，不是靠下一帧的守卫兜底（looping=${F.looping()}）`);
pump(1.2);
const p1 = F.fx(), e1 = F.state().elapsedMs;
ok(F.looping() === false, `暂停之后 rAF 链始终断着（looping=${F.looping()}）`);
ok(p1.steps === p0.steps && p1.clock === p0.clock && p1.halo === p0.halo,
  `暂停 1.2 虚拟秒里 sim 步数/积分钟/光晕进度一格没动（steps ${p0.steps}→${p1.steps}, halo ${p0.halo.toFixed(4)}→${p1.halo.toFixed(4)}）`);
ok(e1 === e0, `暂停期间用时不偷走（${e0.toFixed(0)}→${e1.toFixed(0)}ms）`);
F.setPaused(false);
pump(0.2);
const p2 = F.fx();
ok(p2.steps > p1.steps, `恢复之后仿真继续（steps ${p1.steps}→${p2.steps}）`);
ok(F.state().written === w0 && F.state().status === 'playing', `恢复没丢盘面（written=${F.state().written}, status=${F.state().status}）`);

console.log('\n### 3 重开：时钟、累加器、粒子、笔迹、暂停态全部归零');
F.begin({ tier: 'expert', seed: 'b-restart' });
for (let i = 0; i < 4; i++) F.useHint();
F.solveWithLogic();
pump(0.3);
const beforeState = F.state();
const before = { ...F.fx(), elapsed: beforeState.elapsedMs, hints: beforeState.hints, written: beforeState.written, status: beforeState.status };
ok(before.particles > 0 || before.status === 'won', `重开前盘面是跑过的（steps=${before.steps}, 粒子=${before.particles}, ${before.written} 写, ${before.status}）`);
F.restart();
const after = { ...F.fx(), elapsed: F.state().elapsedMs, hints: F.state().hints, written: F.state().written, status: F.state().status };
ok(after.status === 'playing', `重开之后回到对局态（${after.status}）`);
ok(after.steps === 0 && after.clock === 0 && after.accum === 0 && after.particles === 0 && after.halo === -1,
  `动效全清（steps ${before.steps}→${after.steps}, accum ${after.accum}, 粒子 ${before.particles}→${after.particles}, halo=${after.halo}）`);
ok(after.elapsed === 0, `时钟归零（${before.elapsed.toFixed(0)}→${after.elapsed}ms）`);
ok(after.hints === 0 && after.written === 0, `提示与已写归零（hints ${before.hints}→${after.hints}, written ${before.written}→${after.written}）`);
ok(F.paused() === false && reg('#pause-veil').hidden === true && reg('#win-veil').hidden === true,
  `暂停态与遮罩一起复位（paused=${F.paused()}）`);
ok(F.state().total === beforeState.total && F.state().clues === beforeState.clues,
  `重开还是同一张盘（${F.state().total} 格 / ${F.state().clues} 个印数）`);

console.log('\n### 4 触摸：画布坐标按 CSS 缩放换算（点 A 不许打 B）');
F.begin({ tier: 'expert', seed: 'b-touch' });
const geo = F.view.geo;
for (const scale of [1, 0.5, 2]) {
  boardEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: geo.w * scale, height: geo.h * scale, right: geo.w * scale, bottom: geo.h * scale, x: 0, y: 0 });
  let good = 0, total = 0;
  for (const t of [0, 3, 7, 12, 24, F.view.game.w * F.view.game.h - 1]) {
    const r = F.cellRect(t);
    const hit = F.view.hitCell((r.x + r.size / 2) * scale, (r.y + r.size / 2) * scale);
    total++; if (hit === t) good++;
  }
  ok(good === total, `CSS 缩放 ${scale}x 下 6 格全部命中自己（${good}/${total}）`);
}
boardEl.getBoundingClientRect = () => ({ left: 40, top: 90, width: geo.w, height: geo.h, right: 40 + geo.w, bottom: 90 + geo.h, x: 40, y: 90 });
{
  const t = 13, r = F.cellRect(t);
  ok(F.view.hitCell(r.x + r.size / 2 + 40, r.y + r.size / 2 + 90) === t, '画布整体偏移 (40,90) 时仍然命中');
}
boardEl.getBoundingClientRect = origRect;
// 判别性对照：同一格中心在 0.5x 缩放下"不换算直接喂画布坐标"必须打到别的格（或 -1）。
// 少了这一条，上面三条 6/6 与"代码根本忽略 rect 比例"那种写法并不互相排斥——
// 有了它，缩放换算这件事才是被测出来的，不是恰好没测出来。
{
  boardEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: geo.w * 0.5, height: geo.h * 0.5, right: geo.w * 0.5, bottom: geo.h * 0.5, x: 0, y: 0 });
  const t = 12, r = F.cellRect(t);
  const naive = F.view.hitCell(r.x + r.size / 2, r.y + r.size / 2);
  ok(naive !== t, `0.5x 缩放里"不换算直接喂画布坐标"确实会打错格（打到 ${naive}，本应是 ${t}）`);
  boardEl.getBoundingClientRect = origRect;
}

console.log('\n### 5 事件通路：真派发 pointerdown/move/up 与 touchstart 回落');
{
  const w0 = F.state().written;
  // valueOf() 只报玩家自己的笔迹，印上去的线索格读出来也是 0 —— 选格必须问 writable()，
  // 否则测的是"往线索格上写"这种本来就该被拒的路径（第一版就踩了这里，误报成触屏坏）。
  const t = (() => { for (let i = 0; i < 200; i++) if (F.game.writable(i) && F.cellRect(i)) return i; return -1; })();
  const r = F.cellRect(t);
  emit(boardEl, 'pointerdown', { clientX: r.x + r.size / 2, clientY: r.y + r.size / 2, pointerId: 1 });
  emit(boardEl, 'pointerup', { clientX: r.x + r.size / 2, clientY: r.y + r.size / 2, pointerId: 1 });
  ok(F.state().written === w0 + 1, `pointerdown+up 写进一格（${w0}→${F.state().written}）`);
  const tp = reg('#board');
  const hasTouch = (listeners.get(tp) || {})['touchstart'];
  ok(Array.isArray(hasTouch) && hasTouch.length > 0, 'touchstart 回落监听已挂上（沙箱里 window.PointerEvent 未定义）');
  const w1 = F.state().written;
  const t2 = (() => { for (let i = 0; i < 200; i++) if (F.game.writable(i) && F.cellRect(i) && F.valueOf(i) === 0) return i; return -1; })();
  const r2 = F.cellRect(t2);
  emit(tp, 'touchstart', { touches: [{ clientX: r2.x + r2.size / 2, clientY: r2.y + r2.size / 2 }] });
  emit(tp, 'touchend', { changedTouches: [{ clientX: r2.x + r2.size / 2, clientY: r2.y + r2.size / 2 }] });
  ok(F.state().written === w1 + 1, `touchstart+touchend 也写进一格（${w1}→${F.state().written}）`);
}

console.log('\n### 6 键位：Enter/P/Space/R/M/F/H/? 逐条实测');
const key = (k, extra = {}) => emit(windowShim, 'keydown', { key: k, tagName: 'BODY', target: documentShim.body, shiftKey: k === '?', ...extra });
{
  F.show('menu');
  key('Enter');
  ok(F.state() && F.state().status === 'playing', 'Enter 在选档页开局');
  // Enter 走的是"有未完成牌局先续牌局"那条分支，续上来的残局可能已经带冲突；
  // 而出不了货的提示不计费（main.js: An unproductive hint is not a purchase）——
  // 所以测 H 必须从一张干净的盘起步，否则量到的是计费规则不是键位。
  F.begin({ tier: 'regular', seed: 'b-key-h' });
  const hints0 = F.state().hints; key('h');
  ok(F.state().hints === hints0 + 1 && F.state().written > 0, `H 出提示并计费（${hints0}→${F.state().hints}，已写 ${F.state().written}）`);
  const snd0 = F.sound().enabled; key('m');
  ok(F.sound().enabled === !snd0, `M 切静音（${snd0}→${F.sound().enabled}）`);
  key('m');
  const paused0 = F.paused(); key('p');
  ok(F.paused() === !paused0, `P 切暂停（${paused0}→${F.paused()}）`);
  key('p');
  const wA = F.state().written; key(' ');
  ok(F.paused() === true, `Space 在局内切暂停（${F.paused()}）`);
  key(' ');
  F.begin({ tier: 'expert', seed: 'b-key' });
  for (let i = 0; i < 3; i++) F.useHint();
  const wB = F.state().written;
  key('r');
  ok(F.state().written === 0 && F.state().status === 'playing', `R 重开本局（写 ${wB}→${F.state().written}）`);
  const help0 = F.help(); key('?');
  ok(F.help() === !help0, `? 开合教学层（${help0}→${F.help()}）`);
  key('Escape');
  ok(F.help() === false, 'Esc 关教学层');
}

console.log('\n### 7 全屏：绑在真实存在的按钮上，requestFullscreen 真被调用');
{
  let fsCalls = 0, exitCalls = 0;
  const app = reg('#app');
  app.requestFullscreen = () => { fsCalls++; documentShim.fullscreenElement = app; return Promise.resolve(); };
  documentShim.exitFullscreen = () => { exitCalls++; documentShim.fullscreenElement = null; return Promise.resolve(); };
  ok(typeof reg('#btn-fullscreen').id === 'string', `#btn-fullscreen 这个 id 在盘上真的有节点`);
  emit(reg('#btn-fullscreen'), 'click', {});
  await tick(); await tick();
  ok(fsCalls === 1 && F.fullscreen() === true, `点按钮真的请求了全屏（calls=${fsCalls}, fullscreen=${F.fullscreen()}）`);
  key('f'); await tick(); await tick();
  ok(exitCalls === 1 && F.fullscreen() === false, `F 键退出全屏（exit=${exitCalls}）`);
}

console.log('\n### 8 reduceMotion：真分支，粒子与光晕一个都不生成');
{
  F.begin({ tier: 'expert', seed: 'b-motion' });
  const haloOn = (() => { F.useHint(); const s = F.fx(); return s.halo >= 0; })();
  ok(haloOn, `省动效前：提示会生成光晕（halo=${F.fx().halo.toFixed(3)}）`);
  F.begin({ tier: 'expert', seed: 'b-motion2' });
  F.solveWithLogic();
  const partsFull = F.fx().particles;
  ok(partsFull > 0, `省动效前：胜利彩带真的生成粒子（${partsFull} 个）`);
  emit(reg('#btn-motion'), 'click', {});
  ok(F.fx().reduced === true, '点「动效」按钮之后 reduced=true');
  F.begin({ tier: 'expert', seed: 'b-motion3' });
  F.useHint();
  const s = F.fx();
  ok(s.halo === -1 && s.particles === 0, `省动效下提示不再生成光晕（halo=${s.halo}, 粒子=${s.particles}）`);
  F.solveWithLogic();
  ok(F.fx().particles === 0, `省动效下胜利不放彩带（粒子=${F.fx().particles}）`);
  ok(reg('#win-veil').hidden === false && F.state().status === 'won', `省动效不影响结算本身（${F.state().status}）`);
  emit(reg('#btn-motion'), 'click', {});
}

console.log(`\n行为复验：${pass} 通过 / ${fails.length} 失败${fails.length ? ' —— ' + fails.join('、') : ''}`);
process.exit(fails.length ? 1 : 0);
