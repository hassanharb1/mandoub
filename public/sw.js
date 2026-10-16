const CACHE="mandoub-v6";
const SHELL=["./","index.html","catalog.js","manifest.json","icon-192.png","icon-512.png","icon-maskable.png"];
// product photos: listed in catalog.js, saved in the background so the catalog works offline
try{importScripts("catalog.js")}catch(e){}
const IMGS=[...new Set(((self.CATALOG||{}).products||[]).map(p=>p.img).filter(Boolean))];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>{c.addAll(IMGS).catch(()=>{});return c.addAll(SHELL)}).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  if(url.origin===location.origin&&url.pathname.includes("/img/p/")){
    // photos don't change between releases (a new CACHE name clears them), so cache first
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{if(res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}return res})));
  } else if(url.origin===location.origin){
    // network first for the page so updates arrive, cache fallback offline
    e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))));
  } else if(url.host.includes("fonts.g")){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return res})));
  }
});
