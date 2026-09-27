// Engine self-test for Fillomino / 埋方块 — plain Node, no framework, no DOM:
//   node tools/engine-test.mjs
//
// Every expectation below is hand-derived from a board worked out on paper and written as a
// LITERAL; the only exceptions are the generated-board sections, which cannot be written down and
// are therefore only asserted against *other* things (the acceptance test, the independent
// counter, the measured bands). The rule this file exists to enforce: 埋方块's rulebook is one
// sentence — 每一块相连的同数区域，格数刚好等于它写着的那个数 — so if a number and the cells
// carrying it stop agreeing, something here must go red.

import {
  OPEN, ONE, TWO, THREE, FOUR, FIVE, SIX, NO_CLUE, MAX_K_CEIL,
  createBoard, cluesFrom, Rules, propagate, solve, nextDeduction, withClues, regions,
  verify, complete, diagnose, reachable,
  createState, snapshot, undo, setCell, eraseCell, resetInk,
} from '../js/engine/fillomino.js';
import { countSolutions, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { mix, TIERS, tierFor, generate, makePuzzle } from '../js/engine/generate.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; return true; }
  fail++;
  console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  return false;
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  fail++;
  console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`);
  return false;
};
const throws = (fn) => {
  try { fn(); return null; } catch (e) { return e.message; }
};
const key = (a) => Array.from(a).join(',');
const join = (a) => Array.from(a).join('');

// ---------- 状态常量：空、能写的数、没印数字 ----------
eq('OPEN 是 0（笔迹的「没落子」）', OPEN, 0);
eq('数字从 1 开始', ONE, 1);
eq('SIX 是 6', SIX, 6);
eq('NO_CLUE 是 -1，和笔迹的空格两个轴', NO_CLUE, -1);
eq('最大块的上限', MAX_K_CEIL, 8);
ok('能写的数全是正整数（NO_CLUE 不在其中）', [ONE, TWO, THREE, FOUR, FIVE, SIX].every((v) => Number.isInteger(v) && v >= ONE) && ![ONE, TWO, THREE, FOUR, FIVE, SIX].includes(NO_CLUE), '');
eq('NO_CLUE 不等于 OPEN', NO_CLUE === OPEN, false);

// ---------- 几何 ----------
// 5×5 全盘线索：一张手搓的合法答案 —— 第 1、3 行各是一条 5 和四个 4，第 2、4 行各是三个 3 加两个 2。
// 数一下就知道每一块都正好写着自己的格数，同数的两块之间永远隔着另一行。
const SOL5 = [5, 5, 5, 5, 5, 1, 4, 4, 4, 4, 3, 3, 3, 2, 2, 1, 4, 4, 4, 4, 3, 3, 3, 2, 2];
const b5 = createBoard({ w: 5, h: 5, maxK: 5, clue: Int8Array.from(SOL5) });
eq('5×5 有 25 格', b5.n, 25);
eq('5×5 角上两邻', key(b5.adj[0]), '5,1');
eq('5×5 正中有四邻', key(b5.adj[12]), '7,17,11,13');
eq('5×5 对角两邻', key(b5.adj[24]), '19,23');
eq('全线索盘的 blankAt 永远是 false', b5.blankAt(0), false);
eq('全线索盘线索数', b5.clues, 25);
eq('cluesFrom 把这张答案原样吐出来', join(cluesFrom(5, 5, Int8Array.from(SOL5))), join(SOL5));
// 4×3 只印一行半：第 1 行四个 4（一整行就是一块），第 2 行三个 3 加一个 1。
const b43 = createBoard({ w: 4, h: 3, clue: Int8Array.from([4, 4, 4, 4, 3, 3, 3, 1, 4, 4, 4, 4]) });
eq('4×3 调色板是 1..6（最大块默认 6）', key(b43.kinds), '1,2,3,4,5,6');
eq('4×3 默认最大块', b43.maxK, SIX);
eq('4×3 线索原样', key(b43.clue), '4,4,4,4,3,3,3,1,4,4,4,4');
// 2×4 只在第2行第2列印一个 1，坐标写法要按「行/列」拆开
const b24 = createBoard({ w: 2, h: 4, maxK: 4, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, 1, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE]) });
eq('第4行2列的编号是 7', b24.cellName(7), '第4行2列');
eq('第1行1列的编号是 0', b24.cellName(0), '第1行1列');
eq('没印数字的格子 blankAt 为真', b24.blankAt(2), true);
eq('印了数字的格子 blankAt 为假', b24.blankAt(3), false);
eq('只印一个数字也算盘', b24.clues, 1);

// ---------- -1 和 0 是两件事：一条轴少了另一条轴的账 ----------
// 事故记录：有个游戏把「作者没印数字」(-1) 当成了「玩家还没写」(0)，于是每一颗 0 线索都被悄悄
// 抹掉，测试全绿。这里的对策是把两条轴同时摊在桌面上数一遍：印了几颗、没印几格、笔迹写了几格。
const blankCells = [...Array(8).keys()].filter((t) => b24.blankAt(t));
eq('2×4 上没印的是 7 格', key(blankCells), '0,1,2,4,5,6,7');
eq('2×4 上印了的是 1 颗', b24.clues, 1);
eq('调色板里既没有 0 也没有 -1（能写的数才是这些）', b24.kinds.every((v) => v !== OPEN && v !== NO_CLUE), true);
eq('没印的地方合并完还是没印', key(withClues(b24, new Int8Array(8))), '0,0,0,1,0,0,0,0');
eq('印着的地方空笔迹也带着数', withClues(b24, new Int8Array(8))[3], 1);
eq('空笔迹下「填了」只算印着的那一格', diagnose(b24, new Int8Array(8)).filled, 1);
eq('空笔迹下剩的格数＝没印的格数', diagnose(b24, new Int8Array(8)).remaining, 7);
eq('空笔迹下区域只有那块 1', regions(b24, new Int8Array(8)).map((g) => `${g.value}@${key(g.cells)}`).join(','), '1@3');
eq('诊断报的线索数读的是盘，不是笔迹', diagnose(b24, Int8Array.from([0, 0, 0, 1, 0, 0, 0, 0])).clues, 1);
// 反方向的事故：把一份带 0 的答案当成线索集递进来，必须当场拒绝，不能「抹掉那一颗继续」
eq('带 0 的答案推不出线索（0 会被读成没落子）',
  throws(() => cluesFrom(2, 4, Int8Array.from([2, 2, 0, 0, 1, 1, 2, 2]))),
  '第2行1列 没有落子，推不出数字');
// 整张答案原样印回去：一颗数字都不会在路上丢掉
{
  // 手搓的 3×3 答案：上排一块 2 加一颗 1，中排一整行 3，下排一颗 1 加一块 2。
  // 两块 1 在第 3 格和第 7 格（不相邻），两块 2 各占一行的一头（也不相邻），数一下就知道每块都写着自己的格数。
  const sol = Int8Array.from([2, 2, 1, 3, 3, 3, 1, 2, 2]);
  const cl = cluesFrom(3, 3, sol);
  const full = createBoard({ w: 3, h: 3, maxK: 3, clue: cl });
  eq('3×3 答案原样变线索', key(cl), key(sol));
  eq('印上去一颗都没丢', full.clues, 9);
  eq('印上去之后空笔迹就已经是满盘', key(withClues(full, new Int8Array(9))), key(sol));
  eq('印满的盘直接算通关', complete(full, new Int8Array(9)), true);
  eq('印满的盘是 5 块', regions(full, new Int8Array(9)).length, 5);
}

// ---------- 给出的数字必须是可能的：每一条中文报错都手推到 ----------
eq('最大块超过格子数被拒',
  throws(() => createBoard({ w: 2, h: 2, maxK: 5, clue: Int8Array.from([1, 2, 2, 1]) })),
  '最大块上限写成 5，它只能是 1 到 4 之间的整数');
eq('最大块超过引擎天花板被拒',
  throws(() => createBoard({ w: 4, h: 3, maxK: 9, clue: Int8Array.from([1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2]) })),
  `最大块上限写成 9，它只能是 1 到 ${MAX_K_CEIL} 之间的整数`);
eq('最大块为 0 被拒',
  throws(() => createBoard({ w: 4, h: 3, maxK: 0, clue: Int8Array.from([1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2]) })),
  '最大块上限写成 0，它只能是 1 到 8 之间的整数');
eq('印一个比最大块还大的数被拒',
  throws(() => createBoard({ w: 4, h: 3, clue: Int8Array.from([7, 1, 2, 1, 2, 1, 2, 1, 1, 2, 1, 2]) })),
  '第1行1列 写着 7，可这盘最大一块只有 6 格');
eq('印 0 被拒（0 是笔迹不是数字）',
  throws(() => createBoard({ w: 4, h: 3, clue: Int8Array.from([1, 2, 0, 1, 2, 1, 2, 1, 1, 2, 1, 2]) })),
  '第1行3列 写着 0：0 是「还没落子」，不是一个能占格子的数');
eq('负数（除了 NO_CLUE）被拒',
  throws(() => createBoard({ w: 4, h: 3, clue: Int8Array.from([1, 2, -2, 1, 2, 1, 2, 1, 1, 2, 1, 2]) })),
  '第1行3列 写着 -2，给出的数字必须是正整数');
// 一行三个格：第2、3列印了两个 1。两个 1 上下相邻就是同一块，可那块只容得下 1 格。
eq('连成一片的 1 超数被拒',
  throws(() => createBoard({ w: 3, h: 1, maxK: 3, clue: Int8Array.from([NO_CLUE, 1, 1]) })),
  '第1行2列 一带有 2 个连成一片的 1，可它那块只容得下 1 格');
// 一行三个格：第2列印 2、第3列印 3。3 那格左边被 2 堵死，右边没路，一圈最多圈到 1 格。
eq('圈不满自己数字的线索被拒',
  throws(() => createBoard({ w: 3, h: 1, maxK: 3, clue: Int8Array.from([NO_CLUE, 2, 3]) })),
  '第1行3列 写着 3，可它最多只能圈出 1 格，凑不满 3');
eq('线索长度对不上被拒', throws(() => createBoard({ w: 3, h: 1, clue: Int8Array.from([1, 2]) })), 'clue length mismatch');
eq('零尺寸的盘被拒', throws(() => createBoard({ w: 0, h: 3, clue: new Int8Array(0) })), 'board too small');
eq('一个数字都没印的盘被拒', throws(() => createBoard({ w: 4, h: 3, clue: new Int8Array(12).fill(NO_CLUE) })), '盘上没有数字');
// cluesFrom 也一样不许一份对不上数的答案冒充线索
eq('答案里连成三片的 1 推不出线索',
  throws(() => cluesFrom(3, 1, Int8Array.from([1, 1, 1]))),
  '第1行1列 那块写着 1，实际连成 3 格，对不上');
eq('没落子的答案推不出线索',
  throws(() => cluesFrom(3, 1, Int8Array.from([0, 1, 2]))),
  '第1行1列 没有落子，推不出数字');

// ---------- 每条规则都得说点能做的 ----------
// 规则表：四条，权重是「玩家自己想到这一步要多少脑子」。
eq('规则条数', Object.keys(Rules).length, 4);
eq('规则名', Object.values(Rules).map((r) => r.name).join(','), '刚好长满,必经之格,邻区已满,只剩一个数');
ok('权重都是正数', Object.values(Rules).every((r) => r.weight > 0 && r.weight <= 3), '');

// 刚好长满：一行三格，最右印一个 3。它左边全空，够得着的地方连自己数过来正好 3 格 → 整行都得是 3。
const growB = createBoard({ w: 3, h: 1, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, THREE]) });
const growInk = new Int8Array(3);
growInk[2] = 3;
const growSweep = propagate(growB, growInk);
eq('刚好长满：一次扫出两格', growSweep.found.length, 2);
eq('刚好长满：先写第1行2列', growSweep.found[0].cell, 1);
eq('刚好长满：写的数是 3', growSweep.found[0].value, 3);
eq('刚好长满：理由是那块的第 2 格', growSweep.found[0].root, 2);
eq('刚好长满：够得着 3 格', growSweep.found[0].room, 3);
eq('刚好长满：changed', growSweep.changed, true);
const growSolve = solve(growB);
eq('刚好长满：推到底', key(growSolve.derived), '3,3,3');
eq('刚好长满：两步', growSolve.steps, 2);
eq('刚好长满：分数 = 2×2', growSolve.score, 4);
eq('刚好长满：明细', JSON.stringify(growSolve.breakdown), JSON.stringify({ 刚好长满: 2 }));
eq('刚好长满的话术点名两格', growSolve.rows[0].rule.text(growB, growSolve.rows[0]),
  '第1行2列 得写成 3：第1行3列 那块要凑满 3 格，而它够得着的地方连自己数过来刚好 3 格，一步都让不了');

// 必经之格：3×2。第2行第2列印 1、第2行第3列印 2。那个 2 的四邻里只有第1行第3列是空的
// （左边是 1，下边出界），所以它那一块非占第1行第3列不可。
const mustB = createBoard({ w: 3, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, ONE, TWO]) });
const mustInk = Int8Array.from([0, 0, 0, 0, 1, 2]);
const mustSweep = propagate(mustB, mustInk);
eq('必经之格：第一写就是它', mustSweep.found[0].rule.name, '必经之格');
eq('必经之格：写第1行3列', mustSweep.found[0].cell, 2);
eq('必经之格：写 2', mustSweep.found[0].value, 2);
eq('必经之格：理由是那块的第 2 格', mustSweep.found[0].root, 5);
eq('必经之格：绕开就只剩 1 格', mustSweep.found[0].without, 1);
// 整张盘手推：必经(2) → 邻区已满(第1行2列只剩 3) → 刚好长满(第1行1列、第2行1列)
const mustSolve = solve(mustB);
eq('必经之格：推到底的答案', key(mustSolve.derived), '3,3,2,3,1,2');
eq('必经之格：四步', mustSolve.steps, 4);
eq('必经之格：分数', mustSolve.score, Math.round((2.8 + 1.6 + 2 * 2) * 10) / 10);
eq('必经之格：顺序', mustSolve.rows.map((r) => `${r.rule.name}/${r.cell}/${r.value}`).join(' '),
  '必经之格/2/2 邻区已满/1/3 刚好长满/0/3 刚好长满/3/3');
eq('必经之格的话术', mustSolve.rows[0].rule.text(mustB, mustSolve.rows[0]),
  '第1行3列 必须写 2：第2行3列 那块要凑满 2 格，可绕开这一格它最多只能圈到 1 格，不够');
eq('必经之格：答案过验收', verify(mustB, mustSolve.derived).length, 0);
eq('必经之格：答案算通关', complete(mustB, mustSolve.derived), true);

// 邻区已满：接着上面第 2 步手推 —— 第1行2列 左边、右边各压着一块已经写满的（1 和 2），
// 两个候选都被邻区挤掉，且没有「长不满」掺进来，所以这条规则才有名字。
const sealRow = mustSolve.rows[1];
eq('邻区已满：写第1行2列', sealRow.cell, 1);
eq('邻区已满：写 3', sealRow.value, 3);
eq('邻区已满：挤掉 2 个候选', sealRow.sealed, 2);
eq('邻区已满：一个都没因为长不满', sealRow.shorted, 0);
eq('邻区已满：见证的那块从第2行2列起', sealRow.block, 4);
eq('邻区已满：那块是 1', sealRow.blockV, 1);
eq('邻区已满的话术', sealRow.rule.text(mustB, sealRow),
  '第1行2列 只能写 3：挨着 第2行2列 那块 1 再塞一格就成 2 格了，2 个候选都被这样封死');

// 只剩一个数：3×2，第1行第3列印 1、第2行第2列印 2。第2行第3列 是一个被写死的小口袋：
// 写 1 就和第1行第3列那个 1 连成两格（邻区挤掉），写 3 就只剩自己一格（长不满挤掉），
// 只有 2 能把第2行第2列那个 2 补成一块 —— 两种排除都有，规则就老实说「只剩一个数」。
const onlyB = createBoard({ w: 3, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, ONE, NO_CLUE, TWO, NO_CLUE]) });
const onlySweep = propagate(onlyB, Int8Array.from([0, 0, 1, 0, 2, 0]));
eq('只剩一个数：一次只定第2行3列', onlySweep.found.length, 1);
eq('只剩一个数：格子', onlySweep.found[0].cell, 5);
eq('只剩一个数：写 2', onlySweep.found[0].value, 2);
eq('只剩一个数：名字', onlySweep.found[0].rule.name, '只剩一个数');
eq('只剩一个数：邻区挤掉 1 个', onlySweep.found[0].sealed, 1);
eq('只剩一个数：长不满挤掉 1 个', onlySweep.found[0].shorted, 1);
eq('只剩一个数的话术', onlySweep.found[0].rule.text(onlyB, onlySweep.found[0]),
  '第2行3列 能写的数只剩 2：2 个候选被周围的块挤掉了——邻区满掉的占 1 个，长不满的占 1 个');
const onlySolve = solve(onlyB);
eq('只剩一个数：这张盘能推到底', onlySolve.ok, true);
eq('只剩一个数：答案', key(onlySolve.derived), '3,3,1,3,2,2');
eq('只剩一个数：四步', onlySolve.steps, 4);
eq('只剩一个数：分数', onlySolve.score, Math.round((2.4 + 1.6 + 2 * 2) * 10) / 10);
eq('只剩一个数：顺序', onlySolve.rows.map((r) => `${r.rule.name}/${r.cell}/${r.value}`).join(' '),
  '只剩一个数/5/2 邻区已满/1/3 刚好长满/0/3 刚好长满/3/3');

// 冲突：写下去就不可能成立。1×3，第3列印 1；玩家在第2列印 3 —— 那个 3 左右一个被 1 堵死、
// 一个只有第1列可去，圈不满 3 格。
const cfB = createBoard({ w: 3, h: 1, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, ONE]) });
const cfInk = Int8Array.from([0, 3, 1]);
eq('冲突：凑不满被点名', propagate(cfB, cfInk).conflict, '第1行2列 那块 3 能圈到的地方只剩 2 格，凑不满');
eq('冲突：changed 是 false', propagate(cfB, cfInk).changed, false);
eq('冲突：found 是空', propagate(cfB, cfInk).found.length, 0);
// 一行三格，两头印 1、最大块 2：中间那格既不能是 1（两边各一个 1，一写就成三格的 1），
// 也不能是 2（2 的那一块连自己都只有两格，可它右边那位已经写满了）。
const deadB = createBoard({ w: 3, h: 1, maxK: 2, clue: Int8Array.from([ONE, NO_CLUE, ONE]) });
eq('冲突：没有数可写', propagate(deadB, Int8Array.from([1, 0, 1])).conflict, '第1行2列 已经没有任何数可写了');
eq('冲突：solve 也带回来同样的话', solve(deadB).conflict, '第1行2列 已经没有任何数可写了');
// 2×2 对角各印一个 2（最大块 2）：两个 2 想各自成块，中间两格只能都写 1，可那一来两个 2 都圈不满了。
const diagB = createBoard({ w: 2, h: 2, maxK: 2, clue: Int8Array.from([TWO, NO_CLUE, NO_CLUE, TWO]) });
const diagSolve = solve(diagB);
eq('对角两个 2：推不出解', key(diagSolve.derived), '2,1,1,2');
eq('对角两个 2：以冲突收场', diagSolve.conflict, '第1行1列 那块 2 能圈到的地方只剩 1 格，凑不满');
eq('对角两个 2：冲突前还是推了两步', diagSolve.steps, 2);
eq('对角两个 2：独立计数器也说无解', countSolutions(diagB, { cap: 2 }).status, NONE);

// ---------- 穷举器的口径：数出来几条，就是几条 ----------
// 手推 1×4（最大块 4，只有最右列印一颗 1）。这条带子只能这么切：
//   · 1｜2 2｜1 → 1,2,2,1
//   · 3 3 3｜1 → 3,3,3,1
// 为什么只有这两种（格子按 0 数）：格 0 所在的那一块只能长 1、2 或 3 —— 长 4 就得把格 3 吞进去，
// 可那里印着 1，它只能是 1。若是 2，它占格 0、1，剩下的格 2 只能自己当 1，可它和印着 1 的格 3 左右
// 相邻，两块「1」并成一块两格的 1，规则不认；若是 3，它占格 0、1、2，正好是一块 3；若是 1，中间两格
// 必须凑成一块 2（各自当 1 也会并成一块两格的 1），于是得到 1,2,2,1。
// 所以「一共有两条解」这件事在纸上是数得出来的。
// 这条是回归测试：cap 只是「数到几条就停手」，不是判决。把 cap 设成 400、只数出 2 条，按 cap 定
// 罪的写法会判成 NONE（无解）—— 那等于指着一道歧解题说「它没有答案」，而所有拿穷举当唯一性裁判的
// 地方都会跟着点头。tents 那边就踩过这个坑。
const stripB = createBoard({ w: 4, h: 1, maxK: 4, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, ONE]) });
const stripAll = countSolutions(stripB, { cap: 400, budget: 400000, all: true });
eq('四条带：要 400 条、只数出 2 条，仍然是 MANY', stripAll.status, MANY);
eq('四条带：数出的条数', stripAll.solutions, 2);
eq('四条带：每一条都交出来', stripAll.every.map(key).join(' | '), '1,2,2,1 | 3,3,3,1');
eq('四条带：first 就是第一条', key(stripAll.first), '1,2,2,1');
eq('四条带：走过的节点数', stripAll.nodes, 16);
eq('四条带：每一条解都过验收器', stripAll.every.filter((s) => verify(stripB, s).length || !complete(stripB, s)).length, 0);
eq('四条带：不点名要 every 就不给', countSolutions(stripB, { cap: 400, budget: 400000 }).every, null);
eq('四条带：笔迹一条都推不出（可靠但不完全）', solve(stripB).steps, 0);
const starvedAll = countSolutions(stripB, { cap: 400, budget: 3 });
eq('预算撞顶时不许交半成品', `${starvedAll.status}/${String(starvedAll.every)}/${String(starvedAll.first)}`, 'OVERBUDGET/null/null');
// 手推 2×2（最大块 3，只在右下角印一颗 1）：四格切成若干块，块大小之和是 4，能用的数只有 1、2、3。
// 1+1+1+1 会留下相邻的 1（并成一块两格）；2+2 的两块 2 要么相邻（并成 4，超最大块）要么对角
// （对角那两格各缺一格同伴）；3+1 只有一种摆法：除那颗 1 之外的三格连成一块 L 形的 3。
// 所以唯一解是 3,3,3,1 —— 而笔迹在这张盘上一步都推不动：这就是「可靠」和「完全」不是一回事。
const sqB = createBoard({ w: 2, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, ONE]) });
const sqAll = countSolutions(sqB, { cap: 400, budget: 400000, all: true });
eq('2×2 只印一颗 1：唯一解', sqAll.status, UNIQUE);
eq('2×2 只印一颗 1：解就一条', sqAll.every.map(key).join(' | '), '3,3,3,1');
eq('2×2 只印一颗 1：笔迹推不动', solve(sqB).steps, 0);
eq('2×2 只印一颗 1：也没冲突', solve(sqB).conflict, undefined);

// ---------- 两套独立实现必须逐格同意 ----------
// 三个来源：① 种下的解整张印出来；② 出货器剪过枝的题面；③ 在②上再无差别随机擦掉 2–5 个数字
// （不做任何筛选，所以这里既有唯一解也有歧解）。断言不是「解的条数」，是「逐格的答案」。
let boards = 0;
let unique = 0;
let many = 0;
let none = 0;
let over = 0;
let disagree = 0;
let pencilButNotUnique = 0;
let stalled = 0; // 唯一解但笔迹推不动：出货器会拒掉，这里只统计
for (let i = 0; i < 45; i++) {
  const tier = i % 2 ? TIERS[1] : TIERS[0];
  const r = generate({ ...tier, seed: `agree#${i}`, count: false }); // 计数交给计数器
  const compare = (b) => {
    boards++;
    const p = solve(b);
    const c = countSolutions(b, { cap: 2, budget: 300000 });
    if (c.status === UNIQUE) unique++;
    else if (c.status === MANY) many++;
    else if (c.status === NONE) none++;
    else over++;
    if (p.ok && c.status !== UNIQUE) pencilButNotUnique++;
    // 笔迹写下的每一格都必须在计数器的唯一解里一模一样
    if (c.first) {
      for (let t = 0; t < b.n; t++) {
        if (p.derived[t] !== OPEN && p.derived[t] !== c.first[t]) { disagree++; break; }
      }
    }
    // 反过来：笔迹推完了却没有唯一解，或推出来的和计数器的唯一解不同
    if (c.status !== UNIQUE && p.steps && key(p.derived) === key(c.first)) disagree++;
    if (c.status === UNIQUE && !p.ok) stalled++;
  };
  compare(createBoard({ w: r.board.w, h: r.board.h, maxK: r.board.maxK, clue: Int8Array.from(r.solution) }));
  compare(r.board);
  const del = mix(`del#${i}`);
  const cs = Int8Array.from(r.board.clue);
  let k = 2 + Math.floor(del() * 4);
  while (k > 0) {
    const j = Math.floor(del() * cs.length);
    if (cs[j] !== NO_CLUE) { cs[j] = NO_CLUE; k--; }
  }
  compare(createBoard({ w: r.board.w, h: r.board.h, maxK: r.board.maxK, clue: cs }));
}
eq('共识用例数', boards, 135);
eq('两套实现逐格不同意的盘数', disagree, 0);
eq('笔迹推完但计数器不叫唯一解的盘数', pencilButNotUnique, 0);
ok('唯一解样本够多', unique >= 40 && many >= 10, `UNIQUE ${unique}，MANY ${many}，NONE ${none}，OVERBUDGET ${over}`);
ok('无差别擦除确实擦出过歧解', many >= 10, `MANY ${many}`);
eq('擦掉的盘不会变成无解', none, 0);
eq('这些小盘不会撞计数预算', over, 0);
ok('唯一解里确实有笔迹推不动的（所以出货器要 gate）', stalled > 0, `卡住 ${stalled}`);
// 手推一张：3×2 只在第2行第2列印 2、第2行第3列印 1。唯一解是上面一行三个 3，但笔迹看不出第2行第2列
// 那个 2 该往左还是往右 —— 只有穷举知道。
const stallB = createBoard({ w: 3, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, TWO, ONE]) });
eq('手推卡住样本：笔迹一步都推不出', solve(stallB).steps, 0);
eq('手推卡住样本：不算推到底', solve(stallB).ok, false);
eq('手推卡住样本：也没冲突', solve(stallB).conflict, undefined);
eq('手推卡住样本：计数器说唯一', countSolutions(stallB, { cap: 2 }).status, UNIQUE);
eq('手推卡住样本：唯一解', key(countSolutions(stallB, { cap: 2 }).first), '3,3,3,2,2,1');
// 计数器的预算/封顶都得诚实
const capped = countSolutions(onlyB, { cap: 2, budget: 3 });
eq('预算撞顶要说 OVERBUDGET', capped.status, OVERBUDGET);
eq('OVERBUDGET 时 first 是 null', capped.first, null);
ok('OVERBUDGET 不算 OK', capped.status !== UNIQUE, '');
const two = countSolutions(stallB, { cap: 2, budget: 300000 });
ok('封顶生效：solutions 不超过 cap', two.solutions <= 2, `solutions ${two.solutions}`);
eq('计数器给的解要过验收器', verify(stallB, two.first).length, 0);
eq('计数器给的解算通关', complete(stallB, two.first), true);
// 贴边的两块 1：3×2 印第1行第3列=1、第2行第2列=2，把第2行第3列 也写成 1 —— 它和印着的那个 1
// 上下贴上，两块「1」变成一块两格的 1，规则当场不认。
const sealBad = Int8Array.from([0, 0, 1, 0, 2, 1]);
eq('贴边的两块 1：验收器不认', verify(onlyB, sealBad).map((x) => `${x.cell}:${x.why}`).join(','), '0:空格,1:空格,3:空格,2:块大了');
eq('贴边的两块 1：不算通关', complete(onlyB, sealBad), false);
eq('贴边的两块 1：印上去连盘面都成立不了',
  throws(() => createBoard({ w: 3, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, ONE, NO_CLUE, TWO, ONE]) })),
  '第1行3列 一带有 2 个连成一片的 1，可它那块只容得下 1 格');

