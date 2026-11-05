'use strict';
const CACHE_NAME='spiralcam-app-v4';
const SHELL=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png',
  './examples/animal-cat.webp','./examples/animal-dog.webp','./examples/animal-bird.webp','./examples/animal-butterfly.webp','./examples/animal-fox.webp'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('spiracam-app-')||k.startsWith('spiralcam-app-'))&&k!==CACHE_NAME).map(k=>caches.delete(k)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy)).catch(()=>{});}
    return response;
  }).catch(async()=>await caches.match(request)||await caches.match('./index.html')));
});
