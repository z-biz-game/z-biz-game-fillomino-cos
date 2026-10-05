#!/usr/bin/env node
/*
 * tools/frame-ladder-test.mjs —— 关卡内三档帧率对拍（规范 §3 的硬骨头）。
 *
 *   node tools/frame-ladder-test.mjs
 *
 * 官方量具 cos_frame_probe.js 对本仓（以及这一族所有 ESM 入口的仓）只能报
 * `结论：无法比对（SyntaxError: Cannot use import statement outside a module）`：
 * 它用 vm.runInContext 把 <script src> 当**普通脚本**求值，而 index.html 挂的是
 * `<script type="module">`，`import` 那一行直接炸。实测 z-biz-game-akari-cos 同形同报，
 * 所以那是量具的装载模型限制，不是本仓缺陷 —— 判据不能停在"探针跑不了"，得自己补尺。
 *
 * 与 tools/store-fx-test.mjs 的分工：那边把 Fx 单独拎出来对拍动效积分；这边对拍的是
 * **真关卡跑起来之后的一切** —— 用时时钟、步数、提示计费、已写/待写/成块/冲突/难度分，
 * 加上同一批动效字段。要的是"喂 30/60/120Hz、同一虚拟时长，玩家看到的状态逐字段相等"。
 *
 * 三条口径（都是规范 §3/§6 点名的坑）：
 *  · 按 **sim 步号**对齐取样与注入，不按墙钟虚拟秒：1000/60 的浮点亏空会让 60Hz 少喂
 *    5e-13 秒、定步长累加器少跑一步，凭空判红。
 *  · 时钟从 1000ms 起步（dom-harness 里那颗哨兵），且每档各起一个子进程：模块级单例
 *    （Store.data、fx 实例、LCG 流）在同进程里跑第二档会带着上一档的账。
 *  · 阴性对照钉在**仍在吃帧 dt 的那一行** —— fx.js 的 `accum += elapsed`。做法是把整份源码
 *    拷到 /tmp 改成 `accum += SIM_STEP` 再跑同一把尺（FILLONOMINO_SRC 指过去），必须判红。
 *    仓内已彻底定步长的逐粒子位移行换成常量仍然绿，那是结构性质，不作为尺子空跑的证据。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FPS = [30, 60, 120];
const SECONDS = 3;
const TICK_MS = 100;
// 取样与注入都钉在"整 100 虚拟毫秒"的 tick 上：30/60/120Hz 每 tick 分别是 3/6/12 帧（整数），
// 于是用时时钟与 sim 步数落在同一刻度上，可以同轴对拍。规范 §3 提醒的浮点坑（1000/60 的亏空
// 让定步长累加器少跑一步）在这里是被**检**的对象而不是被绕开的借口：tick 上三档 sim 步数一旦
// 分叉就判红，那正是 fx.advance 里那颗 1e-9 舍入容差存在的理由。
const SAMPLE_TICKS = [1, 2, 4, 8, 12, 16, 20, 24, 29];
const EVENT_TICKS = [0, 2, 5, 8, 11];
const GAME_FIELDS = ['elapsedMs', 'moves', 'hints', 'written', 'remaining', 'full', 'blocks', 'conflicts', 'score', 'status'];
const FX_FIELDS = ['clock', 'steps', 'particles', 'sumX', 'sumY', 'spin', 'halo'];

// 玩家侧输入序列：提示、连写、撤销、通关放彩带……窗口里既有"对局中"也有"结算后"两种状态，
// 而通关那一下真的会生成 46 个飞行粒子——sumX/sumY/spin 若全是 0，"三档全等"就是平凡相等。
const events = (F) => [
  () => { F.useHint(); },
  () => { paintSome(F, 3); F.useHint(); },
  () => { paintSome(F, 3); F.undo(); },
  () => { F.useHint(); paintSome(F, 2); },
  () => { F.solveWithLogic(); },
];

function paintSome(F, n) {
  let done = 0;
  for (let i = 0; i < 400 && done < n; i++) {
    if (F.game.writable(i) && F.cellRect(i)) { F.paintDigit(i); done++; }
  }
}

// ---- 子进程：跑一档，逐样本报 JSON ----------------------------------------------------------
if (process.argv[2] === '--child') {
  const fps = Number(process.argv[3]);
  const secs = Number(process.argv[4] || SECONDS);
  const { loadGame, makePump, setSeed } = await import('./dom-harness.mjs');
  setSeed(0x5eed1); // 每档同一条随机流，否则比的是两次不同的抽样
  const F = await loadGame();
  F.begin({ tier: 'expert', seed: 'ladder-42' });
  const pump = makePump(F);
  const samples = [];
  let nextSample = 0;
  let nextEvent = 0;
  const framesPerTick = Math.round(TICK_MS / (1000 / fps));
  pump(secs, fps, (frameNo) => {
    if (frameNo % framesPerTick !== 0) return;
    const tick = frameNo / framesPerTick;
    const ev = events(F);
    // 先事件后取样：tick 单调递增，三档在同一 tick 上收到同一串操作，先后关系可复现。
    while (nextEvent < EVENT_TICKS.length && tick >= EVENT_TICKS[nextEvent]) {
      ev[nextEvent]();
      nextEvent++;
    }
    if (nextSample < SAMPLE_TICKS.length && tick >= SAMPLE_TICKS[nextSample]) {
      const at = SAMPLE_TICKS[nextSample++];
      samples.push({ at: at * TICK_MS, tick: at, ...pick(F.fx(), FX_FIELDS), ...pick(F.state(), GAME_FIELDS) });
    }
  });
  process.stdout.write(JSON.stringify({
    fps, secs, samples,
    end: { ...pick(F.fx(), FX_FIELDS), ...pick(F.state(), GAME_FIELDS) },
    // tick 上三档 sim 步数必须一致：这条是"取样轴选对了"的自检，不成立就说明刻度没对齐。
    missTick: samples.some((s) => s.tick * TICK_MS !== s.at),
  }));
  process.exit(0);
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return o;
}

// ---- 父进程：起三档、逐字段对拍、跑阴性对照 ------------------------------------------------
function ladder(fps, src = null, secs = SECONDS) {
  const env = { ...process.env };
  if (src) env.FILLONOMINO_SRC = src;
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', String(fps), String(secs)], {
    env, encoding: 'utf8', maxBuffer: 64 << 20,
  });
  return JSON.parse(out);
}


let pass = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const runs = FPS.map((f) => [f, ladder(f)]);
const base = runs[0][1];

// ① 台架自检：关卡真跑起来了，而且状态随虚拟时长在动（否则"三档全等"是静止快照的平凡相等）。
ok(base.missTick === false, '三档取样都落在整 100ms 刻度上（取样轴本身没被帧率带偏）');
// 末样（2900ms）落在彩带散尽之后：粒子 0、halo −1 是正确行为，不能要求"每个样都活着"。
// 但窗口里必须真有足够多个样带着活动效，否则对拍又退化成比 0==0 的平凡相等。
ok(base.samples.filter((s) => s.halo >= 0 || s.particles > 0).length >= 8, '对拍窗口非空（≥8 个样带着活动效）',
  `实有 ${base.samples.filter((s) => s.halo >= 0 || s.particles > 0).length}/${base.samples.length}`);
// 漂移只在"还活着粒子"的那些样之间比才有意义：首样在通关前（还没有彩带）、末样在散尽后
// （全是 0），拿它们相减得到 0==0 的平凡相等，正是规范 §3 点名要防的那种假绿。
const alive = base.samples.filter((s) => s.particles > 0);
ok(alive.length >= 3, `窗口里至少有 ${alive.length} 个样还带着飞行粒子（通关真的放了彩带）`);
const a0 = alive[0] || {};
const a1 = alive[alive.length - 1] || {};
const drift = typeof a0.sumY === 'number' ? a1.sumY - a0.sumY : NaN;
ok(Math.abs(drift) > 1e3, `活粒子区间内轨迹确实在推进（sumY Δ=${Number.isFinite(drift) ? drift.toFixed(1) : '无样'}）`,
  `Δ=${drift}`);
ok(a1.steps > a0.steps, `对拍窗口跨 ${a0.steps}→${a1.steps} 个定步长`);
ok(base.end.status === 'won' && base.end.moves > 0 && base.end.hints > 0 && base.end.written > 0,
  `玩法真推进到结算（moves=${base.end.moves}, hints=${base.end.hints}, written=${base.end.written}, status=${base.end.status}）`);
ok(base.end.elapsedMs > 0, `用时时钟在走（末态 elapsed=${base.end.elapsedMs.toFixed(1)}ms）`);

// ② 逐字段对拍：同一 100ms 刻度下，60/120Hz 与 30Hz 必须逐字段相等。
const FLOAT_TOL = 1e-6; // 时钟残差来自 1000/fps 的浮点累加，量级 1e-10ms，不是帧率依赖
let worstDelta = 0;
let worstField = '';
const diffOf = (a, b) => (typeof a === 'number' ? Math.abs(a - b) : (a === b ? 0 : Infinity));
for (let i = 0; i < SAMPLE_TICKS.length; i++) {
  const at = SAMPLE_TICKS[i] * TICK_MS;
  for (const [fps, r] of runs.slice(1)) {
    // sim 步数也在这一条检里：三档在同一刻度上积出的步数一旦分叉，后面所有动效字段都不可信。
    ok(!!r.samples[i] && r.samples[i].steps === base.samples[i].steps,
      `${fps}Hz 在 ${at}ms 刻度上积出与 30Hz 相同的 sim 步数`,
      r.samples[i] ? `${r.samples[i].steps} vs ${base.samples[i].steps}` : '没取到样');
    for (const k of [...FX_FIELDS, ...GAME_FIELDS]) {
      const a = base.samples[i][k];
      const b = r.samples[i] ? r.samples[i][k] : NaN;
      const d = diffOf(a, b);
      if (d > worstDelta) { worstDelta = d; worstField = `${k}@${at}ms ${fps}Hz`; }
      ok(d <= FLOAT_TOL, `${at}ms 的 ${k}：${fps}Hz 与 30Hz 相等`, `差 ${d.toExponential(2)}（${b} vs ${a}）`);
    }
  }
}
// 末态单独对一遍：收口发生在"最后一个粒子死掉"那一步，末态步数按帧率分叉就是漏了最后一步。
for (const [fps, r] of runs.slice(1)) {
  for (const k of [...FX_FIELDS, ...GAME_FIELDS]) {
    const d = diffOf(base.end[k], r.end[k]);
    ok(d <= FLOAT_TOL, `末态 ${k}：${fps}Hz 与 30Hz 相等`, `差 ${d.toExponential(2)}（${r.end[k]} vs ${base.end[k]}）`);
  }
  ok(r.end.steps === base.end.steps, '末态 sim 步数与帧率无关', `${base.end.steps}/${r.end.steps}`);
}
notes.push(`三档末态 steps=${runs.map(([, r]) => r.end.steps).join('/')}，elapsed=${runs.map(([, r]) => r.end.elapsedMs.toFixed(4)).join('/')}ms，written=${runs.map(([, r]) => r.end.written).join('/')}`);
notes.push(`逐字段最大残差 ${worstDelta.toExponential(2)}（${worstField}）`);

// ③ 1 秒窗口的反证：把时长缩到 1s，末态必须与 3s 不同（否则上面那堆"三档全等"量的是静止快照）。
{
  const one = ladder(60, null, 1);
  ok(one.end.steps > 0 && one.end.steps < base.end.steps,
    `1 秒窗口比 3 秒短且非空（steps ${one.end.steps} vs ${base.end.steps}）—— 全等不是静止快照`);
  ok(one.end.status !== base.end.status || one.end.written < base.end.written,
    `1 秒里玩法没走完（status=${one.end.status}, written=${one.end.written} vs 3s 的 ${base.end.written}）`);
}

// ④ 阴性对照：把 fx.js 里唯一还在吃帧 dt 的那一行 `accum += elapsed` 改成 `accum += SIM_STEP`，
// 拷一份真源码到 /tmp 再跑同一把尺。判不红说明这把尺空跑。
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fillomino-mut-'));
  try {
    cpSync(path.join(REPO, 'js'), path.join(tmp, 'js'), { recursive: true });
    cpSync(path.join(REPO, 'css'), path.join(tmp, 'css'), { recursive: true });
    cpSync(path.join(REPO, 'assets'), path.join(tmp, 'assets'), { recursive: true });
    cpSync(path.join(REPO, 'index.html'), path.join(tmp, 'index.html'));
    const fxPath = path.join(tmp, 'js', 'render', 'fx.js');
    const src = readFileSync(fxPath, 'utf8');
    const mutated = src.replace('this.accum += elapsed;', 'this.accum += SIM_STEP;');
    if (mutated === src) throw new Error('变异没落上：fx.js 里找不到 `this.accum += elapsed;`');
    writeFileSync(fxPath, mutated);
    const mut = FPS.map((f) => [f, ladder(f, tmp)]);
    let diverged = 0;
    const note = [];
    for (let i = 0; i < SAMPLE_TICKS.length; i++) {
      const vals = mut.map(([, r]) => (r.samples[i] || {}).sumY);
      const missing = vals.some((v) => typeof v !== 'number');
      const spread = missing ? Infinity : Math.max(...vals) - Math.min(...vals);
      if (missing || spread > 1) diverged++;
      note.push(`${SAMPLE_TICKS[i] * TICK_MS}ms:${missing ? '缺样' : spread.toFixed(1)}`);
    }
    ok(diverged >= 3, '阴性对照：accum += elapsed 换成 SIM_STEP 之后同一把尺判红',
      `${diverged}/${SAMPLE_TICKS.length} 个取样点分叉（${note.join(' ')}）`);
    const mutSteps = mut.map(([, r]) => r.end.steps).join('/');
    notes.push(`阴性对照分叉 ${diverged}/${SAMPLE_TICKS.length} 个刻度（${note.join(' ')}），末态 steps=${mutSteps}（正点 ${base.end.steps}）`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

for (const n of notes) console.log('  · ' + n);
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${fails.length ? '✗' : '✓'} 关卡内三档对拍：${pass} 通过 / ${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
