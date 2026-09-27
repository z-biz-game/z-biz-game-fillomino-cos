// Generator. Partition first: cut the board into regions at random, label each one with its own
// size, and the result is a legal 埋方块 answer by construction — no two regions of one size end up
// sharing an edge, because the growth step refuses any cell whose written neighbour spells that
// size. The givens are then read off that answer, and difficulty comes from the one knob the game
// actually has: how many of those numbers get rubbed out. A removal is kept only if the pencil path
// still finishes the board, so "unique" and "no guessing" are the same test here, and the exhaustive
// counter in count.js exists to check that the two have not drifted apart.

import { NO_CLUE, OPEN, ONE, createBoard, cluesFrom, solve, verify } from './fillomino.js';
import { countSolutions, UNIQUE } from './count.js';

export function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const shuffled = (list, rand) => {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// A random decomposition of the grid into orthogonally connected blocks of at most `maxK` cells.
// The scan-first empty cell is always the seed of the next block, so every block is anchored at its
// own top-left and the tiling is exact without any retrying — and a block only ever takes a cell
// whose already-written neighbours spell a different size, which is the whole of Fillomino's
// adjacency rule enforced while the shape is being grown.
export function plantSolution(w, h, maxK, rand) {
  const n = w * h;
  const val = new Int8Array(n);
  const nbrs = [];
  for (let t = 0; t < n; t++) {
    const r = (t / w) | 0;
    const c = t % w;
    const l = [];
    if (r > 0) l.push(t - w);
    if (r + 1 < h) l.push(t + w);
    if (c > 0) l.push(t - 1);
    if (c + 1 < w) l.push(t + 1);
    nbrs.push(l);
  }
  let free = n;
  // Cutting a single blank cell off from all other blanks is the one way this construction can
  // paint itself into a corner: that cell can only ever be a 1, and a 1 next to it makes the board
  // unplantable. So a finished block is asked whether it strands such a cell, and the size is
  // rejected when it does.
  const strands = (inBlob, size) => {
    for (let c = 0; c < n; c++) {
      if (val[c] || inBlob[c]) continue;
      if (nbrs[c].some((x) => !val[x] && !inBlob[x])) continue;
      if (nbrs[c].some((x) => val[x] === 1 || (inBlob[x] && size === 1))) return true;
    }
    return false;
  };
  const grown = (seed, size) => {
    const blob = [seed];
    const inBlob = new Uint8Array(n);
    inBlob[seed] = 1;
    let frontier = nbrs[seed].filter((u) => !val[u]);
    while (blob.length < size) {
      const ok = frontier.filter((u) => !inBlob[u] && !nbrs[u].some((x) => val[x] && !inBlob[x] && val[x] === size));
      if (!ok.length) return null;
      const pick = ok[Math.floor(rand() * ok.length)];
      inBlob[pick] = 1;
      blob.push(pick);
      frontier = blob.flatMap((c) => nbrs[c]).filter((u) => !val[u] && !inBlob[u]);
    }
    return strands(inBlob, size) ? null : blob;
  };
  for (let t = 0; t < n; t++) {
    if (val[t]) continue;
    const forb = [];
    for (const u of nbrs[t]) if (val[u] && !forb.includes(val[u])) forb.push(val[u]);
    const room = Math.min(maxK, free);
    const sizes = [];
    for (let s = ONE; s <= room; s++) if (!forb.includes(s)) sizes.push(s);
    // a 1 is legal but it strands everything around it, so it is the last thing to reach for
    const order = shuffled(sizes, rand);
    const i1 = order.indexOf(1);
    if (i1 > 0) { order.splice(i1, 1); order.push(1); }
    let placed = 0;
    for (const size of order) {
      const blob = grown(t, size);
      if (!blob) continue;
      for (const c of blob) { val[c] = size; free--; }
      placed = size;
      break;
    }
    if (!placed) return null;
  }
  return val;
}

// Greedy removal down to `target` givens, each one gated on the pencil path still finishing. The
// order is shuffled, so which numbers survive is a property of the seed, not of the scan direction.
export function pruneClues(board, rand, target) {
  const clue = Int8Array.from(board.clue);
  let kept = board.clues;
  for (const i of shuffled([...clue.keys()], rand)) {
    if (kept <= target) break;
    if (clue[i] === NO_CLUE) continue;
    const before = clue[i];
    clue[i] = NO_CLUE;
    let stillOk = false;
    try {
      stillOk = solve(createBoard({ w: board.w, h: board.h, maxK: board.maxK, clue })).ok;
    } catch {
      stillOk = false;
    }
    if (!stillOk) clue[i] = before;
    else kept--;
  }
  return clue;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The picker is the measurement: a candidate ships only when the pencil path finishes it *and* the
// independent counter calls it unique cell by cell. Nothing in that key reads the wall clock, so a
// saved seed always redraws the same board.
export function generate(opts = {}) {
  const {
    w = 6,
    h = 6,
    maxK = 5,
    seed = 'plain',
    keepRatio = 0.45,
    band = null,
    tries = 24,
    budget = 300000,
    count = true,
    report = () => {},
  } = opts;
  const target = Math.max(1, Math.round(w * h * keepRatio));
  const stats = { planted: 0, pencil: 0, unique: 0, overbudget: 0 };
  let best = null;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    let board;
    let solution;
    try {
      solution = plantSolution(w, h, maxK, rand);
      if (!solution) continue;
      const full = createBoard({ w, h, maxK, clue: cluesFrom(w, h, solution) });
      // the plant is checked against the acceptance test that knows nothing about how it was built
      if (verify(full, solution).length || !solution.some((v) => v !== OPEN)) continue;
      stats.planted++;
      board = createBoard({ w, h, maxK, clue: pruneClues(full, rand, target) });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    stats.pencil++;
    let c = null;
    if (count) {
      c = countSolutions(board, { cap: 2, budget });
      if (c.status === 'OVERBUDGET') { stats.overbudget++; continue; }
      if (c.status !== UNIQUE) continue;
      if (Array.from(p.derived).join(',') !== Array.from(c.first).join(',')) continue;
      stats.unique++;
    }
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      seed: trial,
      score: p.score,
      steps: p.steps,
      breakdown: p.breakdown,
      clues: board.clues,
      maxK,
      nodes: c ? c.nodes : 0,
      offBand,
      gen: k + 1,
    };
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, score: p.score, steps: p.steps, clues: board.clues, offBand });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, stats, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, stats, ...best };
}

