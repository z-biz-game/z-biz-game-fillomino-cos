// 难度阶梯的实测报告：把每个档位真的出一批题，量出货成功率、命中区间的比例、平均抽取次数、每局耗时、
// 分数四分位、推理步数中位、留下的数字，然后卡六道关：
//   1 阶梯：五档的中位分数严格递增，命中率 ≥ 80%，每局出货；
//   2 出货的盘：笔迹能推到底，且独立计数器逐格同意（歧解、超预算都算不同意）；
//   3 同一盘重解：同分、同步、同结论，计数不撞预算；
//   4 种下的解：每一份都过只认盘面的验收器（未筛选的随机擦除）；
//   5 两道闸：带闸剪枝的盘一律推得完，无闸对照里确实有推不完的；
//   6 带是排序键不是闸门：区间够不着也照样出货，并且选中的必须是所有试作里离带最近的那一局。
// 任何一道关走样都以非零码退出：CI 上 `node tools/balance.mjs` 的返回值就是这张表的结论。
// 跑法：node tools/balance.mjs            （样本数改环境变量：SAMPLES=12 node tools/balance.mjs）
//
// 这里用的计数预算和 generate 内部的预算一致（300000），DFS 是确定性的，所以「出货的盘在这里回来
// 是 OVERBUDGET」这种荒唐事只可能是真 bug —— 它一旦出现就算失败，不当成「跳过」。

import { createBoard, cluesFrom, solve, verify, complete, NO_CLUE, OPEN } from '../js/engine/fillomino.js';
import { countSolutions, UNIQUE } from '../js/engine/count.js';
import { TIERS, generate, makePuzzle, plantSolution, pruneClues, mix } from '../js/engine/generate.js';

const N = Math.max(6, Number(process.env.SAMPLES || 40));
const BUDGET = 300000;
const say = (s) => console.log(s);
let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { bad++; say(`  ✗ ${name}${detail ? `：${detail}` : ''}`); }
  else say(`  ✓ ${name}`);
  return !!cond;
};
const key = (a) => Array.from(a).join(',');
const quantile = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.min(a.length - 1, Math.round((a.length - 1) * p))];
};
const row = (label, arr, fix = (x) => x) =>
  `  ${label.padEnd(12)} p25 ${String(fix(quantile(arr, 0.25))).padStart(5)} 中位 ${String(fix(quantile(arr, 0.5))).padStart(5)}` +
  `  p75 ${String(fix(quantile(arr, 0.75))).padStart(5)} 最高 ${String(fix(quantile(arr, 1))).padStart(5)}`;

say(`埋方块 难度阶梯实测：每档 ${N} 局，独立计数预算 ${BUDGET}\n`);

// ---------- 1. 逐档出货 ----------
const per = [];
for (const t of TIERS) {
  const tag = `balance-${t.key}`;
  const scores = [];
  const steps = [];
  const clueN = [];
  const draws = [];
  const nodes = [];
  const times = [];
  let shipped = 0;
  let pencil = 0;
  let counted = 0;
  let over = 0;
  let many = 0;
  let inBand = 0;
  let ms = 0;
  for (let s = 0; s < N; s++) {
    const q0 = Date.now();
    const r = makePuzzle(`${tag}#${s}`, t.key); // 产品路径：seed + 档位 → 题面
    const dt = Date.now() - q0;
    ms += dt;
    times.push(dt);
    if (!r) continue;
    shipped++;
    const p = solve(r.board);
    if (p.ok) pencil++;
    const c = countSolutions(r.board, { cap: 2, budget: BUDGET });
    if (c.status === UNIQUE && key(p.derived) === key(c.first)) counted++;
    if (c.status === 'OVERBUDGET') over++;
    if (c.status !== UNIQUE && c.status !== 'OVERBUDGET') many++;
    if (r.score >= t.band[0] && r.score <= t.band[1]) inBand++;
    scores.push(r.score);
    steps.push(r.steps);
    clueN.push(r.clues);
    draws.push(r.gen);
    nodes.push(c.nodes);
  }
  say(`—— ${t.key} ${t.name}：${t.w}×${t.h}，最大块 ${t.maxK}，留字比例 ${t.keepRatio}，区间 ${t.band[0]}…${t.band[1]} ——`);
  say(`  出货成功率 ${shipped}/${N}，平均抽 ${(draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length)).toFixed(2)} 次出一题，用时 ${ms}ms（${N} 局，${Math.round(ms / N)}ms/局）`);
  say(`  命中目标区间 ${inBand}/${N}，笔迹能推到底 ${pencil}/${shipped}，独立计数唯一 ${counted}/${shipped}（歧解 ${many}，超预算 ${over}）`);
  say(row('分数', scores));
  say(row('推理步数', steps));
  say(row('留下的数字', clueN));
  say(row('计节点', nodes));
  // 墙钟是观测，不是选盘钥匙（generate 的排序键里没有 ms）。这里报的是**尾巴**：一局的中位便宜、
  // 尾巴能贵三五倍，只报「平均每局」会把慢尾巴说成不慢。绝对值每次打印，换机器只会让出 p95 那一条。
  say(row('出题耗时ms', times, (x) => Math.round(x)));
  check(`${t.key} 出货成功率 ${N}/${N}`, shipped === N, `只出 ${shipped} 题`);
  check(`${t.key} 每局都能推到底`, pencil === shipped, `${pencil}/${shipped}`);
  check(`${t.key} 每局都唯一解（独立计数器复核）`, counted === shipped, `${counted}/${shipped}，歧解 ${many}，超预算 ${over}`);
  check(`${t.key} 命中目标区间 ≥ 80%`, inBand / N >= 0.8, `${inBand}/${N}`);
  check(`${t.key} 平均每局 < 900ms`, ms / N < 900, `${Math.round(ms / N)}ms/局`);
  // p95, not max: the tail here is a machine-speed observation, so the bar is a backstop against a
  // pathological slowdown, and must sit far enough above the measured p95 that a loaded CI runner
  // cannot trip it. The absolute value prints every run, so the real number is never hidden.
  const p95 = quantile(times, 0.95);
  check(
    `${t.key} p95 出题 < 4000ms（实测尾巴见上一行）`,
    Math.max(1, p95) < 4000,
    `p95 ${Math.round(p95)}ms，最慢 ${Math.round(quantile(times, 1))}ms`,
  );
  say('');
  per.push({ tier: t, median: quantile(scores, 0.5), inBand, shipped, ms });
}

