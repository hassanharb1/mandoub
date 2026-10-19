const CACHE="mandoub-v27";
const SHELL=["./","index.html","catalog.js","manifest.json","icon-192.png","icon-512.png","icon-maskable.png"];
const PHOTOS="catalog-img.js"; // ~850 KB of product photos, only changes with a release
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>{c.add(PHOTOS).catch(()=>{});return c.addAll(SHELL.map(u=>new Request(u,{cache:"reload"})))}).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&k!=="mandoub-notify").map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
const put=(req,res)=>{if(res&&res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put(req,cp))}return res};
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  if(url.searchParams.has("check"))return; // the app's "is there a newer version?" check goes straight to the network
  if(url.origin===location.origin&&url.pathname.endsWith("/"+PHOTOS)){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>put(e.request,res))));
  } else if(url.origin===location.origin){
    // network first so updates arrive, but a slow line falls back to the saved copy after 4 s instead of hanging on the splash screen
    e.respondWith(new Promise(resolve=>{let done=false;
      const fromCache=()=>caches.match(e.request).then(r=>r||caches.match("index.html"));
      const t=setTimeout(()=>fromCache().then(r=>{if(r&&!done){done=true;resolve(r)}}),4000);
      // no-cache: always ask the server (it answers "not modified" cheaply), so the browser's own HTTP cache never hands back an old file
      fetch(new Request(e.request.url,{cache:"no-cache",credentials:"same-origin"})).then(res=>{put(e.request,res);clearTimeout(t);
          if(!done){done=true;resolve(res)}
          // the page already opened from the saved copy: tell it a fresh copy has arrived
          else if(e.request.mode==="navigate"&&res.ok)self.clients.matchAll({type:"window"}).then(cs=>cs.forEach(c=>c.postMessage({type:"fresh"})))})
        .catch(()=>{clearTimeout(t);fromCache().then(r=>{if(!done){done=true;resolve(r||Response.error())}})})}));
  } else if(url.host.includes("fonts.g")){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>put(e.request,res))));
  }
});

/* reminders: the app leaves notify.json (items with the time each becomes due) in the "mandoub-notify" cache */
async function remind(){
  if(self.Notification&&Notification.permission!=="granted")return;
  const c=await caches.open("mandoub-notify");const r=await c.match("notify.json");if(!r)return;
  const {items}=await r.json();const now=Date.now();const due=(items||[]).filter(i=>i.due<=now);if(!due.length)return;
  // don't repeat the same list more than once every 20 hours
  const key=due.map(i=>i.t).join("|");const last=await c.match("last.json");const prev=last?await last.json():{};
  if(prev.key===key&&now-prev.at<20*3600e3)return;
  await c.put("last.json",new Response(JSON.stringify({key,at:now})));
  await self.registration.showNotification(due.length>1?`محتاج تفتكر (${due.length})`:"محتاج تفتكر",
    {body:due.slice(0,4).map(i=>"• "+i.t).join("\n")+(due.length>4?`\nو ${due.length-4} كمان`:""),icon:"icon-192.png",badge:"icon-192.png",tag:"mandoub-remind",dir:"rtl",lang:"ar"});
}
self.addEventListener("periodicsync",e=>{if(e.tag==="mandoub-remind")e.waitUntil(remind())});
self.addEventListener("notificationclick",e=>{e.notification.close();
  e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{const w=ws.find(x=>"focus" in x);return w?w.focus():clients.openWindow("./")}))});
