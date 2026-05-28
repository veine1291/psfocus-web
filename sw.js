// PSFocus mobile · Service Worker
// 目的:Chrome / Safari iOS 杀掉 tab 重新加载时,不依赖网络也能起来 — 防「无法打开此网页」
// 策略:app shell(html / js / css)走 stale-while-revalidate,云端 API(CloudBase)绝不拦
const SW_BUILD = '20260528-0922';
const CACHE_NAME = 'psfocus-shell-' + SW_BUILD;
const SHELL_URLS = ['./', './index.html', './app.js', './style.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => Promise.all(
        SHELL_URLS.map(u => fetch(u, { cache: 'reload' }).then(r => r.ok && c.put(u, r.clone())).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // 清掉老 cache(同 prefix 不同版本 的 → 干掉)
  e.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => n.startsWith('psfocus-shell-') && n !== CACHE_NAME).map(n => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 只接管自己域名下的 GET 请求;跨域请求(CloudBase 等)完全不动
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 只缓存 app shell(html / js / css)— 别的(图标、动态资源)绕开
  const isShell = url.pathname === '/' || /\.(html|js|css)$/i.test(url.pathname);
  if (!isShell) return;

  // stale-while-revalidate:先吐 cache,后台拉网络更新 cache
  // 没 cache 时就走网络,网络也失败时返回 cache 里 fallback(/ 或 index.html)
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 关键:**不**忽略 query string —— 否则 app.js?v=新 会命中老缓存,版本号 bump 失效
    // 不同 ?v= 算两个不同 URL 各自缓存;同 URL 走 stale-while-revalidate
    const cached = await cache.match(req);
    const networkPromise = fetch(req)
      .then(res => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => null);
    if (cached) {
      // 有缓存 → 立刻给浏览器,网络更新在后台静默进行
      networkPromise.catch(() => {});
      return cached;
    }
    // 没缓存 → 等网络
    const netRes = await networkPromise;
    if (netRes) return netRes;
    // 网络也挂了 → 兜底 index.html(避免「无法打开此网页」白屏)
    // fallback 还是用 ignoreSearch:true,任意 query 都能 fallback 到一个 index.html
    const fallback = await cache.match('./index.html', { ignoreSearch: true })
      || await cache.match('./', { ignoreSearch: true });
    if (fallback) return fallback;
    return new Response('Offline — 没有缓存可用,请连接网络后重试', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
  })());
});
