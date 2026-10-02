// 存档解码 + 动效定步长的纯 node 回归闸：
//   node tools/store-fx-test.mjs
//
// 为什么这两段值得单独钉住：它们都是"字符串扫不到、浏览器台架也懒得跑"的那类缺陷。
// ① 一条垃圾档只能丢那一条 —— 越界值被 clamp 成 0 会造出一条永远破不了的纪录，
//    而 `Object.assign(defaults, JSON.parse(raw))` 那种写法会让整局在启动那一刻冻死。
// ② 动效只按虚拟秒推进 —— 30/60/120Hz 必须积出同一条轨迹，连"最后一个粒子死掉时
//    一共走了几步"也要一致。这条在真浏览器里几乎不可测（帧率不由你定），在这里是 20 行。

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

function runAt(fps, seconds) {
  const fx = new Fx(canvas);
  fx.resize({ w: 240, h: 240 });
  const spawned = fx.burst();
  const frame = 1 / fps;
  // 照抄 js/main.js 的帧纪律：先推进，再看动效是否还活着——不活就把 rAF 链停掉。
  // 少了这个"停"，台架会在彩带散尽之后继续喂步，测出来的就不是游戏的那条轨迹。
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    fx.advance(frame);
    if (!fx.active()) break;
  }
  return { spawned, ...fx.snapshot() };
}
const SEC = 3;
const ladder = [30, 60, 120].map((f) => [f, runAt(f, SEC)]);
const base = ladder[0][1];
ok(base.spawned > 0 && base.particles === 0, '彩带在 3 虚拟秒内走完（对拍窗口非空）');
for (const [fps, s] of ladder) {
  for (const k of ['steps', 'clock', 'particles', 'sumX', 'sumY', 'spin', 'halo']) {
    const d = Math.abs(s[k] - base[k]);
    ok(d <= 1e-9, `${fps}Hz 的 ${k} 与 30Hz 逐字段相等`, `差 ${d.toExponential(2)}（${s[k]} vs ${base[k]}）`);
  }
}
ok(ladder.every(([, s]) => s.accum >= 0 && s.accum < SIM_STEP), '累加器余数始终小于一个定步长');
// 收口必须发生在"最后一个粒子死掉"那一步，而不是那一帧的末尾：末态步数按帧率分叉
// 就是定步长漏了最后一步（实测修前 184/182/182）。
ok(new Set(ladder.map(([, s]) => s.steps)).size === 1, '末态 sim 步数与帧率无关',
  ladder.map(([, s]) => s.steps).join('/'));

const total = pass + fails.length;
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${total === pass ? '✓' : '✗'} 存档解码与动效定步长：${pass} 通过 / ${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
