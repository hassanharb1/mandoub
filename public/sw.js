const CACHE="mandoub-v14";
const SHELL=["./","index.html","catalog.js","manifest.json","icon-192.png","icon-512.png","icon-maskable.png"];
const PHOTOS="catalog-img.js"; // ~850 KB of product photos, only changes with a release
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>{c.add(PHOTOS).catch(()=>{});return c.addAll(SHELL)}).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
const put=(req,res)=>{if(res&&res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put(req,cp))}return res};
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  if(url.origin===location.origin&&url.pathname.endsWith("/"+PHOTOS)){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>put(e.request,res))));
  } else if(url.origin===location.origin){
    // network first so updates arrive, but a slow line falls back to the saved copy after 4 s instead of hanging on the splash screen
    e.respondWith(new Promise(resolve=>{let done=false;
      const fromCache=()=>caches.match(e.request).then(r=>r||caches.match("index.html"));
      const t=setTimeout(()=>fromCache().then(r=>{if(r&&!done){done=true;resolve(r)}}),4000);
      fetch(e.request).then(res=>{put(e.request,res);clearTimeout(t);if(!done){done=true;resolve(res)}})
        .catch(()=>{clearTimeout(t);fromCache().then(r=>{if(!done){done=true;resolve(r||Response.error())}})})}));
  } else if(url.host.includes("fonts.g")){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>put(e.request,res))));
  }
});
