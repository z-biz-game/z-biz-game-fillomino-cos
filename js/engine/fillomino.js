// Fillomino / 埋方块 engine. Every cell carries the NUMBER OF CELLS of the region it belongs to: a
// 1 is a lone square, a 5 is a pentomino, and each of its five cells reads 5. Two regions of the
// same size may never share an edge — and because touching equal numbers are by definition one
// region, that clause collapses into the size check itself. So the whole rulebook is one sentence:
//
//   每一块相连的同数区域，格数刚好等于它写着的那个数。
//
// Everything below is that sentence read three ways: `propagate` turns it into forced writes,
// `verify` reads it straight off the ink, and count.js re-derives it from scratch as a second
// opinion. The board also caps how big a region may get (`maxK`), which is what keeps the player's
// palette at 1..maxK instead of 1..n.
//
// `solve()` is the pencil path: it is the player's route, the generator's acceptance test and the
// source of every hint, so it never backtracks. Search lives only in count.js, and the generator
// trusts neither.

// The cell's own states. 0 means "not written yet"; 1..maxK are the region sizes a player may
// write. 0 is not a legal number here, so the palette and the emptiness marker share one axis
// without ever colliding.
export const OPEN = 0;
export const ONE = 1; // 单格块：它的四邻都不能再写 1
export const TWO = 2;
export const THREE = 3;
export const FOUR = 4;
export const FIVE = 5;
export const SIX = 6;
// A *separate* sentinel for "this cell carries no given", because the player's blank (0) and the
// author's blank (-1) are different facts: one says "nothing written here", the other says "no
// number was printed here, so anything may still go here".
export const NO_CLUE = -1;
// The largest 最大块 a board spec may declare. Sizes above it are never offered, which is what
// keeps both the pencil path and the exhaustive counter inside budget.
export const MAX_K_CEIL = 8;

// ---------------------------------------------------------------- 几何

const neighbourList = (w, h, r, c) => {
  const out = [];
  if (r > 0) out.push((r - 1) * w + c);
  if (r + 1 < h) out.push((r + 1) * w + c);
  if (c > 0) out.push(r * w + c - 1);
  if (c + 1 < w) out.push(r * w + c + 1);
  return out;
};

export function createBoard(spec = {}) {
  const { w, h, clue, maxK = SIX } = spec;
  if (!(w > 0 && h > 0)) throw new Error('board too small');
  const n = w * h;
  if (!clue || clue.length !== n) throw new Error('clue length mismatch');
  if (!(maxK >= ONE && maxK <= Math.min(n, MAX_K_CEIL))) {
    throw new Error(`最大块上限写成 ${maxK}，它只能是 1 到 ${Math.min(n, MAX_K_CEIL)} 之间的整数`);
  }
  const cellName = (t) => `第${((t / w) | 0) + 1}行${(t % w) + 1}列`;
  const adj = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) adj.push(neighbourList(w, h, r, c));

  for (let t = 0; t < n; t++) {
    const v = clue[t];
    if (v === NO_CLUE) continue;
    if (v === OPEN) throw new Error(`${cellName(t)} 写着 0：0 是「还没落子」，不是一个能占格子的数`);
    if (v < 0) throw new Error(`${cellName(t)} 写着 ${v}，给出的数字必须是正整数`);
    if (v > maxK) throw new Error(`${cellName(t)} 写着 ${v}，可这盘最大一块只有 ${maxK} 格`);
  }

  // Two touching clues carrying the same number are the *same* region, so a clue set can be born
  // impossible in exactly two ways: a run of equal clues longer than the number they spell, or a
  // clue whose region cannot reach its own size even after swallowing every same-numbered clue it
  // can reach and all the blank cells beyond them. Both are checked here so a bad board never
  // reaches a player.
  const blank = (t) => clue[t] === NO_CLUE;
  const seen = new Int8Array(n);
  for (let t = 0; t < n; t++) {
    if (blank(t) || seen[t]) continue;
    const v = clue[t];
    const group = [];
    const queue = [t];
    seen[t] = 1;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      group.push(c);
      for (const nb of adj[c]) if (!seen[nb] && clue[nb] === v) { seen[nb] = 1; queue.push(nb); }
    }
    if (group.length > v) {
      throw new Error(`${cellName(t)} 一带有 ${group.length} 个连成一片的 ${v}，可它那块只容得下 ${v} 格`);
    }
    // room: everything the block could still become — itself, the other printed v's it can reach,
    // and the blanks in between
    const room = new Set(group);
    const grow = [...group];
    for (let q = 0; q < grow.length; q++) {
      for (const nb of adj[grow[q]]) {
        if (room.has(nb) || (!blank(nb) && clue[nb] !== v)) continue;
        room.add(nb);
        grow.push(nb);
      }
    }
    if (room.size < v) {
      throw new Error(`${cellName(t)} 写着 ${v}，可它最多只能圈出 ${room.size} 格，凑不满 ${v}`);
    }
  }

  let clues = 0;
  for (let t = 0; t < n; t++) if (!blank(t)) clues++;
  if (!clues) throw new Error('盘上没有数字');
  const kinds = [];
  for (let k = ONE; k <= maxK; k++) kinds.push(k);
  return {
    w,
    h,
    n,
    maxK,
    adj,
    clue: Int8Array.from(clue),
    kinds,
    clues,
    cellName,
    blankAt: (t) => clue[t] === NO_CLUE,
  };
}

