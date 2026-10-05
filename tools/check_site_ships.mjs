#!/usr/bin/env node
// 装配自查：把「声明过本地路径」这件事和「那条路径真的进了产物」钉在一起。
//
//   node tools/check_site_ships.mjs <站点目录>
//
// 为什么要有它：Pages 那条腿是手工 `cp` 几个目录（见 .github/workflows/pages.yml），
// 加一类资产就漏一类的风险全在人的记性上。本仓曾经只拷 index.html/css/js，于是
// manifest.webmanifest、sw.js、assets/** 统统不上线——装机提示、图标、离线壳、社交卡图、
// 格子纸纹理与彩带贴图在部署站上全是 404，而所有本仓的闸都只看得到盘上的文件，一条都不红。
// 现在装配完就跑这一句：index.html 与 manifest 里每一个同源相对路径都必须在产物里，
// 少一条就非零退出。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SITE = path.resolve(process.argv[2] || '.');
const missing = [];
const checked = [];

function add(from, raw) {
  // 只查同源、无协议、无域名的相对路径；data:/http(s):/#/mailto: 一律放过。
  if (!raw || /^(data:|blob:|https?:|\/\/|#|mailto:|tel:)/i.test(raw)) return;
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return;
  const abs = path.resolve(SITE, clean);
  checked.push(`${from} → ${clean}`);
  if (!existsSync(abs)) missing.push(`${from}: ${raw}`);
}

const htmlPath = path.join(SITE, 'index.html');
if (!existsSync(htmlPath)) {
  console.error(`产物里没有 index.html：${SITE}`);
  process.exit(1);
}
const html = readFileSync(htmlPath, 'utf8');
for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) add('index.html', m[1]);
for (const m of html.matchAll(/content\s*=\s*["']((?:https?:\/\/[^"'/]*)?\/z-biz-game-fillomino-cos\/[^"']+\.(?:png|jpg|jpeg|webp|svg|ico))["']/g)) {
  add('index.html(og:image)', m[1].replace(/^https?:\/\/[^/]*/, '').replace(/^\/z-biz-game-fillomino-cos\//, ''));
}

const mfPath = path.join(SITE, 'manifest.webmanifest');
if (!existsSync(mfPath)) missing.push('manifest.webmanifest: 产物里没有这个文件（PWA 不可安装）');
else {
  let mf;
  try { mf = JSON.parse(readFileSync(mfPath, 'utf8')); } catch (e) { missing.push(`manifest.webmanifest 不可解析：${e.message}`); }
  if (mf) {
    for (const i of mf.icons || []) add('manifest:icons', i.src);
    for (const s of mf.shortcuts || []) {
      add('manifest:shortcuts.url', s.url);
      for (const i of s.icons || []) add(`manifest:shortcuts[${s.name}]`, i.src);
    }
  }
}

// 服务工作者：注册代码在 js/main.js 里按 location.protocol 判断，产物里必须有这个文件本身。
if (!existsSync(path.join(SITE, 'sw.js'))) missing.push('sw.js: 产物里没有（离线壳不存在）');

// 运行时按名取的两张位图不在任何 link/manifest 里声明，只能从源码里抓。
for (const f of ['js/main.js']) {
  const src = path.join(SITE, f);
  if (!existsSync(src)) { missing.push(`${f}: 产物里没有`); continue; }
  for (const m of readFileSync(src, 'utf8').matchAll(/asset\(\s*['"]([^'"]+)['"]/g)) add(f, m[1]);
}

console.log(`站点 ${SITE}：核对 ${checked.length} 条同源声明`);
if (missing.length) {
  for (const m of missing) console.error('  缺 ' + m);
  console.error(`${missing.length} 条声明的路径没进产物 —— 部署站上就是 404`);
  process.exit(1);
}
console.log('  全部命中');