// ---------- 2. 档位阶梯 ----------
say('—— 档位阶梯 ——');
const meds = per.map((p) => p.median);
let mono = true;
for (let i = 1; i < meds.length; i++) if (!(meds[i] > meds[i - 1])) mono = false;
say(`  中位分数：${meds.join(' → ')}`);
check('中位分数严格递增', mono, meds.join(' → '));
const hitAll = per.every((p) => p.inBand / p.shipped >= 0.8);
check('每档命中率 ≥ 80%', hitAll, per.map((p) => `${p.tier.key} ${p.inBand}/${p.shipped}`).join(' '));
say('');

// ---------- 3. 独立计数复核 ----------
// 这里刻意用 count:false 的生成器：笔迹过了就当候选，唯一性完全交给那套互不信任的代码判。
// 预算封顶只可能是盘子太大，算 skipped 并同时把阶梯验收拦下来：出货器不该往预算上撞。
say('—— 独立计数复核（前四档 × 4 个种子，生成时不计数）——');
let disagree = 0;
let skipped = 0;
for (const t of TIERS.slice(0, 4)) {
  const stat = { UNIQUE: 0, MANY: 0, NONE: 0, OVERBUDGET: 0 };
  for (let s = 0; s < 4; s++) {
    const r = generate({ ...t, seed: `audit-${t.key}#${s}`, count: false });
    if (!r.ok) { disagree++; say(`  · ${t.key}#${s} 出货器空手而归`); continue; }
    const c = countSolutions(r.board, { cap: 2, budget: BUDGET });
    stat[c.status]++;
    const p = solve(r.board);
    if (c.status === UNIQUE && key(p.derived) !== key(c.first)) { disagree++; say(`  · ${t.key}#${s} 唯一解和笔迹推出来的不是一份`); }
    if (c.status !== UNIQUE && c.status !== 'OVERBUDGET') disagree++;
    if (c.status === 'OVERBUDGET') skipped++;
  }
  say(`  ${t.key}：${JSON.stringify(stat)}`);
}
check('独立计数器全部同意（歧解／超预算都算不同意）', disagree === 0, `不同源 ${disagree}`);
check('没有一盘撞到计数预算', skipped === 0, `超预算 ${skipped}`);
say('');

// ---------- 4. 复解一致 ----------
say('—— 同一盘重解 ——');
let drift = 0;
let maxNodes = 0;
for (const t of TIERS) {
  for (let s = 0; s < 3; s++) {
    const r = makePuzzle(`repeat-${t.key}#${s}`, t.key);
    if (!r) { drift++; continue; }
    const a = solve(r.board);
    const b = solve(r.board);
    const c = countSolutions(r.board, { cap: 2, budget: BUDGET });
    maxNodes = Math.max(maxNodes, c.nodes);
    if (a.score !== b.score || a.steps !== b.steps || key(a.derived) !== key(b.derived)) drift++;
  }
}
say(`  最贵的一次独立计数吃了 ${maxNodes} 个节点（预算 ${BUDGET}）`);
check('同盘重解同分同步同结论', drift === 0, `漂移 ${drift}`);
check('计数器留在预算内', maxNodes < BUDGET, `最高 ${maxNodes}`);
say('');

