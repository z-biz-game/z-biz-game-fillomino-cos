// The playable state machine: what a tap does, what an undo takes back, when a board counts as
// solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/fillomino.js:
//   * the ink lives in the engine's own `st.cell` array and the win check is the engine's
//     independent `verify()`/`complete()` — written from 每一块相连的同数区域，格数刚好等于它写着
//     的那个数 rather than from this file's bookkeeping — so "the UI said I won" cannot disagree
//     with "the regions add up".
//   * hints are handed over by `nextDeduction`, which only ever names a cell that is still blank
//     in the merged ink. A given therefore has nothing to fear from a hint, and this file never
//     has to remember which cells the author printed.
//
// 埋方块 has no two-way toggle: the player writes a digit 1..maxK into a cell or erases it. So the
// "brush" here is a digit from the palette, not a direction, and the palette is exactly as wide as
// the board's 最大块.
//
// One axis deserves a comment because the org has lost a game to it: `st.cell[t] === OPEN` (0) means
// "the player has written nothing here" while `board.clue[t] === NO_CLUE` (-1) means "the author
// printed nothing here". They are different facts and are never compared to each other. Every test
// for "may the player write here" goes through `isClue`, which compares against NO_CLUE by name.

import {
  createState,
  setCell,
  snapshot,
  undo as undoState,
  solve,
  nextDeduction,
  withClues,
  regions,
  verify,
  complete,
  reachable,
  diagnose,
  Rules,
  OPEN,
  ONE,
  NO_CLUE,
} from '../engine/fillomino.js';