// ---------- 每一次落子都要对得上「每一条」解 ----------
// 「唯一解」只是一半：规则写下的每一格，必须在这道盘的 *每一条* 完成解里都成立，不然这条规则就是在
// 编故事（可靠性）。下面让 count.js 把每条解都收回来（cap 400、预算 40 万节点），再逐格对 solve()
// 写下的每一步。
// 盘的来源刻意不做筛选：出货器的题面 + 在其上无差别随机擦掉 0–8 颗数字。擦数字只会让盘更难，不会让
// 它不合法（等数线索的连片只会缩短、可圈的范围只会变大），createBoard 在这里一律成立，样本一个不丢。
let sBoards = 0;
let sChecked = 0; // 逐格核对过的落子次数
let sUnsound = 0; // 被某一条解当场推翻的落子：必须是 0
let sEveryBad = 0; // 穷举器交出来的解里过不了验收器的：必须是 0
let sUnique = 0;
let sStalled = 0; // 唯一解但铅笔推不完
let sMany = 0;
let sNone = 0;
let sOver = 0; // 预算内数不完的盘：这些盘拿不到「每一条解」，照实报，不算通过也不算失败
let sPencilBad = 0; // 铅笔推完了却不止一条解：必须是 0
for (let i = 0; i < 120; i++) {
  const tier = TIERS[i % 5];
  const r = makePuzzle(`sound#${i}`, tier.key);
  if (!ok('可靠样本：出货器给得出盘', !!r, `${tier.key}#${i}`)) continue;
  const rnd = mix(`rub#${i}`);
  const clue = Int8Array.from(r.board.clue);
  let left = i % 9; // 0…8 颗，擦几颗由序号定，不挑结果
  while (left > 0) {
    const j = Math.floor(rnd() * clue.length);
    if (clue[j] !== NO_CLUE) { clue[j] = NO_CLUE; left--; }
  }
  const b = createBoard({ w: tier.w, h: tier.h, maxK: tier.maxK, clue });
  sBoards++;
  const c = countSolutions(b, { cap: 400, budget: 400000, all: true });
  const p = solve(b);
  if (c.status === UNIQUE) {
    sUnique++;
    if (!p.ok) sStalled++;
  } else if (c.status === MANY) sMany++;
  else if (c.status === NONE) sNone++;
  else sOver++;
  if (p.ok && c.status !== UNIQUE) sPencilBad++;
  if (!c.every) continue; // 数不完的盘不做逐格核对（数目已经报在 sOver 里）
  for (const one of c.every) if (verify(b, one).length || !complete(b, one)) sEveryBad++;
  for (const row of p.rows) {
    sChecked++;
    for (const one of c.every) {
      if (one[row.cell] !== row.value) { sUnsound++; break; }
    }
  }
}
console.log(`  逐格核对：${sBoards} 盘、${sChecked} 次落子，对过「每一条」解之后站不住的是 ${sUnsound} 次`);
console.log(`  唯一解但铅笔推不完：${sStalled}/${sUnique} 局（另有 ${sOver} 盘在 40 万节点内数不完，未做逐格核对；歧解 ${sMany}，无解 ${sNone}）`);
eq('落子在每一条解里都站得住（可靠性缺口）', sUnsound, 0);
eq('穷举器数出的解全过验收器', sEveryBad, 0);
eq('铅笔推完却不止一条解的盘数', sPencilBad, 0);
ok('样本里既有唯一解也有歧解（不然这条测试是空的）', sUnique >= 8 && sMany >= 8, `UNIQUE ${sUnique}，MANY ${sMany}，NONE ${sNone}，OVERBUDGET ${sOver}`);
ok('抽样里也确实推不完过（所以出货器需要 gate）', sStalled > 0, `${sStalled}/${sUnique}`);

