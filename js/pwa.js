(function registerAwWeatherPwa(){
  if (!('serviceWorker' in navigator)) return;
  // Service workers require HTTPS or localhost. This is what allows mobile browsers
  // to install this map as a standalone/fullscreen web app.
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('./sw.js').catch(function(err){
      console.warn('AW Weather service worker registration failed:', err);
    });
  });
})();