export { OPEN, ONE, NO_CLUE };

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = puzzle.board.w;
    this.h = puzzle.board.h;
    this.maxK = puzzle.board.maxK;
    this.st = createState(puzzle.board);
    this.steps = [];
    // What the clues alone force, counted once. The generator only ships a board this finishes, so
    // it doubles as the promise behind every hint and as the denominator of a hint-only run.
    this.script = solve(puzzle.board).rows;
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.digit = ONE; // the palette selection a tap or a drag paints with
    this.lastHint = null;
    this.recompute();
  }

  // Every live verdict, straight from the engine. Called after any change of ink; nothing here is
  // re-derived from geometry by the caller.
  recompute() {
    // The single merged view: clues first, the player's ink where the author left a blank.
    this.ink = withClues(this.board, this.st.cell);
    this.diag = diagnose(this.board, this.st.cell);
    this.areas = regions(this.board, this.st.cell);
    // verify() lists every unwritten cell as a problem ('空格'). That is a progress report, not a
    // mistake, and painting the whole board red before the first tap would be a lie — so the UI
    // keeps the two counts apart and only the region verdicts are called 冲突.
    this.problems = verify(this.board, this.st.cell).filter((p) => p.why !== '空格');
    this.stuck = !reachable(this.board, this.st.cell);
    // Two different "filled" numbers, because they answer two different questions: `diag.filled`
    // counts every cell carrying a number (givens included — the board as it reads), `written`
    // counts only the ink the player has put down. Reading one as the other is how a save screen
    // starts at 15/25 and a player stops trusting the counter.
    let written = 0;
    for (let t = 0; t < this.board.n; t++) if (this.st.cell[t] !== OPEN) written++;
    this.written = written;
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  isClue(t) {
    return t >= 0 && t < this.board.n && this.board.clue[t] !== NO_CLUE;
  }

  // The number a cell shows: the given if there is one, otherwise the player's ink.
  shownAt(t) {
    return t >= 0 && t < this.board.n ? this.ink[t] : OPEN;
  }

  // What the player has written. A given is not the player's ink, so valueOf() of a clue cell is
  // OPEN — the harness asserts exactly that, because a layer that conflated the two would read a
  // printed 4 as something the player typed.
  valueOf(t) {
    return t >= 0 && t < this.board.n ? this.st.cell[t] : OPEN;
  }

  // Only a cell the author left blank can take ink.
  writable(t) {
    return t >= 0 && t < this.board.n && this.board.clue[t] === NO_CLUE;
  }

  // The palette a board hands out: 擦除 plus 1..最大块, no more and no less.
  palette() {
    const out = [OPEN];
    for (let k = ONE; k <= this.maxK; k++) out.push(k);
    return out;
  }

  setDigit(value) {
    const v = Number(value);
    if (!(v === OPEN || (v >= ONE && v <= this.maxK))) return false;
    this.digit = v;
    return true;
  }

  // One gesture = one engine snapshot, and the cells it changed with their prior values, so 撤销
  // is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // Tap writes the selected digit — 擦除 selected means the tap only ever takes ink off. There is
  // no toggle here, because this game has no two states a cell can be flipped between: writing over
  // your own digit is legal, and a given answers with null and changes nothing (the engine's own
  // setCell refuses it, so this cannot be argued into overwriting the author).
  tap(t, digit = this.digit) {
    if (this.status === 'won' || t < 0 || !this.writable(t)) return null;
    const from = this.st.cell[t];
    if (!setCell(this.st, t, digit)) return null;
    return this.commit('tap', { writes: [{ cell: t, from, to: digit }], value: digit });
  }

  // Write one digit into one cell with no toggle at all — this is what the palette buttons and
  // `paintDigit` use, and what a scenario drives when it must not depend on the current selection.
  paint(t, value) {
    if (this.status === 'won' || t < 0 || !this.writable(t)) return null;
    const from = this.st.cell[t];
    if (!setCell(this.st, t, value)) return null;
    return this.commit('paint', { writes: [{ cell: t, from, to: value }], value });
  }

  // A drag paints one digit and never toggles: sweeping back over what you just wrote must not eat
  // it. The whole gesture is one step, so 撤销 undoes a stroke rather than a cell of it. Givens are
  // skipped before anything is written, which keeps a drag across a printed number harmless.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    if (!(value === OPEN || (value >= ONE && value <= this.maxK))) return null;
    const writes = [];
    const seen = new Set();
    for (const t of cells) {
      if (!this.writable(t) || seen.has(t)) continue;
      seen.add(t);
      if (this.st.cell[t] === value) continue;
      writes.push({ cell: t, from: this.st.cell[t], to: value });
    }
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.cell[w.cell] = w.to;
    return this.commit('stroke', { writes, value });
  }

  // Restoring a run in progress: ink only, never the clues, and never onto a given.
  load(cells) {
    for (let t = 0; t < this.board.n; t++) {
      const v = cells[t];
      this.st.cell[t] = v >= ONE && v <= this.maxK && this.board.clue[t] === NO_CLUE ? v : OPEN;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.cell[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The next write the numbers on the board force. Free readings (nothing charged, nothing written)
  // are the two cases where a hint cannot honestly help: the ink already contradicts itself, or the
  // rules have simply run out of forced cells and the rest is the player's to finish.
  hint() {
    if (this.status === 'won') return null;
    const found = nextDeduction(this.board, Int8Array.from(this.ink));
    if (found && found.conflict) {
      // propagate drove this ink into a wall. It always names the cell it ran into; say the same
      // thing the `stuck` reading says, so no branch of a dead end ships without coordinates.
      return this.deadEnd(found, found.conflict);
    }
    if (!found) {
      return {
        stalled: true,
        charged: false,
        text: '规则能定下的格子都已经定下了：剩下的要你自己找那块该往哪长。',
      };
    }
    if (this.stuck) {
      // The rules can still name a cell that follows from this ink, while `reachable` can prove no
      // completion of this ink exists at all. Saying the forced number here would be a consolation
      // prize, so say the true thing instead and charge nothing.
      return this.deadEnd(found, `${this.board.cellName(found.cell)} 就算写成 ${found.value} 也来不及了`);
    }
    const from = this.st.cell[found.cell];
    setCell(this.st, found.cell, found.value);
    this.commit('hint', { writes: [{ cell: found.cell, from, to: found.value }], value: found.value, rule: found.rule.name });
    const info = {
      rule: found.rule.name,
      name: found.rule.name,
      cell: found.cell,
      value: found.value,
      why: found.rule.text(this.board, found),
      charged: true,
    };
    this.lastHint = info;
    return info;
  }

  // 死路只有一种说法，两条撞墙的路都走这里：规则在这一笔之后自己撞死（nextDeduction 直接回
  // conflict），或者规则还点得出一格、可达性却说这盘已经没有完整答案（this.stuck）。承诺有三样：
  // 说清这条路走死了、带上坐标、说清是哪一格来不及。引擎给的那句本来就点到格，所以把它嵌进来说话，
  // 而不是另编一句没有坐标的安慰话。
  deadEnd(found, engineSays) {
    const p = this.problems[0] || this.violatedRoot();
    const why = p
      ? `${this.board.cellName(p.cell)}：${p.why}（写着 ${p.want}，现在占了 ${p.have} 格）——${engineSays}`
      : `每一块看着都还有救，可从这一笔出发已经凑不出一个完整答案（${engineSays}）`;
    const cell = p ? p.cell : found.cell;
    return { conflict: `这条路已经走死了——${why}。撤销一步再推。`, cell: Number.isInteger(cell) ? cell : -1, charged: false };
  }

  // The first region the engine calls broken, for a sentence about it.
  violatedRoot() {
    for (const a of this.areas) {
      if (this.diag.violated.has(a.cells[0])) return { cell: a.cells[0], want: a.value, have: a.size, why: a.size > a.value ? '块大了' : '凑不满' };
    }
    return null;
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Only used by the verification harness and the "solve it for me" path: hand the player every
  // forced write until the board closes. Every cell it writes is one the region rules justify.
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    let stalled = 0;
    let conflict = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h) break;
      if (h.stalled) {
        stalled++;
        break;
      }
      if (h.conflict) {
        conflict++;
        break;
      }
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k, stalled: !!stalled, conflict: !!conflict };
  }

  state() {
    const g = this.diag;
    let full = 0;
    let grown = 0;
    for (const a of this.areas) {
      if (a.full) full++;
      if (a.size > a.value) grown++;
    }
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      written: this.written,
      clues: g.clues,
      maxK: this.maxK,
      digit: this.digit,
      // 成块: regions whose cell count already equals their own number. Counted by the engine's
      // regions(), so a block the player has grown too big is not quietly counted as finished.
      blocks: this.areas.length,
      full,
      grown,
      conflicts: g.violated.size,
      stuck: this.stuck,
      problems: this.problems.length,
      script: this.script.length,
      score: this.puzzle.score,
      steps: this.steps.length,
    };
  }
}

// A digit's name in the player's own words — used by hint sentences and by the harness.
export function digitName(value) {
  return value === OPEN ? '空' : `${value} 格块`;
}

export { Rules };