// ---------- 5. 种下的解 vs 验收器 ----------
// 出题器的全部底气是「结构上先有一个合法分区」。这里把那些分区直接喂给只认盘面和笔迹的验收器：
// 剪枝用的是无规则的随机擦除（不带 generate 里那道笔迹 gate），所以合法的解配上任意一堆剩下的数字
// 都必须继续被判为「已完整」—— 擦掉线索只会让题目更难，绝不会让一个正确答案变成错答案。
say('—— 种下的解 vs 只认盘面的验收器（未筛选的随机擦除）——');
const RAW_TARGET = 12; // 每档 12 个分区 × 4 种擦法 = 60 份布局
let raw = 0;
let rejected = 0;
let attempts = 0;
let partial = 0;
let partialBad = 0;
let empty = 0;
let emptyBad = 0;
for (const t of TIERS) {
  let plants = 0;
  for (let a = 0; a < 40 && plants < RAW_TARGET; a++) {
    attempts++;
    const rand = mix(`raw-${t.key}#${a}`);
    const sol = plantSolution(t.w, t.h, t.maxK, rand);
    if (!sol) continue;
    let full;
    try {
      full = createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue: cluesFrom(t.w, t.h, sol) });
    } catch {
      rejected++;
      plants++;
      continue;
    }
    for (const cut of [0.25, 0.5, 0.75, 1]) {
      const clue = Int8Array.from(full.clue);
      const r2 = mix(`cut-${t.key}#${a}-${cut}`);
      for (const i of [...clue.keys()]) if (r2() < cut) clue[i] = NO_CLUE;
      // 擦到一颗不剩时 createBoard 是对的：那是「盘上没有数字」，不是一道题。这里要测的是「线索少到
      // 几乎没有了」，所以先把这条规矩量下来，再补一颗数字把题面立住。
      if (clue.every((v) => v === NO_CLUE)) {
        empty++;
        try {
          createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue: Int8Array.from(clue) });
          emptyBad++;
        } catch (e) {
          if (!String(e.message).includes('盘上没有数字')) emptyBad++;
        }
        clue[0] = sol[0];
      }
      let board;
      try {
        board = createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue });
      } catch {
        rejected++;
        continue;
      }
      raw++;
      if (verify(board, sol).length || !complete(board, sol)) rejected++;
      // 少一格就不算完：验收器认的是笔迹铺满，不是「推得动」
      const hole = [...clue].indexOf(NO_CLUE);
      if (hole < 0) continue;
      const half = Int8Array.from(sol);
      half[hole] = OPEN;
      partial++;
      if (complete(board, half) || !verify(board, half).some((x) => x.why === '空格')) partialBad++;
    }
    plants++;
  }
}
say(`  试了 ${attempts} 次种分区，逐局检查 ${raw} 份「解 + 随机擦剩的线索」盘面，另有 ${partial} 次留了一格空`);
say(`  其中 ${empty} 次把数字擦得一个不剩，createBoard 拒绝立案 ${empty - emptyBad} 次（「盘上没有数字」不是一道题）`);
check('种下的解每一份都过验收器（块数＝写的数，没有空格）', rejected === 0, `不合格 ${rejected}`);
check('留一格空的盘一律不算通关，且被报成空格', partialBad === 0, `看走眼 ${partialBad}`);
check('擦光数字的盘一律被拒，理由是「盘上没有数字」', emptyBad === 0, `走样 ${emptyBad}`);
check('样本量够（≥ 60 份未筛选布局）', raw >= 60, `只有 ${raw}`);
say('');