// ---------- 出货器自己必须躲开这块天花板 ----------
// 「唯一解但铅笔推不完」不是引擎的缺陷，是规则的天花板：铅笔不回头，穷举才回头。产品不能赌运气，
// 所以 generate 每擦一颗数字都重跑一遍 solve()，擦完推不完的那一版直接不要。
// 这里走产品路径（makePuzzle(种子, 档位)）五档各 12 局，共 60 局，逐局要求：
// 纯计数能推到底、穷举器说唯一、笔迹写下的每一格和「每一条」解都对得上、一局都不许撞预算。
let gShipped = 0;
let gChecked = 0;
let gUnsound = 0;
let gStalled = 0;
let gNotUnique = 0;
let gOver = 0;
let gPlantBad = 0;
let gAgree = 0;
for (const tier of TIERS) {
  for (let s = 0; s < 12; s++) {
    const r = makePuzzle(`gate|${tier.key}#${s}`, tier.key);
    if (!ok(`gate：${tier.key}#${s} 出货`, !!r)) continue;
    gShipped++;
    const c = countSolutions(r.board, { cap: 400, budget: 400000, all: true });
    if (c.status === OVERBUDGET) gOver++;
    if (c.status !== UNIQUE) gNotUnique++;
    const p = solve(r.board);
    if (!p.ok) gStalled++;
    else if (key(p.derived) === key(c.first)) gAgree++;
    if (verify(r.board, r.solution).length || !complete(r.board, r.solution)) gPlantBad++;
    for (const row of p.rows) {
      gChecked++;
      for (const one of c.every || []) if (one[row.cell] !== row.value) { gUnsound++; break; }
    }
  }
}
console.log(`  gate：出货 ${gShipped}/60，逐格核对 ${gChecked} 次落子，出货盘里铅笔推不完的是 ${gStalled} 局`);
eq('gate 出货 60/60', gShipped, 60);
eq('出货的盘全都能纯计数推完', gStalled, 0);
eq('出货的盘在 40 万节点内全都数得完', gOver, 0);
eq('出货的盘全都是唯一解', gNotUnique, 0);
eq('出货的盘逐格对得上每一条解', gUnsound, 0);
eq('出货的盘和穷举器的唯一解是同一份答案', gAgree, 60);
eq('种下的解每一份都过验收器', gPlantBad, 0);

