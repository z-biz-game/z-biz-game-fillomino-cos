// 第二套互不信任的代码. It shares no neighbour table, no region helper and no state with
// fillomino.js: the blocks are re-derived here straight from the sentence 「每一块相连的同数区域，
// 格数刚好等于它写着的那个数」, because the point of the second opinion is that a mistake in the
// first one cannot show up in both.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting. A board
// counted with a capped budget is reported as OVERBUDGET, never as a pass.
//
// `all: true` hands back every completion it found instead of just the first. That is what lets the
// test ask the question the pencil has to survive: is each of its writes true in *every* solution,
// not merely true in one of them? `status` is read off the COUNT, never off `cap` — asking for 400
// completions and finding 5 is still MANY.

import { OPEN, NO_CLUE } from './fillomino.js';

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

// Cells are decided in scan order, so every constraint is checked the moment the last cell it
// depends on lands: that is what keeps the search off the maxK^(w*h) floor.
export function countSolutions(board, { cap = 2, budget = 400000, all = false } = {}) {
  const { w, h, clue } = board;
  const n = w * h;
  // the palette is re-derived from the board's own geometry, not handed to it
  const top = Math.max(1, Math.min(board.maxK || 1, n));

  const nbrs = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const t = r * w + c;
      const l = [];
      if (r > 0) l.push(t - w);
      if (r < h - 1) l.push(t + w);
      if (c > 0) l.push(t - 1);
      if (c < w - 1) l.push(t + 1);
      nbrs.push(l);
    }
  }

  const assign = new Int8Array(n);
  const mark = new Uint32Array(n);
  let epoch = 0;

  // the block of already-written `value` cells that reaches t
  function blockOf(t, value) {
    epoch++;
    const out = [t];
    mark[t] = epoch;
    for (let q = 0; q < out.length; q++) {
      for (const u of nbrs[out[q]]) {
        if (assign[u] === value && mark[u] !== epoch) { mark[u] = epoch; out.push(u); }
      }
    }
    return out;
  }

  // how far a block spelling `v` that reaches `seed` could still spread: across blank cells, and
  // across any other block spelling v too — filling the gap between two of them joins them into one
  // region, so counting only the blanks around a block understates its room and throws away real
  // answers. The returned cell count is an upper bound on the finished block's size.
  function reachOf(seed, v) {
    epoch++;
    let count = 0;
    const queue = [seed];
    mark[seed] = epoch;
    count++;
    for (let q = 0; q < queue.length; q++) {
      for (const u of nbrs[queue[q]]) {
        if (mark[u] === epoch) continue;
        if (assign[u] !== OPEN && assign[u] !== v) continue;
        mark[u] = epoch;
        queue.push(u);
        count++;
      }
    }
    return count;
  }

  // the block's canonical id: blockOf seeds its result with the cell it was asked about, so two
  // questions about one block answer with two different first cells
  function head(b) {
    let m = b[0];
    for (const c of b) if (c < m) m = c;
    return m;
  }

  // Could the blank cell t still carry k? Two necessary conditions, both read off the rule: the
  // blocks it would merge into have to fit inside k, and k cells have to lie within its reach.
  function fits(t, k) {
    if (clue[t] !== NO_CLUE && clue[t] !== k) return false;
    const heads = [];
    let sum = 1;
    for (const u of nbrs[t]) {
      if (assign[u] !== k) continue;
      const b = blockOf(u, k);
      const h = head(b);
      if (heads.includes(h)) continue;
      heads.push(h);
      sum += b.length;
    }
    if (sum > k) return false;
    return reachOf(t, k) >= k;
  }

  // everything the write at t is able to decide right now
  function consistent(t) {
    const v = assign[t];
    const block = blockOf(t, v);
    if (block.length > v) return false;
    if (reachOf(block[0], v) < v) return false;
    const checked = [];
    for (const c of block) {
      for (const u of nbrs[c]) {
        if (assign[u] === OPEN) {
          let any = false;
          for (let k = 1; k <= top && !any; k++) if (fits(u, k)) any = true;
          if (!any) return false;
          continue;
        }
        if (assign[u] === v || checked.includes(u)) continue;
        checked.push(u);
        const other = blockOf(u, assign[u]);
        if (other.length > assign[u]) return false;
        if (reachOf(other[0], assign[u]) < assign[u]) return false;
      }
    }
    return true;
  }

  // the last word, taken with none of the incremental machinery involved
  function closed() {
    const done = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
      if (done[t]) continue;
      const v = assign[t];
      if (v < 1 || v > top) return false;
      const b = blockOf(t, v);
      if (b.length !== v) return false;
      for (const c of b) done[c] = 1;
    }
    return true;
  }

  let nodes = 0;
  let solutions = 0;
  let first = null;
  const every = all ? [] : null;
  let over = false;

  function go(t) {
    if (++nodes > budget) { over = true; return true; }
    if (t === n) {
      if (closed()) {
        solutions++;
        if (!first) first = Int8Array.from(assign);
        if (every) every.push(Int8Array.from(assign));
      }
      return solutions >= cap;
    }
    const given = clue[t] !== NO_CLUE;
    const lo = given ? clue[t] : 1;
    const hi = given ? clue[t] : top;
    for (let v = lo; v <= hi; v++) {
      assign[t] = v;
      let stop = false;
      if (consistent(t) && go(t + 1)) stop = true;
      assign[t] = OPEN;
      if (over || stop) return true;
    }
    return false;
  }
  go(0);

  if (over) return { status: OVERBUDGET, solutions, nodes, first: null, every: null };
  // Read off the count, not off `cap`: with `all` the caller asks for hundreds of completions, and
  // "five of them" is still MANY even though the cap was never reached.
  return {
    status: solutions === 0 ? NONE : solutions === 1 ? UNIQUE : MANY,
    solutions,
    nodes,
    first,
    every,
  };
}
