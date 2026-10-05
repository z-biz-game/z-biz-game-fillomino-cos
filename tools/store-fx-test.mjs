// 存档解码 + 动效定步长的纯 node 回归闸：
//   node tools/store-fx-test.mjs
//
// 为什么这两段值得单独钉住：它们都是"字符串扫不到、浏览器台架也懒得跑"的那类缺陷。
// ① 一条垃圾档只能丢那一条 —— 越界值被 clamp 成 0 会造出一条永远破不了的纪录，
//    而 `Object.assign(defaults, JSON.parse(raw))` 那种写法会让整局在启动那一刻冻死。
// ② 动效只按虚拟秒推进 —— 30/60/120Hz 必须积出同一条轨迹。这条在真浏览器里几乎不可测
//    （帧率不由你定），在这里是逐帧喂 dt。取样的三条纪律：
//    · 按 sim 步号对齐取样，且步号取 4 的倍数（30Hz 一帧恰走 4 个定步长）；
//    · 光比末态不够——彩带散尽后 sumX/sumY/spin 全是 0，那是平凡相等，必须取飞行中的中间态；
//    · 自带一发阴性对照（把 advance 退回按帧 dt 积分），尺子判不红就说明它空跑。

// store.js 直接读全局 localStorage，所以桩必须在 import 之前挂上。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

let pass = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const KEY = 'fillomino.save.v1';
const good = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {
    trainee: { ms: 12000, hints: 0, moves: 9, size: '5×5', at: 1 },
    regular: { ms: 30000, hints: 1, moves: 20, size: '7×7', at: 2 },
  },
  totals: { solved: 3, hints: 2, ms: 50000 },
  resume: { seed: 's1', tier: 'trainee', elapsedMs: 4000, cells: 25,
    ink: [0, 0, 3, 3, 1, 1, 2, 2, 0, 0], moves: 4, hints: 1, at: 3 },
});
const tweak = (fn) => { const g = good(); fn(g); return JSON.stringify(g); };

// 每一发都要一次全新的模块实例：解码发生在 store 模块求值的那一刻。
let caseNo = 0;
async function decode(raw) {
  mem.set(KEY, raw);
  const mod = await import(`../js/store.js?case=${++caseNo}`);
  return mod.Store;
}

const cases = [
  ['好档全收', JSON.stringify(good()), (S) => S.data.best.trainee && S.data.best.regular && S.data.resume && S.health().dropped.length === 0],
  ['整串不是 JSON', '{ not json', (S) => S.health().dropped.join() === 'json'],
  ['顶层 null', 'null', (S) => S.health().dropped.join() === 'envelope'],
  ['顶层是数组', '[1,2,3]', (S) => S.health().dropped.join() === 'envelope'],
  ['纪录条目是 null', tweak((g) => { g.best.trainee = null; }),
    (S) => !S.data.best.trainee && S.data.best.regular.ms === 30000 && !!S.data.resume],
  ['纪录缺 ms', tweak((g) => { delete g.best.regular.ms; }),
    (S) => !S.data.best.regular && S.data.best.trainee.ms === 12000],
  ['ms 类型错', tweak((g) => { g.best.trainee.ms = 'abc'; }),
    (S) => !S.data.best.trainee && !!S.data.best.regular],
  ['ms 负数越界（不许 clamp 成 0）', tweak((g) => { g.best.trainee.ms = -5; }),
    (S) => !S.data.best.trainee && S.data.best.regular.ms === 30000],
  ['ms 巨大越界（不许 clamp 成 24h）', tweak((g) => { g.best.trainee.ms = 1e12; }),
    (S) => !S.data.best.trainee && !!S.data.best.regular],
  ['moves 负数只丢这一条', tweak((g) => { g.best.regular.moves = -3; }),
    (S) => !S.data.best.regular && S.data.best.trainee.ms === 12000],
  ['ink 含 -1', tweak((g) => { g.resume.ink[3] = -1; }),
    (S) => !S.data.resume && !!S.data.best.trainee],
  ['ink 缺字段', tweak((g) => { delete g.resume.ink; }), (S) => !S.data.resume],
  ['cells 越界不 clamp', tweak((g) => { g.resume.cells = 999999; }), (S) => !S.data.resume],
  ['settings 是字符串', tweak((g) => { g.settings = 'loud'; }),
    (S) => S.data.settings.sound === true && !!S.data.best.trainee && !!S.data.resume],
  ['totals 一项类型错只丢那一项', tweak((g) => { g.totals.solved = {}; }),
    (S) => S.data.totals.solved === 0 && S.data.totals.hints === 2 && S.data.totals.ms === 50000],
];