// ---------- 验收只看盘和笔迹 ----------
// 全线索的手搓 5×5：一笔都不用推就算通关。
eq('全线索盘：空笔迹就是满的', complete(b5, new Int8Array(25)), true);
eq('全线索盘：验收挑不出毛病', verify(b5, new Int8Array(25)).length, 0);
eq('全线索盘：笔迹一步都不用推', solve(b5).steps, 0);
eq('全线索盘：分数是 0', solve(b5).score, 0);
eq('全线索盘：9 块区域', regions(b5, new Int8Array(25)).length, 9);
const b5gen = makePuzzle('engine-accept', 'trainee');
ok('给张生成的题', !!b5gen, b5gen ? '' : '出货失败');
if (b5gen) {
  const gb = b5gen.board;
  eq('生成的题：空笔迹不算完', complete(gb, new Int8Array(gb.n)), false);
  eq('生成的题：种下的解过验收', verify(gb, b5gen.solution).length, 0);
  eq('生成的题：种下的解算通关', complete(gb, b5gen.solution), true);
  eq('生成的题：引擎推出来的解算通关', complete(gb, solve(gb).derived), true);
  eq('生成的题：空笔迹填过的格数等于线索数', diagnose(gb, new Int8Array(gb.n)).filled, gb.clues);
  eq('生成的题：空笔迹剩的格数', diagnose(gb, new Int8Array(gb.n)).remaining, gb.n - gb.clues);
  // 找一格改写成别的数，验收器必须挑出来（只读盘和笔迹就能挑出来）
  let wt = -1;
  let wv = 0;
  for (let i = 0; i < gb.n && wt < 0; i++) {
    if (!gb.blankAt(i)) continue;
    for (let v = 1; v <= gb.maxK; v++) {
      if (v === b5gen.solution[i]) continue;
      const probe = Int8Array.from(b5gen.solution);
      probe[i] = v;
      if (verify(gb, probe).length) { wt = i; wv = v; break; }
    }
  }
  ok('生成的题：有一格写歪就被验收器抓住', wt >= 0, `第${wt}格`);
  if (wt >= 0) {
    const promoted = Int8Array.from(gb.clue);
    promoted[wt] = wv;
    let status = 'throws';
    try {
      status = countSolutions(createBoard({ w: gb.w, h: gb.h, maxK: gb.maxK, clue: promoted }), { cap: 2, budget: 300000 }).status;
    } catch { /* 印上去直接就不合法，也算没解 */ }
    ok('生成的题：写歪那格印上去就没解（计数器独立同意）', status === NONE || status === 'throws', String(status));
  }
}
// 空笔迹：除了印着数字的格子全报空格
const v0 = verify(mustB, new Int8Array(6));
eq('验收：没印的格数', v0.length, 4);
eq('验收：第1格是空格', v0[0].why, '空格');
eq('验收：空格子编号', v0[0].cell, 0);
eq('验收：空格想要的数', v0[0].want, '1…3');
eq('验收：空格有的数', v0[0].have, OPEN);
eq('验收：最后一个空格是第2行第1列', v0[3].cell, 3);
// 块大了：手推 3×2 —— 第1行全部写 2，加上第2行第3列那个印着的 2，连成 3 格
const v1 = verify(mustB, Int8Array.from([2, 2, 2, 0, 1, 2]));
eq('验收：块大了＋空格', v1.map((x) => `${x.cell}:${x.why}`).join(','), '3:空格,0:块大了');
eq('验收：块大了要 2 有 4', `${v1[1].want}/${v1[1].have}`, '2/4');
eq('验收：块大了把整块都列出来', key(v1[1].group), '0,1,2,5');
// 凑不满：1×3 印第3列=1，玩家在第2列写 3 —— 那个 3 只能往左占一格
const v2 = verify(cfB, Int8Array.from([0, 3, 1]));
eq('验收：凑不满＋空格', v2.map((x) => `${x.cell}:${x.why}`).join(','), '0:空格,1:凑不满');
eq('验收：凑不满要 3 有 1', `${v2[1].want}/${v2[1].have}`, '3/1');
eq('验收：凑不满只剩 2 格可圈', v2[1].room, 2);
eq('验收：凑不满那块就是它自己', key(v2[1].group), '1');
// 超块：1×3 最大块 2，中间写 3
const overB = createBoard({ w: 3, h: 1, maxK: 2, clue: Int8Array.from([ONE, NO_CLUE, NO_CLUE]) });
const v3 = verify(overB, Int8Array.from([0, 3, 0]));
eq('验收：超块也报', v3.map((x) => `${x.cell}:${x.why}`).join(','), '1:超出最大块,2:空格,1:凑不满');
eq('验收：超块想要 1…2', v3[0].want, '1…2');
eq('验收：超块有 3', v3[0].have, 3);
eq('验收：正确答案零告警', verify(mustB, Int8Array.from([3, 3, 2, 3, 1, 2])).length, 0);
eq('通关：正确答案', complete(mustB, Int8Array.from([3, 3, 2, 3, 1, 2])), true);
eq('通关：一格歪了就不算', complete(mustB, Int8Array.from([2, 3, 2, 3, 1, 2])), false);
// 那一格歪了会连带三块都凑不满：第1行第1列那个 2 谁都不挨，两个 3 各成一块独苗
eq('通关：歪在哪里', verify(mustB, Int8Array.from([2, 3, 2, 3, 1, 2])).map((x) => `${x.cell}:${x.why}`).join(','), '0:凑不满,1:凑不满,3:凑不满');
eq('通关：少一格就不算', complete(mustB, Int8Array.from([3, 3, 2, 0, 1, 2])), false);
// 诊断：手推 3×2 写了第1行第3列=2 之后：填了 3 格、成形的块是 {第1行第3列,第2行第3列} 和 {第2行第2列}
const dA = diagnose(mustB, Int8Array.from([0, 0, 2, 0, 1, 2]));
eq('诊断：填/总/剩/线索/冲突', [dA.filled, dA.total, dA.remaining, dA.clues, dA.conflicts].join('/'), '3/6/3/2/0');
eq('诊断：成形的块两块', [dA.satisfied.has(2), dA.satisfied.has(4), dA.satisfied.has(5)].join(','), 'true,true,false');
const dB = diagnose(mustB, Int8Array.from([2, 2, 2, 2, 1, 2]));
eq('诊断：一块大了', [dB.filled, dB.remaining, dB.conflicts].join('/'), '6/0/1');
eq('诊断：大的是那块 2', dB.violated.has(0), true);
eq('诊断：印着的 1 还是好的', dB.satisfied.has(4), true);
// 区域 outlines：笔迹和线索合并后按扫描顺序出块
eq('区域：两块都写满', regions(mustB, Int8Array.from([0, 0, 2, 0, 1, 2])).map((g) => `${g.value}@${key(g.cells)}${g.full ? '/full' : ''}`).join(' '),
  '2@2,5/full 1@4/full');
