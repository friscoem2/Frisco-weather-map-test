(function(){
  'use strict';
  if(!('serviceWorker' in navigator))return;
  let accepted=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(accepted)window.location.reload();});
  window.addEventListener('load',async()=>{
    try {
      const registration=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
      const notice=document.getElementById('app-update');
      const show=()=>{if(registration.waiting && navigator.serviceWorker.controller)notice.hidden=false;};
      show();
      registration.addEventListener('updatefound',()=>{
        registration.installing?.addEventListener('statechange',show);
      });
      document.getElementById('app-update-refresh').addEventListener('click',()=>{
        if(!registration.waiting)return;
        accepted=true;registration.waiting.postMessage({type:'SKIP_WAITING'});
      });
    } catch(error){console.warn('Offline shell is unavailable:',error.message);}
  });
})();