// ---------- 6. 出货器的闸：擦数字的时候重跑一遍笔迹 ----------
// 同一张分区、同样擦到 target 颗，两条路：pruneClues（每擦一颗都问一次 solve()，推不完的那一擦不算）
// 和一条无闸的随机擦除。带闸的那份就是出货盘的样子，必须一张不漏地推得完；无闸那份是「唯一解但铅笔
// 推不完」的富矿。两边一比，才知道这道闸到底在拦什么 —— 铅笔只保证可靠（写下的每格都在每条解里成立），
// 不完全（推不完唯一解），gap 就摊在这里量出来。
say('—— 出货器的闸（带闸剪枝 vs 无闸擦到同样颗数）——');
let gated = 0;
let gatedStalled = 0;
let gatedNotUnique = 0;
let loose = 0;
let looseUnique = 0;
let looseStalled = 0;
for (const t of TIERS) {
  for (let a = 0; a < 6; a++) {
    const rand = mix(`gate-${t.key}#${a}`);
    const sol = plantSolution(t.w, t.h, t.maxK, rand);
    if (!sol) continue;
    let full;
    try {
      full = createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue: cluesFrom(t.w, t.h, sol) });
    } catch {
      continue;
    }
    const target = Math.max(1, Math.round(t.w * t.h * t.keepRatio));
    const kept = createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue: pruneClues(full, mix(`g-${t.key}#${a}`), target) });
    const gp = solve(kept);
    gated++;
    if (!gp.ok) gatedStalled++;
    if (countSolutions(kept, { cap: 2, budget: BUDGET }).status !== UNIQUE) gatedNotUnique++;
    // 无闸对照：同样擦到 target 颗，只是不看笔迹
    const clue = Int8Array.from(full.clue);
    const r2 = mix(`l-${t.key}#${a}`);
    let have = full.clues;
    while (have > target) {
      const j = Math.floor(r2() * clue.length);
      if (clue[j] !== NO_CLUE) {
        clue[j] = NO_CLUE;
        have--;
      }
    }
    const lb = createBoard({ w: t.w, h: t.h, maxK: t.maxK, clue });
    loose++;
    const c = countSolutions(lb, { cap: 400, budget: 400000, all: true });
    if (c.status === UNIQUE) {
      looseUnique++;
      if (!solve(lb).ok) looseStalled++;
    }
  }
}
say(`  带闸剪枝 ${gated} 张：笔迹推不完 ${gatedStalled} 张，非唯一解 ${gatedNotUnique} 张`);
say(`  无闸擦到同样颗数 ${loose} 张：唯一解 ${looseUnique} 张，其中笔迹推不完 ${looseStalled} 张（＝出货器拦掉的那一类）`);
check('带闸剪枝的盘全都能纯计数推完', gatedStalled === 0, `${gatedStalled}/${gated}`);
check('带闸剪枝的盘全是唯一解（出货的底气）', gatedNotUnique === 0, `${gatedNotUnique}/${gated}`);
check('无闸对照里出现过「唯一解但推不完」（闸不是空转）', looseStalled > 0, `推不完 ${looseStalled}/${looseUnique} 条唯一解`);
say('');

// ---------- 7. 带是排序键，不是闸门 ----------
// 「够不着带就不出货」这句话是错的：generate 把所有过闸的候选按 offBand（到带的距离）留最近的，
// 带定得再离谱也照样给盘。report 回调把每一次试作都报出来，所以「就近」可以直接对答案。
say('—— 区间够不着时照样出货，只是就近取 ——');
let bandBad = 0;
for (const t of TIERS) {
  for (const band of [[9999, 10000], [1, 2]]) {
    const seen = [];
    const r = generate({ ...t, seed: `band-${t.key}-${band[0]}`, band, tries: 12, report: (x) => seen.push(x.offBand) });
    if (!r.ok) {
      bandBad++;
      say(`  · ${t.key} 带 ${band.join('…')}：${r.reason}（试作 ${seen.length} 次）`);
      continue;
    }
    const nearest = Math.min(...seen);
    const p = solve(r.board);
    const c = countSolutions(r.board, { cap: 2, budget: BUDGET });
    let why = '';
    if (Math.abs(r.offBand - nearest) > 1e-9) why = `选中的不是最近的那局：${r.offBand} vs 最近 ${nearest}`;
    else if (!p.ok) why = '出货的盘推不完';
    else if (c.status !== UNIQUE) why = `出货的盘不唯一（${c.status}）`;
    else if (!(r.offBand > 0)) why = `offBand 居然还是 0：${r.offBand}`;
    if (why) bandBad++;
    say(`  ${t.key} 带 ${band.join('…')}：出货 ${r.score} 分，离带 ${r.offBand.toFixed(1)}，试作 ${seen.length} 次里最近的就是它${why ? ` —— ${why}` : ''}`);
  }
}
check('区间够不着时：照样出货、照样选最近、盘照样唯一且推得完', bandBad === 0, `走样 ${bandBad}`);
say('');

say(bad
  ? `共 ${bad} 处失败`
  : '全部通过：阶梯单调、出货的盘独立计数同意、重解同分、种下的解过验收、闸不空转、带只排序');
process.exit(bad ? 1 : 0);