eq('区域：没写满的标 false', regions(onlyB, Int8Array.from([0, 0, 1, 0, 2, 0])).map((g) => `${g.value}@${key(g.cells)}${g.full ? '/full' : ''}`).join(' '),
  '1@2/full 2@4');
// withClues：印着的数字说了算
eq('合并：线索盖过笔迹', key(withClues(mustB, Int8Array.from([0, 0, 0, 0, 3, 3]))), '0,0,0,0,1,2');
eq('合并：笔迹留在没印的地方', key(withClues(mustB, Int8Array.from([2, 0, 0, 0, 0, 0]))), '2,0,0,0,1,2');
// ↑↓ 这一段是一条引擎 bug 的现场。withClues 原本写的是「笔迹非空就用笔迹」，于是只要有人在印着数字
// 的格子上留了值（状态机走不出这一步，但读档、任何直接写 st.cell 的调用方都走得出来），那颗印着的
// 数字就在 verify/complete/diagnose/regions/reachable 面前凭空消失 —— 和事故记录里「0 线索被静抹掉」
// 是同一件事。三处独立的说法都站在「印着的赢」这边：函数自己头上的注释、setCell 拒绝在印着的格子上
// 落子、UI 里那句「clues first, the player's ink where the author left a blank」（js/ui/game.js:66）。
eq('合并：那块 1 不会被人写的 2 并走（区域视图）',
  regions(mustB, Int8Array.from([0, 0, 0, 0, 2, 2])).map((g) => `${g.value}@${key(g.cells)}${g.full ? '/full' : ''}`).join(' '),
  '1@4/full 2@5');
