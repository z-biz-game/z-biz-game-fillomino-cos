# 埋方块 · Fillomino（零猜测区域格数推理） · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

一个浏览器原生的 Fillomino：格子里写的不是线索，是这块的面积。整本规则只有一句话——每一块相连的同数区域，格数刚好等于它写着的那个数。

- 仓名：`z-biz-game-fillomino-cos`　组别：E · 生成艺术与交互视觉
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm run start    # node server.cjs 5255
```

README 的快速开始：

```sh
npm start            # http://127.0.0.1:5255/  零依赖静态服务器
npm run check        # 每个源文件 node --check，解析不过就红
npm test             # 1060 条纯 node 断言：引擎 509 + 存档/动效定步长 129 + 关卡内三档对拍 370 + 行为复验 52
npm run balance      # 难度阶梯实测：每档 40 局，六道关（`SAMPLES=12 npm run balance` 可缩样）
npm run verify       # 门禁：上面四套 + 一个真 headless Chrome 跑 13 个场景遍、655 条断言
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |
| 文档腿 | `node tools/docs-test.mjs` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 62 |
| 应用代码 | 4,208 行（JS 3,330 / CSS 687 / HTML 191） |
| 测试/工具文件 | 14 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 1 |
| 位图资产（不含 shots） | 20 个 / 602 KB |

## 目录

```
.github .gitignore DESIGN.md LICENSE README.md assets css electron icons index.html js manifest.webmanifest package.json server.cjs sw.js tools
```

## 已知边界

- **最大块锁 4**。计数器每格走 1..maxK，所以 7×7 配最大块 6 会烧掉六位数的节点：同一台机器各出 4 局
  对照，maxK 4 是 4/4 出货、0 次撞预算、每次调用 40–117ms；maxK 6 是 24 次试作里 **4 次撞预算**、
  每次调用 429–1272ms。整条阶梯因此住在 maxK 4、5×5→7×7 这五格里（量法与结果在 `/tmp` 的一次性脚本里，
  原始判断记在 `js/engine/generate.js:206` 的注释）。
- **`必经之格` 有一个便宜的截断**：一块还能圈到的地方超过 `n+12` 格时这一轮不做绕路勘察。
  它只会少推一步，不会推错一步（漏掉的格本来也没被这条定死）。
- **`reachable()` 是单向的**：它说「不合法」时一定不合法，说「还行」时可能已经死了。
  盘上那个「这笔已经来不及了」只在它报警时出现，从不反过来承诺。
- **高阶与大师的区间重叠**（52…60 与 58…67）：两档的差别是盘面大小与印数密度，
  大师的中位（62.4）确实高于高阶（55.2），但同一分数的两盘是可能各自出货的。
- **减少动效只测了按钮那一路**：`motion` 场景按的是顶栏的动效按钮；系统级的
  `prefers-reduced-motion` 在开机时被读一次（`js/theme.js:109`）并写进同一个设置，但门禁不模拟
  媒体查询，所以这条路是「实现了、没测到」。
- 存档不是防作弊设计：改 `localStorage` 能伪造纪录，这个仓没有服务端可以核对。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-fillomino-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
