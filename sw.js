const CACHE='collect-clock-v12';
const CORE=['./','./index.html','./alerts.js','./bonus-data.json','./manifest.json','./assets/icon.svg','./assets/icon-180.png','./assets/icon-192.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));return res}).catch(()=>caches.match(event.request).then(r=>r||new Response('Offline',{status:503}))))});
// Background alerts from collectclock-api (Web Push). Payload: {title, body, tag, site, key, collect, url, ts}.
self.addEventListener('push',event=>{let d={};try{d=event.data?event.data.json():{}}catch{d={body:event.data?event.data.text():''}}
event.waitUntil(self.registration.showNotification(d.title||'CollectClock',{body:d.body||'',tag:d.tag||'cc',renotify:true,icon:'assets/icon-192.png',badge:'assets/icon-192.png',timestamp:d.ts||Date.now(),data:{url:d.url||self.registration.scope,site:d.site||'',key:d.key||'',collect:d.collect||''}}))});
// Tap: focus an open CollectClock window on that site, or open one at #cc_site=<site>.
self.addEventListener('notificationclick',event=>{event.notification.close();const d=event.notification.data||{};const target=new URL(d.url||'./',self.registration.scope).href;
event.waitUntil((async()=>{const wins=await self.clients.matchAll({type:'window',includeUncontrolled:true});const w=wins.find(c=>c.url.startsWith(self.registration.scope));if(w){try{await w.focus()}catch{}w.postMessage({type:'cc-focus',site:d.site,key:d.key,collect:d.collect});return}await self.clients.openWindow(target)})())});