eq('合并：歪笔迹盖不住印着的 2 —— 正解其余五格仍算通关', complete(mustB, Int8Array.from([3, 3, 2, 3, 1, 1])), true);
eq('合并：同上，验收器不再报「块大了」', verify(mustB, Int8Array.from([3, 3, 2, 3, 1, 1])).length, 0);
eq('合并：歪笔迹也不会被当成死局', reachable(mustB, Int8Array.from([3, 3, 2, 3, 1, 1])), true);
// 合法笔迹（印着的格子一律是空）下，合并的结果就是「印着的地方用印着的，没印的地方用笔迹」，
// 和两端的次序无关 —— 这条等价关系是上面那个修复没有改动正常路径的证明。
if (b5gen) {
  const legal = new Int8Array(b5gen.board.n);
  const rnd = mix('merge#0');
  for (let t = 0; t < legal.length; t++) if (b5gen.board.blankAt(t) && rnd() < 0.5) legal[t] = 1 + Math.floor(rnd() * b5gen.board.maxK);
  const byHand = new Int8Array(b5gen.board.n);
  for (let t = 0; t < byHand.length; t++) byHand[t] = b5gen.board.clue[t] !== NO_CLUE ? b5gen.board.clue[t] : legal[t];
  eq('合并：合法笔迹下就是「印着的用印着的」', key(withClues(b5gen.board, legal)), key(byHand));
  eq('合并：每一颗印着的数在合并视图里都还是印着的那颗',
    [...withClues(b5gen.board, legal)].filter((v, t) => v === b5gen.board.clue[t]).length, b5gen.board.clues);
  eq('合并：没印的地方在合并视图里就是笔迹（含没写的 0）',
    [...withClues(b5gen.board, legal)].filter((v, t) => v === legal[t] && b5gen.board.blankAt(t)).length,
    b5gen.board.n - b5gen.board.clues);
}

// ---------- 这笔迹还救得回来吗 ----------
// 空笔迹、干净的题面：一路推到底也没撞坏 —— 救得回来。
eq('干净的题面救得回来', reachable(mustB, new Int8Array(6)), true);
// 手推：3×2（第2行第2列=1、第2行第3列=2）上再点一个 1 在第1行第1列 ——
// 第1行第2列 就被夹死了：写 1 会和上下两块 1 连成三格，写 2 会让邻块变三格，写 3 又只有它自己一格。
eq('夹死一格：报警', reachable(mustB, Int8Array.from([1, 0, 0, 0, 0, 0])), false);
// 另一面：1×3 两头印 1，中间没数可写 —— 引擎能看出来这盘根本活不了。
eq('夹死：空笔迹也救不回死盘', reachable(deadB, new Int8Array(3)), false);
eq('夹死：独立计数器也说无解', countSolutions(deadB, { cap: 2 }).status, NONE);
// true ≠ 一定有救（单向）：3×3 最大块 2，只在第2行第3列、第3行第1列印两个 2。
// 盘上没冲突，笔迹也一步都推不下去 —— 可它其实没有解：两个 2 各要占一格邻居，
// 而第2行第2列 一旦被谁占住，剩下的空格就再也凑不出第二块 2。
const doomedB = createBoard({ w: 3, h: 3, maxK: 2, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, TWO, TWO, NO_CLUE, NO_CLUE]) });
eq('死盘：笔迹不报警', solve(doomedB).conflict, undefined);
eq('死盘：笔迹推不出任何一步', solve(doomedB).steps, 0);
eq('死盘：不算推到底', solve(doomedB).ok, false);
eq('死盘：独立计数器判无解', countSolutions(doomedB, { cap: 2 }).status, NONE);
eq('死盘：reachable 却放它过去（只保证单向）', reachable(doomedB, new Int8Array(9)), true);
// 单向的另一面：不报警 ≠ 有救，而且这一步能在手上一格格走完。3×3、最大块 3，只在第1行第1列印 1、
// 第1行第2列印 2。假设把中心格 4 写成 2：格 4 和印着的格 1 贴着，两块并成一块，所以格 1 那一块
// 就是 {1,4}，格 2、格 5 都不许再写 2；格 3 不能写 1（格 0 那块 1 已经满了）、不能写 2（一写就和
// {1,4} 并成三格），只剩 3，而它那一块必须正好三格 → 只能是 {3,6,7}。现在剩下格 2、5、8：
// 格 5 写 2 已经禁了；写 3 要拉两格同伴，能拉的只有格 2 和格 8，可格 8 一写 3 就和格 7 那块并成
// 四格，不行；写 1 就把自己关成一格，可那来格 2 既不能写 2、写 3 又没有同伴（上下都是别人的块），
// 也活不成。所以格 4 写 2 是一步死棋。
// 引擎看不出它是死棋：不报警、验收器只看见一堆空格、reachable 一路放行；把这一格升成线索再交给
// 独立穷举器，才是 0 条解。这条断言的作用就是说清楚：reachable 只保证「报警的一定是死的」。
const h10 = createBoard({ w: 3, h: 3, maxK: 3, clue: Int8Array.from([ONE, TWO, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE, NO_CLUE]) });
const h10All = countSolutions(h10, { cap: 400, budget: 400000, all: true });
eq('稀盘：中心格在每条解里只出现 1 和 3', [...new Set(h10All.every.map((a) => a[4]))].join(','), '1,3');
const deadInk = Int8Array.from([OPEN, OPEN, OPEN, OPEN, TWO, OPEN, OPEN, OPEN, OPEN]);
eq('稀盘：空笔迹下一步都推不出', solve(h10).steps, 0);
eq('稀盘：死笔迹不报警（单向的另一半）', reachable(h10, deadInk), true);
eq('稀盘：验收器只看见空格，看不见死', verify(h10, deadInk).every((x) => x.why === '空格'), true);
eq('稀盘：这一格升成线索，穷举器就判 0 条解', (() => {
  const cl = Int8Array.from(h10.clue);
  cl[4] = TWO;
  return countSolutions(createBoard({ w: 3, h: 3, maxK: 3, clue: cl }), { cap: 2, budget: 400000 }).status;
})(), NONE);
// 反过来它必须说得对：把三张小盘的每一种笔迹都过一遍（401 份），凡是 reachable 报警的，都把这份
// 笔迹升成线索交给独立穷举器 —— 必须一条解都没有。误报 0 是这条断言的全部内容；「放行」不是承诺，
// 所以下面同时把「放行但确实死」的份数打出来，不让任何人把它当完整判据。
let sweepInks = 0;
let sweepAlarm = 0;
let sweepFalseAlarm = 0;
let sweepSilentDead = 0;
for (const sb of [
  createBoard({ w: 4, h: 1, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, NO_CLUE, ONE]) }),
  createBoard({ w: 3, h: 2, maxK: 2, clue: Int8Array.from([ONE, NO_CLUE, NO_CLUE, NO_CLUE, TWO, NO_CLUE]) }),
  mustB,
]) {
  const blanks = [...Array(sb.n).keys()].filter((t) => sb.blankAt(t));
  const total = Math.pow(sb.maxK + 1, blanks.length); // 每格：不写，或写 1…maxK
  for (let code = 0; code < total; code++) {
    const ink = new Int8Array(sb.n);
    let x = code;
    for (const t of blanks) {
      ink[t] = x % (sb.maxK + 1);
      x = Math.floor(x / (sb.maxK + 1));
    }
    sweepInks++;
    const cl = Int8Array.from(sb.clue);
    for (let t = 0; t < sb.n; t++) if (ink[t] !== OPEN) cl[t] = ink[t];
    let dead;
    try {
      dead = countSolutions(createBoard({ w: sb.w, h: sb.h, maxK: sb.maxK, clue: cl }), { cap: 2, budget: 200000 }).status === NONE;
    } catch {
      dead = true; // 笔迹加线索连盘面都成立不了，那更是死路
    }
    const alive = reachable(sb, ink);
    if (!alive) sweepAlarm++;
    if (!alive && !dead) sweepFalseAlarm++;
    if (alive && dead) sweepSilentDead++;
  }
}
console.log(`  reachable 全枚举：${sweepInks} 份笔迹，报警 ${sweepAlarm} 份，误报 0 是要求；放行却已经死了 ${sweepSilentDead} 份（单向，见上面那张稀盘）`);
eq('全枚举：reachable 一次都没有冤枉过', sweepFalseAlarm, 0);
eq('全枚举：样本量', sweepInks, 401);