for (const [name, raw, check] of cases) {
  let S = null;
  let threw = null;
  try {
    S = await decode(raw);
    S.save();                                     // 坏档之后必须还写得回，不许冻死
    if (JSON.parse(mem.get(KEY)) === null) threw = 'save 写回了不可解析的内容';
  } catch (e) {
    threw = `${e.constructor.name}: ${e.message}`;
  }
  ok(!threw && check(S), `存档 ${name}`, threw || '断言为假');
}
{
  const S = await decode('null');
  ok(S.health().dropped.length === 1, '坏档清单不累积（第二次 load 只报这一次的账）');
}

// ---- ② 动效定步长：同一虚拟时长，三档帧率必须积出同一条轨迹 ----
globalThis.window = { devicePixelRatio: 1 };
const ctx2d = new Proxy({ canvas: null }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => { o[k] = v; return true; },
});
const canvas = { style: {}, width: 0, height: 0, getContext: () => ctx2d };
const { Fx, SIM_STEP } = await import('../js/render/fx.js');

// 取样步号一律取 4 的倍数：最粗的 30Hz 一帧恰好走 4 个定步长（33.33ms / 8.33ms = 4），
// 否则粗档会跨过目标多走 1~3 步，量出来的是取样粒度而不是帧率依赖（实测目标 90 → 92/90/90）。
// 上限 104 也留了余地：光晕寿命 0.9s = 108 步，取到 104 时 halo.t 还在飞，比得出那一条。
const SAMPLES = [4, 24, 48, 96, 104];
const FIELDS = ['clock', 'steps', 'particles', 'sumX', 'sumY', 'spin', 'halo'];

function runAt(fps, seconds, { Ctor = Fx, samples = null } = {}) {
  const fx = new Ctor(canvas);
  fx.resize({ w: 240, h: 240 });
  const spawned = fx.burst();
  const haloed = fx.hint([0, 1, 4, 9, 16], null);
  const frame = 1 / fps;
  const trace = [];
  let next = 0;
  // 照抄 js/main.js 的帧纪律：先推进，再看动效是否还活着——不活就把 rAF 链停掉。
  // 少了这个"停"，台架会在彩带散尽之后继续喂步，测出来的就不是游戏的那条轨迹。
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    fx.advance(frame);
    if (samples) {
      const s = fx.snapshot();
      while (next < samples.length && s.steps >= samples[next]) trace.push({ at: samples[next++], ...s });
    }
    if (!fx.active()) break;
  }
  return { spawned, haloed, trace, end: fx.snapshot() };
}

const SEC = 3;
const ladder = [30, 60, 120].map((f) => [f, runAt(f, SEC, { samples: SAMPLES })]);
const base = ladder[0][1];
ok(base.spawned > 0 && base.haloed && base.end.particles === 0, '彩带与光晕在 3 虚拟秒内走完（对拍窗口非空）');
for (const [fps, s] of ladder) {
  for (const k of ['steps', 'clock', 'particles', 'sumX', 'sumY', 'spin', 'halo']) {
    const d = Math.abs(s.end[k] - base.end[k]);
    ok(d <= 1e-9, `${fps}Hz 的 ${k} 与 30Hz 逐字段相等`, `差 ${d.toExponential(2)}（${s.end[k]} vs ${base.end[k]}）`);
  }
}
ok(ladder.every(([, s]) => s.end.accum >= 0 && s.end.accum < SIM_STEP), '累加器余数始终小于一个定步长');
// 收口必须发生在"最后一个粒子死掉"那一步，而不是那一帧的末尾：末态步数按帧率分叉
// 就是定步长漏了最后一步（实测修前 184/182/182）。
ok(new Set(ladder.map(([, s]) => s.end.steps)).size === 1, '末态 sim 步数与帧率无关',
  ladder.map(([, s]) => s.end.steps).join('/'));

