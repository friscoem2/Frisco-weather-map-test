const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const reports=[];const pass=name=>reports.push('PASS '+name);
async function weatherTests(){
 const elements=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',children:[],classList:{toggle(){}},disabled:false});return elements.get(id);};
 let failObs=false,failHourly=false,allFail=false;
 const calls=[];
 const now=Date.now(),period={startTime:new Date(now-60000).toISOString(),endTime:new Date(now+3600000).toISOString(),temperature:70,temperatureUnit:'F',isDaytime:true,name:'Today',shortForecast:'<script>test</script>',detailedForecast:'Sunny & warm',windSpeed:'5 mph',windDirection:'S',probabilityOfPrecipitation:{value:null}};
 const context={window:{},document:{getElementById:get},console:{warn(){}},URL,AbortController,setTimeout,clearTimeout,setInterval(){},Date,fetch:async(url,options)=>{
   calls.push({url,options});if(allFail)throw new Error('offline');
   if(url.includes('/points/'))return{ok:true,json:async()=>({properties:{timeZone:'America/Chicago',observationStations:'https://api.weather.gov/stations',forecastHourly:'https://api.weather.gov/hourly',forecast:'https://api.weather.gov/daily'}})};
   if(url.endsWith('/stations'))return{ok:true,json:async()=>({features:[{id:'https://api.weather.gov/stations/TEST',properties:{stationIdentifier:'TEST'}}]})};
   if(url.includes('/observations/')){if(failObs)throw new Error('Observation outage');return{ok:true,json:async()=>({properties:{temperature:{value:0},heatIndex:{value:null},windSpeed:{value:10,unitCode:'wmoUnit:m_s-1'},relativeHumidity:{value:0},visibility:{value:null},barometricPressure:{value:null},timestamp:new Date(now).toISOString(),textDescription:'Test observation'}})};}
   if(url.endsWith('/hourly')&&failHourly)throw new Error('Hourly outage');
   return{ok:true,json:async()=>({properties:{updateTime:new Date(now).toISOString(),periods:[period]}})};
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'js/weather-data.js'),'utf8'),context);
 const city={city:'Frisco',state:'TX',lat:33.155,lng:-96.823};
 await context.window.WeatherData.load(city);
 assert.match(get('c-temp').innerHTML,/32/);assert.equal(get('c-wind').textContent,'22 mph ');assert.equal(get('c-hum').textContent,'0%');assert.equal(get('c-rain').textContent,'—');pass('Observation units, zero values, and missing precipitation');
 assert.ok(get('hourly-list').innerHTML.includes('&lt;script&gt;'));assert.ok(!get('hourly-list').innerHTML.includes('<script>'));pass('External forecast content is escaped');
 failObs=true;await context.window.WeatherData.load(city);assert.match(get('conditions-status').textContent,/temporarily unavailable/);assert.match(get('hourly-status').textContent,/Updated/);assert.match(get('c-temp').innerHTML,/32/);pass('Observation failure preserves data and does not block forecasts');
 failObs=false;failHourly=true;await context.window.WeatherData.load(city);assert.match(get('hourly-status').textContent,/temporarily unavailable/);assert.match(get('daily-status').textContent,/Updated/);pass('Hourly failure does not block daily forecast or observations');
 assert.equal(calls.filter(c=>c.url.includes('/points/')).length,1);assert.ok(calls.every(c=>c.options.cache==='no-store'));pass('Shared metadata lookup and fresh live weather requests');
 allFail=true;await context.window.WeatherData.load({...city,lat:34});assert.equal(get('c-temp').textContent,'—');assert.equal(get('hourly-list').innerHTML,'');assert.equal(get('weather-retry').disabled,false);pass('Location changes clear previous-city values and recover Retry on failure');
}
async function workerTests(){
 const listeners={};let networkCalls=0,cacheWrites=0;
 const shellResponse={ok:true,type:'basic',clone(){return this;}};
 const context={self:{location:{origin:'https://example.test'},registration:{scope:'https://example.test/Frisco-weather-map/'},addEventListener(type,fn){listeners[type]=fn;},skipWaiting(){throw new Error('Unexpected automatic activation');}},URL,Request,Response,Set,fetch:async()=>{networkCalls++;return shellResponse;},caches:{open:async()=>({put:async()=>{cacheWrites++;},addAll:async()=>{}}),match:async()=>null}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),context);
 let captured;
 const dispatch=url=>{captured=null;listeners.fetch({request:new Request(url),respondWith(p){captured=p;},waitUntil(){}});return captured;};
 for(const url of ['https://api.weather.gov/alerts/active','https://opengeo.ncep.noaa.gov/geoserver/conus/ows','https://example.test/other-project/app.js','https://example.test/Frisco-weather-map/missing.js'])assert.equal(dispatch(url),null);
 assert.equal(networkCalls,0);pass('Service worker completely bypasses external APIs and unrelated paths');
 assert.equal(await dispatch('https://example.test/Frisco-weather-map/js/app.js'),shellResponse);await Promise.resolve();assert.equal(cacheWrites,1);pass('Known shell assets use network-first and cache only successful responses');
 context.fetch=async()=>{throw new Error('offline');};const offline=await dispatch('https://example.test/Frisco-weather-map/js/app.js');assert.equal(offline.type,'error');pass('Missing offline JavaScript never receives HTML fallback');
 const cached={body:'previous shell'};context.caches.match=async()=>cached;assert.equal(await dispatch('https://example.test/Frisco-weather-map/index.html'),cached);pass('Offline navigation can use the saved shell');
 await listeners.install({waitUntil:p=>p});pass('Installation does not automatically activate a new worker');
}
function staticTests(){
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 for(const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g))assert.ok(fs.existsSync(path.resolve(root,match[1])),match[1]);
 assert.match(fs.readFileSync(path.join(root,'js/config.js'),'utf8'),/window.CARTO_API_KEY = ''/);pass('Unique HTML IDs, relative assets, project favicon and empty committed CARTO key');
 const updated=fs.readFileSync(path.join(root,'.github/workflows/deploy-pages.yml'),'utf8');
 const injection=s=>s.slice(s.indexOf('      - name: Inject CARTO API key'),s.indexOf('      - name: ',s.indexOf('      - name: Inject CARTO API key')+10));
 assert.equal(require('node:crypto').createHash('sha256').update(injection(updated)).digest('hex'),'60cc3a0eb6c0f49e4117101ae71275a7ab786a97aa1a51e8d3e09a3ebe5804d8');pass('CARTO secret injection is unchanged');
}
function mapAndAlertTests(){
 const app=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
 const between=(a,b)=>app.slice(app.indexOf('function '+a+'('),app.indexOf('function '+b+'('));
 const labels={textContent:''};let tileUrl='';
 const carto={window:{CARTO_API_KEY:'test-key'},document:{getElementById:()=>labels},darkModeEnabled:true,L:{tileLayer(url){tileUrl=url;return{};}}};
 vm.runInNewContext(between('makeBaseMapLayer','setDarkMode')+'makeBaseMapLayer();',carto);
 assert.match(tileUrl,/cartocdn.com.*dark_all/);assert.equal(labels.textContent,'CARTO Dark Matter');carto.window.CARTO_API_KEY='';vm.runInNewContext('makeBaseMapLayer()',carto);assert.match(tileUrl,/tile.openstreetmap.org/);pass('CARTO primary path and missing-key OpenStreetMap fallback (simulated key)');
 const list={innerHTML:'',querySelectorAll:()=>[]};const dot={className:''},card={classList:{remove(){},toggle(){}}};
 const context={document:{getElementById:id=>id==='alert-list'?list:id==='alert-dot'?dot:card},activeAlertPanelType:'both',localAlertFeatures:[],ALERT_PANEL_RADIUS_MILES:150,alertFeatureIndex:new Map(),alertLayerIndex:new Map(),isWatchedWarning:e=>/warning/i.test(e),isWatchedWatch:e=>/watch/i.test(e),alertTypeForFeature:f=>/warning/i.test(f.properties.event)?'warnings':'watches',alertPopupColor:()=> '#ff677b',wireAlertCardInteractions(){}};
 const definitions=between('getAlertId','escapeHTML')+between('escapeHTML','formatAlertTime')+between('formatAlertTime','getAlertSourceUrl')+between('getAlertSourceUrl','zoomToAlert')+between('renderAlertDetails','wireAlertCardInteractions')+between('renderAlerts','setAlertPolygonLoading');
 vm.runInNewContext(definitions,context);
 const expires=new Date(Date.now()+3600000).toISOString();
 context.fixtures=[{id:'watch',properties:{event:'Flood Watch',expires,description:'<unsafe>',severity:'Moderate',certainty:'Likely',urgency:'Expected'}},...Array.from({length:9},(_,i)=>({id:'warning-'+i,properties:{event:'Tornado Warning',expires,headline:'Take shelter',instruction:'Move inside'}}))];
 vm.runInNewContext('renderAlerts(fixtures)',context);
 assert.equal((list.innerHTML.match(/role="article"/g)||[]).length,10);assert.ok(list.innerHTML.indexOf('Tornado Warning')<list.innerHTML.indexOf('Flood Watch'));assert.ok(list.innerHTML.includes('&lt;unsafe&gt;'));assert.ok(list.innerHTML.includes('Urgency'));assert.ok(list.innerHTML.includes('Take shelter'));pass('Alert rendering prioritizes warnings, preserves all cards, escapes content, and includes NWS details');
}
(async()=>{await weatherTests();await workerTests();staticTests();mapAndAlertTests();const text=reports.join('\n')+'\n';console.log(text);})().catch(error=>{console.error(error);process.exitCode=1;});
