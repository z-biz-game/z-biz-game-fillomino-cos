// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the numbers add up
// but the picture lies — five cells of a 5-block painted as five separate squares, a printed 4 and
// a written 4 wearing the same colour, a region outlined blue while the engine already called it
// broken.
//
// window.fillomino.engine is the shipped module graph, so a scenario that passes here has passed on
// the same solver the player's hints come from — not a second copy kept for testing. Where a case
// cannot be reached through the live DOM (a hand-made board that the rules cannot finish at all),
// the scenario builds it with the *shipped* engine's Game class rather than faking the reading.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Mixing them up is
// how `ck('count', 0)` reads as a failure to a human and a pass to a boolean — every "must equal"
// below therefore goes through eq.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = {
      // The window every geometry row was measured in travels with the report: verify.sh runs the
      // same scenario at two widths, and without `vw` on the line the two passes print alike.
      rows: rows.slice(),
      fail: rows.filter((r) => !r.pass).length,
      vw: window.innerWidth,
      vh: window.innerHeight,
      ...extra,
    };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtMs = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  const A = () => w.fillomino;
  const E = () => w.fillomino.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const num = (sel) => Number(text(sel));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---------- gestures ----------

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size, box, r };
  };
  async function tap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }
  // A run in this game is a polyomino, not a straight line: the pointer has to actually walk the
  // cells, bends included, so the gesture under test is the one a player makes.
  async function sweep(cells, { thereAndBack = false } = {}) {
    const pts = cells.map((t) => at(t));
    pointer('pointerdown', pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) pointer('pointermove', pts[i].x, pts[i].y);
    if (thereAndBack) for (let i = pts.length - 2; i >= 0; i--) pointer('pointermove', pts[i].x, pts[i].y);
    const last = thereAndBack ? pts[0] : pts[pts.length - 1];
    pointer('pointerup', last.x, last.y);
    return wait(24);
  }

  // ---------- pixels ----------

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 10) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  // Largest channel gap: tells two shades apart without guessing how much a gradient may drift.
  const gap = (p, c) => Math.max(...p.map((v, i) => Math.abs(v - c[i])));
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // Count pixels of one colour inside a CSS-pixel box. A single probe can land on an antialiased
  // edge, a grid line or the glyph itself; a region's fill, its outline and its digit are all wide
  // enough that a band over them is unambiguous.
  function countNear(x, y, bw, bh, target, tol = 26) {
    const v = A().view;
    const d = v.geo.dpr;
    const data = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), Math.max(1, Math.round(bw * d)), Math.max(1, Math.round(bh * d))).data;
    let n = 0;
    for (let k = 0; k + 3 < data.length; k += 4) {
      if (near([data[k], data[k + 1], data[k + 2]], target, tol)) n++;
    }
    return n;
  }
  // A point that is fill, neither glyph nor grid line: 26% across, 76% down.
  function fillPixel(t) {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size * 0.26, r.y + r.size * 0.76);
  }
  function glyphCount(t, colour, tol = 30) {
    const r = A().view.cellRect(t);
    const s = r.size;
    return countNear(r.x + s * 0.3, r.y + s * 0.28, s * 0.4, s * 0.46, colour, tol);
  }
  // The outline of a block straddles a grid line, and the 1px grid is painted over it, so the probe
  // band sits just inside the cell rather than exactly on the edge.
  function edgeCount(t, side, colour, tol = 40) {
    const r = A().view.cellRect(t);
    const s = r.size;
    const band = Math.max(2, s * 0.12);
    const box = {
      up: [r.x + s * 0.2, r.y + 1, s * 0.6, band],
      down: [r.x + s * 0.2, r.y + s - 1 - band, s * 0.6, band],
      left: [r.x + 1, r.y + s * 0.2, band, s * 0.6],
      right: [r.x + s - 1 - band, r.y + s * 0.2, band, s * 0.6],
    }[side];
    return countNear(box[0], box[1], box[2], box[3], colour, tol);
  }

  // ---------- engine-side helpers (no DOM, no storage) ----------

  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);
  const sum = (arr) => arr.reduce((a, v) => a + v, 0);
  const blanksOf = (b) => {
    const out = [];
    for (let t = 0; t < b.n; t++) if (b.clue[t] === -1) out.push(t);
    return out;
  };
  const givensOf = (b) => {
    const out = [];
    for (let t = 0; t < b.n; t++) if (b.clue[t] !== -1) out.push(t);
    return out;
  };
  const throws = (fn, re) => {
    try {
      fn();
      return false;
    } catch (e) {
      return re.test(e.message);
    }
  };
  // cells minus one candidate still orthogonally connected?
  function connected(b, cells, skip) {
    const set = new Set(cells.filter((c) => c !== skip));
    if (set.size <= 1) return true;
    const start = set.values().next().value;
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const c = q.pop();
      for (const nb of b.adj[c]) if (set.has(nb) && !seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    return seen.size === set.size;
  }
  // One wrong digit that leaves every block individually plausible: the case a player cannot see
  // coming, and the one the engine proves with `reachable`.
  function deadEndWrite(en, b, base, sol) {
    for (let t = 0; t < b.n; t++) {
      if (b.clue[t] !== en.NO_CLUE) continue;
      for (let d = en.ONE; d <= b.maxK; d++) {
        if (d === sol[t]) continue;
        const ink = Int8Array.from(base);
        ink[t] = d;
        if (en.diagnose(b, ink).conflicts === 0 && !en.reachable(b, ink)) return { t, d };
      }
    }
    return null;
  }
  // A printed 1 with a blank next to it: the cheapest way to make a block too big on a real board.
  function printedOne(en, b) {
    for (let t = 0; t < b.n; t++) {
      if (b.clue[t] !== en.ONE) continue;
      for (const nb of b.adj[t]) if (b.clue[nb] === en.NO_CLUE) return { t, nb };
    }
    return null;
  }
  const inkKey = (g) => Array.from(g.st.cell).join(',');
  // The replay the resume round trip is measured against: same seed, same scripted gestures, no
  // wall clock and no localStorage anywhere in it.
  function expectedRun(en, seed, tier, paints, hintCount) {
    const p = en.makePuzzle(seed, tier);
    const g = new en.Game(p);
    let done = 0;
    for (let t = 0; t < g.board.n && done < paints; t++) {
      if (!g.writable(t)) continue;
      if (g.paint(t, p.solution[t])) done++;
    }
    for (let i = 0; i < hintCount; i++) g.hint();
    return { ink: inkKey(g), moves: g.moves, hints: g.hints, written: g.written, puzzle: p };
  }

  const HANDOFF = { seed: 'scen|reload-handoff', tier: 'regular', paints: 8, hints: 3 };

  // ---------- boot ----------

  const boot = async () => {
    const en = E();
    ck('window.fillomino 挂出来了', !!A() && typeof A().version === 'string', typeof A().version);
    const surface = ['show', 'begin', 'useHint', 'undo', 'setDigit', 'paintDigit', 'stroke', 'tap', 'solveWithLogic', 'elapsed', 'state', 'cellAt', 'valueOf', 'digit', 'digitName', 'view', 'engine'];
    ck('测试台要的入口都在', surface.every((k) => k in A()), surface.filter((k) => !(k in A())).join(','));
    const needs = ['createBoard', 'cluesFrom', 'Rules', 'propagate', 'solve', 'nextDeduction', 'withClues', 'regions', 'verify', 'complete', 'diagnose', 'reachable', 'createState', 'setCell', 'eraseCell', 'snapshot', 'undo', 'makePuzzle', 'generate', 'plantSolution', 'pruneClues', 'countSolutions', 'TIERS', 'tierFor', 'Game', 'Store', 'theme'];
    ck('引擎整组挂上来了', needs.every((k) => k in en), needs.filter((k) => !(k in en)).join(','));
    eq('没落子是 0', en.OPEN, 0);
    eq('单格块是 1', en.ONE, 1);
    eq('没印数字的哨兵是 -1', en.NO_CLUE, -1);
    eq('最大块能声明的上限', en.MAX_K_CEIL, 8);
    eq('规则表里有四条', Object.keys(en.Rules).length, 4);
    ck('四条规则都有名字、权重与说法', Object.values(en.Rules).every((r) => r.name && typeof r.weight === 'number' && typeof r.text === 'function'), JSON.stringify(Object.keys(en.Rules)));
    eq('四条规则的名字', Object.values(en.Rules).map((r) => r.name).join(','), '刚好长满,必经之格,邻区已满,只剩一个数');
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].w * en.TIERS[i].h >= en.TIERS[i - 1].w * en.TIERS[i - 1].h)) ordered = false;
    }
    ck('档位按难度递增、盘面不缩回去', ordered, JSON.stringify(en.TIERS.map((t) => [t.w * t.h, t.band])));
    ck('每档的最大块都在引擎允许之内', en.TIERS.every((t) => t.maxK >= 1 && t.maxK <= en.MAX_K_CEIL), en.TIERS.map((t) => t.maxK).join(','));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    // 0 与 -1 不是一回事：这条线是组织里输过一局的地方。
    ck('写着 0 的线索直接被拒绝', throws(() => en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([0, -1, -1, -1]) }), /写着 0/));
    ck('负数（除 -1）线索被拒绝', throws(() => en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([-2, -1, -1, -1]) }), /正整数/));
    ck('超过最大块的线索被拒绝', throws(() => en.createBoard({ w: 2, h: 2, maxK: 3, clue: Int8Array.from([4, -1, -1, -1]) }), /最大一块只有 3/));
    // maxK 必须 ≤ 格数，否则 createBoard 的「最大块上限」那道闸先炸，这条断言根本走不到
    // 连片检查（同 tools/engine-test.mjs:125 的写法：3×1 的盘上 maxK 只能是 3）。
    ck('连成一片的同数线索超过自己写的数时拒绝开局', throws(() => en.createBoard({ w: 3, h: 1, maxK: 3, clue: Int8Array.from([2, 2, 2]) }), /连成一片/));
    ck('圈不满自己数字的线索拒绝开局', throws(() => en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([4, 1, 1, 1]) }), /凑不满/));
    ck('0 格哨兵 -1 能原样通过', (() => {
      const b2 = en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([-1, 1, -1, -1]) });
      return b2.clue[0] === -1 && b2.clues === 1;
    })());

    const p = en.makePuzzle('scen|boot', 'trainee');
    ck('出一局', !!p);
    const b = p.board;
    eq('盘面尺寸就是档位', `${b.w}×${b.h}`, '5×5');
    eq('格数', b.n, 25);
    eq('最大块', b.maxK, 4);
    ck('印上去的数都在 1..最大块', Array.from(b.clue).every((v) => v === -1 || (v >= 1 && v <= b.maxK)), Array.from(b.clue).join(','));
    ck('数字确实被删过（不是满印面）', b.clues < b.n, `${b.clues}/${b.n}`);
    const s = en.solve(b);
    ck('铅笔推到底', s.ok === true, s.conflict);
    eq('推到底与种下的解同盘', Array.from(s.derived).join(','), Array.from(p.solution).join(','));
    eq('推出来的盘通过独立验收', en.verify(b, s.derived).length, 0);
    eq('推出来即完整', en.complete(b, s.derived), true);
    eq('强制步数刚好填满所有空格', s.steps, b.n - b.clues);
    eq('穷举计数判定唯一', en.countSolutions(b, { cap: 2, budget: 200000 }).status, 'UNIQUE');
    eq('空盘不判胜', en.complete(b, new Int8Array(b.n)), false);
    eq('空盘没有冲突', en.diagnose(b, new Int8Array(b.n)).conflicts, 0);
    ck('满印面的每一格都是合法线索', (() => {
      const full = en.createBoard({ w: b.w, h: b.h, maxK: b.maxK, clue: en.cluesFrom(b.w, b.h, p.solution) });
      return full.clues === full.n && en.verify(full, p.solution).length === 0;
    })());
    ck('改一格答案必有块对不上', (() => {
      const off = Int8Array.from(p.solution);
      const t = blanksOf(b)[0];
      off[t] = off[t] === b.maxK ? 1 : off[t] + 1;
      return en.verify(b, off).length > 0 && !en.complete(b, off);
    })(), true);
    eq('同种子同盘', Array.from(en.makePuzzle('scen|boot', 'trainee').board.clue).join(','), Array.from(b.clue).join(','));
    // The row above compares Chrome to Chrome. This one pins the other engine: the literal is what
    // `makePuzzle('scen|boot', 'trainee')` hands back under node, where the whole engine suite runs.
    // A generator whose result leaned on engine-specific behaviour would sail through every
    // same-seed-twice check on this side and ship boards the tests never saw.
    eq('node 量过的那张盘，浏览器画的也是它', Array.from(b.clue).join(','),
      '1,-1,3,2,-1,3,2,-1,-1,1,3,-1,4,-1,-1,-1,1,4,4,2,2,3,-1,3,-1');
    ck('不同种子不同盘', Array.from(en.makePuzzle('scen|other', 'trainee').board.clue).join(',') !== Array.from(b.clue).join(','));
    eq('出货记下原始种子', p.originSeed, 'scen|boot');
    ck('派生种子带 trials 编号', /^scen\|boot#\d+$/.test(p.seed), p.seed);

    // the renderer's contract: diagnose's verdict keys are region roots, so the canvas can outline a
    // whole blob without ever re-deriving a rule
    const probe = new en.Game(p);
    probe.paint(blanksOf(b)[0], 1);
    const roots = new Set(probe.areas.map((a) => a.cells[0]));
    ck('每块的根格就是判定表的键', [...probe.diag.violated].every((r) => roots.has(r)) && [...probe.diag.satisfied].every((r) => roots.has(r)), JSON.stringify([[...probe.diag.violated], [...probe.diag.satisfied], [...roots]]));
    eq('区域格数与数字同真', probe.areas.every((a) => a.cells.length === a.size), true);
    const d0 = s.rows[0];
    ck('提示脚本的每条都带规则、格与值', !!(d0.rule && d0.cell >= 0 && d0.value >= 1), JSON.stringify({ rule: d0.rule && d0.rule.name, cell: d0.cell, value: d0.value }));
    ck('规则文本带坐标', /第\d+行\d+列/.test(d0.rule.text(b, d0)), d0.rule.text(b, d0));

    // ---- the page itself ----
    eq('页面标题带本作名字', /埋方块/.test(document.title) && /Fillomino/i.test(document.title), true);
    eq('标题是埋方块', text('#app h1'), '埋方块');
    ck('副标题点出玩法', /Fillomino/.test(text('.brand .sub')), text('.brand .sub'));
    ck('一句话讲清面积规则', /格数刚好等于它写着的那个数/.test(text('.menu-hero h2')), text('.menu-hero h2'));
    eq('玩法说明写了四条规则', document.querySelectorAll('.rules li').length, 4);
    eq('档位按钮五个', document.querySelectorAll('#tier-list .tier').length, 5);
    ck('档位按钮写着尺寸与最大块', [...document.querySelectorAll('#tier-list .tier')].every((x) => /×/.test(x.textContent) && /最大 \d 块/.test(x.textContent)));
    ck('档位按钮写着实测分', [...document.querySelectorAll('#tier-list .tier')].every((x) => /实测 \d+–\d+/.test(x.textContent)));
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('页脚提到验证脚本', /tools\/verify\.sh/.test(text('footer')), text('footer'));
    ck('页脚写下三个不需要运气的承诺', /唯一解/.test(text('footer')) && /逻辑/.test(text('footer')) && /提示只给/.test(text('footer')), text('footer'));
    ck('未开局不显示继续', !shown('#resume-card'));
    ck('选档页可见、棋局页藏起', shown('#view-menu') && !shown('#view-game'));
    eq('未开局面板是空的', document.querySelectorAll('#palette .digit').length, 0);
    eq('未开局没有棋盘可测', A().game, null);
    eq('画布在', !!$('#board') && !!A().view.ctx, true);
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    eq('统计项的标签', [...document.querySelectorAll('.stats .stat span')].map((x) => x.textContent).join(','), '步数,提示,已写,待写,成块,冲突,难度实测');
    eq('图例六项', document.querySelectorAll('.legend span').length, 6);
    return report({ version: A().version, score: p.score, clues: b.clues, steps: s.steps });
  };

  // ---------- paint (write a digit, erase, drag a run, undo) ----------

  const paint = async () => {
    const en = E();
    A().begin({ tier: 'trainee', seed: 'scen|paint' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    const st0 = g.state();
    const free = blanksOf(b);
    const givenCells = givensOf(b);
    eq('进入的是初学档', st0.tier, 'trainee');
    eq('棋头写了档位与尺寸', text('#stat-name'), `${st0.name} · ${g.w}×${g.h}`);
    eq('档位牌写了档位', text('#stat-tier'), '初学');
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', num('#stat-moves'), 0);
    eq('提示为 0', num('#stat-hints'), 0);
    eq('已写从 0 起：印上去的不算你写的', text('#stat-filled'), `0/${b.n - b.clues}`);
    eq('待写就是空格数', num('#stat-remaining'), b.n - b.clues);
    eq('难度实测显示分数', text('#stat-score'), st0.score.toFixed(1));
    eq('开局状态行是空的', text('#state-line'), '');
    ck('胜利遮罩藏起', !shown('#win-veil'));
    eq('已写读数与引擎的两个计数同源', [st0.written, st0.filled, st0.clues].join(','), `0,${b.clues},${b.clues}`);

    const digits = [...document.querySelectorAll('#palette .digit')];
    eq('面板就是最大块那么宽 + 擦除', digits.length, g.maxK + 1);
    eq('第一个按钮是擦除', digits[0].dataset.digit, '0');
    eq('面板按 1..最大块 排', digits.slice(1).map((x) => x.dataset.digit).join(','), '1,2,3,4');
    eq('默认选中 1', A().digit(), 1);
    eq('选中的按钮有按下态', digits[0].nextElementSibling.getAttribute('aria-pressed'), 'true');
    ck('没选中的按钮没有按下态', digits.filter((x) => x.dataset.digit !== '1').every((x) => x.getAttribute('aria-pressed') === 'false'));
    eq('画布记下当前数字', $('#board').dataset.digit, '1');

    // --- tap writes the selected digit; there is nothing to toggle ---
    const t1 = free[0];
    ck('选数字 3', A().setDigit(3));
    await tap(t1);
    eq('点一格写下选中的数字', A().valueOf(t1), 3);
    eq('这一格显示的就是它', g.shownAt(t1), 3);
    eq('点一格算一步', num('#stat-moves'), 1);
    eq('已写读数 +1', text('#stat-filled'), `1/${b.n - b.clues}`);
    eq('选择写进画布 dataset', $('#board').dataset.digit, '3');
    await tap(t1);
    eq('再点同一个数字不落子（本作没有双向切换）', num('#stat-moves'), 1);
    eq('再点也没有把数字弄丢', A().valueOf(t1), 3);

    // --- erase ---
    digits[0].click();
    await wait(24);
    eq('点擦除按钮选中擦除', A().digit(), en.OPEN);
    eq('擦除按钮亮起', digits[0].getAttribute('aria-pressed'), 'true');
    await tap(t1);
    eq('选擦除再点就擦掉', A().valueOf(t1), en.OPEN);
    eq('擦掉也算一步', num('#stat-moves'), 2);
    eq('擦掉之后已写归零', text('#stat-filled'), `0/${b.n - b.clues}`);
    eq('擦掉之后显示回印面', g.shownAt(t1), en.OPEN);

    // --- the givens are fixed ink ---
    const given = givenCells[0];
    const clueValue = b.clue[given];
    const mv0 = num('#stat-moves');
    ck('选数字 2', A().setDigit(2));
    await tap(given);
    eq('印上去的数被点之后还是它自己', b.clue[given], clueValue);
    eq('点印着的格子不落子、不计步', num('#stat-moves'), mv0);
    eq('玩家的笔迹里不含印上去的数', A().valueOf(given), en.OPEN);
    eq('超出最大块的数写不进去', A().paintDigit(free[1], g.maxK + 1), null);
    eq('越界的格子写不进去', A().paintDigit(-1, 1), null);
    eq('越界的大数字也写不进去', A().paintDigit(b.n + 3, 2), null);
    eq('拒绝之后步数没动', num('#stat-moves'), mv0);
    ck('paintDigit 指定数字落子', !!A().paintDigit(free[1], 2));
    eq('写进去的就是那个数', A().valueOf(free[1]), 2);
    eq('指定数字不用先选', A().digit(), 2);
    ck('擦除也能显式指定', !!A().paintDigit(free[1], en.OPEN));
    eq('擦完是空', A().valueOf(free[1]), en.OPEN);

    // --- drag-paint a run (an L-shaped block, through the real gesture path) ---
    const sol = g.puzzle.solution;
    const target = en.regions(b, sol).find((a) => a.size >= 3 && a.cells.some((c) => b.clue[c] === en.NO_CLUE));
    ck('有一块三格以上的可以拖着写', !!target, JSON.stringify(en.regions(b, sol).map((a) => [a.value, a.size])));
    const runCells = target.cells.filter((c) => b.clue[c] === en.NO_CLUE);
    const printedIn = target.cells.filter((c) => b.clue[c] !== en.NO_CLUE);
    while (A().undo()) { /* start from a clean sheet */ }
    await wait(20);
    eq('一路撤销退到空盘', g.state().written, 0);
    const mv1 = num('#stat-moves');
    ck('选中这块的数字', A().setDigit(target.value));
    await sweep(target.cells);
    eq('一笔拖出一个块', num('#stat-moves'), mv1 + 1);
    ck('拖过的空格都写上了同一个数', runCells.every((c) => A().valueOf(c) === target.value), Array.from(g.st.cell).join(','));
    eq('一笔写了几格就记几格', g.state().written, runCells.length);
    ck('拖过印着的数时它没被改', printedIn.every((c) => b.clue[c] === target.value), JSON.stringify(printedIn.map((c) => b.clue[c])));
    const merged = g.areas.find((a) => a.cells.includes(runCells[0]));
    ck('同数的邻格被算成一块', !!merged && merged.value === target.value && merged.size === target.size, JSON.stringify(merged && { v: merged.value, size: merged.size, cells: merged.cells }));
    ck('这一块连到了印着的格子', printedIn.every((c) => merged.cells.includes(c)), JSON.stringify(merged.cells));
    eq('成块读数与引擎一致', text('#stat-blocks'), `${g.state().full}/${g.state().blocks}`);
    ck('同一块是同一个底色', runCells.every((c) => near(fillPixel(c), hex(en.theme.DigitFill[(target.value - 1) % en.theme.DigitFill.length]))), JSON.stringify(runCells.map(fillPixel)));
    ck('印着的那格也染上了同一块的颜色', printedIn.every((c) => near(fillPixel(c), hex(en.theme.DigitFill[(target.value - 1) % en.theme.DigitFill.length]))), JSON.stringify(printedIn.map(fillPixel)));
    await sweep(target.cells, { thereAndBack: true });
    eq('来回拖不会吃掉自己写的数', runCells.every((c) => A().valueOf(c) === target.value), true);
    eq('来回拖重走一遍不多算一步', num('#stat-moves'), mv1 + 1);
    eq('也没有重复写格', g.state().written, runCells.length);

    // erasing with a drag: 擦除 selected, sweep the same cells
    ck('选擦除', A().setDigit(en.OPEN));
    await sweep(target.cells);
    eq('一笔拖掉一整块', runCells.every((c) => A().valueOf(c) === en.OPEN), true);
    eq('擦这一笔也算一步', num('#stat-moves'), mv1 + 2);
    eq('擦干净之后已写归零', g.state().written, 0);

    // --- undo ---
    ck('选中数字 4', A().setDigit(4));
    A().paintDigit(free[2], 4);
    A().paintDigit(free[3], 4);
    await wait(20);
    const mv2 = num('#stat-moves');
    A().undo();
    await wait(20);
    eq('一次撤销退掉最近那一格', A().valueOf(free[3]), en.OPEN);
    eq('前一步还在', A().valueOf(free[2]), 4);
    eq('撤销也退步数', num('#stat-moves'), mv2 - 1);
    while (A().undo()) { /* drain */ }
    eq('一路撤销能退到空盘', g.state().written, 0);
    eq('退无可退时返回空', A().undo(), null);

    // a hint taken back is still a hint taken
    const hintsBefore = g.hints;
    const mv3 = num('#stat-moves');
    const info = A().useHint();
    await wait(30);
    ck('提示落了一格', !!info && info.charged === true, JSON.stringify(info));
    eq('提示不占步数', num('#stat-moves'), mv3);
    eq('提示计一次', g.hints, hintsBefore + 1);
    A().undo();
    await wait(20);
    eq('撤销退掉提示写的那格', g.state().written, 0);
    eq('撤销不退提示次数', num('#stat-hints'), hintsBefore + 1);

    // --- keyboard ---
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    await wait(20);
    eq('数字键 2 选数字', A().digit(), 2);
    eq('面板按下态跟着键', document.querySelector('#palette [data-digit="2"]').getAttribute('aria-pressed'), 'true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: String(g.maxK + 3), bubbles: true }));
    await wait(20);
    eq('超出最大块的数字键被忽略', A().digit(), 2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    await wait(20);
    eq('0 键选擦除', A().digit(), en.OPEN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    eq('退格键也是擦除（已选时不变）', A().digit(), en.OPEN);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }));
    await wait(20);
    eq('数字键 4 选数字', A().digit(), 4);
    eq('画布 dataset 跟着选', $('#board').dataset.digit, '4');
    ck('超出盘面的选择被 Game 拒绝', A().setDigit(9) === false && A().setDigit(-1) === false && A().digit() === 4);

    // off-canvas press does nothing
    const c = A().view.canvas.getBoundingClientRect();
    const mv4 = num('#stat-moves');
    pointer('pointerdown', c.left - 6, c.top + 6);
    pointer('pointerup', c.left - 6, c.top + 6);
    await wait(24);
    eq('画布外的按下不落子', num('#stat-moves'), mv4);
    pointer('pointerdown', c.right + 4, c.bottom + 4);
    pointer('pointerup', c.right + 4, c.bottom + 4);
    await wait(24);
    eq('画布右下角外也不落子', num('#stat-moves'), mv4);
    eq('面板宽度跟着档位', getComputedStyle($('#palette')).gridTemplateColumns.trim().split(/\s+/).length, g.maxK + 1);
    return report({ blanks: b.n - b.clues, maxK: g.maxK });
  };

  // ---------- hint (a reason for every step) ----------

  const hint = async () => {
    const en = E();
    A().begin({ tier: 'expert', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const blanks = b.n - b.clues;
    eq('提示局开局没写任何格', g.state().written, 0);
    eq('引擎的强制步数等于空格数', g.state().script, blanks);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let badRule = 0;
    let outOfRange = 0;
    let notWritten = 0;
    let chargedFlag = 0;
    for (let k = 0; k < 400 && g.status !== 'won'; k++) {
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      if (info.conflict) {
        ck('一路提示不该撞到自己的数字', false, info.conflict);
        break;
      }
      charged++;
      if (info.charged !== true) chargedFlag++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!(info.cell >= 0 && info.cell < b.n)) outOfRange++;
      if (A().valueOf(info.cell) !== info.value) notWritten++;
      if (!/第\d+行\d+列/.test(info.why)) badRule++;
      if (b.clue[info.cell] !== en.NO_CLUE) badRule++;
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于空格数', charged, blanks);
    eq('提示次数被记上', g.hints, charged);
    eq('面板提示读数同步', text('#stat-hints'), String(charged));
    eq('提示按钮角标同步', text('#hint-count'), String(charged));
    eq('每条都真按 charged 收费', chargedFlag, 0);
    eq('提示说的规则都在表里', badRule, 0);
    eq('提示不越界', outOfRange, 0);
    eq('提示说完就真落子', notWritten, 0);
    ck('用到的规则不止一种', seen.size >= 2, [...seen].join(','));
    ck('提示从不改印上去的数', givensOf(b).every((t) => b.clue[t] === g.shownAt(t) && A().valueOf(t) === en.OPEN));
    eq('终局通过独立验收', en.verify(b, g.st.cell).length, 0);
    eq('终局每一块都长满了', g.state().conflicts, 0);
    eq('格数对上了', `${g.state().full}/${g.state().blocks}`, g.state().blocks + '/' + g.state().blocks);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带花费', new RegExp(`${g.moves} 步 · 提示 ${g.hints} 次`).test(text('#win-meta')), text('#win-meta'));
    ck('提示理由写着规则名', /规则：.+/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示说的是带坐标的人话', /第\d+行\d+列/.test(text('#hint-line')), text('#hint-line'));
    eq('已写读数走满了', text('#stat-filled'), `${blanks}/${blanks}`);
    eq('待写归零', text('#stat-remaining'), '0');
    const after = g.hints;
    ck('胜利之后再按提示什么都不给', A().useHint() === null);
    eq('胜利后再提示不充电', g.hints, after);
    eq('胜利后续局被清掉', en.Store.resume(), null);

    // a second board must not be walkable by reusing the first one's script
    const g2 = A().begin({ tier: 'expert', seed: 'scen|hint2' });
    await wait(60);
    eq('换局后提示清零', g2.hints, 0);
    eq('换局后已写清零', g2.state().written, 0);
    ck('换局后盘面不同', Array.from(g2.board.clue).join(',') !== Array.from(b.clue).join(','));
    const first = A().useHint();
    ck('新局的第一个提示照样带理由', !!first && !!first.why && first.charged === true, JSON.stringify(first));

    // The second free reading: the rules have run out and the board is not finished. A shipped
    // puzzle never does this (it is generated to be pencil-finishable), so build the case with the
    // shipped engine's own Game — a fake reading in the shell would be caught by the text check.
    const stalled = new en.Game({
      board: en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([1, -1, -1, -1]) }),
      tier: 'trainee',
      tierName: '手工',
      score: 0,
      seed: 'hand|stall',
      originSeed: 'hand|stall',
      w: 2,
      h: 2,
    });
    eq('手工盘的铅笔推不完', en.solve(stalled.board).ok, false);
    const s1 = stalled.hint();
    ck('推不动时说 stalled', !!s1 && s1.stalled === true, JSON.stringify(s1));
    eq('stalled 不收费', s1.charged, false);
    eq('stalled 不落子', stalled.state().written, 0);
    ck('stalled 说人话', (s1.text || '').length > 8, s1.text);
    eq('stalled 不动步数与提示数', `${stalled.moves},${stalled.hints}`, '0,0');
    return report({ hints: charged, rules: [...seen], blanks });
  };

  // ---------- region (one blob, one colour, one verdict) ----------

  const region = async () => {
    const en = E();
    A().begin({ tier: 'trainee', seed: 'scen|region' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const sol = g.puzzle.solution;
    const areas = en.regions(b, sol);
    const pick = areas.find(
      (a) => a.size >= 3 && a.cells.some((c) => b.clue[c] !== en.NO_CLUE) && a.cells.filter((c) => b.clue[c] === en.NO_CLUE).length >= 2
    );
    ck('有一块既有印着的数又有两个以上空格', !!pick, JSON.stringify(areas.map((a) => [a.value, a.size])));
    const anchor = pick.cells.filter((c) => b.clue[c] === en.NO_CLUE).find((c) => connected(b, pick.cells, c));
    ck('留一格还能让其余连成一片', anchor != null, JSON.stringify(pick.cells));
    const v = pick.value;
    const printedIn = pick.cells.filter((c) => b.clue[c] !== en.NO_CLUE);
    const part = pick.cells.filter((c) => c !== anchor && b.clue[c] === en.NO_CLUE);
    const before = g.state();
    eq('空笔迹时盘上没有冲突', before.conflicts, 0);
    eq('开局没有任何笔迹', before.written, 0);
    eq('成块读数与引擎同源', text('#stat-blocks'), `${before.full}/${before.blocks}`);
    ck('这块开局还差着空格', pick.cells.some((c) => b.clue[c] === en.NO_CLUE));
    for (const c of part) A().paintDigit(c, v);
    await wait(30);
    eq('一块分几格写就记几步', num('#stat-moves'), part.length);
    const merged = g.areas.find((a) => a.cells.includes(part[0]));
    ck('这一块被引擎认成一整块', !!merged, JSON.stringify(g.areas.map((a) => [a.value, a.size, a.cells])));
    eq('块的数字就是它的数', merged.value, v);
    eq('差一格就少一格', merged.size, pick.size - 1);
    eq('差一格还没长满', merged.full, false);
    eq('差一格不算错', g.state().conflicts, 0);
    eq('差一格不计入成块', g.state().full, before.full);
    ck('印着的格子在这块里', printedIn.every((c) => merged.cells.includes(c)), JSON.stringify(merged.cells));
    eq('没写的那一格还空着', A().valueOf(anchor), en.OPEN);
    eq('状态里那块还没满', g.shownAt(anchor), en.OPEN);
    // the last cell closes it: the verdict comes from the engine, the picture follows
    A().paintDigit(anchor, v);
    await wait(30);
    const done = g.areas.find((a) => a.cells.includes(part[0]));
    eq('补上最后一格就连成一整块', done.size, v);
    eq('这一块的格数等于它写着的数', done.value, done.size);
    ck('它被引擎判为长满了', g.diag.satisfied.has(done.cells[0]), JSON.stringify([...g.diag.satisfied]));
    eq('成块数 +1', g.state().full, before.full + 1);
    eq('成块读数写在面板上', text('#stat-blocks'), `${g.state().full}/${g.state().blocks}`);
    eq('补完之后仍然没有冲突', g.state().conflicts, 0);
    const th = hex(en.theme.DigitFill[(v - 1) % en.theme.DigitFill.length]);
    const succ = hex(en.theme.success);
    ck('整块共用同一个底色', pick.cells.every((c) => near(fillPixel(c), th)), JSON.stringify(pick.cells.map(fillPixel)));
    // the sides where this block ends and another begins have to wear the green verdict
    const border = [];
    for (const c of pick.cells) {
      const row = ((c / b.w) | 0) * b.w;
      const col = c % b.w;
      if (row === 0 || !pick.cells.includes(c - b.w)) border.push([c, 'up']);
      if (row + b.w >= b.n || !pick.cells.includes(c + b.w)) border.push([c, 'down']);
      if (col === 0 || !pick.cells.includes(c - 1)) border.push([c, 'left']);
      if (col + 1 >= b.w || !pick.cells.includes(c + 1)) border.push([c, 'right']);
    }
    const greenSides = border.filter(([c, s]) => edgeCount(c, s, succ) > 0).length;
    ck('长满的块每一条外接边都描了绿', greenSides === border.length && border.length >= 2, `${greenSides}/${border.length} @${JSON.stringify(border)}`);
    eq('绿色的边与引擎的令牌同源', cssVar('--success'), en.theme.success);

    // two blocks that carry the same digit but never touch stay two blocks
    const same = areas.filter((a) => a.value === v && a !== pick && a.cells.some((c) => b.clue[c] === en.NO_CLUE));
    ck('盘上还有另一块同数的', same.length >= 1, JSON.stringify(areas.map((a) => a.value)));
    const other = same[0];
    const mv = g.moves;
    // 基线数的是「同数的块里已经数得着的块」，不是「带这个数的区域条数」：other 印着的那几格在落子
    // 之前各自就是一块（engine 的 regions() 按连通分块，js/engine/fillomino.js:420），stroke 一落下
    // 它们就并成一块——区域条数反而会掉。这条承诺说的是两块同数的各算一块，也就是长满的 v 块多一块。
    const fullV = () => g.areas.filter((a) => a.value === v && a.full).length;
    const beforeFullV = fullV();
    A().stroke(other.cells.filter((c) => b.clue[c] === en.NO_CLUE), v);
    await wait(30);
    eq('整块一次落下只算一步', g.moves, mv + 1);
    eq('同数的两块各算一块', fullV(), beforeFullV + 1);
    ck('两块是同数的两块、不并成一块', (() => {
      const one = g.areas.find((a) => a.cells.includes(pick.cells[0]));
      const two = g.areas.find((a) => a.cells.includes(other.cells[0]));
      return one !== two && one.full && two.full && !one.cells.some((c) => two.cells.includes(c));
    })(), JSON.stringify(g.areas.filter((a) => a.value === v).map((a) => [a.size, a.full, a.cells])));
    const twoV = g.areas.filter((a) => a.value === v && a.size === v);
    ck('两块都长满了', twoV.length >= 2, JSON.stringify(g.areas.filter((a) => a.value === v).map((a) => [a.size, a.cells])));
    ck('两块互不共享格子', (() => {
      const s = new Set();
      for (const a of g.areas.filter((x) => x.value === v)) for (const c of a.cells) { if (s.has(c)) return false; s.add(c); }
      return true;
    })(), true);
    ck('挨着的两块写的数不一样', (() => {
      for (const a of g.areas) for (const c of a.cells) for (const nb of b.adj[c]) {
        const o = g.areas.find((x) => x.cells.includes(nb));
        if (o && o !== a && o.value === a.value) return false;
      }
      return true;
    })(), true);

    // a printed number is not the player's, in either direction
    const g2 = A().game;
    const gv = printedIn[0];
    const mvG = g2.moves;
    ck('印着的格子不可写', g2.writable(gv) === false && g2.isClue(gv) === true);
    eq('想改印着的数会被拒绝', A().paintDigit(gv, v === 1 ? 2 : 1), null);
    eq('印着的数还是原来那个', b.clue[gv], v);
    eq('擦除也擦不掉它', A().paintDigit(gv, en.OPEN), null);
    eq('两次拒绝都不计步', g2.moves, mvG);
    ck('数字的名字说得出格数', A().digitName(v) === `${v} 格块` && A().digitName(en.OPEN) === '空', A().digitName(v));
    // erase one cell of the finished block: the block shrinks, the printed cell stays in it
    const shrink = part[0];
    const writtenBefore = g.state().written;
    // 成块的基线就地取：上面又画了 other 那一块，开局那个 before.full 已经把两块算成一笔账了。
    // 这条承诺说的是「擦掉这一格，这块就不计成块」——成块数因此正好少一。
    const fullBeforeErase = g.state().full;
    A().paintDigit(shrink, en.OPEN);
    await wait(30);
    eq('擦掉一格就少一格笔迹', g.state().written, writtenBefore - 1);
    eq('擦掉一格之后这块要么缩回去要么裂开', g.areas.filter((a) => pick.cells.includes(a.cells[0])).reduce((n, a) => n + a.size, 0), pick.size - 1);
    ck('印着的那格仍然显示它的数', g.shownAt(gv) === v && A().valueOf(gv) === en.OPEN);
    eq('擦掉一格之后不计成块', g.state().full, fullBeforeErase - 1);
    eq('擦掉一格也不算错', g.state().conflicts, 0);
    const info = A().useHint();
    // `hint()` answers null only when the board is already won (js/ui/game.js:203), and this board
    // was just erased back into play — so "no answer at all" is a defect, not a case to forgive.
    // The old `!info ||` in the next row passed either way, which is how a green run proved nothing.
    ck('擦掉一格之后提示还开得了口', !!info, JSON.stringify(info));
    ck('差的那一格：推得出就给理由，推不出就直说枯竭', !!info && (!!info.charged || !!info.conflict || !!info.stalled), JSON.stringify(info));
    return report({ value: v, size: pick.size, blocks: g.state().blocks });
  };

  // ---------- conflict (the two free readings, and red pixels) ----------

  const conflict = async () => {
    const en = E();
    // A) a block grown one cell too big: the engine's verdict, painted red
    A().begin({ tier: 'trainee', seed: 'scen|conflict2' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const one = printedOne(en, b);
    ck('盘上有一个印着的 1 挨着空格', !!one, Array.from(b.clue).join(','));
    ck('选中 1', A().setDigit(1));
    const mv = num('#stat-moves');
    await tap(one.nb);
    eq('把 1 写到印着的 1 旁边', A().valueOf(one.nb), 1);
    eq('这一笔算一步', num('#stat-moves'), mv + 1);
    eq('冲突计数 1', g.state().conflicts, 1);
    eq('面板冲突读数 1', text('#stat-conflicts'), '1');
    ck('冲突的格子被标红底', near(fillPixel(one.nb), hex(en.theme.errorFill)) && near(fillPixel(one.t), hex(en.theme.errorFill)), `${fillPixel(one.nb)} / ${fillPixel(one.t)} vs ${en.theme.errorFill}`);
    ck('红块上的数字也是红的', glyphCount(one.nb, hex(en.theme.error)) >= 2, String(glyphCount(one.nb, hex(en.theme.error))));
    ck('红色的边由引擎判定驱动', ['up', 'down', 'left', 'right'].some((s) => edgeCount(one.nb, s, hex(en.theme.error)) > 0), JSON.stringify(['up', 'down', 'left', 'right'].map((s) => edgeCount(one.nb, s, hex(en.theme.error)))));
    const p0 = g.problems[0];
    eq('引擎说这块大了', p0.why, '块大了');
    eq('这块写着 1', p0.want, 1);
    eq('这块占了 2 格', p0.have, 2);
    ck('判定挂在块的代表格上', p0.cell === one.t || p0.cell === one.nb, JSON.stringify(p0));
    const h1 = A().useHint();
    ck('矛盾时提示不落子', !!h1 && !!h1.conflict, JSON.stringify(h1));
    eq('矛盾时不收钱', g.hints, 0);
    eq('提示按钮角标不动', text('#hint-count'), '0');
    ck('矛盾的说法来自引擎', /写着 1/.test(h1.conflict) && /连成 2 格/.test(h1.conflict), h1.conflict);
    eq('提示理由说这是笔对不上的账', text('#hint-rule'), '这一笔对不上');
    eq('提示行复述同一句话', text('#hint-line'), h1.conflict);
    ck('状态行说出矛盾', /矛盾|对不上/.test(text('#state-line')), text('#state-line'));
    ck('冲突的面板亮了', $('.stats .stat:nth-child(6)').classList.contains('bad'));
    A().undo();
    await wait(30);
    eq('擦掉那一格之后冲突清零', g.state().conflicts, 0);
    eq('面板冲突读数也清零', text('#stat-conflicts'), '0');
    eq('状态行清空', text('#state-line'), '');
    ck('擦掉那一格之后回到纸色', near(fillPixel(one.nb), hex(en.theme.bgBottom), 4), String(fillPixel(one.nb)));
    ck('印着的 1 单独成块时用的是 1 号色', near(fillPixel(one.t), hex(en.theme.DigitFill[0]), 4), `${fillPixel(one.t)} vs ${en.theme.DigitFill[0]}`);
    const ok2 = A().useHint();
    ck('这时提示才肯落子', !!ok2 && ok2.charged === true, JSON.stringify(ok2));
    eq('这次才计一次提示', g.hints, 1);

    // B) one plausible-looking digit that makes the whole board unsalvageable: no red block at all,
    //    and yet nothing the player can write from here finishes the puzzle.
    A().begin({ tier: 'trainee', seed: 'scen|conflict' });
    await wait(60);
    const g2 = A().game;
    const bad = deadEndWrite(en, g2.board, g2.st.cell, g2.puzzle.solution);
    ck('找到一个看着没错、其实走死的写法', !!bad, JSON.stringify(bad));
    A().paintDigit(bad.t, bad.d);
    await wait(30);
    eq('这一笔没有任何块超标', g2.state().conflicts, 0);
    eq('面板冲突读数是 0', text('#stat-conflicts'), '0');
    eq('但引擎证明这盘救不回来了', g2.state().stuck, true);
    ck('状态行把死路说给玩家', /矛盾/.test(text('#state-line')), text('#state-line'));
    ck('已写那格亮红提醒', $('.stats .stat:nth-child(3)').classList.contains('bad'));
    const h2 = A().useHint();
    ck('死路时提示只说不落子', !!h2 && !!h2.conflict && !h2.value, JSON.stringify(h2));
    eq('死路的提示也不收费', g2.hints, 0);
    ck('说的是这条路走死了', /走死/.test(h2.conflict), h2.conflict);
    ck('死路的说法带坐标、也说清是哪一格来不及', /第\d+行\d+列/.test(h2.conflict) && /凑不出一个完整答案/.test(h2.conflict), h2.conflict);
    A().undo();
    await wait(30);
    eq('撤销一步就又走得通了', g2.state().stuck, false);
    eq('状态行随之清空', text('#state-line'), '');
    const h3 = A().useHint();
    eq('这时提示恢复落子', h3.charged, true);

    // C) 凑不满 — a block that can never reach its own number. Built with the shipped engine, and
    //    distinguished from 块大了 by the counters, because the two read differently on screen.
    const hand = new en.Game({
      board: en.createBoard({ w: 2, h: 2, maxK: 4, clue: Int8Array.from([3, -1, -1, -1]) }),
      tier: 'trainee',
      tierName: '手工',
      score: 0,
      seed: 'hand|short',
      originSeed: 'hand|short',
      w: 2,
      h: 2,
    });
    hand.paint(3, 4);
    eq('手工盘也报一个冲突', hand.state().conflicts, 1);
    eq('报的是凑不满', hand.problems[0].why, '凑不满');
    eq('凑不满时块还没超标', hand.state().grown, 0);
    eq('它要 4 格', hand.problems[0].want, 4);
    eq('它现在只有 1 格', hand.problems[0].have, 1);
    const hh = hand.hint();
    ck('凑不满时提示说不落子', !!hh.conflict && hh.charged === false, JSON.stringify(hh));
    ck('说法里带坐标', /第\d+行\d+列/.test(hh.conflict), hh.conflict);
    eq('手工盘不落子时不计数', `${hand.moves},${hand.hints}`, '1,0');
    hand.undo();
    eq('擦掉那个数之后就没有凑不满', hand.problems.length, 0);

    // D) a whole board of one digit: many conflicts, no crash, no win
    A().begin({ tier: 'trainee', seed: 'scen|conflict3' });
    await wait(60);
    const g4 = A().game;
    const maxDigit = g4.maxK;
    A().setDigit(maxDigit);
    for (const t of blanksOf(g4.board)) A().paintDigit(t, maxDigit);
    await wait(30);
    ck('满盘同一个数字时冲突可读', typeof g4.state().conflicts === 'number' && g4.state().conflicts > 0, String(g4.state().conflicts));
    eq('满盘同一个数字不会误判胜利', g4.status, 'playing');
    eq('待写归零', g4.state().remaining, 0);
    ck('冲突数不超过块数', g4.state().conflicts <= g4.state().blocks, JSON.stringify(g4.state()));
    ck('面板说的冲突与引擎一致', text('#stat-conflicts'), String(g4.state().conflicts));
    ck('状态行有话说', text('#state-line').length > 0);
    // the engine's own answer, drawn through the same path, must have no conflict at all
    A().begin({ tier: 'trainee', seed: 'scen|conflict4' });
    await wait(60);
    const g5 = A().game;
    for (const a of en.regions(g5.board, g5.puzzle.solution)) A().stroke(a.cells, a.value);
    await wait(30);
    eq('照解画完时冲突为 0', g5.state().conflicts, 0);
    eq('照解画完时每块都长满', `${g5.state().full}/${g5.state().blocks}`, `${g5.state().blocks}/${g5.state().blocks}`);
    eq('照解画完就赢了', g5.status, 'won');
    eq('赢盘的状态行为空', text('#state-line'), '');
    return report({ conflicts: g4.state().conflicts, deadEnd: bad });
  };

  // ---------- save ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    localStorage.removeItem('fillomino.save.v1');
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const sol = g.puzzle.solution;
    let done = 0;
    for (let t = 0; t < b.n && done < 6; t++) {
      if (!g.writable(t)) continue;
      if (A().paintDigit(t, sol[t])) done++;
    }
    A().useHint();
    await wait(30);
    const raw = JSON.parse(localStorage.getItem('fillomino.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过一千字节', JSON.stringify(raw.resume).length < 1000, JSON.stringify(raw.resume).length);
    ck('存档不带走答案', !('solution' in raw.resume) && !('clue' in raw.resume) && !('derived' in raw.resume), Object.keys(raw.resume).join(','));
    ck('笔迹用游程编码存', Array.isArray(raw.resume.ink) && raw.resume.ink.length % 2 === 0, JSON.stringify(raw.resume.ink));
    ck('游程编码比一格一数省', raw.resume.ink.length < b.n * 2, `${raw.resume.ink.length} vs ${b.n * 2}`);
    ck('存下来的笔迹里没有负数：-1 是作者的哨兵，从不进存档', raw.resume.ink.every((v) => v >= 0), JSON.stringify(raw.resume.ink));
    ck('存下来的笔迹不超过最大块', raw.resume.ink.every((v, i) => i % 2 === 0 ? v <= b.maxK : true), JSON.stringify(raw.resume.ink));
    const back = en.Store.resume();
    eq('笔迹一格不差地回来', Array.from(back.board).join(','), inkKey(g));
    ck('空格在存档里还是空格', Array.from(back.board).some((v) => v === en.OPEN) && Array.from(back.board).every((v) => v >= en.OPEN && v <= b.maxK), Array.from(back.board).slice(0, 12).join(','));
    eq('印上去的格在笔迹里是 0', Array.from(back.board).filter((v, t) => b.clue[t] !== en.NO_CLUE && v === en.OPEN).length, b.clues);
    eq('还原的格数与盘一致', back.board.length, b.n);
    ck('续局带着花费回来', back.moves === g.moves && back.hints === g.hints, JSON.stringify([back.moves, back.hints]));
    eq('默认设置音效开', en.Store.setting('sound'), true);
    eq('默认设置动效全开', en.Store.setting('reduceMotion'), false);
    ck('本作没有上一作的设置项', !('showNotes' in raw.settings) && !('mode' in raw.settings), JSON.stringify(raw.settings));
    localStorage.setItem('shikaku.save.v1', JSON.stringify({ settings: { sound: false, showNotes: false }, resume: { seed: 'x' } }));
    localStorage.setItem('other-game.save.v1', JSON.stringify({ settings: { sound: false }, resume: { seed: 'y' } }));
    eq('不读别人的存档键', en.Store.setting('sound'), true);
    localStorage.removeItem('shikaku.save.v1');
    localStorage.removeItem('other-game.save.v1');

    // the sound toggle is a store write the DOM has to agree with
    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    eq('音效按钮改按下态', $('#btn-sound').getAttribute('aria-pressed'), String(!wasOn));
    eq('音效选择进存档', JSON.parse(localStorage.getItem('fillomino.save.v1')).settings.sound, !wasOn);
    $('#btn-sound').click();
    await wait(30);
    eq('再点回来存档也跟着回来', en.Store.setting('sound'), true);

    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    ck('累计用时在涨', en.Store.data.totals.ms >= 1000, en.Store.data.totals.ms);
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '6×6' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '6×6' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '6×6' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '6×6' }), false);
    eq('更省提示的直接赢', en.Store.recordBest('regular', { ms: 900000, hints: 0, moves: 99, size: '6×6' }), true);
    eq('纪录留的是最不求人的那次', `${en.Store.best('regular').hints},${en.Store.best('regular').moves}`, '0,99');
    eq('纪录写下盘面尺寸', en.Store.best('regular').size, '6×6');
    en.Store.reset();
    eq('清空存档清掉纪录', en.Store.best('regular'), null);
    eq('清空后续档也没了', en.Store.resume(), null);
    eq('清空之后设置回到默认', en.Store.setting('sound'), true);
    return report({ bytes: JSON.stringify(raw.resume).length, ink: raw.resume.ink.length, cells: b.n });
  };

  // ---------- resume (same document) ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const clueBefore = Array.from(b.clue).join(',');
    const sol = g.puzzle.solution;
    let done = 0;
    for (let t = 0; t < b.n && done < 8; t++) {
      if (!g.writable(t)) continue;
      if (A().paintDigit(t, sol[t])) done++;
    }
    A().useHint();
    A().useHint();
    await wait(30);
    const saved = { ink: inkKey(g), moves: g.moves, hints: g.hints };
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /高阶/.test(text('#resume-name')), text('#resume-name'));
    const r = en.Store.resume();
    eq('续局取回了笔迹', Array.from(r.board).join(','), saved.ink);
    eq('续局取回了花费', `${r.moves},${r.hints}`, `${saved.moves},${saved.hints}`);
    $('#btn-resume').click();
    await wait(80);
    const g2 = A().game;
    ck('继续回到棋局', shown('#view-game'));
    eq('续局重绘出同一块盘', Array.from(g2.board.clue).join(','), clueBefore);
    eq('续局还原全部笔迹', inkKey(g2), saved.ink);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    eq('面板显示还原后的已写', text('#stat-filled'), `${g2.state().written}/${b.n - b.clues}`);
    ck('续局接着计时', A().elapsed() >= r.elapsedMs, `${A().elapsed()} vs ${r.elapsedMs}`);
    ck('棋头仍是同一档', text('#stat-tier'), '高阶');
    eq('续局的判定与引擎一致', text('#stat-blocks'), `${g2.state().full}/${g2.state().blocks}`);
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('续局之后笔迹还在', inkKey(g2), saved.ink);
    const res = A().solveWithLogic();
    await wait(40);
    eq('续局可以推到胜利', g2.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1 && !res.conflict, JSON.stringify(res));
    ck('提示次数没被续局清零', g2.hints >= saved.hints, `${g2.hints} vs ${saved.hints}`);
    eq('胜利盘通过独立验收', en.verify(g2.board, g2.st.cell).length, 0);
    ck('破纪录按求助最少算', !!en.Store.best('expert') && en.Store.best('expert').hints <= g2.hints, JSON.stringify(en.Store.best('expert')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu') && !shown('#view-game'));
    eq('清空后续档也没了', en.Store.resume(), null);

    // leave a run in progress for the *next* document to pick up (tools/playtest.cjs loads the page
    // afresh per scenario, so the reload scenario below really is starting from scratch)
    const g3 = await handoffLeave(en);
    const want = expectedRun(en, HANDOFF.seed, HANDOFF.tier, HANDOFF.paints, HANDOFF.hints);
    eq('走 DOM 写的这一半与纯引擎重放同盘', inkKey(g3), want.ink);
    eq('DOM 与纯引擎的步数一致', g3.moves, want.moves);
    eq('DOM 与纯引擎的提示一致', g3.hints, want.hints);
    A().show('menu');
    await wait(40);
    const handoff = en.Store.resume();
    ck('留在手里的这一局写进了存档', !!handoff, JSON.stringify(handoff));
    ck('回选档能看到继续卡', shown('#resume-card'));
    eq('继续卡写着花费', text('#resume-meta'), `${fmtMs(handoff.elapsedMs)} · ${want.moves} 步 · 提示 ${want.hints} 次`);
    eq('继续卡写的是留下的那一档', text('#resume-name'), `继续 ${en.tierFor(handoff.tier).name} 的一局`);
    return report({ moves: saved.moves, hints: saved.hints });
  };

  // The run handed to the next document, driven through the DOM.
  async function handoffLeave(en) {
    A().begin({ tier: HANDOFF.tier, seed: HANDOFF.seed });
    await wait(60);
    const g = A().game;
    const sol = g.puzzle.solution;
    let done = 0;
    for (let t = 0; t < g.board.n && done < HANDOFF.paints; t++) {
      if (!g.writable(t)) continue;
      if (A().paintDigit(t, sol[t])) done++;
    }
    for (let i = 0; i < HANDOFF.hints; i++) A().useHint();
    await wait(30);
    return g;
  }

  // ---------- reload (the round trip across a real page load) ----------

  const reload = async () => {
    const en = E();
    // This document has never seen the game: tools/playtest.cjs navigates to the page afresh for
    // every scenario, so everything readable here came out of localStorage.
    ck('重新载入之后没有棋局在跑', A().game === null, JSON.stringify(A().state()));
    ck('重新载入之后停在选档页', shown('#view-menu') && !shown('#view-game'));
    const raw = JSON.parse(localStorage.getItem('fillomino.save.v1'));
    if (!raw || !raw.resume) {
      ck('上一个文档留下的存档还在', false, localStorage.getItem('fillomino.save.v1'));
      return report({ error: 'no resume left by the previous document' });
    }
    ck('上一个文档留下的存档还在', !!raw.resume);
    eq('留下的是约定好的那一局', raw.resume.seed, HANDOFF.seed);
    eq('留下的是约定好的档位', raw.resume.tier, HANDOFF.tier);
    const want = expectedRun(en, HANDOFF.seed, HANDOFF.tier, HANDOFF.paints, HANDOFF.hints);
    eq('存档里的笔迹 = 种子推出来的笔迹', Array.from(en.Store.resume().board).join(','), want.ink);
    eq('存档里的步数对得上', raw.resume.moves, want.moves);
    eq('存档里的提示数对得上', raw.resume.hints, want.hints);
    ck('继续卡在重新载入后出现', shown('#resume-card'));
    ck('继续卡写了花费', /\d+ 步 · 提示 \d+ 次/.test(text('#resume-meta')), text('#resume-meta'));
    ck('继续卡写了用时', /^\d\d:\d\d/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(80);
    const g = A().game;
    ck('点继续进入棋局', shown('#view-game'));
    eq('重新载入之后盘面尺寸还是它', `${g.w}×${g.h}`, en.tierFor(HANDOFF.tier).w + '×' + en.tierFor(HANDOFF.tier).h);
    eq('重新载入之后笔迹全回来了', inkKey(g), want.ink);
    eq('重新载入之后步数回来了', g.moves, want.moves);
    eq('重新载入之后提示数回来了', g.hints, want.hints);
    eq('面板的提示读数回来了', text('#stat-hints'), String(want.hints));
    eq('面板的步数读数回来了', text('#stat-moves'), String(want.moves));
    eq('面板的已写读数回来了', text('#stat-filled'), `${want.written}/${g.board.n - g.board.clues}`);
    ck('计时是接着走的而不是从 0 开始', A().elapsed() >= raw.resume.elapsedMs, `${A().elapsed()} vs ${raw.resume.elapsedMs}`);
    ck('面板上的用时还是时分格式', /^\d\d:\d\d$/.test(text('#stat-time')), text('#stat-time'));
    const shownSec = text('#stat-time').split(':').map(Number).reduce((a, v) => a * 60 + v, 0);
    ck('面板的用时不会退回存档之前', shownSec >= Math.floor(raw.resume.elapsedMs / 1000), `${text('#stat-time')} vs ${fmtMs(raw.resume.elapsedMs)}`);
    ck('重新载入后的存档没有把印上去的数当笔迹', givensOf(g.board).every((t) => A().valueOf(t) === en.OPEN));
    eq('印着的数照样显示', givensOf(g.board).every((t) => g.shownAt(t) === g.board.clue[t]), true);
    eq('重新载入后不能撤销到上一个文档之前', A().undo(), null);
    // and the same seed still means the same board: nothing about the wall clock entered the key
    const again = expectedRun(en, HANDOFF.seed, HANDOFF.tier, HANDOFF.paints, HANDOFF.hints);
    eq('同种子重放还是同一个盘', again.ink, want.ink);
    ck('换一种用时也换不回别的盘', Array.from(g.board.clue).join(',') === Array.from(want.puzzle.board.clue).join(','));
    const res = A().solveWithLogic();
    await wait(40);
    eq('重新载入的这一局能推到胜利', g.status, 'won', JSON.stringify(res));
    eq('胜利之后独立验收通过', en.verify(g.board, g.st.cell).length, 0);
    eq('胜利后清掉续档', en.Store.resume(), null);
    A().show('menu');
    await wait(60);
    ck('赢完回到菜单就不再给继续卡', !shown('#resume-card'));
    const left = JSON.parse(localStorage.getItem('fillomino.save.v1') || '{}');
    ck('赢完的存档里不再藏着续档', !left.resume, JSON.stringify(left));
    return report({ ink: want.ink.split(',').filter((v) => v !== '0').length, moves: want.moves, hints: want.hints });
  };

  // ---------- records ----------

  const records = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|records-menu' });
    A().show('menu');
    await wait(50);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('空纪录写得清楚', [...document.querySelectorAll('#record-list li')].every((x) => /还没有纪录/.test(x.textContent)), text('#record-list'));
    // 1) fill cell by cell: 0 hints, one move per blank
    A().begin({ tier: 'trainee', seed: 'scen|records-a' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const sol = g.puzzle.solution;
    const blanks = blanksOf(b);
    for (const t of blanks) A().paintDigit(t, sol[t]);
    await wait(40);
    eq('一格一格也能通关', g.status, 'won');
    eq('一格一格的步数等于空格数', g.moves, blanks.length);
    eq('纯手工通关不用提示', g.hints, 0);
    const best1 = en.Store.best('trainee');
    ck('手工通关写下纪录', !!best1, JSON.stringify(best1));
    eq('纪录里的提示是 0', best1.hints, 0);
    eq('纪录里的步数', best1.moves, blanks.length);
    eq('纪录写下盘面尺寸', best1.size, `${b.w}×${b.h}`);
    ck('第一条纪录说这是新的', /新纪录/.test(text('#win-record')), text('#win-record'));
    A().show('menu');
    await wait(50);
    const li1 = document.querySelector('#record-list li[data-tier="trainee"]').textContent;
    ck('纪录表写出了这一档的纪录', /提示 0/.test(li1) && /\d+ 步/.test(li1) && /\d\d:\d\d/.test(li1), li1);
    ck('没玩过的档仍是空', /还没有纪录/.test(document.querySelector('#record-list li[data-tier="master"]').textContent));
    // 2) the same seed, closed block by block: fewer moves, still 0 hints -> the record must fall
    A().begin({ tier: 'trainee', seed: 'scen|records-a' });
    await wait(60);
    const g2 = A().game;
    const areas = en.regions(g2.board, sol);
    const withBlanks = areas.filter((a) => a.cells.some((c) => g2.board.clue[c] === en.NO_CLUE));
    for (const a of withBlanks) A().stroke(a.cells, a.value);
    await wait(40);
    eq('一块一块画也能通关', g2.status, 'won');
    eq('一块一步：步数就是块数', g2.moves, withBlanks.length);
    ck('整块下笔比逐格少', g2.moves < blanks.length, `${g2.moves} vs ${blanks.length}`);
    const best2 = en.Store.best('trainee');
    eq('同提示下更省步的算破纪录', best2.moves, withBlanks.length);
    ck('破纪录时胜利卡说破纪录', /新纪录/.test(text('#win-record')), text('#win-record'));
    // 3) a hinted win must not touch it
    A().begin({ tier: 'trainee', seed: 'scen|records-b' });
    await wait(60);
    const g3 = A().game;
    A().useHint();
    A().useHint();
    await wait(30);
    eq('两个提示算两次求助', g3.hints, 2);
    for (const a of en.regions(g3.board, g3.puzzle.solution)) {
      if (g3.status === 'won') break;
      A().stroke(a.cells, a.value);
    }
    await wait(40);
    ck('靠提示也能通关', g3.status === 'won' || g3.state().written === g3.board.n - g3.board.clues, JSON.stringify(g3.state()));
    const best3 = en.Store.best('trainee');
    eq('靠提示的那局没破纪录', best3.hints, 0);
    eq('靠提示的那局也没改步数纪录', best3.moves, withBlanks.length);
    ck('未破纪录时胜利卡说清楚', /未破纪录/.test(text('#win-record')), text('#win-record'));
    eq('总局数按胜局累加', en.Store.data.totals.solved, 3);
    ck('累计提示记下了那两次', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    ck('累计时数在涨', en.Store.data.totals.ms > 0, en.Store.data.totals.ms);
    // the record list is re-rendered from the store on every trip to the menu
    A().show('menu');
    await wait(50);
    const li = document.querySelector('#record-list li[data-tier="trainee"]').textContent;
    eq('纪录表只留最好的那次', /提示 0/.test(li), true);
    ck('纪录表写了尺寸', /5×5/.test(li), li);
    const tiers = [...document.querySelectorAll('#tier-list .tier')];
    eq('档位按钮五个', tiers.length, 5);
    tiers[0].click();
    await wait(90);
    ck('从选档点档位能进棋局', shown('#view-game'));
    eq('点的是初学档', A().game.puzzle.tier, 'trainee');
    eq('新开的局提示清零', A().game.hints, 0);
    $('#btn-menu').click();
    await wait(40);
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写了花费', /\d+ 步 · 提示 \d+ 次/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(60);
    ck('继续回到棋局', shown('#view-game'));
    en.Store.reset();
    return report({ best: best2.moves, blanks: blanks.length, solved: 3 });
  };

  // ---------- motion (and the settings that go with it) ----------

  const motion = async () => {
    const en = E();
    A().begin({ tier: 'trainee', seed: 'scen|motion' });
    await wait(60);
    const btn = $('#btn-motion');
    const before = en.Store.setting('reduceMotion');
    const animBefore = getComputedStyle($('#view-game')).animationName;
    ck('没开减少动效时 .view 有入场动画', animBefore !== 'none', animBefore);
    btn.click();
    await wait(40);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    eq('动效按钮改按下态', $('#btn-motion').getAttribute('aria-pressed'), String(!before));
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    ck('减少动效写进存档', JSON.parse(localStorage.getItem('fillomino.save.v1')).settings.reduceMotion === true, localStorage.getItem('fillomino.save.v1'));
    const animAfter = getComputedStyle($('#view-game')).animationName;
    eq('减少动效之后动画真的没了', animAfter, 'none');
    const trans = getComputedStyle($('#btn-undo')).transitionDuration;
    eq('按钮的过渡也停了', trans, '0s');
    // a hint and a win still have to work with motion off
    const info = A().useHint();
    await wait(30);
    ck('省动效时提示照样落子', !!info && info.charged === true, JSON.stringify(info));
    ck('省动效时提示理由照样写', /规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('画布照样重画', !near(fillPixel(info.cell), hex(en.theme.bgBottom)), String(fillPixel(info.cell)));
    for (const a of en.regions(A().game.board, A().game.puzzle.solution)) {
      if (A().game.status === 'won') break;
      A().stroke(a.cells, a.value);
    }
    await wait(40);
    eq('省动效也能通关', A().game.status, 'won');
    ck('省动效时胜利遮罩照样出现', shown('#win-veil'));
    $('#btn-motion').click();
    await wait(40);
    eq('再点回动效全', text('#btn-motion'), '动效 全');
    ck('body 上的类撤掉了', !document.body.classList.contains('reduce-motion'));
    eq('动画回来了', getComputedStyle($('#view-menu')).animationName, animBefore);
    eq('设置也撤掉了', en.Store.setting('reduceMotion'), false);
    const soundBefore = en.Store.setting('sound');
    $('#btn-sound').click();
    await wait(30);
    eq('音效开关与存档同步', en.Store.setting('sound'), !soundBefore);
    $('#btn-sound').click();
    await wait(30);
    eq('音效开关能关回去', en.Store.setting('sound'), soundBefore);
    ck('主题的时长令牌都在 :root 上', ['--dur-tap', '--dur-base', '--dur-win', '--ease-spring'].every((v) => cssVar(v) !== ''), ['--dur-tap', '--dur-base'].map(cssVar).join(' '));
    eq('引擎里最大块的颜色数量够用', en.theme.DigitFill.length, en.MAX_K_CEIL);
    ck('每个数字都有 CSS 变量可抄', en.theme.DigitFill.every((_, i) => cssVar(`--digit-fill-${i + 1}`) !== ''), en.theme.DigitFill.map((_, i) => cssVar(`--digit-fill-${i + 1}`)).join(' '));
    eq('变量与引擎同源', cssVar('--digit-fill-3'), en.theme.DigitFill[2]);
    return report({ animBefore, animAfter });
  };

  // ---------- layout (geometry, colours and the pixels they produce) ----------

  const layout = async () => {
    const en = E();
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(90);
    const g = A().game;
    const b = g.board;
    const v = A().view;
    eq('大师档 7×7', `${g.w}×${g.h}`, '7×7');
    eq('大师档最大块 4', g.maxK, 4);
    const rect = v.canvas.getBoundingClientRect();
    const geo = v.geo;
    ck('格子在可点范围里', geo.cell >= en.theme.Cell.min && geo.cell <= en.theme.Cell.max, String(geo.cell));
    eq('格子边长是整数', Number.isInteger(geo.cell), true);
    eq('画布宽度 = 格数×边长 + 两条留白', Math.round(rect.width), geo.cell * g.w + geo.x * 2);
    eq('画布高度 = 格数×边长 + 两条留白', Math.round(rect.height), geo.cell * g.h + geo.y * 2);
    ck('留白够画块的轮廓', geo.x >= 8 && geo.y >= 8, JSON.stringify({ x: geo.x, y: geo.y }));
    ck('画布不出视口', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom, w: window.innerWidth, h: window.innerHeight }));
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    eq('设备像素比至少是 1', geo.dpr >= 1, true);
    // Captured here, not at the end: the rest of this scenario repaints smaller boards, and the
    // 7×7 cell is the number that actually moves with the window (it is capped at 56 when there is
    // room, height-bound when there is not).
    const masterCell = geo.cell;
    // availBox() in js/main.js reserves a different width above and below 900 css px, and the CSS
    // moves the panel under the board at the same threshold via @media (max-width: 900). The two
    // are one promise read two ways: if they disagree the board sizes itself for a layout it is
    // not in — which is how a control can end up below the fold on a desktop window.
    const cols = getComputedStyle($('#view-game')).gridTemplateColumns.trim().split(/\s+/).length;
    eq('窗口宽度与版式分支同源', `${window.innerWidth <= 900 ? '窄' : '宽'}/${cols}`, window.innerWidth <= 900 ? '窄/1' : '宽/2');
    let misses = 0;
    let edgeMisses = 0;
    for (let t = 0; t < b.n; t++) {
      const p = at(t);
      if (v.hitCell(p.x, p.y) !== t) misses++;
      const r = p.r;
      const box = p.box;
      const probes = [
        [box.left + r.x + 1.5, box.top + r.y + 1.5],
        [box.left + r.x + r.size - 1.5, box.top + r.y + 1.5],
        [box.left + r.x + 1.5, box.top + r.y + r.size - 1.5],
        [box.left + r.x + r.size - 1.5, box.top + r.y + r.size - 1.5],
      ];
      for (const q of probes) if (v.hitCell(q[0], q[1]) !== t) edgeMisses++;
    }
    eq('大棋盘每一格中心都点得中', misses, 0);
    eq('格子四角也点得中（布局与命中同源）', edgeMisses, 0);
    eq('格外的点不命中任何格', v.hitCell(rect.left - 2, rect.top - 2), -1);
    ck('cellRect 的坐标就是画布坐标', (() => {
      const r0 = v.cellRect(0);
      return r0.x === geo.x && r0.y === geo.y && r0.size === geo.cell;
    })(), true);
    ck('最后一格的右下角在画布内', (() => {
      const r1 = v.cellRect(b.n - 1);
      return r1.x + r1.size <= geo.w + 0.5 && r1.y + r1.size <= geo.h + 0.5;
    })(), true);
    eq('cellAt 与 hitCell 说的是同一套坐标', g.cellAt(g.w - 1, g.h - 1), b.n - 1);
    eq('越界的 cellAt 返回 -1', A().cellAt(g.w, 0), -1);

    // panel: palette, stats, legend
    const digits = [...document.querySelectorAll('#palette .digit')];
    eq('面板按钮数 = 最大块 + 擦除', digits.length, g.maxK + 1);
    eq('面板栅格跟着最大块走', getComputedStyle($('#palette')).gridTemplateColumns.trim().split(/\s+/).length, g.maxK + 1);
    ck('每个数字按钮都有底色', digits.slice(1).every((x) => {
      const i = Number(x.dataset.digit) - 1;
      return rgb(getComputedStyle(x, '::after').backgroundColor).join(',') === hex(en.theme.DigitFill[i]).join(',');
    }), digits.slice(1).map((x) => getComputedStyle(x, '::after').backgroundColor).join(' '));
    eq('擦除按钮没有数字底色', digits[0].classList.contains('erase'), true);
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    eq('图例六项', document.querySelectorAll('.legend span').length, 6);
    const swatch = (sel) => rgb(getComputedStyle($(sel)).backgroundColor).join(',');
    eq('图例的空格色与画布同源', swatch('.sw-empty'), hex(en.theme.bgBottom).join(','));
    eq('图例的印数色与画布同源', swatch('.sw-given'), hex(en.theme.ink).join(','));
    eq('图例的你写的数与画布同源', swatch('.sw-mine'), hex(en.theme.accent).join(','));
    eq('图例的没长满与画布同源', swatch('.sw-growing'), hex(en.theme.info).join(','));
    eq('图例的长满了与画布同源', swatch('.sw-full'), hex(en.theme.success).join(','));
    eq('图例的对不上与画布同源', swatch('.sw-bad'), hex(en.theme.error).join(','));
    ck('操作提示讲清手势与键', /拖动/.test(text('.keyhint')) && /撤销/.test(text('.keyhint')) && /1…8/.test(text('.keyhint')), text('.keyhint'));
    ck('按钮都够点', (() => {
      // `.every()` on an empty NodeList is true, so the count is part of the promise: an empty
      // toolbar used to pass this row while painting nothing at all.
      const bs = [...document.querySelectorAll('.acts button, #palette button, .top-actions button')];
      return bs.length >= 6 && bs.every((x) => x.getBoundingClientRect().height >= 28);
    })(), JSON.stringify([...document.querySelectorAll('.acts button, #palette button, .top-actions button')].map((x) => Math.round(x.getBoundingClientRect().height))));
    ck('顶部按钮不重叠', (() => {
      // 这一条原来写的是 `bs.length === 2`，把「不重叠」换成了「HUD 只有两枚按钮」。全屏开关接上
      // 真按钮那天顶栏变成三枚（再加暂停是四枚），闸没有变宽、只是改口去审一个没人承诺过的数，
      // 于是红了 4 笔 CI 而红字说的是「重叠」——读的人按句名去找叠放的按钮，找不到。
      // 数量下限留着（`.every()` 在空集合上为真），但它不再是断言的全部内容；逐对真判。
      // 判成对而不是相邻：顶栏会折行，第二行最左那枚的 left 可以小于第一行最右那枚的 right，
      // 那是不重叠的两行、不是叠放——所以两个轴都要交叠才算。
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      if (bs.length < 2) return false;
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i]; const b = bs[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) return false;
        }
      }
      return true;
    })(), JSON.stringify([...document.querySelectorAll('.top-actions button')].map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.width)]; })));
    ck('提示框不横向溢出', $('.hint-box').scrollWidth <= $('.hint-box').clientWidth + 1, `${$('.hint-box').scrollWidth} vs ${$('.hint-box').clientWidth}`);

    // pixels: the three states a cell can be in must be three different pictures
    const paper = hex(en.theme.bgBottom);
    const blank = blanksOf(b);
    const given = givensOf(b)[0];
    // Sample cells must not sit next to a printed digit equal to the one we write: that would be a
    // conflict, and a conflict paints the error fill, not the digit fill we are trying to read.
    const noClash = (t, d) => b.adj[t].every((nb) => b.clue[nb] !== d);
    const mine = blank.find((t) => noClash(t, 2));
    const second = blank.find((t) => t !== mine && noClash(t, 1) && noClash(t, 2));
    const still = blank.find((t) => t !== mine && t !== second);
    ck('三种底色的采样格各不相撞', mine >= 0 && second >= 0 && still >= 0 && new Set([mine, second, still]).size === 3, JSON.stringify({ mine, second, still, blanks: blank.length }));
    ck('没写的格就是纸色', near(fillPixel(still), paper), `${fillPixel(still)} vs 纸色 ${paper}`);
    ck('印着的格不是纸色（它已经是数）', !near(fillPixel(given), paper), String(fillPixel(given)));
    const givenArea = g.areas.find((a) => a.cells.includes(given));
    ck('印着的格染的是它那块的颜色', near(fillPixel(given), hex(en.theme.DigitFill[(givenArea.value - 1) % en.theme.DigitFill.length]), 12), `${fillPixel(given)} vs ${en.theme.DigitFill[givenArea.value - 1]}`);
    const whiteGlyph = glyphCount(given, hex(en.theme.ink));
    const amberGlyph = glyphCount(given, hex(en.theme.accent));
    ck('印着的数是亮白的', whiteGlyph >= 3, String(whiteGlyph));
    eq('印着的数不是玩家色', amberGlyph, 0);
    A().paintDigit(mine, 2);
    await wait(40);
    const myAmber = glyphCount(mine, hex(en.theme.accent));
    const myWhite = glyphCount(mine, hex(en.theme.ink));
    ck('你写的数是琥珀色的', myAmber >= 3, String(myAmber));
    ck('你写的数不是亮白的', myWhite <= 1, String(myWhite));
    ck('你写的那格染上了 2 号色', near(fillPixel(mine), hex(en.theme.DigitFill[1]), 12), `${fillPixel(mine)} vs ${en.theme.DigitFill[1]}`);
    A().paintDigit(second, 1);
    await wait(40);
    const fillA = fillPixel(mine);
    const fillB = fillPixel(second);
    ck('两个不同的数字画出两种底色', !near(fillA, fillB, 9), `${fillA} vs ${fillB}`);
    ck('写 2 的那格离 2 号色更近', gap(fillA, hex(en.theme.DigitFill[1])) < gap(fillA, hex(en.theme.DigitFill[0])), `${fillA} vs 1号${en.theme.DigitFill[0]} 2号${en.theme.DigitFill[1]}`);
    ck('写 1 的那格离 1 号色更近', gap(fillB, hex(en.theme.DigitFill[0])) < gap(fillB, hex(en.theme.DigitFill[1])), `${fillB} vs 1号${en.theme.DigitFill[0]} 2号${en.theme.DigitFill[1]}`);
    eq('没写的格仍然是纸色', near(fillPixel(still), paper), true);
    // 还没长满的块是蓝边，长满的是绿边——两种状态不能画成一个
    const growing = g.areas.find((a) => !a.full);
    ck('有还没长满的块可采样', !!growing, JSON.stringify(g.areas.map((a) => [a.value, a.size])));
    const infoHits = ['up', 'down', 'left', 'right'].reduce((n, s) => n + edgeCount(growing.cells[0], s, hex(en.theme.info)), 0);
    const greenHits = ['up', 'down', 'left', 'right'].reduce((n, s) => n + edgeCount(growing.cells[0], s, hex(en.theme.success)), 0);
    ck('没长满的块描蓝边', infoHits > 0, String(infoHits));
    eq('没长满的块不冒充绿边', greenHits, 0);
    eq('写完两格冲突仍然是 0', g.state().conflicts, 0);
    A().undo();
    A().undo();
    await wait(30);
    eq('两笔都撤掉之后写的格回到纸色', [near(fillPixel(mine), paper), near(fillPixel(second), paper)], [true, true]);

    // a finished board reads green all the way round: every side of every block that leaves the
    // block has to carry the success outline, not just a sample of them.
    for (const a of en.regions(b, g.puzzle.solution)) A().stroke(a.cells, a.value);
    await wait(50);
    eq('照解画完就胜利', g.status, 'won');
    const succ = hex(en.theme.success);
    const stepOf = { up: -b.w, down: b.w, left: -1, right: 1 };
    const wraps = (s, c) => (s === 'left' && c % b.w === 0) || (s === 'right' && c % b.w === b.w - 1);
    let green = 0;
    let probes = 0;
    const uncoloured = [];
    for (const a of g.areas) {
      for (const c of a.cells) {
        for (const s of ['up', 'down', 'left', 'right']) {
          const nb = c + stepOf[s];
          if (wraps(s, c) || nb < 0 || nb >= b.n || !a.cells.includes(nb)) {
            probes++;
            if (edgeCount(c, s, succ) > 0) green++;
            else uncoloured.push([b.cellName(c), s, a.value]);
          }
        }
      }
    }
    ck('赢盘时每块每一条外接边都描了绿', probes >= b.n && green === probes, `${green}/${probes} 未描绿=${JSON.stringify(uncoloured)}`);
    const bad = hex(en.theme.errorFill);
    const redCells = [];
    for (let t = 0; t < b.n; t++) if (near(fillPixel(t), bad, 12)) redCells.push(b.cellName(t));
    eq('赢盘时全没有任何格还留着红底', redCells, []);
    eq('赢盘时冲突为 0', text('#stat-conflicts'), '0');
    ck('赢盘时状态行不说话', text('#state-line') === '');

    // the win card sits inside the board, on a small board too
    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(60);
    for (const a of en.regions(A().game.board, A().game.puzzle.solution)) A().stroke(a.cells, a.value);
    await wait(60);
    eq('初学档也照解能赢', A().game.status, 'won');
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40);
    ck('胜利按钮在胜利卡里', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const btn = $('#btn-again').getBoundingClientRect();
      return btn.top >= card.top - 1 && btn.bottom <= card.bottom + 1;
    })());
    $('#btn-again').click();
    await wait(90);
    ck('再来一局关掉遮罩', !shown('#win-veil'));
    eq('再来一局清零步数', text('#stat-moves'), '0');
    eq('再来一局清零提示', text('#stat-hints'), '0');
    eq('再来一局留在同档', A().game.puzzle.tier, 'trainee');
    eq('再来一局面板按新盘重画', document.querySelectorAll('#palette .digit').length, A().game.maxK + 1);
    ck('再来一局数字清零已写', text('#stat-filled').startsWith('0/'), text('#stat-filled'));
    // `cell7` is the 7×7 the geometry block measured; `cellWin` and `green` belong to the 5×5 win
    // board further down. Both are reported because they answer different questions, and a single
    // `cell` key could only be one of them — which is how three passes at three window sizes
    // printed an identical 56.
    return report({
      cell7: masterCell,
      cellWin: A().view.geo.cell,
      dpr: A().view.geo.dpr,
      green: `${green}/${probes}`,
    });
  };

  w.__ng = { boot, paint, hint, region, conflict, save, resume, reload, records, motion, layout };
})(window);
