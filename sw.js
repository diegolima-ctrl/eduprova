const CACHE = 'eduprova-v2';
const STATIC = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis.com') || url.hostname.includes('jsdelivr.net')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{}', {headers:{'Content-Type':'application/json'}})));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return r;}).catch(()=>caches.match('/index.html')));
    return;
  }
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});

self.addEventListener('message', e => { if(e.data==='skipWaiting') self.skipWaiting(); });
