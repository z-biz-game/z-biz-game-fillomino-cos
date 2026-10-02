// 离线壳。两条纪律写在这里，因为它们是这个文件最容易悄悄做错的两件事：
//
// 1) 缓存名带版本号（VERSION）。不带版本的 cache 会让旧版本的文件在用户设备上活到永远，
//    出新 HTML 配旧 js 的鬼状态就是这么来的。activate 时把非本版名的 cache 全删掉。
// 2) 同源子资源一律**网络优先、失败退缓存**。cache-first 会把 js/css 钉死在第一次存进去的
//    那份上——版本号再新也没用，因为请求根本没出网。只有导航请求（打开应用）才允许先尝缓存。
//
// file:// 下不注册（注册代码在 js/main.js 里按协议判断），这个文件本身也不会在该协议下被加载。

const VERSION = 'fillomino-v1.0.0';
const CACHE = `${VERSION}-shell`;

// 预缓存的只是壳：盘面、样式、引擎与图标。生成器是确定性的，所以一局牌不需要任何网络。
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/audio/synth.js',
  './js/engine/fillomino.js',
  './js/engine/generate.js',
  './js/engine/count.js',
  './js/render/board.js',
  './js/render/fx.js',
  './js/ui/game.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-16.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-48.png',
  './assets/img/paper-grid.png',
  './assets/img/particles.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))))
      .catch(() => { /* 单张图标取不到不该阻塞安装：运行期还有网络优先这条路 */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 字体、CDN 一概不碰

  // 导航：离线也要打得开，所以退路是壳里的 index.html。
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html') || caches.match('./')))
    );
    return;
  }

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)) // 断网：退到上一次成功取到的那份；取不到就是 undefined，让请求如实失败
  );
});
