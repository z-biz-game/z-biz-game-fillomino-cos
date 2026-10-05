#!/usr/bin/env node
/*
 * tools/dom-harness.mjs —— 一层最小 DOM/事件/canvas/AudioContext/虚拟时钟桩，把 js/main.js
 * 当作真入口在纯 node 里装载起来。两份闸共用它（dom-behavior-test、frame-ladder-test），
 * 因为桩一旦分成两份就会各自漂移：一边补了 pointerdown 的细节，另一边测的就不是同一台机器。
 *
 * 四条台架纪律（前三条是从 dom-behavior-test 那边继承下来的实测教训）：
 *  · 虚拟时钟从 1000ms 起步——从 0 起会被 main.js 里 `lastTs ?` 那颗哨兵吃掉第一帧。
 *  · Math.random 换成 LCG，同一 seed 才可复现；setSeed() 让多轮对拍走同一条随机流。
 *  · 选格必须问 game.writable()：valueOf() 只报玩家自己的笔迹，印上去的线索格读出来也是 0，
 *    照着 0 去选会选中线索格，然后测出"触屏写不进"这种假缺陷（第一版就栽在这里）。
 *  · FILLONOMINO_SRC 可把源码指向一份仓外副本：阴性对照必须跑**改过的真源码**，
 *    在台架里伪造一个假实现测不到真代码里那一行（规范 §6 的口径）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 阴性对照要跑一份改过源码的仓外副本：FILLONOMINO_SRC 指过去，台架其余部分一字不改。
const REPO = process.env.FILLONOMINO_SRC
  ? path.resolve(process.env.FILLONOMINO_SRC)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

// ---- 装载与驱动 -----------------------------------------------------------------------------

/** 把 js/main.js 装进当前进程的全局桩，返回 window.fillomino 面。 */
export async function loadGame() {
  await import(pathToFileURL(path.join(REPO, 'js/main.js')).href);
  const F = windowShim.fillomino;
  if (!F) throw new Error('window.fillomino 没挂出来');
  return F;
}

/** 每喂一帧都重绑一次几何：#board/#fx-layer 的 getBoundingClientRect 要跟着 resize() 走。 */
function syncGeo(F) {
  const g = F.view.geo;
  if (g) { reg('#board').geoRef = F.view; reg('#fx-layer').geoRef = F.view; }
}

/**
 * 按 fps 喂 `seconds` 虚拟秒，逐帧回调 onFrame(steps)。泵序照浏览器语义：先推虚拟时钟，
 * 再泵定时器，最后跑这一帧的 rAF 回调——同一帧里 setTimeout 与 rAF 的先后决定光晕何时被点燃。
 * onFrame 让你在**这一帧真正被喂掉的那一刻**取事件与取样；没有它，"第 N 帧注入"这件事
 * 在 30Hz 与 120Hz 下根本不是同一时刻。
 */
export function makePump(F) {
  return function pump(seconds, fps = 60, onFrame = null) {
    const stepMs = 1000 / fps;
    const frames = Math.round(seconds * fps);
    for (let i = 0; i < frames; i++) {
      VT += stepMs;
      const cbs = rafQ.splice(0, rafQ.length);
      pumpTimers();
      for (const cb of cbs) { cb(VT); syncGeo(F); }
      if (onFrame) onFrame(i + 1, VT);
    }
  };
}

/** 复位 LCG：三档对拍要走同一条随机流，否则比的是两次不同的抽样。 */
export function setSeed(s = 0x2f8bdeca) { seed = s; }

/** 真宏任务一格：虚拟 setTimeout 只在 pump 里被泵，await 异步链要用真 nextTick。 */
export const tick = () => new Promise((r) => process.nextTick(r));

export const clockNow = () => VT;
export const setClock = (v) => { VT = v; };
export { reg, emit, listeners, windowShim, documentShim, audioStats, registry };
