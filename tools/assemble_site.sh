#!/usr/bin/env bash
# 装配「能静态托管的那一份」并当场核对声明过的路径都进了产物。
#
#   bash tools/assemble_site.sh _site
#
# 这条腿是 Pages 与 CI 共用的唯一副本：拷贝清单只写在这里一次，
# 所以「CI 绿、部署站上 404」这种分叉结构上不可能再出现——之前 pages.yml 里手写
# `cp index.html; cp -r css js`，漏了 manifest.webmanifest / sw.js / assets/**，
# 12 条被 index.html 与 manifest 声明的路径在线上全是 404，而本地闸一条都不红。
#
# 不拷 server.cjs / electron / tools / 文档，也就不会把 node_modules 带进产物。
set -eu

DEST=${1:?用法: bash tools/assemble_site.sh <输出目录>}
HERE=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$HERE/index.html" "$HERE/manifest.webmanifest" "$HERE/sw.js" "$DEST/"
cp -r "$HERE/css" "$HERE/js" "$HERE/assets" "$DEST/"

node "$HERE/tools/check_site_ships.mjs" "$DEST"