// The numbers a solution implies. In 埋方块 the answer *is* the number board, so every cell of a
// legal solution is a legal given — but the groups are re-measured here, so a solution that does
// not close up cannot masquerade as a clue set. Used by the generator, and by nothing that judges
// a board: verify() reads the clues, never this.
export function cluesFrom(w, h, solution) {
  const n = w * h;
  const out = new Int8Array(n);
  const adj = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) adj.push(neighbourList(w, h, r, c));
  const name = (t) => `第${((t / w) | 0) + 1}行${(t % w) + 1}列`;
  const done = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const v = solution[t];
    if (!(v >= ONE)) throw new Error(`${name(t)} 没有落子，推不出数字`);
    if (done[t]) continue;
    const group = [];
    const queue = [t];
    done[t] = 1;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      group.push(c);
      for (const nb of adj[c]) if (!done[nb] && solution[nb] === v) { done[nb] = 1; queue.push(nb); }
    }
    if (group.length !== v) {
      throw new Error(`${name(group[0])} 那块写着 ${v}，实际连成 ${group.length} 格，对不上`);
    }
    for (const c of group) out[c] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 规则

// 四条规则，四种「这一格只能这么写」。权重的意思是「玩家自己想到这一步要多少脑子」：
// 数一数量（刚好长满）最便宜，看路由（必经之格）最贵。
// 「凑不满」这个概念只在 `只剩一个数` 的解释里出现，它自己不成一条规则，因为一个能定下唯一数的格子
// 不可能只被「凑不满」排除过候选：唯一的候选必须是 1（1 只会被邻区挤掉），而 1 活着就说明四周没有 1；
// 空格子块若小于某个邻块的数，那个邻块本身就已经圈不满、轮不到解释这一格，早在冲突里报掉了。
export const Rules = {
  grow: {
    name: '刚好长满',
    weight: 2,
    text: (b, d) =>
      `${b.cellName(d.cell)} 得写成 ${d.value}：${b.cellName(d.root)} 那块要凑满 ${d.value} 格，` +
      `而它够得着的地方连自己数过来刚好 ${d.room} 格，一步都让不了`,
  },
  must: {
    name: '必经之格',
    weight: 2.8,
    text: (b, d) =>
      `${b.cellName(d.cell)} 必须写 ${d.value}：${b.cellName(d.root)} 那块要凑满 ${d.value} 格，` +
      `可绕开这一格它最多只能圈到 ${d.without} 格，不够`,
  },
  seal: {
    name: '邻区已满',
    weight: 1.6,
    text: (b, d) =>
      `${b.cellName(d.cell)} 只能写 ${d.value}：挨着 ${b.cellName(d.block)} 那块 ${d.blockV} 再塞一格就成 ${d.blockV + 1} 格了，` +
      `${d.killed} 个候选都被这样封死`,
  },
  only: {
    name: '只剩一个数',
    weight: 2.4,
    text: (b, d) =>
      `${b.cellName(d.cell)} 能写的数只剩 ${d.value}：${d.killed} 个候选被周围的块挤掉了——` +
      `邻区满掉的占 ${d.sealed} 个，长不满的占 ${d.shorted} 个`,
  },
};