// 末态那一份其实比不出粒子：散尽之后 sumX/sumY/spin 全是 0，逐字段相等是平凡真相。
// 证据在中途——同一 sim 步号下对拍位置与旋转，才看得见重力与阻尼积出的那条轨迹。
for (let i = 0; i < SAMPLES.length; i++) {
  const at = base.trace[i];
  ok(!!at && at.steps === at.at, `30Hz 第 ${SAMPLES[i]} 步取样命中步号`, at ? `实走 ${at.steps}` : '没取到样');
  for (const [fps, s] of ladder.slice(1)) {
    const t = s.trace[i];
    ok(!!t && t.steps === t.at, `${fps}Hz 第 ${SAMPLES[i]} 步取样命中步号`, t ? `实走 ${t.steps}` : '没取到样');
    if (!t || !at) continue;
    for (const k of FIELDS) {
      const d = Math.abs(t[k] - at[k]);
      ok(d <= 1e-9, `中途第 ${SAMPLES[i]} 步的 ${k}：${fps}Hz 与 30Hz 相等`, `差 ${d.toExponential(2)}（${t[k]} vs ${at[k]}）`);
    }
  }
}
// 取样窗口不许是静止快照：粒子数在任何帧率下都同样多，位置与旋转才是"虚拟秒"的证据。
ok(base.trace.length === SAMPLES.length, '五个中途取样点全部取到', `实取 ${base.trace.length}`);
ok(base.trace.every((t) => t.particles > 0 && t.halo >= 0), '每个取样点都还有活着的粒子与光晕');
const firstSample = base.trace[0];
const lastSample = base.trace[SAMPLES.length - 1];
const drift = firstSample && lastSample ? lastSample.sumY - firstSample.sumY : NaN;
ok(Number.isFinite(drift) && Math.abs(drift) > 1e3, '中途窗口里轨迹确实在推进（尺子量的是动起来的量）',
  `sumY Δ=${Number.isFinite(drift) ? drift.toFixed(1) : '取样缺失'}`);

// 判尺自检（规范 §6 的阴性对照）：把 advance 退回"每帧走一次帧 dt"的旧形状，同一套口径必须判红。
// 判不出来就说明这 30 多条中途断言是空跑的 —— 那比漏检更糟，因为它长得像通过。
class FrameDtFx extends Fx {
  advance(elapsed) { this.step(elapsed); return 1; }
}
const naive = [30, 60, 120].map((f) => runAt(f, SEC, { Ctor: FrameDtFx, samples: SAMPLES }));
let diverged = 0;
const naivNote = [];
for (let i = 0; i < SAMPLES.length; i++) {
  const vals = naive.map((n) => (n.trace[i] || {}).sumY);
  const missing = vals.some((v) => typeof v !== 'number');
  const spread = missing ? Infinity : Math.max(...vals) - Math.min(...vals);
  if (missing || spread > 1) diverged++;
  naivNote.push(`${SAMPLES[i]}步:${missing ? '缺样' : spread.toFixed(1)}`);
}
ok(diverged >= 3, '阴性对照：按帧 dt 积分的假步器被同一把尺判红',
  `${diverged}/${SAMPLES.length} 个取样点分叉（${naivNote.join(' ')}）`);

const total = pass + fails.length;
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${total === pass ? '✓' : '✗'} 存档解码与动效定步长：${pass} 通过 / ${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
