// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the digits written so far, what the run has cost) rather than a
// copy of the clue set or the solution — the generator is deterministic, so the board never has to
// travel through storage. A 7×7 run costs under two hundred bytes.

const KEY = 'fillomino.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Fillomino ink is 0 (nothing written) up to 最大块 (at most 8), so run-length coding still applies
// and still needs no offset: nothing a player writes is negative, and NO_CLUE (-1) is the author's
// sentinel, which never travels through this array.
//
// Measured on real 埋方块 runs (a whole 5×5 save is 51 bytes written one number per cell):
//   · one quarter of the blanks filled   22 bytes   vs 51
//   · half filled                        38 bytes   vs 73   (6×6)
//   · nine tenths filled                133 bytes   vs 99   (7×7)
// So RLE roughly halves a board that is mostly untouched — which is the only state a resume is ever
// saved in — and costs about a third more once the blocks have all been drawn and every cell is a
// short run. That loss is never paid: a finished board clears its resume before it can be stored,
// so the payload that reaches localStorage is always the sparse half of the curve.
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

// ---- 两段式解码 ---------------------------------------------------------------------------
// 第一段只管"这坨 JSON 是不是我们存过的那个形状"，第二段逐条把每条记录验完再收进来。
// 一条坏记录只丢那一条：存档里有 5 个档的纪录、其中 master 那条是垃圾，那么其余 4 条照用，
// master 退回"还没有纪录"。少了第二段就是 `Object.assign(defaults, JSON.parse(raw))` 那种写法——
// resume.ink 被写成 null 时 rleDecode 直接抛异常，整局在启动那一刻冻死在白屏上。
const dropped = [];

function note(what) {
  dropped.push(what);
}

function finite(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
}

function decodeSettings(raw) {
  const out = { sound: true, reduceMotion: false };
  if (!raw || typeof raw !== 'object') {
    note('settings');
    return out;
  }
  // 只有显式的布尔才作数：`sound: 0` / `sound: "off"` 这种脏值退回默认，而不是被当成 falsy 的"关"。
  out.sound = typeof raw.sound === 'boolean' ? raw.sound : true;
  out.reduceMotion = typeof raw.reduceMotion === 'boolean' ? raw.reduceMotion : false;
  if (typeof raw.sound !== 'boolean') note('settings.sound');
  if (typeof raw.reduceMotion !== 'boolean') note('settings.reduceMotion');
  return out;
}

function decodeBest(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    note('best');
    return out;
  }
  for (const [tier, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') {
      note(`best.${tier}`);
      continue;
    }
    const ms = finite(rec.ms, 0, 1000 * 60 * 60 * 24);
    const hints = finite(rec.hints, 0, 1e6);
    const moves = finite(rec.moves, 0, 1e7);
    if (ms === null || hints === null || moves === null) {
      note(`best.${tier}`);
      continue;
    }
    out[tier] = { ms, hints, moves, size: typeof rec.size === 'string' ? rec.size.slice(0, 12) : '', at: finite(rec.at, 0, Infinity) || 0 };
  }
  return out;
}

function decodeTotals(raw) {
  const out = { solved: 0, hints: 0, ms: 0 };
  if (!raw || typeof raw !== 'object') {
    note('totals');
    return out;
  }
  for (const k of Object.keys(out)) {
    const n = finite(raw[k], 0, Number.MAX_SAFE_INTEGER);
    if (n === null) note(`totals.${k}`);
    else out[k] = n;
  }
  return out;
}

// 坏档实测（四发，见 commit 正文）：null、缺字段、类型错、越界值都只丢这一条。
function decodeResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    note('resume');
    return null;
  }
  // cells 决定 rleDecode 铺出多长的盘面：越界值 clamp 到 4096 会悄悄造出一块尺寸不对的棋盘，
  // 所以这里不 clamp，越界就是坏档，整条丢掉。
  const rawCells = raw.cells;
  const cells = Number.isInteger(rawCells) && rawCells >= 0 && rawCells <= 4096 ? rawCells : null;
  const elapsed = finite(raw.elapsedMs, 0, 1000 * 60 * 60 * 24) || 0;
  if (cells === null || !raw.ink || !Array.isArray(raw.ink)) {
    note(cells === null ? 'resume.cells' : 'resume.ink');
    return null;
  }
  // 逐格取值域：埋方块的墨水是 0..最大块（≤8），一个 -1 或 250 会把 Uint8Array 涂成别的数字。
  const ink = [];
  for (let i = 0; i < raw.ink.length; i++) {
    const v = raw.ink[i];
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      note(`resume.ink[${i}]`);
      return null;
    }
    ink.push(v);
  }
  if (ink.length % 2) {
    note('resume.ink.odd');
    return null;
  }
  return {
    seed: typeof raw.seed === 'string' ? raw.seed : '',
    tier: typeof raw.tier === 'string' ? raw.tier : 'trainee',
    elapsedMs: elapsed,
    cells,
    ink,
    moves: finite(raw.moves, 0, 1e7) || 0,
    hints: finite(raw.hints, 0, 1e6) || 0,
    at: finite(raw.at, 0, Infinity) || 0,
  };
}

function load() {
  // 每次解码都是一份新的坏记录清单：只在模块级数组上追加，第二次 load() 会把上一次的账一起报出来。
  dropped.length = 0;
  const base = defaults();
  let parsed;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    parsed = JSON.parse(raw);
  } catch {
    note('json');
    return base;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    note('envelope');
    return base;
  }
  return {
    settings: decodeSettings(parsed.settings),
    best: decodeBest(parsed.best),
    totals: decodeTotals(parsed.totals),
    resume: parsed.resume === undefined || parsed.resume === null ? null : decodeResume(parsed.resume),
  };
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board out
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store the
      // *origin* seed or the rebuilt board would not be the same one. The clue set is never stored:
      // it is a function of the seed, and a second copy of it could only ever drift.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that decides
      // the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  // 被丢掉的坏记录留在这一条里：验证脚本要能问出"垃圾档被丢了几条、丢了哪几条"，
  // 否则"我们容错了"和"我们什么都没接住"在外部看是同一句话。
  health() {
    return { dropped: dropped.slice(), resume: !!this.data.resume, best: Object.keys(this.data.best).length };
  },
  // 只给对拍/测试用：换一份 localStorage 内容，重新走一遍两段式解码。
  reload() {
    this.data = load();
    return this.data;
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