// ---------------------------------------------------------------- 共用的区域骨架

// The written blocks (connected, equal number) and the blank chunks, straight off the ink. The ink
// this reads is the live `derived`, so a write made earlier in the same sweep is already a wall for
// the next one — which is fine precisely because every such write holds in *every* completion: a
// chain of consequences of true facts is still a consequence of the clues.
function shape(board, ink) {
  const { n } = board;
  const id = new Int16Array(n).fill(-1);
  const groups = [];
  const uid = new Int16Array(n).fill(-1);
  const ugroups = [];
  for (let t = 0; t < n; t++) {
    if (ink[t] === OPEN) {
      if (uid[t] !== -1) continue;
      const gi = ugroups.length;
      const cells = [];
      const queue = [t];
      uid[t] = gi;
      for (let q = 0; q < queue.length; q++) {
        const c = queue[q];
        cells.push(c);
        for (const nb of board.adj[c]) if (ink[nb] === OPEN && uid[nb] === -1) { uid[nb] = gi; queue.push(nb); }
      }
      ugroups.push({ cells, size: cells.length });
      continue;
    }
    if (id[t] !== -1) continue;
    const gi = groups.length;
    const v = ink[t];
    const cells = [];
    const queue = [t];
    id[t] = gi;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      cells.push(c);
      for (const nb of board.adj[c]) if (id[nb] === -1 && ink[nb] === v) { id[nb] = gi; queue.push(nb); }
    }
    groups.push({ v, cells, size: cells.length });
  }
  return { id, groups, uid, ugroups, ink, mark: new Uint32Array(n), epoch: 0 };
}

// How far a block spelling `k` could still spread from `seed`: across blank cells, and across any
// other block that spells k too — two blocks of one number separated by a blank square can be
// joined into a single region by filling that square, which is the fact the naive "count the blanks
// around me" version forgets. `cut` pretends one blank cell is a wall, so the caller can ask what
// is still reachable without it.
function closure(s, board, seed, k, cut) {
  s.epoch++;
  const e = s.epoch;
  const out = [];
  const queue = [];
  const push = (c) => { s.mark[c] = e; out.push(c); queue.push(c); };
  if (seed >= 0 && seed !== cut) push(seed);
  for (let q = 0; q < queue.length; q++) {
    for (const nb of board.adj[queue[q]]) {
      if (nb === cut || s.mark[nb] === e) continue;
      if (s.ink[nb] === OPEN || s.ink[nb] === k) push(nb);
    }
  }
  return out;
}

// Which numbers this blank cell could still carry, and what ruled the rest out. Both tests are
// necessary conditions read straight off the rulebook, so neither can over-exclude:
//   · 合并 — every equal-numbered neighbour joins this cell, and the merged block must still fit
//     inside the number it spells;
//   · 余量 — the block has to be able to reach its own size, and that size has to exist.
function feasible(board, s, t) {
  const U = s.ugroups[s.uid[t]];
  const list = [];
  let sealed = 0;
  let shorted = 0;
  let block = -1;
  let blockV = 0;
  let cap = 0;
  for (let k = 1; k <= board.maxK; k++) {
    const heads = [];
    let sum = 1;
    for (const nb of board.adj[t]) {
      const g = s.id[nb];
      if (g === -1 || s.groups[g].v !== k || heads.includes(g)) continue;
      heads.push(g);
      sum += s.groups[g].size;
    }
    if (sum > k) {
      sealed++;
      if (block === -1) { block = s.groups[heads[0]].cells[0]; blockV = k; cap = sum; }
      continue;
    }
    // a chunk of blanks at least k big can always hold a k-block that starts here
    if (U.size < k) {
      const room = closure(s, board, t, k, -1).length;
      if (room < k) {
        shorted++;
        if (block === -1) { block = t; blockV = k; cap = room; }
        continue;
      }
    }
    list.push(k);
    // two survivors and this cell proves nothing; the labels are only needed for a singleton
    if (list.length > 1) return { list, sealed, shorted, killed: sealed + shorted, block, blockV, cap };
  }
  return { list, sealed, shorted, killed: sealed + shorted, block, blockV, cap };
}