// ---------- 这笔迹本身：状态机 ----------
const inkB = createBoard({ w: 3, h: 2, maxK: 3, clue: Int8Array.from([NO_CLUE, NO_CLUE, ONE, NO_CLUE, TWO, NO_CLUE]) });
const st = createState(inkB);
eq('新建：笔迹全空', key(st.cell), '0,0,0,0,0,0');
eq('新建：历史是空', st.history.length, 0);
eq('落在印着数字的格子上被拒', setCell(st, 2, THREE), false);
eq('落在另一个印着数字的格子上被拒', setCell(st, 4, THREE), false);
eq('印着的格子笔迹仍是空', st.cell[2], 0);
eq('超出最大块被拒', setCell(st, 0, inkB.maxK + 1), false);
eq('越界的格子被拒', setCell(st, inkB.n, ONE), false);
eq('负数被拒', setCell(st, 0, -2), false);
eq('空格子在空的时候擦不掉', eraseCell(st, 0), false);
eq('写一个合法的数', setCell(st, 0, THREE), true);
eq('笔迹落下了', st.cell[0], 3);
eq('落子留了一份快照', st.history.length, 1);
eq('同一个数重复写不算一步', setCell(st, 0, THREE), false);
eq('重复写不留快照', st.history.length, 1);
eq('撤销回到空', undo(st), true);
eq('撤销把格子清了', st.cell[0], 0);
eq('没历史可撤销', undo(st), false);
setCell(st, 1, THREE);
eq('擦掉一个写过的格子', eraseCell(st, 1), true);
eq('擦完是空', st.cell[1], 0);
eq('擦也是一步（有快照）', st.history.length, 2);
eq('撤销擦除', undo(st), true);
eq('撤销把数写回来', st.cell[1], 3);
setCell(st, 0, THREE);
snapshot(st);
st.cell[1] = TWO; // 越过状态机改笔迹：刚推进去的那份快照必须不动
eq('快照是副本不是引用', st.history.at(-1)[1], 3);
eq('越过后笔迹确实变了', st.cell[1], 2);
resetInk(st);
eq('重置清笔迹', key(st.cell), '0,0,0,0,0,0');
eq('重置也清历史', st.history.length, 0);
const st2 = createState(inkB);
for (let i = 0; i < 507; i++) setCell(st2, 1, (i % 3) + 1);
eq('历史封顶 500', st2.history.length, 500);
eq('封顶还留得住最近的', undo(st2), true);
eq('快照是 Int8Array', snapshot(st).history.at(-1) instanceof Int8Array, true);
eq('笔迹也是 Int8Array', createState(inkB).cell instanceof Int8Array, true);

// ---------- 提示来自印着的数字，不来自笔迹 ----------
// 提示脚本 = solve(board).rows，只读线索；玩家写歪了也不会让它改口，写完它就没话可说（不计费）。
const hintScript = solve(mustB).rows;
eq('提示脚本条数（手推的四步）', hintScript.length, 4);
eq('提示脚本第1条', `${hintScript[0].rule.name}/${hintScript[0].cell}/${hintScript[0].value}`, '必经之格/2/2');
eq('提示脚本第2条', `${hintScript[1].rule.name}/${hintScript[1].cell}/${hintScript[1].value}`, '邻区已满/1/3');
const hst = createState(mustB);
let charged = 0;
for (let i = 0; i < 8; i++) {
  const d = nextDeduction(mustB, withClues(mustB, hst.cell)); // 传副本：propagate 会往上写
  if (!d) break;
  if (!setCell(hst, d.cell, d.value)) break;
  charged++;
}
eq('提示计费次数 = 手推的步数', charged, 4);
eq('提示把盘推到底', complete(mustB, hst.cell), true);
eq('没话可说时不再计费', nextDeduction(mustB, withClues(mustB, hst.cell)), null);
eq('推到底之后再点提示还是不计费', charged, 4);
// 写歪一格：第1行第1列 写成 2（正解是 3）。nextDeduction 读的是盘和笔迹的合并，
// 歪笔迹会让夹死的格子暴露出来 —— 它报的是冲突，而不是顺着错误编下一条提示。
// 玩家要是把第1行第1列 写成 2（正解 3）：下一步提示仍然是线索给的那一步（必经之格），
// 引擎不会顺着错笔迹编一个「看起来对」的下一步；而这片笔迹最后会自己撞死。
const wrongCell = Int8Array.from([2, 0, 0, 0, 0, 0]);
eq('写歪一格后：第一步还是线索给的那步', (() => {
  const d = nextDeduction(mustB, withClues(mustB, wrongCell));
  return d && d.rule ? `${d.rule.name}/${d.cell}/${d.value}` : 'conflict';
})(), '必经之格/2/2');
eq('写歪一格后：这笔迹最终救不回来', reachable(mustB, wrongCell), false);
// 而提示脚本本身只认线索：歪笔迹一个字都改不动它
eq('脚本只认线索：歪笔迹改不动它', solve(mustB).rows.map((r) => `${r.cell}:${r.value}`).join(','), '2:2,1:3,0:3,3:3');
eq('脚本逐条对照', hintScript.map((r) => `${r.cell}:${r.value}`).join(','), '2:2,1:3,0:3,3:3');

// ---------- 难度：五档，每档六局 ----------
const medians = [];
for (const t of TIERS) {
  const scores = [];
  let shipped = 0;
  let pencil = 0;
  let uniq = 0;
  let inBand = 0;
  let ms = 0;
  for (let s = 0; s < 6; s++) {
    const q0 = Date.now();
    const r = makePuzzle(`tier-${t.key}#${s}`, t.key);
    ms += Date.now() - q0;
    if (!r) continue;
    shipped++;
    scores.push(r.score);
    if (solve(r.board).ok) pencil++;
    const c = countSolutions(r.board, { cap: 2, budget: 300000 });
    if (c.status === UNIQUE && key(solve(r.board).derived) === key(c.first)) uniq++;
    if (r.score >= t.band[0] && r.score <= t.band[1]) inBand++;
  }
  scores.sort((a, b) => a - b);
  medians.push(scores[3]);
  eq(`${t.key} 出货 6/6`, shipped, 6);
  eq(`${t.key} 每局都能推到底`, pencil, 6);
  eq(`${t.key} 每局都唯一解`, uniq, 6);
  ok(`${t.key} 分数落在区间里（≥5/6）`, inBand >= 5, `${inBand}/6，band ${t.band.join('…')}`);
  ok(`${t.key} 出题不慢（每局 < 900ms）`, ms / 6 < 900, `${Math.round(ms / 6)}ms/局`);
}
let mono = true;
for (let i = 1; i < medians.length; i++) if (!(medians[i] > medians[i - 1])) mono = false;
eq('档位中位分数单调递增', mono, true);
console.log(`  档位中位分数：${medians.join(' → ')}`);

