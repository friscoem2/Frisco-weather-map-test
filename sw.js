// Changed by deployment using the commit SHA; bump locally when shell files change.
const AW_CACHE = 'aw-weather-shell-v9-mobile-dashboard';
const AW_SHELL = ['./','./index.html','./css/styles.css','./css/dashboard.css','./js/config.js','./js/app.js','./js/weather-data.js','./js/frisco/frisco-layers.js','./js/pwa.js','./manifest.json','./icons/icon-192.png','./icons/icon-512.png','./vendor/leaflet/leaflet.js','./vendor/leaflet/leaflet.css','./vendor/leaflet/images/layers.png','./vendor/leaflet/images/layers-2x.png','./vendor/leaflet/images/marker-icon.png','./vendor/leaflet/images/marker-icon-2x.png','./vendor/leaflet/images/marker-shadow.png'];
const SHELL_URLS = new Set(AW_SHELL.map(path=>new URL(path,self.registration.scope).href));
self.addEventListener('install',event=>{
  // A new worker waits for user consent. Never replace the running app mid-loop.
  event.waitUntil(caches.open(AW_CACHE).then(cache=>cache.addAll(AW_SHELL.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'})))));
});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('aw-weather-shell-')&&key!==AW_CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  // No respondWith for external data: NWS, NOAA, radar, GIS, basemaps and cameras bypass us entirely.
  if(request.method!=='GET'||url.origin!==self.location.origin||!SHELL_URLS.has(url.href))return;
  event.respondWith((async()=>{
    try {
      const response=await fetch(request);
      if(response.ok && response.type==='basic') {
        const copy=response.clone();
        event.waitUntil(caches.open(AW_CACHE).then(cache=>cache.put(request,copy)).catch(()=>{}));
      }
      return response;
    } catch(error) {
      const cached=await caches.match(request,{cacheName:AW_CACHE});
      if(cached)return cached;
      // Never return HTML for a missing JavaScript, stylesheet or image request.
      return Response.error();
    }
  })());
});