// One sweep: everything the numbers already on the board force. Each write is true in *every*
// completion of this board, so the player can trust it and the generator can gate on it.
export function propagate(board, derived) {
  const s = shape(board, derived);
  const found = [];
  let changed = false;
  const write = (cell, value, rule, detail) => {
    if (derived[cell] !== OPEN) {
      if (derived[cell] === value) return true;
      return false;
    }
    derived[cell] = value;
    found.push({ cell, value, rule, ...detail });
    changed = true;
    return true;
  };
  const deadEnd = (cell, text) => ({ found: [], changed: false, conflict: text, cell });

  // 1) region side: a block that cannot reach its own number has nowhere left to grow, and one that
  //    can reach it exactly has to take everything in reach.
  for (const g of s.groups) {
    const root = g.cells[0];
    if (g.size > g.v) return deadEnd(root, `${board.cellName(root)} 写着 ${g.v}，可它已经连成 ${g.size} 格了`);
    const room = closure(s, board, root, g.v, -1);
    if (room.length < g.v) {
      return deadEnd(root, `${board.cellName(root)} 那块 ${g.v} 能圈到的地方只剩 ${room.length} 格，凑不满`);
    }
    if (room.length === g.v) {
      for (const cell of room) {
        if (s.ink[cell] !== OPEN) continue;
        if (!write(cell, g.v, Rules.grow, { root, need: g.v - g.size, room: room.length })) {
          return deadEnd(cell, `${board.cellName(cell)} 被两块区域同时占住了`);
        }
      }
      continue;
    }
    // 必经之格: the blank squares lying on every route the block still has. A room this big cannot
    // be short of routes, and skipping the survey only costs a deduction, never a wrong one.
    if (room.length > g.v + 12) continue;
    for (const cell of room) {
      if (s.ink[cell] !== OPEN) continue;
      const without = closure(s, board, root, g.v, cell).length;
      if (without >= g.v) continue;
      if (!write(cell, g.v, Rules.must, { root, need: g.v - g.size, without })) {
        return deadEnd(cell, `${board.cellName(cell)} 被两块区域同时占住了`);
      }
    }
  }

  // 2) cell side: a blank square whose palette has been narrowed down to one number
  for (let t = 0; t < board.n; t++) {
    if (derived[t] !== OPEN) continue;
    const f = feasible(board, s, t);
    if (!f.list.length) return deadEnd(t, `${board.cellName(t)} 已经没有任何数可写了`);
    if (f.list.length > 1) continue;
    // 全是邻区挤掉的就说邻区，掺了「长不满」的就老实说这是个数数题
    const rule = f.shorted ? Rules.only : Rules.seal;
    if (!write(t, f.list[0], rule, f)) return deadEnd(t, `${board.cellName(t)} 已经没有任何数可写了`);
  }
  return { found, changed };
}

// The pencil path from the printed numbers to a finished board. It returns the deductions in the
// order the clues forced them — that list *is* the hint script, and it never reads the player's
// ink, so a wrong number cannot make the hints agree with the mistake.
export function solve(board) {
  const derived = new Int8Array(board.n);
  for (let t = 0; t < board.n; t++) derived[t] = board.clue[t] === NO_CLUE ? OPEN : board.clue[t];
  const rows = [];
  const used = new Map();
  let guard = 0;
  for (;;) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) {
      return { ok: false, conflict: sweep.conflict, derived, rows, steps: rows.length, score: 0, breakdown: {} };
    }
    if (!sweep.changed) break;
    for (const f of sweep.found) {
      const key = f.rule.name;
      const cur = used.get(key) || { n: 0, weight: f.rule.weight };
      cur.n++;
      used.set(key, cur);
      rows.push(f);
    }
    if (++guard > board.n + 4) {
      return { ok: false, conflict: '推导没有收敛（引擎缺陷）', derived, rows, steps: rows.length, score: 0, breakdown: {} };
    }
  }
  let filled = true;
  for (let t = 0; t < board.n; t++) if (derived[t] === OPEN) filled = false;
  let score = 0;
  for (const x of used.values()) score += x.n * x.weight;
  return {
    ok: filled,
    derived,
    rows,
    steps: rows.length,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v.n])),
  };
}

// The next thing the clues force that has not been written yet.
export function nextDeduction(board, derived) {
  const sweep = propagate(board, derived);
  // propagate names the cell it ran into a wall at, and the UI pulses on it — dropping it here
  // would leave a dead end with a sentence but nowhere to point.
  if (sweep.conflict) return { conflict: sweep.conflict, cell: sweep.cell };
  return sweep.found[0] || null;
}