// Bands are selection targets, and every number in them is measured — tools/balance.mjs prints the
// spread they came from and fails the build when the ladder stops ordering. Two facts decided this
// shape, both from the probe:
//   · 埋方块 dies on *enumeration*, not on the pencil path. The counter walks 1..maxK per cell, so a
//     7×7 with 最大块 6 burns six figures of nodes per board (measured: 1–5 秒一局，还常 OVERBUDGET),
//     and any 8-列的格子 is worse. The whole ladder therefore lives at maxK 4, 5×5→7×7.
//   · keepRatio 不是难度本身：印着的数字越少，能推的步数越多，分数才越高。所以难度靠「格子变大 +
//     数字变稀」两个旋钮一起推，档位之间的实测中位是 24 / 37.2 / 42.8 / 56 / 62.4，间隔远大于档内
//     的四分位距（最窄的一档也只有 ±1.2 分）。
export const TIERS = [
  { key: 'trainee', name: '初学', w: 5, h: 5, maxK: 4, keepRatio: 0.6, band: [22, 27] },
  { key: 'apprentice', name: '上手', w: 6, h: 5, maxK: 4, keepRatio: 0.5, band: [35, 40] },
  { key: 'regular', name: '熟练', w: 6, h: 6, maxK: 4, keepRatio: 0.5, band: [41, 46] },
  { key: 'expert', name: '高阶', w: 7, h: 6, maxK: 4, keepRatio: 0.42, band: [52, 60] },
  { key: 'master', name: '大师', w: 7, h: 7, maxK: 4, keepRatio: 0.45, band: [58, 67] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
  };
}

export { NO_CLUE, OPEN };