// ---------- 档位表本身 ----------
eq('TIERS 五档', TIERS.length, 5);
eq('档位键顺序', TIERS.map((t) => t.key).join(','), 'trainee,apprentice,regular,expert,master');
eq('档位中文名', TIERS.map((t) => t.name).join(','), '初学,上手,熟练,高阶,大师');
ok('每档都有区间和几何', TIERS.every((t) => t.w > 0 && t.h > 0 && t.maxK > 0 && t.band && t.band[0] < t.band[1] && t.keepRatio > 0 && t.keepRatio < 1), '');
ok('格子只增不减', TIERS.every((t, i) => i === 0 || t.w * t.h > TIERS[i - 1].w * TIERS[i - 1].h), TIERS.map((t) => t.w * t.h).join('/'));
eq('tierFor 认 key', tierFor('regular').name, '熟练');
eq('tierFor 兜底到第 2 档', tierFor('不存在的档').key, TIERS[1].key);
eq('mix 认字符串种子', mix('abc')(), mix('abc')());
eq('mix 不同种子给不同流', mix('abc')() !== mix('abd')(), true);
{
  const a = mix('seed');
  const b = mix('seed');
  eq('mix 同种子逐位一致', [a(), a(), a()].map((x) => x.toFixed(9)).join(','), [b(), b(), b()].map((x) => x.toFixed(9)).join(','));
}
// ---------- 存档形状：读档是从种子重画，不是从内存续命 ----------
// 存下来的只有种子、档位和笔迹。重开时盘必须由同一颗种子重新抽出来，且逐格和当初那张一模一样 ——
// 所以选型的那把钥匙里绝对不许有时钟。这里直接把 Date.now 冻住、再干脆换成一个会抛的假时钟来验。
{
  const save = makePuzzle('resume#7', 'expert');
  if (!ok('读档用例：出得来一盘', !!save)) throw new Error('出货器在 expert 档空手而归，读档这一节无从继续');
  const wasClue = key(save.board.clue);
  const real = Date.now;
  try {
    Date.now = () => 1770000000000;
    const a = makePuzzle('resume#7', 'expert');
    Date.now = () => 1999999999999;
    const b = makePuzzle('resume#7', 'expert');
    eq('冻在 2026 年：同一颗种子同一张题面', key(a.board.clue), wasClue);
    eq('冻到 2033 年：还是同一张', key(b.board.clue), wasClue);
    eq('换个假时钟分数也一模一样', `${a.score}/${b.score}`, `${save.score}/${save.score}`);
    eq('步数、线索数、试作次数都不看时钟', `${a.steps}/${b.steps}/${a.clues}/${b.clues}/${a.gen}/${b.gen}`,
      `${save.steps}/${save.steps}/${save.clues}/${save.clues}/${save.gen}/${save.gen}`);
    // 钥匙本身长什么样：种子 + 第几次试作，两个都是可打印的确定性字符串
    eq('出货记录里的钥匙就是「种子#试作号」', new RegExp(`^${save.originSeed}#\\d+$`).test(save.seed), true);
    eq('钥匙里没有时间戳', /\d{10}/.test(save.seed), false);
  } finally {
    Date.now = real;
  }
  // 时钟不存在：出题路径一次都不许读它
  const real2 = Date.now;
  let threw = '没有抛';
  let blind = null;
  Date.now = () => { throw new Error('这里没有时钟'); };
  try {
    blind = makePuzzle('resume#8', 'master');
  } catch (e) {
    threw = e.message;
  } finally {
    Date.now = real2;
  }
  eq('把 Date.now 换成会抛的，也照样出题', [threw, !!blind].join('/'), '没有抛/true');
  eq('没有时钟时出的盘也是唯一解', blind ? countSolutions(blind.board, { cap: 2, budget: 300000 }).status : 'none', UNIQUE);
  // 真正的读档：只带种子和笔迹回来，重建的盘要能接着同一份笔迹走，且推出来的答案不变
  const play = createState(save.board);
  const pr = solve(save.board);
  for (const row of pr.rows.slice(0, Math.max(1, Math.floor(pr.rows.length / 2)))) setCell(play, row.cell, row.value);
  const archived = { seed: save.originSeed, tier: save.tier, cell: Array.from(play.cell), hints: 2 };
  const back = makePuzzle(archived.seed, archived.tier);
  eq('读档：重建的题面逐格相同', key(back.board.clue), wasClue);
  eq('读档：尺寸档位相同', `${back.w}×${back.h}/${back.tierName}`, `${save.w}×${save.h}/${save.tierName}`);
  const replay = createState(back.board);
  let restored = 0;
  for (const [t, v] of archived.cell.entries()) if (v !== OPEN && setCell(replay, t, v)) restored++;
  eq('读档：笔迹一颗不丢', key(replay.cell), key(play.cell));
  eq('读档：恢复出来的落子数', restored, archived.cell.filter((v) => v !== OPEN).length);
  eq('读档：剩下的路还是同一条', key(solve(back.board).derived), key(pr.derived));
  eq('读档：分数不变', solve(back.board).score, save.score);
  resetInk(replay);
  // 印着的格子内建在合并视图里，没印的地方是 0（不是 -1）：这一格轴的换算就一条 —— 「没印」变成「没写」
  const printed = Int8Array.from(back.board.clue, (v) => (v === NO_CLUE ? OPEN : v));
  eq('读档：清空笔迹后印着的数字还在', key(withClues(back.board, replay.cell)), key(printed));
  eq('读档：没印的地方在笔迹轴上是 0', [...withClues(back.board, replay.cell)].filter((v) => v === OPEN).length, back.board.n - back.board.clues);
}
// ---------- 区间是排序键，不是闸门 ----------
// 「够不着带就不出货」这句话是错的，也不该被写成测试：generate 把所有过闸的候选按 offBand（到带的
// 距离）取最近的留下，带定得再离谱也照样给盘。report 回调把每一次试作都报出来，所以「就近」这件事
// 可以直接验：选中那一局的 offBand 必须等于所有试作里最小的那一个。
{
  const far = generate({ ...TIERS[0], seed: 'farband', band: [9999, 10000], tries: 6 });
  eq('区间高得够不着也出货', far.ok, true);
  ok('够不着时如实记下差多少', far.offBand > 9000 && far.offBand < 10000, `offBand ${far.offBand}`);
  eq('区间隔着十万八千里，盘照样能推到底', solve(far.board).ok, true);
  eq('区间隔着十万八千里，盘照样是唯一解', countSolutions(far.board, { cap: 2, budget: 300000 }).status, UNIQUE);
  const seen = [];
  const pick = generate({ ...TIERS[3], seed: 'nearest', band: [1, 2], tries: 8, report: (x) => seen.push(x) });
  eq('低得够不着也出货', pick.ok, true);
  ok('试作记录不为空', seen.length > 0, `试了 ${seen.length} 次`);
  eq('选中的就是试作里离带最近的那一局', pick.offBand, Math.min(...seen.map((x) => x.offBand)));
  eq('offBand 记的就是到带边的距离', pick.offBand, Math.abs(pick.score - 2));
}
// 预算不够时必须空手而归，不许「差不多就行」：只给 1 个节点的穷举预算，每局都判 OVERBUDGET。
{
  const bad = generate({ ...TIERS[0], seed: 'starved', budget: 1, tries: 3 });
  eq('计数器封顶就不算过', bad.ok, false);
  eq('打不出题的中文原因', bad.reason, '没找到既唯一又能纯逻辑推到底的盘面');
  eq('打不出题时 board 是 null', bad.board, null);
  eq('打不出题时也报告撞顶数', bad.stats.overbudget, bad.stats.pencil);
  ok('确实走到过穷举那一步', bad.stats.pencil > 0, `笔迹能推到底的 ${bad.stats.pencil} 局`);
  eq('预算封顶时一局都不算唯一解', bad.stats.unique, 0);
  const good = makePuzzle('band-check', 'trainee');
  eq('出货时带档位名', good && good.tierName, '初学');
  eq('出货时带尺寸', good && good.size, '5×5');
  const fb = makePuzzle('band-check', '没有这一档');
  eq('不存在的档位也能出题（兜底）', !!fb && fb.tier, TIERS[1].key);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