// ---------------------------------------------------------------- 验收：只看盘和笔迹

// The clues and the player's ink merged into one number board. verify/diagnose/reachable all read
// through this, so a printed number can never be argued out of existence by what the player wrote.
export function withClues(board, cell) {
  const out = new Int8Array(board.n);
  for (let t = 0; t < board.n; t++) {
    out[t] = board.clue[t] !== NO_CLUE ? board.clue[t] : cell[t];
  }
  return out;
}

// The written regions, for the UI's outlines. Reads the board and the ink only.
export function regions(board, cell) {
  const s = shape(board, withClues(board, cell));
  return s.groups.map((g) => ({ value: g.v, size: g.size, cells: g.cells.slice(), full: g.size === g.v }));
}

// Judged straight from the rule of the game: a block may not hold more cells than its number, and
// it may not run out of room before reaching it. Nothing here reads `derived` or the hint script,
// so a bug in the propagation cannot fake a win.
export function verify(board, cell) {
  const bad = [];
  const ink = withClues(board, cell);
  for (let t = 0; t < board.n; t++) {
    const v = ink[t];
    if (v === OPEN) { bad.push({ why: '空格', cell: t, want: `1…${board.maxK}`, have: OPEN }); continue; }
    if (v > board.maxK) bad.push({ why: '超出最大块', cell: t, want: `1…${board.maxK}`, have: v });
  }
  const s = shape(board, ink);
  for (const g of s.groups) {
    const root = g.cells[0];
    if (g.size > g.v) {
      bad.push({ why: '块大了', cell: root, want: g.v, have: g.size, group: g.cells.slice() });
      continue;
    }
    const room = closure(s, board, root, g.v, -1).length;
    if (room < g.v) {
      bad.push({ why: '凑不满', cell: root, want: g.v, have: g.size, room, group: g.cells.slice() });
    }
  }
  return bad;
}

export function complete(board, cell) {
  const ink = withClues(board, cell);
  return verify(board, cell).length === 0 && ink.every((v) => v !== OPEN);
}

export function diagnose(board, cell) {
  const ink = withClues(board, cell);
  let filled = 0;
  for (let t = 0; t < board.n; t++) if (ink[t] !== OPEN) filled++;
  const s = shape(board, ink);
  const violated = new Set();
  const satisfied = new Set();
  for (const g of s.groups) {
    const root = g.cells[0];
    if (g.size === g.v) satisfied.add(root);
    else if (g.size > g.v || closure(s, board, root, g.v, -1).length < g.v) violated.add(root);
  }
  for (let t = 0; t < board.n; t++) if (ink[t] > board.maxK) violated.add(t);
  return {
    filled,
    total: board.n,
    remaining: board.n - filled,
    clues: board.clues,
    violated,
    satisfied,
    conflicts: violated.size,
  };
}

// ---------------------------------------------------------------- 这笔迹还救得回来吗

// Every write the region rules make holds in *every* completion of the board, so seeding the
// player's own numbers and then running those rules into a contradiction proves that no completion
// of this ink exists. That is the one thing a player cannot see coming — a single wrong number
// leaves every region individually plausible — and it is worth saying out loud. The converse is
// deliberately not claimed: ink that survives the rules may still lead nowhere.
export function reachable(board, cell) {
  const derived = withClues(board, cell);
  for (let round = 0; round < board.n + 4; round++) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return false;
    if (!sweep.changed) break;
  }
  return true;
}

// ---------------------------------------------------------------- 玩家的笔迹

export function createState(board) {
  return { board, cell: new Int8Array(board.n), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

// Only blank squares take ink, and only numbers the board offers. A printed clue is not the
// player's to change, and a number above 最大块 is not a move — it is a typo.
export function setCell(st, t, value) {
  if (!(t >= 0 && t < st.board.n)) return false;
  if (st.board.clue[t] !== NO_CLUE) return false;
  if (!(value === OPEN || (value >= ONE && value <= st.board.maxK))) return false;
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

export function eraseCell(st, t) {
  return setCell(st, t, OPEN);
}

export function resetInk(st) {
  st.cell.fill(OPEN);
  st.history.length = 0;
  return st;
}
