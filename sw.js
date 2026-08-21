// PSFocus mobile · Service Worker
// 目的:Chrome / Safari iOS 杀掉 tab 重新加载时,不依赖网络也能起来 — 防「无法打开此网页」
// 策略:app shell(html / js / css)走 stale-while-revalidate,云端 API(CloudBase)绝不拦
const SW_BUILD = '20260821-1046';
const CACHE_NAME = 'psfocus-shell-' + SW_BUILD;
// 注意带 ?v=:fetch 处理器【不】忽略 query,所以预缓存的 key 必须跟 index.html
// 里实际请求的 URL 一模一样,否则预缓存永远命中不到(2026-08-20 修)。
// SDK 也一起预缓存 —— 它现在放自己域名,离线时靠它 + 本地快照仍能看数据。
const SHELL_URLS = ['./', './index.html',
  './app.js?v=' + SW_BUILD, './style.css?v=' + SW_BUILD, './cloudbase.full.js?v=' + SW_BUILD];

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

  // 两种策略,按资源性质分:
  //   · HTML 是「版本指针」(里面写着该加载哪个 app.js?v=xxx)→ 必须新鲜 → 网络优先
  //   · 带 ?v= 的资源每个版本一个 URL,天然不可变 → 缓存优先,命中就完全不碰网络
  const isDoc = url.pathname === '/' || /\.html$/i.test(url.pathname) || req.mode === 'navigate';

  const offline = () => new Response('Offline — 没有缓存可用,请连接网络后重试', {
    status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    if (isDoc) {
      const cached = await cache.match(req, { ignoreSearch: true });
      // cache:'no-cache' —— 强制回源校验。不加的话这次 fetch 会吃浏览器自己的 HTTP 缓存,
      // 服务器没给 Cache-Control 时浏览器按启发式缓存,SW 拿到的还是旧的(实测踩到)。
      // 没变就是个 304,很便宜。
      const netP = fetch(url.pathname + url.search, { cache: 'no-cache' })
        .then(async (res) => {
          if (res && res.ok) { try { await cache.put(req, res.clone()); } catch (_) {} }
          return res;
        })
        .catch(() => null);
      // ⚠️ 2026-08-20 根因修复:后台更新必须挂 e.waitUntil。
      // 之前没挂 —— respondWith 一吐出缓存,iOS Safari 立刻把 Service Worker 杀掉,
      // 后台的 fetch + cache.put 根本跑不完 → 缓存从此定格,再也不更新。
      // 实测后果:用户手机的 app.js 卡在 2026-07-14 抓到的那一份(build 20260710-0426),
      // 之后一个多月所有部署全都没到达。sw.js 自己内容不变时浏览器也不换 SW,于是彻底锁死。
      e.waitUntil(netP);
      if (!cached) return (await netP) || offline();
      // 有缓存:最多等 2.5s 网络,超时先上缓存(后台继续把新的存下来)。
      // 有网 = 一定拿到最新版本指针;没网 = 照样能开。
      const winner = await Promise.race([netP, new Promise(r => setTimeout(() => r(null), 2500))]);
      return winner || cached;
    }

    // 版本化资源:不忽略 query —— ?v= 变了就是另一个 URL,必须走网络,否则版本号 bump 失效
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req).catch(() => null);
    if (res && res.ok) e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    if (res) return res;
    const fb = await cache.match('./index.html', { ignoreSearch: true })
      || await cache.match('./', { ignoreSearch: true });
    return fb || offline();
  })());
});
