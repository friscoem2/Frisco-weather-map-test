/* NWS observations and forecasts share one point lookup. Live products are never persisted. */
(function () {
  'use strict';
  const metadata = new Map();
  let controller, locationKey = '', observationTime = null, zone = 'America/Chicago';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  const fahrenheit = value => number(value) ? Math.round(Number(value) * 9 / 5 + 32) : null;
  const time = value => new Date(value).toLocaleString('en-US', {timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  async function json(url, signal) {
    if (!url || new URL(url).hostname !== 'api.weather.gov') throw new Error('Invalid NWS endpoint');
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) timeout.abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetch(url, {cache:'no-store',signal:timeout.signal,headers:{Accept:'application/geo+json, application/json'}});
      if (!response.ok) throw new Error(`NWS request returned ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function status(id, message, failed = false) {
    el(id).textContent = message;
    el(id).classList.toggle('data-error', failed);
  }
  function freshness() {
    if (!observationTime) return;
    const minutes = Math.max(0, Math.floor((Date.now() - observationTime) / 60000));
    el('observation-age').textContent = `${minutes > 90 ? 'Older observation · ' : ''}${minutes} min ago`;
    el('observation-age').classList.toggle('data-error', minutes > 90);
  }
  function observation(d, stationId) {
    const temp = fahrenheit(d.temperature?.value);
    const feels = fahrenheit(d.heatIndex?.value ?? d.windChill?.value ?? d.temperature?.value);
    const speed = d.windSpeed?.value;
    const speedUnit = d.windSpeed?.unitCode || 'wmoUnit:km_h-1';
    const mph = number(speed) ? Math.round(speed * (speedUnit.endsWith('m_s-1') ? 2.23694 : speedUnit.endsWith('kn') ? 1.15078 : .621371)) : null;
    const direction = number(d.windDirection?.value) ? ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d.windDirection.value/22.5)%16] : '';
    el('c-temp').innerHTML = temp === null ? '—' : `${temp}<sup>°F</sup>`;
    el('c-feels').textContent = feels === null ? 'Feels like —' : `Feels like ${feels}°`;
    el('c-wind').textContent = mph === null ? '—' : `${mph} mph ${direction}`;
    el('c-hum').textContent = number(d.relativeHumidity?.value) ? `${Math.round(d.relativeHumidity.value)}%` : '—';
    el('c-pres').textContent = number(d.barometricPressure?.value) ? `${Math.round(d.barometricPressure.value/100)} hPa` : '—';
    el('c-dew').textContent = fahrenheit(d.dewpoint?.value) === null ? '—' : `${fahrenheit(d.dewpoint.value)}°F`;
    el('c-vis').textContent = number(d.visibility?.value) ? `${(d.visibility.value/1609.344).toFixed(1)} mi` : '—';
    el('c-desc').textContent = d.textDescription || 'Description unavailable';
    el('mobile-temperature').textContent = temp === null ? '—°' : `${temp}°`;
    el('mobile-conditions').textContent = d.textDescription || 'Description unavailable';
    el('mobile-feels').textContent = feels === null ? 'Feels like —' : `Feels like ${feels}°`;
    observationTime = Number.isFinite(Date.parse(d.timestamp)) ? Date.parse(d.timestamp) : null;
    status('conditions-status', `NWS · ${stationId || 'Nearby station'} · ${observationTime ? time(observationTime) : 'Observation time unavailable'}`);
    freshness();
  }
  const tempLabel = p => number(p.temperature) ? `${Math.round(p.temperature)}°${esc(p.temperatureUnit || 'F')}` : '—';
  const rain = p => number(p.probabilityOfPrecipitation?.value) ? `${Math.round(p.probabilityOfPrecipitation.value)}%` : '—';
  function forecast(data, kind) {
    const periods = (data.properties?.periods || []).filter(p => Date.parse(p.endTime) > Date.now());
    if (!periods.length) throw new Error('NWS returned no upcoming forecast periods');
    if (kind === 'hourly') {
      el('hourly-list').innerHTML = periods.slice(0,24).map((p,i) => `<li class="hour-cell${i === 0 ? ' current-hour' : ''}"><span>${i === 0 && Date.parse(p.startTime) <= Date.now() ? 'Now' : esc(new Date(p.startTime).toLocaleTimeString('en-US',{timeZone:zone,hour:'numeric'}))}</span><strong>${tempLabel(p)}</strong><span class="hour-condition">${esc(p.shortForecast)}</span><span class="rain-chance">Rain ${rain(p)}</span><span class="hour-wind">${esc(p.windSpeed)} ${esc(p.windDirection)}</span></li>`).join('');
      el('c-rain').textContent = rain(periods[0]);
    } else {
      const days = new Map();
      periods.forEach(p => {const key = new Date(p.startTime).toLocaleDateString('en-CA',{timeZone:zone}); if(!days.has(key))days.set(key,[]); days.get(key).push(p);});
      el('daily-list').innerHTML = [...days.values()].slice(0,7).map(parts => {
        const day = parts.find(p=>p.isDaytime), night = parts.find(p=>!p.isDaytime), main = day || night;
        const probabilities = parts.map(p=>p.probabilityOfPrecipitation?.value).filter(number);
        return `<details class="forecast-day"><summary><span class="day-name">${esc(new Date(main.startTime).toLocaleDateString('en-US',{timeZone:zone,weekday:'short'}))}</span><span class="day-condition">${esc(main.shortForecast)}</span><span class="day-temperatures"><b>${day ? tempLabel(day) : '—'}</b> / ${night ? tempLabel(night) : '—'}</span><span class="rain-chance">${probabilities.length ? Math.round(Math.max(...probabilities))+'%' : '—'}</span></summary>${parts.map(p=>`<p><b>${esc(p.name)}:</b> ${esc(p.detailedForecast || p.shortForecast)}</p>`).join('')}</details>`;
      }).join('');
      const today = [...days.values()][0];
      const high = today.find(p=>p.isDaytime), low = today.find(p=>!p.isDaytime);
      el('c-highlow').textContent = `High ${high ? high.temperature+'°' : '—'} · Low ${low ? low.temperature+'°' : '—'}`;
    }
    status(`${kind}-status`, `NWS · Updated ${time(data.properties.updateTime || data.properties.generatedAt || Date.now())}`);
  }
  async function load(ctx) {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const key = `${Number(ctx.lat).toFixed(4)},${Number(ctx.lng).toFixed(4)}`;
    if (key !== locationKey) {
      observationTime = null;
      ['c-temp','c-wind','c-hum','c-pres','c-dew','c-vis','c-rain','observation-age'].forEach(id=>el(id).textContent='—');
      el('c-desc').textContent='Loading current conditions…';
      el('mobile-temperature').textContent='—°';el('mobile-conditions').textContent=`Loading ${ctx.city} weather…`;el('mobile-feels').textContent='Feels like —';
      el('c-feels').textContent='Feels like —'; el('c-highlow').textContent='High — · Low —';
      el('hourly-list').innerHTML=''; el('daily-list').innerHTML='';
    }
    locationKey = key;
    ['conditions','hourly','daily'].forEach(kind=>status(`${kind}-status`,'Updating from NWS…'));
    el('weather-retry').disabled = true;
    try {
      let point = metadata.get(key);
      if (!point || Date.now()-point.loaded > 1800000) {
        const data = await json(`https://api.weather.gov/points/${key}`,signal);
        point = { ...data.properties, loaded:Date.now() };
        if (metadata.size >= 8) metadata.delete(metadata.keys().next().value);
        metadata.set(key,point);
      }
      if (signal.aborted) return;
      zone = point.timeZone || 'America/Chicago';
      const run = async (kind, operation) => {
        try { await operation(); }
        catch(error) {
          if(signal.aborted)return;
          console.warn(`${kind} update unavailable:`, error.message);
          status(`${kind}-status`, `${kind === 'conditions' ? 'Conditions' : 'Forecast'} temporarily unavailable. ${kind === 'conditions' ? observationTime ? 'Keeping the previous observation.' : '' : el(kind+'-list').children.length ? 'Keeping the previous forecast.' : ''} Use Retry weather.`,true);
        }
      };
      await Promise.allSettled([
        run('conditions', async()=>{
          const stations = await json(point.observationStations,signal);
          let lastError;
          for(const station of (stations.features || []).slice(0,3)) {
            try {
              const data = await json(`${station.id}/observations/latest`,signal);
              if(signal.aborted)return;
              if(!number(data.properties?.temperature?.value)) throw new Error('Station has no temperature observation');
              observation(data.properties,station.properties?.stationIdentifier); return;
            } catch(error) { if(signal.aborted)return; lastError=error; }
          }
          throw lastError || new Error('No observation stations available');
        }),
        ...[['hourly',point.forecastHourly],['daily',point.forecast]].map(([kind,url])=>run(kind,async()=>{
          const data=await json(url,signal); if(!signal.aborted)forecast(data,kind);
        }))
      ]);
    } catch(error) {
      if(signal.aborted)return;
      console.warn('NWS location lookup unavailable:',error.message);
      ['conditions','hourly','daily'].forEach(kind=>status(`${kind}-status`,'Weather temporarily unavailable. Previous data, if shown, is retained. Use Retry weather.',true));
    } finally { if(!signal.aborted)el('weather-retry').disabled=false; }
  }
  setInterval(freshness,60000);
  window.WeatherData = {load};
})();
