(function() {
'use strict';

const map = L.map('map', {
  center:[33.155,-96.823],
  zoom:12,
  zoomControl:false,
  attributionControl:true,
  tap:true,
  touchZoom:true,
  doubleClickZoom:true,
  dragging:true,
  inertia:true,
  zoomSnap:0.25,
  zoomDelta:0.5
});
// Zoom +/- controls removed for cleaner mobile map UI. Pinch and double-tap zoom remain enabled.
let darkModeEnabled = true;
let baseLayer = makeBaseMapLayer();
baseLayer.addTo(map);

// ── STATE ────────────────────────────────────────────────────────────────────
let radarType = 'reflectivity';
let radarLayers = [];
let splitViewActive = false;
let compareMap = null;
let compareRadarLayers = [];
let compareBaseLayer = null;
let isSyncingMaps = false;
let mirrorMarkerOnMain = null;
let mirrorMarkerOnCompare = null;
let warningLayer = null, watchLayer = null;
let riverGaugeLayer = null, riverGaugeFetchController = null, riverGaugeCount = 0;
let localAlertFeatures = [];
let alertFeatureIndex = new Map();
let alertLayerIndex = new Map();
const countyGeometryCache = new Map();
let alertPolygonRenderToken = 0;
let currentWatchedAlerts = [];
let cityLimitLayer = null;
let fireStationLayer = null, fireDistrictLayer = null;
let sirenLayer = null, camMarkerLayer = null;
let selectedVelStation = 'kfws';
let splitRadarProduct = 'velocity';
let stationMarkerLayer = null;
const layersOn = { warnings:false, watches:false, cityLimits:true, sirens:false, cameras:false, fireStations:false, fireDistricts:false, riverGauges:false };
const NWS_BASE = 'https://opengeo.ncep.noaa.gov/geoserver';
const NWPS_GAUGE_LAYER_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query';

// Recent radar history loop. Live radar remains default until LOOP is pressed.
const REFLECTIVITY_LOOP_MINUTES = 35;
const REFLECTIVITY_LOOP_MAX_FRAMES = 10;
const REFLECTIVITY_LOOP_SPEED_MS = 700;

let reflectivityLoopFrames = [];
let reflectivityLoopLayer = null;
let reflectivityLoopLayerCache = new Map();
let reflectivityLoopPreloaded = false;
let reflectivityLoopPreloading = false;
let reflectivityLoopTimer = null;
let reflectivityLoopIndex = 0;
let reflectivityLoopPlaying = false;
let reflectivityLoopConfigKey = null;

let compareLoopFrames = [];
let compareLoopLayerCache = new Map();
let compareLoopConfigKey = null;
let hydroInspectMode = false;
let hydroInspectDebugEnabled = false;
let hydroInspectDebugEntries = [];
let overlapCullingEnabled = true;
let overlapCullTimer = null;
let stationRangeRingMain = null;
let stationRangeRingCompare = null;

function makeWMS(url, layerName, opacity) {
  return L.tileLayer.wms(url, {
    layers: layerName,
    format: 'image/png',
    transparent: true,
    opacity: opacity || 0.75,
    version: '1.3.0',
    uppercase: true,
    // Prevent the browser from getting overwhelmed by rapid WMS tile churn.
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
    className: String(layerName || '').includes('_bdhc') ? 'radar-tile hydro-tile' : 'radar-tile',
    attribution: 'NOAA/NWS MRMS',
    crossOrigin: true
  });
}

function makeTimedRadarLayer(spec, isoTime, opacity) {
  return L.tileLayer.wms(spec.url, {
    layers: spec.layer,
    format: 'image/png',
    transparent: true,
    opacity: typeof opacity === 'number' ? opacity : (spec.opacity || 0.68),
    version: '1.3.0',
    uppercase: true,
    time: isoTime,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
    className: String(spec.layer || '').includes('_bdhc') ? 'radar-tile hydro-tile' : 'radar-tile',
    attribution: 'NOAA/NWS MRMS',
    crossOrigin: true
  });
}

function getRadarLoopConfig() {
  const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation && !s.tdwr) || DFW_STATIONS[0];

  if (radarType === 'composite') {
    return {
      key: 'conus-composite',
      productName: 'COMPOSITE REFLECTIVITY',
      loadingText: 'LOADING COMPOSITE REFLECTIVITY FRAMES',
      capability: { url: `${NWS_BASE}/conus/ows`, layer: 'conus_cref_qcd' },
      layers: [{ url: `${NWS_BASE}/conus/ows`, layer: 'conus_cref_qcd', opacity: 0.66 }]
    };
  }

  if (radarType === 'velocity' && station) {
    const velocityLayer = getLayerName(station, 'velocity');
    if (!velocityLayer) return null;
    return {
      key: `${station.id}-velocity`,
      productName: `${station.name} VELOCITY`,
      loadingText: `LOADING ${station.name} VELOCITY FRAMES`,
      capability: { url: `${NWS_BASE}/${station.id}/ows`, layer: velocityLayer },
      layers: [{ url: `${NWS_BASE}/${station.id}/ows`, layer: velocityLayer, opacity: 0.82 }]
    };
  }

  if (radarType === 'hclass' && station) {
    const hydroLayer = getLayerName(station, 'hclass');
    if (!hydroLayer) return null;
    return {
      key: `${station.id}-hydro-class`,
      productName: `${station.name} HYDRO CLASS`,
      loadingText: `LOADING ${station.name} HYDRO CLASS FRAMES`,
      capability: { url: `${NWS_BASE}/${station.id}/ows`, layer: hydroLayer },
      layers: [{ url: `${NWS_BASE}/${station.id}/ows`, layer: hydroLayer, opacity: 0.92 }]
    };
  }

  if (radarType === 'reflectivity') {
    // Use the CONUS MRMS base reflectivity time dimension for the main Base Reflectivity loop.
    // Station-specific base reflectivity services are less consistent with TIME support and can
    // return transparent/empty tiles for generated timestamps, which made the map appear to clear.
    return {
      key: 'conus-base-reflectivity',
      productName: 'BASE REFLECTIVITY',
      loadingText: 'LOADING BASE REFLECTIVITY FRAMES',
      capability: { url: `${NWS_BASE}/conus/ows`, layer: 'conus_bref_qcd' },
      layers: [{ url: `${NWS_BASE}/conus/ows`, layer: 'conus_bref_qcd', opacity: 0.68 }]
    };
  }

  return null;
}

function getCompareRadarLoopConfig() {
  if (!splitViewActive || !compareMap) return null;
  const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation && !s.tdwr) || DFW_STATIONS[0];
  if (!station) return null;
  const product = splitRadarProduct === 'hclass' ? 'hclass' : 'velocity';
  const layerName = getLayerName(station, product);
  if (!layerName) return null;
  return {
    key: `compare-${station.id}-${product}`,
    productName: `${station.name} ${product === 'hclass' ? 'HYDRO CLASS' : 'VELOCITY'}`,
    loadingText: `LOADING ${station.name} ${product === 'hclass' ? 'HYDRO CLASS' : 'VELOCITY'} FRAMES`,
    capability: { url: `${NWS_BASE}/${station.id}/ows`, layer: layerName },
    layers: [{ url: `${NWS_BASE}/${station.id}/ows`, layer: layerName, opacity: product === 'hclass' ? 0.92 : 0.82 }]
  };
}

async function fetchRadarTimesForConfig(config) {
  function generatedFallbackFrames() {
    // Some station products do not reliably expose a usable TIME dimension in GetCapabilities.
    // When that happens, request a conservative set of recent timestamps so WMS can serve
    // the closest available frame instead of failing the loop outright.
    const now = Date.now();
    const intervalMs = 5 * 60 * 1000;
    const endMs = Math.floor((now - 2 * 60 * 1000) / intervalMs) * intervalMs;
    const frames = [];
    for (let i = REFLECTIVITY_LOOP_MAX_FRAMES - 1; i >= 0; i--) {
      const ms = endMs - i * intervalMs;
      frames.push({ iso: new Date(ms).toISOString(), ms });
    }
    return frames;
  }

  try {
    const url = `${config.capability.url}?service=WMS&version=1.3.0&request=GetCapabilities&_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch WMS capabilities');
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const layers = Array.from(doc.getElementsByTagName('Layer'));
    const wanted = String(config.capability.layer || '').toLowerCase();
    const targetLayer = layers.find(layer => {
      const name = layer.getElementsByTagName('Name')[0];
      return name && name.textContent.trim().toLowerCase() === wanted;
    }) || layers.find(layer => {
      const name = layer.getElementsByTagName('Name')[0];
      return name && name.textContent.trim().toLowerCase().includes(wanted);
    });

    if (!targetLayer) throw new Error(`${config.capability.layer} layer not found`);

    const timeNodes = [
      ...Array.from(targetLayer.getElementsByTagName('Dimension')),
      ...Array.from(targetLayer.getElementsByTagName('Extent'))
    ];
    const timeDimension = timeNodes.find(d => (d.getAttribute('name') || '').toLowerCase() === 'time');
    if (!timeDimension) throw new Error('No time dimension found');

    const rawText = (timeDimension.textContent || '').trim();
    let rawTimes = [];

    if (rawText.includes('/') && !rawText.includes(',')) {
      // ISO interval syntax: start/end/period. Build frames from the end backward.
      const parts = rawText.split('/').map(x => x.trim());
      const endMs = Date.parse(parts[1]);
      const stepMin = /PT(\d+)M/i.exec(parts[2] || '');
      const stepMs = (stepMin ? Number(stepMin[1]) : 5) * 60 * 1000;
      if (Number.isFinite(endMs)) {
        for (let i = REFLECTIVITY_LOOP_MAX_FRAMES - 1; i >= 0; i--) {
          rawTimes.push(new Date(endMs - i * stepMs).toISOString());
        }
      }
    } else {
      rawTimes = rawText.split(',').map(t => t.trim()).filter(Boolean);
    }

    const cutoff = Date.now() - REFLECTIVITY_LOOP_MINUTES * 60 * 1000;
    let frames = rawTimes.map(t => ({ iso: t, ms: Date.parse(t) }))
      .filter(f => Number.isFinite(f.ms) && f.ms >= cutoff)
      .sort((a, b) => a.ms - b.ms)
      .slice(-REFLECTIVITY_LOOP_MAX_FRAMES);

    if (frames.length < Math.min(4, REFLECTIVITY_LOOP_MAX_FRAMES)) {
      frames = rawTimes.map(t => ({ iso: t, ms: Date.parse(t) }))
        .filter(f => Number.isFinite(f.ms))
        .sort((a, b) => a.ms - b.ms)
        .slice(-REFLECTIVITY_LOOP_MAX_FRAMES);
    }

    return frames.length ? frames : generatedFallbackFrames();
  } catch (err) {
    console.warn('Using generated radar history timestamps for', config && config.key, err);
    return generatedFallbackFrames();
  }
}

function makeBaseMapLayer() {
  if (darkModeEnabled) {
    return L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains:'abcd',
      maxZoom:20,
      className:'basemap-tile dark-basemap-tile',
      attribution:'© CARTO © OSM contributors'
    });
  }

  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19,
    className:'streets-basemap-tile',
    attribution:'© OpenStreetMap contributors'
  });
}

function setDarkMode(enabled) {
  darkModeEnabled = !!enabled;

  if (baseLayer) {
    try { map.removeLayer(baseLayer); } catch(e) {}
  }
  baseLayer = makeBaseMapLayer();
  baseLayer.addTo(map);
  try { baseLayer.bringToBack(); } catch(e) {}

  if (compareMap) {
    if (compareBaseLayer) {
      try { compareMap.removeLayer(compareBaseLayer); } catch(e) {}
    }
    compareBaseLayer = makeBaseMapLayer();
    compareBaseLayer.addTo(compareMap);
    try { compareBaseLayer.bringToBack(); } catch(e) {}
  }

  const btn = document.getElementById('btn-darkmode-top');
  if (btn) btn.classList.toggle('on', darkModeEnabled);
  const settingsBtn = document.getElementById('settings-darkmode');
  if (settingsBtn) settingsBtn.classList.toggle('on', darkModeEnabled);
}

function toggleDarkMode() {
  setDarkMode(!darkModeEnabled);
}

function clearCompareRadarLayers() {
  if (!compareMap) return;
  compareRadarLayers.forEach(l => compareMap.removeLayer(l));
  compareRadarLayers = [];
}


function makeStationRangeRing(station, targetMap) {
  return L.circle([station.lat, station.lon], {
    radius: 160934.4,
    color: 'rgba(255,234,0,.78)',
    weight: 1.5,
    dashArray: '8 6',
    fillColor: 'rgba(255,234,0,.035)',
    fillOpacity: 1,
    interactive: false
  }).addTo(targetMap);
}

function updateStationRangeRings() {
  if (stationRangeRingMain) { map.removeLayer(stationRangeRingMain); stationRangeRingMain = null; }
  if (stationRangeRingCompare && compareMap) { compareMap.removeLayer(stationRangeRingCompare); stationRangeRingCompare = null; }

  const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation && !s.tdwr);
  if (!station) return;

  if (radarType === 'velocity' || radarType === 'hclass') {
    stationRangeRingMain = makeStationRangeRing(station, map);
  }

  if (splitViewActive && compareMap && (splitRadarProduct === 'velocity' || splitRadarProduct === 'hclass')) {
    stationRangeRingCompare = makeStationRangeRing(station, compareMap);
  }
}

function buildCompareRadarLayer() {
  if (!compareMap) return;

  clearCompareRadarLayers();

  const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation && !s.tdwr);
  const product = splitRadarProduct === 'hclass' ? 'hclass' : 'velocity';

  if (station) {
    const ln = getLayerName(station, product);

    if (ln) {
      const opacity = product === 'hclass' ? 0.92 : 0.82;
      const l = makeWMS(`${NWS_BASE}/${station.id}/ows`, ln, opacity);
      l.addTo(compareMap);
      compareRadarLayers.push(l);
    }
  }

  updateSplitProductHUD();
  updateStationRangeRings();
}

function buildCompareVelocityLayer() {
  buildCompareRadarLayer();
}

function updateSplitProductHUD() {
  const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation);
  const label = document.getElementById('split-vel-label');
  const productLabel = document.getElementById('split-product-label');
  const hydroLegend = document.getElementById('hydro-legend');

  if (label && station) label.textContent = station.name;
  if (productLabel) productLabel.textContent = splitRadarProduct === 'hclass' ? 'HYDRO CLASS' : 'VELOCITY';

  document.getElementById('split-btn-velocity')?.classList.toggle('on', splitRadarProduct !== 'hclass');
  document.getElementById('split-btn-hydro')?.classList.toggle('on', splitRadarProduct === 'hclass');

  if (hydroLegend) hydroLegend.classList.toggle('active', radarType === 'hclass' || (splitViewActive && splitRadarProduct === 'hclass'));
  updateHydroInspectAvailability();
}

function setSplitRadarProduct(product) {
  const nextProduct = product === 'hclass' ? 'hclass' : 'velocity';
  if (nextProduct !== splitRadarProduct) {
    stopReflectivityLoop(true, true);
  }
  splitRadarProduct = nextProduct;
  updateSplitProductHUD();
  if (splitViewActive) buildCompareRadarLayer();
}

function initCompareMap() {
  if (compareMap) return;

  compareMap = L.map('compare-map', {
    center: map.getCenter(),
    zoom: map.getZoom(),
    zoomControl: false,
    attributionControl: false,
    tap: true,
    touchZoom: true,
    doubleClickZoom: true,
    dragging: true,
    inertia: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5
  });

  // Zoom +/- controls removed for cleaner mobile split-view UI.

  compareBaseLayer = makeBaseMapLayer();
  compareBaseLayer.addTo(compareMap);

  compareMap.on('moveend zoomend', () => {
    if (!splitViewActive || isSyncingMaps) return;
    isSyncingMaps = true;
    map.setView(compareMap.getCenter(), compareMap.getZoom(), { animate:false });
    isSyncingMaps = false;
  });

  compareMap.on('mousemove', e => {
    updateMirrorCursor('compare', e.latlng);
    sampleHydroTileAtMouse(e);
  });
  compareMap.on('mouseout', () => {
    hideMirrorCursors();
    hideHydroMapTip();
  });
}

function syncCompareToMain() {
  if (!compareMap || isSyncingMaps) return;
  isSyncingMaps = true;
  compareMap.setView(map.getCenter(), map.getZoom(), { animate:false });
  isSyncingMaps = false;
}


function makeMirrorCursorMarker(latlng, targetMap) {
  return L.marker(latlng, {
    interactive:false,
    keyboard:false,
    zIndexOffset:5000,
    icon:L.divIcon({
      className:'',
      html:'<div class="mirror-cursor-dot"></div>',
      iconSize:[16,16],
      iconAnchor:[8,8]
    })
  }).addTo(targetMap);
}

function hideMirrorCursors() {
  if (mirrorMarkerOnMain) {
    map.removeLayer(mirrorMarkerOnMain);
    mirrorMarkerOnMain = null;
  }

  if (compareMap && mirrorMarkerOnCompare) {
    compareMap.removeLayer(mirrorMarkerOnCompare);
    mirrorMarkerOnCompare = null;
  }
}

function updateMirrorCursor(source, latlng) {
  if (!splitViewActive || !compareMap || !latlng) return;

  if (source === 'main') {
    if (!mirrorMarkerOnCompare) {
      mirrorMarkerOnCompare = makeMirrorCursorMarker(latlng, compareMap);
    } else {
      mirrorMarkerOnCompare.setLatLng(latlng);
    }

    if (mirrorMarkerOnMain) {
      map.removeLayer(mirrorMarkerOnMain);
      mirrorMarkerOnMain = null;
    }
  } else {
    if (!mirrorMarkerOnMain) {
      mirrorMarkerOnMain = makeMirrorCursorMarker(latlng, map);
    } else {
      mirrorMarkerOnMain.setLatLng(latlng);
    }

    if (mirrorMarkerOnCompare) {
      compareMap.removeLayer(mirrorMarkerOnCompare);
      mirrorMarkerOnCompare = null;
    }
  }
}

function setSplitView(active) {
  splitViewActive = active;
  document.body.classList.toggle('split-view', active);

  const btn = document.getElementById('btn-split');
  if (btn) {
    btn.classList.toggle('on', active);
    btn.textContent = active ? 'EXIT SPLIT' : 'SPLIT';
  }

  setTimeout(() => {
    map.invalidateSize();
    refreshMapSizesSoon();

    if (active) {
      initCompareMap();
      compareMap.invalidateSize();
      syncCompareToMain();

      // Left side stays reflectivity; right side can show selected-station velocity or hydro class.
      if (radarType !== 'reflectivity') {
        setRadarType('reflectivity');
      } else {
        applyAllRadarLayers();
      }

      buildCompareVelocityLayer();
    } else {
      hideMirrorCursors();

      if (compareMap) {
        clearCompareRadarLayers();
        compareMap.invalidateSize();
      }

      applyAllRadarLayers();
    }
  }, 250);
}

function toggleSplitView() {
  setSplitView(!splitViewActive);
}

map.on('moveend zoomend', () => {
  scheduleOverlapCulling(80);
  if (!splitViewActive || !compareMap || isSyncingMaps) return;
  syncCompareToMain();
});

map.on('mousemove', e => updateMirrorCursor('main', e.latlng));
map.on('mouseout', hideMirrorCursors);



// ── MOBILE LAYOUT HELPERS ────────────────────────────────────────────────────
const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
if (isCoarsePointer) document.body.classList.add('touch-device');

function refreshMapSizesSoon() {
  setTimeout(() => {
    map.invalidateSize();
    if (compareMap) compareMap.invalidateSize();
    if (splitViewActive) syncCompareToMain();
  }, 260);
}

window.addEventListener('resize', refreshMapSizesSoon);
window.addEventListener('orientationchange', refreshMapSizesSoon);

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', refreshMapSizesSoon);
}


// ── STATIONS ─────────────────────────────────────────────────────────────────
// DFW primary + TDWR
const DFW_STATIONS = [
  { id:'kfws', name:'KFWS', label:'Ft Worth TX',    lat:32.573, lon:-97.303 },
  { id:'kdyx', name:'KDYX', label:'Dyess AFB TX',   lat:32.538, lon:-99.254 },
  { id:'kfdr', name:'KFDR', label:'Altus AFB OK',   lat:34.362, lon:-98.977 },
];

// Test/aux stations — shown on map with purple tint, included in reflectivity stack
const TEST_STATIONS = [
  { id:'klzk', name:'KLZK', label:'Little Rock AR', lat:34.836500, lon:-92.262194, test:true },
  { id:'ksrx', name:'KSRX', label:'Fort Smith AR', lat:35.290417, lon:-94.361889, test:true },
  { id:'kftg', name:'KFTG', label:'Denver / Front Range CO', lat:39.786639, lon:-104.545800, test:true },
  { id:'kgjx', name:'KGJX', label:'Grand Junction CO', lat:39.062169, lon:-108.213760, test:true },
  { id:'kpux', name:'KPUX', label:'Pueblo CO', lat:38.459550, lon:-104.181350, test:true },
  { id:'kdmx', name:'KDMX', label:'Des Moines IA', lat:41.731200, lon:-93.722869, test:true },
  { id:'kdvn', name:'KDVN', label:'Davenport IA', lat:41.611667, lon:-90.580833, test:true },
  { id:'kvwx', name:'KVWX', label:'Evansville IN', lat:38.260250, lon:-87.724528, test:true },
  { id:'kind', name:'KIND', label:'Indianapolis IN', lat:39.707500, lon:-86.280278, test:true },
  { id:'kddc', name:'KDDC', label:'Dodge City KS', lat:37.760833, lon:-99.968889, test:true },
  { id:'kgld', name:'KGLD', label:'Goodland KS', lat:39.366944, lon:-101.700270, test:true },
  { id:'kict', name:'KICT', label:'Wichita KS', lat:37.654444, lon:-97.443056, test:true },
  { id:'ktwx', name:'KTWX', label:'Topeka KS', lat:38.996950, lon:-96.232550, test:true },
  { id:'klch', name:'KLCH', label:'Lake Charles LA', lat:30.125306, lon:-93.215889, test:true },
  { id:'klix', name:'KLIX', label:'New Orleans LA', lat:30.336667, lon:-89.825417, test:true },
  { id:'kpoe', name:'KPOE', label:'Fort Polk LA', lat:31.155278, lon:-92.976111, test:true },
  { id:'kshv', name:'KSHV', label:'Shreveport LA', lat:32.450833, lon:-93.841250, test:true },
  { id:'keax', name:'KEAX', label:'Kansas City MO', lat:38.810250, lon:-94.264472, test:true },
  { id:'klsx', name:'KLSX', label:'St. Louis MO', lat:38.698611, lon:-90.682778, test:true },
  { id:'ksgf', name:'KSGF', label:'Springfield MO', lat:37.235239, lon:-93.400419, test:true },
  { id:'kbis', name:'KBIS', label:'Bismarck ND', lat:46.770833, lon:-100.760550, test:true },
  { id:'kmbx', name:'KMBX', label:'Minot AFB ND', lat:48.393056, lon:-100.864440, test:true },
  { id:'kmvx', name:'KMVX', label:'Grand Forks ND', lat:47.527778, lon:-97.325556, test:true },
  { id:'klnx', name:'KLNX', label:'North Platte NE', lat:41.957944, lon:-100.576220, test:true },
  { id:'koax', name:'KOAX', label:'Omaha NE', lat:41.320369, lon:-96.366819, test:true },
  { id:'kuex', name:'KUEX', label:'Hastings NE', lat:40.320833, lon:-98.441944, test:true },
  { id:'kabx', name:'KABX', label:'Albuquerque NM', lat:35.149722, lon:-106.823880, test:true },
  { id:'kepz', name:'KEPZ', label:'El Paso NM', lat:31.873056, lon:-106.698000, test:true },
  { id:'kfdx', name:'KFDX', label:'Cannon AFB NM', lat:34.634167, lon:-103.618880, test:true },
  { id:'khdx', name:'KHDX', label:'Holloman AFB NM', lat:33.077000, lon:-106.120030, test:true },
  { id:'kfdr', name:'KFDR', label:'Altus AFB OK', lat:34.362194, lon:-98.976667, test:true },
  { id:'kinx', name:'KINX', label:'Tulsa OK', lat:36.175131, lon:-95.564161, test:true },
  { id:'koun', name:'KOUN', label:'Norman / NSSL OK', lat:35.236058, lon:-97.462350, test:true },
  { id:'ktlx', name:'KTLX', label:'Oklahoma City OK', lat:35.333361, lon:-97.277761, test:true },
  { id:'kvnx', name:'KVNX', label:'Vance AFB OK', lat:36.740617, lon:-98.127717, test:true },
  { id:'kabr', name:'KABR', label:'Aberdeen SD', lat:45.455833, lon:-98.413333, test:true },
  { id:'kfsd', name:'KFSD', label:'Sioux Falls SD', lat:43.587778, lon:-96.729444, test:true },
  { id:'kudx', name:'KUDX', label:'Rapid City SD', lat:44.124722, lon:-102.830000, test:true },
  { id:'kama', name:'KAMA', label:'Amarillo TX', lat:35.233333, lon:-101.709270, test:true },
  { id:'kbro', name:'KBRO', label:'Brownsville TX', lat:25.916000, lon:-97.418967, test:true },
  { id:'kcrp', name:'KCRP', label:'Corpus Christi TX', lat:27.784017, lon:-97.511250, test:true },
  { id:'kdfx', name:'KDFX', label:'Laughlin AFB TX', lat:29.273139, lon:-100.280330, test:true },
  { id:'kdyx', name:'KDYX', label:'Dyess AFB TX', lat:32.538500, lon:-99.254333, test:true },
  { id:'kewx', name:'KEWX', label:'Austin / San Antonio TX', lat:29.704056, lon:-98.028611, test:true },
  { id:'kfws', name:'KFWS', label:'Dallas / Fort Worth TX', lat:32.573000, lon:-97.303150, test:true },
  { id:'kgrk', name:'KGRK', label:'Fort Hood TX', lat:30.721833, lon:-97.382944, test:true },
  { id:'khgx', name:'KHGX', label:'Houston TX', lat:29.471900, lon:-95.078733, test:true },
  { id:'klbb', name:'KLBB', label:'Lubbock TX', lat:33.654139, lon:-101.814160, test:true },
  { id:'kmaf', name:'KMAF', label:'Midland / Odessa TX', lat:31.943461, lon:-102.189250, test:true },
  { id:'ksjt', name:'KSJT', label:'San Angelo TX', lat:31.371278, lon:-100.492500, test:true },
  { id:'kcys', name:'KCYS', label:'Cheyenne WY', lat:41.151919, lon:-104.806030, test:true },
  { id:'kriw', name:'KRIW', label:'Riverton WY', lat:43.066089, lon:-108.477300, test:true },
  { id:'kilx', name:'KILX', label:'Lincoln IL', lat:40.15056, lon:-89.33667, test:true },
  { id:'klot', name:'KLOT', label:'Chicago IL', lat:41.60444, lon:-88.08472, test:true },
  { id:'klvx', name:'KLVX', label:'Louisville KY', lat:37.97528, lon:-85.94389, test:true },
  { id:'kpah', name:'KPAH', label:'Paducah KY', lat:37.06833, lon:-88.77194, test:true },
  { id:'khpx', name:'KHPX', label:'Fort Campbell KY', lat:36.73667, lon:-87.28500, test:true },
  { id:'kdgx', name:'KDGX', label:'Jackson / Brandon MS', lat:32.28000, lon:-89.98444, test:true },
  { id:'kiwa', name:'KIWA', label:'Phoenix AZ', lat:33.28917, lon:-111.66917, test:true },
  { id:'kemx', name:'KEMX', label:'Tucson AZ', lat:31.89361, lon:-110.63028, test:true },
  { id:'kyux', name:'KYUX', label:'Yuma AZ', lat:32.49528, lon:-114.65583, test:true },
  { id:'kfsx', name:'KFSX', label:'Flagstaff AZ', lat:34.57444, lon:-111.19833, test:true },
  { id:'ksox', name:'KSOX', label:'Santa Ana Mountains CA', lat:33.81778, lon:-117.63500, test:true },
  { id:'knkx', name:'KNKX', label:'San Diego CA', lat:32.91889, lon:-117.04194, test:true },
  { id:'kvtx', name:'KVTX', label:'Los Angeles CA', lat:34.41167, lon:-119.17861, test:true },
  { id:'keyx', name:'KEYX', label:'Edwards AFB CA', lat:35.09778, lon:-117.56000, test:true },
  { id:'kapx', name:'KAPX', label:'Gaylord MI', lat:44.90722, lon:-84.71972, test:true },
  { id:'kgrr', name:'KGRR', label:'Grand Rapids MI', lat:42.89389, lon:-85.54472, test:true },
  { id:'kdtx', name:'KDTX', label:'Detroit / Pontiac MI', lat:42.69972, lon:-83.47167, test:true },
];

const ALL_STATIONS = [...DFW_STATIONS, ...TEST_STATIONS];
let ACTIVE_STATIONS = [...ALL_STATIONS];
let dopplerStationsOn = true;
let dopplerStationFetchController = null;
const NWS_RADAR_STATIONS_URL = 'https://api.weather.gov/radar/stations?stationType=WSR-88D';

const HYDRO_CLASSES = [
  {color:'#9C9C9C', code:'BI', cls:'Biological', meaning:'Birds, insects — non-precipitation return, often at dawn/dusk near roosts'},
  {color:'#767676', code:'GC', cls:'Ground Clutter', meaning:'Anomalous propagation or stationary ground targets; not real precipitation'},
  {color:'#FFB0B0', code:'IC', cls:'Ice Crystals', meaning:'Small, high-altitude ice crystals; little to no precipitation reaching the ground'},
  {color:'#00FFFF', code:'DS', cls:'Dry Snow', meaning:'Low-density, unrimed snow; light accumulation potential'},
  {color:'#0090FF', code:'WS', cls:'Wet Snow', meaning:'Melting snow near the bright band; slushy precipitation with higher accumulation rates'},
  {color:'#00FB90', code:'RA', cls:'Rain', meaning:'Liquid precipitation; standard rain'},
  {color:'#00BB00', code:'HR', cls:'Heavy Rain', meaning:'Intense rainfall; flash flood potential'},
  {color:'#D0D060', code:'BD', cls:'Big Drops', meaning:'Large raindrops; often precedes or follows hail; high reflectivity but lower rain rate'},
  {color:'#D28484', code:'GR', cls:'Graupel', meaning:'Soft hail / snow pellets; rimed ice common in strong convection'},
  {color:'#FF0000', code:'HA', cls:'Hail', meaning:'Confirmed hail in the column; may or may not be reaching the surface'},
  {color:'#A01414', code:'LH', cls:'Large Hail', meaning:'Significant hail, roughly 1 inch diameter range or larger; severe thunderstorm criteria met'},
  {color:'#FFFF00', code:'GH', cls:'Giant Hail', meaning:'Extreme hail, potentially 2 inches or larger; life-threatening'},
  {color:'#E700FF', code:'UK', cls:'Unknown', meaning:'Algorithm could not confidently classify the return; treat with caution'},
  {color:'#77007D', code:'RF', cls:'Range Folding', meaning:'Radar artifact — second-trip echo from beyond the unambiguous range; not real weather at that spot'}
];


function getLayerName(station, type) {
  if (station.tdwr) {
    return type === 'reflectivity' ? `${station.id}_bref` : null;
  }

  if (type === 'reflectivity') {
    return `${station.id}_bref_raw`;
  }

  if (type === 'hclass') {
    return station.id + '_bdhc';
  }

  // NOAA OpenGeo uses super-resolution base velocity names like kfws_sr_bvel.
  if (type === 'velocity') {
    return station.id + '_sr_bvel';
  }

  return null;
}

const MAX_ACTIVE_REFLECTIVITY_RADARS = 4;

function getNearestReflectivityStations(limit = MAX_ACTIVE_REFLECTIVITY_RADARS) {
  const center = map.getCenter();
  const paddedBounds = map.getBounds().pad(1.5);

  return ACTIVE_STATIONS
    .filter(s => !s.tdwr)
    // Always allow the nearby primary DFW sites; only include distant test/aux sites if they are near the current map view.
    .filter(s => !s.test || paddedBounds.contains([s.lat, s.lon]))
    .map(s => ({
      ...s,
      dist: map.distance(center, L.latLng(s.lat, s.lon))
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

// ── ALERT COLOR MAP ───────────────────────────────────────────────────────────
// Custom warning/watch palette:
// Tornado Warning: dark red / maroon
// Severe Thunderstorm Warning: orange
// Flash Flood Warning: dark green
// Tornado Watch: red
// Severe Thunderstorm Watch: yellow
// Flood Watch: light green
// Winter products: teal / purple
// Advisories / statements: lighter accent colors

function getAlertTheme(event) {
  const e = (event || '').toLowerCase();

  // WARNINGS
  if (e.includes('tornado warning')) {
    return {
      color: '#7f0000',
      fill: '#7f0000',
      fillOp: 0.24,
      weight: 3,
      dash: null
    };
  }

  if (e.includes('severe thunderstorm warning')) {
    return {
      color: '#ff8c00',
      fill: '#ff8c00',
      fillOp: 0.20,
      weight: 2.5,
      dash: null
    };
  }

  if (e.includes('flash flood warning')) {
    return {
      color: '#006400',
      fill: '#006400',
      fillOp: 0.20,
      weight: 2.5,
      dash: null
    };
  }

  if (e.includes('flood warning')) {
    return {
      color: '#008000',
      fill: '#008000',
      fillOp: 0.16,
      weight: 2,
      dash: null
    };
  }

  if (e.includes('hurricane warning') || e.includes('tropical storm warning')) {
    return {
      color: '#b00020',
      fill: '#b00020',
      fillOp: 0.18,
      weight: 2.5,
      dash: null
    };
  }

  if (e.includes('special marine warning')) {
    return {
      color: '#ff9900',
      fill: '#ff9900',
      fillOp: 0.16,
      weight: 2,
      dash: null
    };
  }

  if (
    e.includes('winter storm warning') ||
    e.includes('blizzard warning') ||
    e.includes('ice storm warning')
  ) {
    return {
      color: '#800080',
      fill: '#800080',
      fillOp: 0.16,
      weight: 2.25,
      dash: null
    };
  }

  if (e.includes('warning')) {
    return {
      color: '#ff6600',
      fill: '#ff6600',
      fillOp: 0.14,
      weight: 2,
      dash: null
    };
  }

  // WATCHES
  if (e.includes('tornado watch')) {
    return {
      color: '#ff0000',
      fill: '#ff0000',
      fillOp: 0.11,
      weight: 2.25,
      dash: '8 5'
    };
  }

  if (e.includes('severe thunderstorm watch')) {
    return {
      color: '#ffff00',
      fill: '#ffff00',
      fillOp: 0.12,
      weight: 2.25,
      dash: '8 5'
    };
  }

  if (e.includes('flash flood watch') || e.includes('flood watch')) {
    return {
      color: '#90ee90',
      fill: '#90ee90',
      fillOp: 0.12,
      weight: 2,
      dash: '8 5'
    };
  }

  if (e.includes('hurricane watch') || e.includes('tropical storm watch')) {
    return {
      color: '#ff4d6d',
      fill: '#ff4d6d',
      fillOp: 0.10,
      weight: 2,
      dash: '8 5'
    };
  }

  if (e.includes('winter storm watch')) {
    return {
      color: '#008b8b',
      fill: '#008b8b',
      fillOp: 0.11,
      weight: 2,
      dash: '8 5'
    };
  }

  if (e.includes('watch')) {
    return {
      color: '#ffd166',
      fill: '#ffd166',
      fillOp: 0.09,
      weight: 1.75,
      dash: '8 5'
    };
  }

  // WINTER ADVISORIES / WINTER PRODUCTS
  if (
    e.includes('winter weather advisory') ||
    e.includes('freezing rain advisory') ||
    e.includes('snow advisory')
  ) {
    return {
      color: '#7b68ee',
      fill: '#7b68ee',
      fillOp: 0.09,
      weight: 1.75,
      dash: '3 4'
    };
  }

  if (
    e.includes('wind chill') ||
    e.includes('hard freeze') ||
    e.includes('freeze warning') ||
    e.includes('frost advisory')
  ) {
    return {
      color: '#40e0d0',
      fill: '#40e0d0',
      fillOp: 0.09,
      weight: 1.75,
      dash: '3 4'
    };
  }

  // ADVISORIES
  if (e.includes('dense fog advisory')) {
    return {
      color: '#b0c4de',
      fill: '#b0c4de',
      fillOp: 0.08,
      weight: 1.5,
      dash: '3 4'
    };
  }

  if (e.includes('wind advisory')) {
    return {
      color: '#d2b48c',
      fill: '#d2b48c',
      fillOp: 0.08,
      weight: 1.5,
      dash: '3 4'
    };
  }

  if (e.includes('heat advisory') || e.includes('excessive heat')) {
    return {
      color: '#ffb347',
      fill: '#ffb347',
      fillOp: 0.09,
      weight: 1.5,
      dash: '3 4'
    };
  }

  if (e.includes('small craft advisory')) {
    return {
      color: '#66cccc',
      fill: '#66cccc',
      fillOp: 0.08,
      weight: 1.5,
      dash: '3 4'
    };
  }

  if (e.includes('advisory')) {
    return {
      color: '#80dfff',
      fill: '#80dfff',
      fillOp: 0.07,
      weight: 1.5,
      dash: '3 4'
    };
  }

  // STATEMENTS / SPECIAL WEATHER
  if (
    e.includes('special weather statement') ||
    e.includes('short term forecast') ||
    e.includes('hazardous weather outlook')
  ) {
    return {
      color: '#d9f0ff',
      fill: '#d9f0ff',
      fillOp: 0.055,
      weight: 1.25,
      dash: '2 5'
    };
  }

  // FALLBACK
  return {
    color: '#cccccc',
    fill: '#cccccc',
    fillOp: 0.05,
    weight: 1,
    dash: '2 5'
  };
}

function alertStyle(event) {
  const s = getAlertTheme(event);

  return {
    color: s.color,
    weight: s.weight,
    fillColor: s.fill,
    fillOpacity: s.fillOp,
    dashArray: s.dash || undefined,
    opacity: 0.95
  };
}

function alertPopupColor(event) {
  return getAlertTheme(event).color;
}

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function tick() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour12:false}) + ' CDT';
}
setInterval(tick,1000); tick();

// ── CITY / STATE SEARCH ─────────────────────────────────────────────────────
let searchedCityLabelMarker = null;
let citySearchController = null;
let selectedCityContext = { city:'Frisco', state:'TX', lat:33.155, lng:-96.823 };
const SAVED_CITY_KEY = 'awWeather.savedCity';
const ALERT_RADIUS_KEY = 'awWeather.alertRadiusMiles';
let conditionsController = null;
const TIGER_PLACES_QUERY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query';
const STATE_FIPS = {AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',DC:'11',FL:'12',GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56'};
const STATE_NAMES = {ALABAMA:'AL',ALASKA:'AK',ARIZONA:'AZ',ARKANSAS:'AR',CALIFORNIA:'CA',COLORADO:'CO',CONNECTICUT:'CT',DELAWARE:'DE','DISTRICT OF COLUMBIA':'DC',FLORIDA:'FL',GEORGIA:'GA',HAWAII:'HI',IDAHO:'ID',ILLINOIS:'IL',INDIANA:'IN',IOWA:'IA',KANSAS:'KS',KENTUCKY:'KY',LOUISIANA:'LA',MAINE:'ME',MARYLAND:'MD',MASSACHUSETTS:'MA',MICHIGAN:'MI',MINNESOTA:'MN',MISSISSIPPI:'MS',MISSOURI:'MO',MONTANA:'MT',NEBRASKA:'NE',NEVADA:'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ','NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND',OHIO:'OH',OKLAHOMA:'OK',OREGON:'OR',PENNSYLVANIA:'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD',TENNESSEE:'TN',TEXAS:'TX',UTAH:'UT',VERMONT:'VT',VIRGINIA:'VA',WASHINGTON:'WA','WEST VIRGINIA':'WV',WISCONSIN:'WI',WYOMING:'WY'};
function setCitySearchStatus(text, mode){const el=document.getElementById('city-search-status');if(!el)return;el.textContent=text;el.classList.toggle('err',mode==='err');el.classList.toggle('ok',mode==='ok');}
function setConditionsTitle(city,state){const title=document.querySelector('#hud-cond .hud-title');if(!title)return;const label=[city,state].filter(Boolean).join(', ').toUpperCase();title.innerHTML='<div class="dot g"></div>CONDITIONS · '+(label||'CURRENT LOCATION');}
function clearNwsAlertsForNonTexas(city,state){currentWatchedAlerts=[];localAlertFeatures=[];alertFeatureIndex.clear();alertLayerIndex.clear();if(warningLayer){try{map.removeLayer(warningLayer);}catch(e){} warningLayer=null;}if(watchLayer){try{map.removeLayer(watchLayer);}catch(e){} watchLayer=null;}const list=document.getElementById('alert-list');if(list){list.innerHTML='<div class="no-alerts"><div class="dot g"></div>NWS ALERTS CLEARED · '+String(city||'SELECTED CITY').toUpperCase()+', '+String(state||'').toUpperCase()+' IS OUTSIDE TEXAS</div>';}const dot=document.getElementById('alert-dot');if(dot){dot.className='dot g';}const hud=document.getElementById('hud-alerts');if(hud)hud.classList.remove('alert-active');}
function updateSelectedCityContext(city,state,layer){let center=map.getCenter();try{if(layer&&layer.getBounds&&layer.getBounds().isValid())center=layer.getBounds().getCenter();}catch(e){}selectedCityContext={city:city||'Selected City',state:String(state||'').toUpperCase(),lat:center.lat,lng:center.lng};setConditionsTitle(selectedCityContext.city,selectedCityContext.state);syncFriscoLayerAvailability();loadConditions();loadAlerts();}
function normalizeCitySearchText(v){return String(v||'').trim().replace(/\s+/g,' ');}
function parseCityStateSearch(raw){const q=normalizeCitySearchText(raw);if(!q)return null;let city='',state='';if(q.includes(',')){const parts=q.split(',').map(x=>normalizeCitySearchText(x)).filter(Boolean);city=parts[0]||'';state=(parts[1]||'').toUpperCase();}else{const parts=q.split(' ');const last=String(parts[parts.length-1]||'').toUpperCase();const lastTwo=parts.length>=2?String(parts.slice(-2).join(' ')).toUpperCase():'';if(STATE_FIPS[last]){state=last;city=parts.slice(0,-1).join(' ');}else if(STATE_NAMES[lastTwo]){state=STATE_NAMES[lastTwo];city=parts.slice(0,-2).join(' ');}else{city=q;state='';}}state=STATE_NAMES[state]||state;if(state)state=state.replace(/[^A-Z]/g,'');return{city:city.replace(/\s+(city|town|village|borough)$/i,''),state};}
function sqlQuote(v){return String(v||'').replace(/'/g,"''");}
function stripPlaceSuffix(name){return String(name||'').replace(/\s+(city|town|village|borough|municipality|balance)$/i,'').trim().toLowerCase();}
function rankPlaceFeature(feature,wantedCity){const p=feature.properties||{};const wanted=String(wantedCity||'').trim().toLowerCase();const name=String(p.NAME||'').trim().toLowerCase();const base=stripPlaceSuffix(p.NAME||'');if(base===wanted)return 0;if(name===wanted)return 1;if(name===wanted+' city')return 2;if(base.startsWith(wanted))return 3;if(name.includes(wanted))return 4;return 9;}
async function queryTigerPlaces(where,signal){const url=TIGER_PLACES_QUERY_URL+'?where='+encodeURIComponent(where)+'&outFields=NAME,GEOID,STATE&outSR=4326&f=geojson&returnGeometry=true&returnExceededLimitFeatures=true';const res=await fetch(url,{cache:'no-store',signal});if(!res.ok)throw new Error('Census boundary request failed');const data=await res.json();if(data.error)throw new Error(data.error.message||'Census boundary request failed');return data;}
async function fetchCityBoundary(city,stateAbbr,signal){const stateFips=STATE_FIPS[String(stateAbbr||'').toUpperCase()];if(!city||!stateFips)throw new Error('Use City, ST');const safe=sqlQuote(city);const candidates=["STATE='"+stateFips+"' AND (UPPER(NAME)=UPPER('"+safe+"') OR UPPER(NAME)=UPPER('"+safe+" city') OR UPPER(NAME)=UPPER('"+safe+" town') OR UPPER(NAME)=UPPER('"+safe+" village'))","STATE='"+stateFips+"' AND UPPER(NAME) LIKE UPPER('"+safe+"%')","STATE='"+stateFips+"' AND UPPER(NAME) LIKE UPPER('%"+safe+"%')"];for(const where of candidates){const data=await queryTigerPlaces(where,signal);if(data.features&&data.features.length){data.features.sort((a,b)=>rankPlaceFeature(a,city)-rankPlaceFeature(b,city));data.features=[data.features[0]];return data;}}throw new Error('City boundary not found');}
function clearCityLabelMarker(){if(searchedCityLabelMarker){map.removeLayer(searchedCityLabelMarker);searchedCityLabelMarker=null;}}
function replaceCityLimitBoundary(data,city,state){if(cityLimitLayer){try{map.removeLayer(cityLimitLayer);}catch(e){}}clearCityLabelMarker();cityLimitLayer=L.geoJSON(data,{style:{color:'rgba(0,200,255,0.95)',weight:2,fillColor:'rgba(0,200,255,0.07)',fillOpacity:1,dashArray:'6 4',interactive:true},onEachFeature:(feature,layer)=>{const p=feature.properties||{};const nm=p.NAME||city;layer.bindPopup('<b style="color:#00c8ff">'+nm+', '+state.toUpperCase()+'</b><br><span style="color:rgba(160,200,225,.7)">Census place boundary · GEOID '+(p.GEOID||'—')+'</span>');}});layersOn.cityLimits=true;const btn=document.getElementById('btn-citylimits');if(btn)btn.classList.add('on');cityLimitLayer.addTo(map);const bounds=cityLimitLayer.getBounds();if(bounds&&bounds.isValid()){map.fitBounds(bounds.pad(0.18),{animate:true,duration:.8});const center=bounds.getCenter();searchedCityLabelMarker=L.marker(center,{icon:L.divIcon({className:'',html:'<div class="city-label-marker">'+String(city).toUpperCase()+' '+state.toUpperCase()+'</div>',iconAnchor:[42,8]}),interactive:false}).addTo(map);}return cityLimitLayer;}
function distanceMiles(lat1,lon1,lat2,lon2){const R=3958.8,toRad=d=>d*Math.PI/180;const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(a));}
function findNearestSelectableStation(latlng){const merged=new Map();[...(ACTIVE_STATIONS||[]),...(ALL_STATIONS||[])].forEach(s=>{if(s&&s.id&&!s.tdwr&&Number.isFinite(s.lat)&&Number.isFinite(s.lon)&&!merged.has(s.id))merged.set(s.id,s);});let best=null;merged.forEach(s=>{const miles=distanceMiles(latlng.lat,latlng.lng,s.lat,s.lon);if(!best||miles<best.miles)best={...s,miles};});return best;}
function selectNearestTowerForCity(layer){if(!layer||!layer.getBounds)return;const center=layer.getBounds().getCenter();const nearest=findNearestSelectableStation(center);if(!nearest){setCitySearchStatus('NO TOWER','err');return;}selectedVelStation=nearest.id;if(typeof updateVelStationHUD==='function')updateVelStationHUD();if(typeof buildStationMarkers==='function')buildStationMarkers();if(typeof buildStationLegend==='function')buildStationLegend();if(typeof updateStationRangeRings==='function')updateStationRangeRings();if(typeof applyAllRadarLayers==='function')applyAllRadarLayers();if(splitViewActive&&typeof buildCompareRadarLayer==='function')buildCompareRadarLayer();setCitySearchStatus(nearest.name+' · '+nearest.miles.toFixed(0)+' MI','ok');setTimeout(()=>{if(!stationMarkerLayer||!stationMarkerLayer.eachLayer)return;stationMarkerLayer.eachLayer(marker=>{const s=marker.options&&marker.options.stationData;if(s&&s.id===nearest.id&&marker.openPopup)marker.openPopup();});},80);}
function refitMapToCityLimitLayer(layer,animate){
  if(!layer||!layer.getBounds)return;
  const bounds=layer.getBounds();
  if(bounds&&bounds.isValid()){
    map.fitBounds(bounds.pad(0.18),{animate:animate!==false,duration:.65});
  }
}
async function searchCityBoundaryAndTower(raw){const parsed=parseCityStateSearch(raw);if(!parsed||!parsed.city||!parsed.state){setCitySearchStatus('USE CITY, ST','err');return;}if(citySearchController)citySearchController.abort();citySearchController=new AbortController();setCitySearchStatus('SEARCHING…');try{const data=await fetchCityBoundary(parsed.city,parsed.state,citySearchController.signal);const layer=replaceCityLimitBoundary(data,parsed.city,parsed.state);updateSelectedCityContext(parsed.city,parsed.state,layer);selectNearestTowerForCity(layer);refitMapToCityLimitLayer(layer,true);setTimeout(()=>refitMapToCityLimitLayer(layer,true),180);setTimeout(()=>refitMapToCityLimitLayer(layer,false),520);}catch(err){if(err.name==='AbortError')return;console.warn('City search failed:',err);setCitySearchStatus(err.message||'NOT FOUND','err');}}

function getSavedCityText(){try{return localStorage.getItem(SAVED_CITY_KEY)||'';}catch(e){return ''}}
function saveCityText(text){try{localStorage.setItem(SAVED_CITY_KEY, normalizeCitySearchText(text));}catch(e){}}
function initCitySearch(){
  const form=document.getElementById('city-search-form');
  const input=document.getElementById('city-search-input');
  if(form&&input){
    const saved=getSavedCityText();
    if(saved) input.value=saved;
    form.addEventListener('submit',e=>{e.preventDefault();searchCityBoundaryAndTower(input.value);closeFloatingPanels();});
  }
  const setForm=document.getElementById('set-my-city-form');
  const setInput=document.getElementById('set-my-city-input');
  const setStatus=document.getElementById('set-my-city-status');
  if(setInput){setInput.value=getSavedCityText() || 'Frisco, TX';}
  if(setForm&&setInput){
    setForm.addEventListener('submit', async e=>{
      e.preventDefault();
      const cityText=normalizeCitySearchText(setInput.value);
      if(!cityText){ if(setStatus)setStatus.textContent='Enter a city as City, ST.'; return; }
      saveCityText(cityText);
      if(input) input.value=cityText;
      if(setStatus)setStatus.textContent='Saved. Loading '+cityText+' as your home city…';
      await searchCityBoundaryAndTower(cityText);
      closeFloatingPanels();
    });
  }
}



// ── DEVICE LOCATION / REAL-TIME TRACKING ─────────────────────────────────────
let userLocationMarker = null;
let userAccuracyCircle = null;
let userLocationWatchId = null;
let userLocationFirstFix = true;
let userLocationLast = null;

function setLocateButtonState(state, title){
  const btn = document.getElementById('locate-me-btn');
  if(!btn) return;
  btn.classList.toggle('tracking', state === 'tracking');
  btn.classList.toggle('error', state === 'error');
  btn.setAttribute('aria-pressed', state === 'tracking' ? 'true' : 'false');
  btn.title = title || (state === 'tracking' ? 'Tracking your location' : 'Locate me');
}
function formatCoord(n){return Number.isFinite(n) ? n.toFixed(5) : '—';}
function formatLocationTime(ts){try{return new Date(ts || Date.now()).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'});}catch(e){return 'now';}}
function buildLocationPopup(pos){
  const c = pos.coords || {};
  const acc = Number.isFinite(c.accuracy) ? Math.round(c.accuracy) + ' m' : '—';
  const speed = Number.isFinite(c.speed) && c.speed !== null ? (c.speed * 2.23694).toFixed(1) + ' mph' : '—';
  const heading = Number.isFinite(c.heading) && c.heading !== null ? Math.round(c.heading) + '°' : '—';
  return '<div class="location-popup"><b>LIVE DEVICE LOCATION</b><br>' +
    '<span>Lat/Lon:</span> ' + formatCoord(c.latitude) + ', ' + formatCoord(c.longitude) + '<br>' +
    '<span>Accuracy:</span> ' + acc + '<br>' +
    '<span>Speed:</span> ' + speed + ' &nbsp; <span>Heading:</span> ' + heading + '<br>' +
    '<span>Updated:</span> ' + formatLocationTime(pos.timestamp) + '</div>';
}
function updateUserLocationOnMap(pos){
  if(!pos || !pos.coords) return;
  const lat = pos.coords.latitude, lng = pos.coords.longitude;
  if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const latlng = [lat, lng];
  const popupHtml = buildLocationPopup(pos);
  userLocationLast = pos;
  scheduleAlertPanelRefresh();
  if(!userLocationMarker){
    userLocationMarker = L.marker(latlng, {zIndexOffset:2200, icon:L.divIcon({className:'', html:'<div class="locate-dot"></div>', iconSize:[18,18], iconAnchor:[9,9]})}).addTo(map);
    userLocationMarker.bindPopup(popupHtml);
  } else {
    userLocationMarker.setLatLng(latlng);
    userLocationMarker.setPopupContent(popupHtml);
  }
  const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 0;
  if(!userAccuracyCircle){
    userAccuracyCircle = L.circle(latlng, {radius:Math.max(accuracy,10), color:'rgba(0,230,118,.75)', weight:1, fillColor:'rgba(0,230,118,.14)', fillOpacity:1, interactive:false}).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(latlng);
    userAccuracyCircle.setRadius(Math.max(accuracy,10));
  }
  if(userLocationFirstFix){
    userLocationFirstFix = false;
    map.setView(latlng, Math.max(map.getZoom(), 13), {animate:true});
    setTimeout(() => { try{ userLocationMarker.openPopup(); }catch(e){} }, 350);
  }
}
function handleUserLocationError(err){
  console.warn('Location error:', err);
  stopDeviceLocationTracking(false);
  let msg = 'Location unavailable';
  if(err && err.code === 1) msg = 'Location permission denied';
  if(err && err.code === 2) msg = 'Device position unavailable';
  if(err && err.code === 3) msg = 'Location request timed out';
  setLocateButtonState('error', msg);
  setTimeout(() => setLocateButtonState('idle'), 2500);
}
function startDeviceLocationTracking(){
  if(!navigator.geolocation){setLocateButtonState('error','Geolocation is not supported');setTimeout(()=>setLocateButtonState('idle'),2500);return;}
  userLocationFirstFix = true;
  setLocateButtonState('tracking','Finding your location…');
  userLocationWatchId = navigator.geolocation.watchPosition(updateUserLocationOnMap, handleUserLocationError, {enableHighAccuracy:true, maximumAge:3000, timeout:15000});
}
function stopDeviceLocationTracking(clearLayers){
  if(userLocationWatchId !== null){navigator.geolocation.clearWatch(userLocationWatchId);userLocationWatchId = null;}
  if(clearLayers){
    if(userLocationMarker){try{map.removeLayer(userLocationMarker);}catch(e){} userLocationMarker = null;}
    if(userAccuracyCircle){try{map.removeLayer(userAccuracyCircle);}catch(e){} userAccuracyCircle = null;}
    userLocationLast = null;
  }
  setLocateButtonState('idle');
}
function toggleDeviceLocationTracking(){
  if(userLocationWatchId !== null) stopDeviceLocationTracking(true);
  else startDeviceLocationTracking();
}

function closeFloatingPanels(exceptId){
  ['location-panel','settings-panel'].forEach(id=>{
    if(id===exceptId)return;
    const panel=document.getElementById(id);
    const btn=document.getElementById(id==='location-panel'?'btn-location-menu':'btn-settings-menu');
    if(panel){panel.classList.remove('open');panel.setAttribute('aria-hidden','true');}
    if(btn){btn.classList.remove('on');btn.setAttribute('aria-expanded','false');}
  });
}
function toggleFloatingPanel(panelId, buttonId){
  const panel=document.getElementById(panelId), btn=document.getElementById(buttonId);
  if(!panel)return;
  const open=!panel.classList.contains('open');
  closeFloatingPanels(open?panelId:null);
  panel.classList.toggle('open',open);
  panel.setAttribute('aria-hidden',open?'false':'true');
  if(btn){btn.classList.toggle('on',open);btn.setAttribute('aria-expanded',open?'true':'false');}
}
function syncSettingsControls(){
  const dark=document.getElementById('settings-darkmode');
  const over=document.getElementById('settings-overlap');
  const radius=document.getElementById('settings-alert-radius');
  if(dark)dark.classList.toggle('on',!!darkModeEnabled);
  if(over)over.classList.toggle('on',!!overlapCullingEnabled);
  if(radius)radius.value=String(ALERT_PANEL_RADIUS_MILES||150);
}
function initTopMenus(){
  document.getElementById('btn-location-menu')?.addEventListener('click',()=>toggleFloatingPanel('location-panel','btn-location-menu'));
  document.getElementById('btn-settings-menu')?.addEventListener('click',()=>{syncSettingsControls();toggleFloatingPanel('settings-panel','btn-settings-menu');});
  document.addEventListener('click',e=>{
    if(e.target.closest('.floating-panel')||e.target.closest('#btn-location-menu')||e.target.closest('#btn-settings-menu'))return;
    closeFloatingPanels();
  });
  document.getElementById('settings-darkmode')?.addEventListener('click',()=>{toggleDarkMode();syncSettingsControls();});
  document.getElementById('settings-overlap')?.addEventListener('click',()=>{toggleOverlapCulling();syncSettingsControls();});
  document.getElementById('settings-alert-radius')?.addEventListener('change',e=>{
    ALERT_PANEL_RADIUS_MILES=Number(e.target.value)||150;
    try{localStorage.setItem(ALERT_RADIUS_KEY,String(ALERT_PANEL_RADIUS_MILES));}catch(err){}
    scheduleAlertPanelRefresh();
  });
}
function initLocateMeControl(){
  const btn = document.getElementById('locate-me-btn');
  if(!btn) return;
  btn.addEventListener('click', toggleDeviceLocationTracking);
}


// ── DEFAULT CITY BOUNDARY ─────────────────────────────────────────────────────
async function loadDefaultCityBoundary() {
  if (window.FriscoLayers && typeof window.FriscoLayers.loadBoundary === 'function') {
    cityLimitLayer = await window.FriscoLayers.loadBoundary({ map, L, layersOn });
    return cityLimitLayer;
  }
}

function isSelectedCityFrisco() {
  const city = String(selectedCityContext?.city || '').trim().toLowerCase();
  const state = String(selectedCityContext?.state || '').trim().toUpperCase();
  return state === 'TX' && city === 'frisco';
}

function syncFriscoLayerAvailability() {
  const isFrisco = isSelectedCityFrisco();
  ['btn-sirens','btn-firestations','btn-firedistricts'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !isFrisco;
    btn.classList.toggle('disabled', !isFrisco);
    btn.title = isFrisco ? '' : 'Frisco-only layer. Search Frisco, TX to enable.';
  });
  const note = document.getElementById('frisco-layer-note');
  if (note) note.textContent = isFrisco
    ? 'Frisco emergency layers are available. They load only when toggled on.'
    : 'Frisco fire districts, fire stations, and sirens stay unloaded unless Frisco, TX is selected.';

  if (!isFrisco) {
    ['sirens','fireStations','fireDistricts'].forEach(name => {
      if (layersOn[name]) toggleLayer(name, false);
    });
  }
}

loadDefaultCityBoundary();
if (window.FriscoLayers && typeof window.FriscoLayers.addDefaultLabel === 'function') {
  window.FriscoLayers.addDefaultLabel({ map, L });
}

// ── RADAR ─────────────────────────────────────────────────────────────────────
function loadRadar() {
  applyAllRadarLayers();
  buildStationMarkers();
  buildStationLegend();
  updateRadarTime();
  document.getElementById('radar-frames').textContent = 'NWS LIVE';
}

function applyAllRadarLayers() {
  radarLayers.forEach(l=>map.removeLayer(l));
  radarLayers=[];
  const hydroLegend = document.getElementById('hydro-legend');
  if (hydroLegend) hydroLegend.classList.toggle('active', radarType === 'hclass' || (splitViewActive && splitRadarProduct === 'hclass'));
  updateHydroInspectAvailability();

  if (radarType === 'reflectivity') {
    const base = makeWMS(NWS_BASE + '/conus/ows', 'conus_bref_qcd', 0.52);
    base.addTo(map); radarLayers.push(base);
    getNearestReflectivityStations(4).forEach(s => { const ln = getLayerName(s, 'reflectivity'); if (!ln) return; const l = makeWMS(NWS_BASE + '/' + s.id + '/ows', ln, 0.68); l.addTo(map); radarLayers.push(l); });
  } else if (radarType === 'composite') {
    const l = makeWMS(NWS_BASE + '/conus/ows', 'conus_cref_qcd', 0.66); l.addTo(map); radarLayers.push(l);
  } else if (radarType === 'hclass') {
    const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation && !s.tdwr) || DFW_STATIONS[0];
    const ln = station ? getLayerName(station, 'hclass') : null;
    if (station && ln) { const l = makeWMS(NWS_BASE + '/' + station.id + '/ows', ln, 0.92); l.addTo(map); radarLayers.push(l); }
    updateVelStationHUD();
  } else {
    const station = ACTIVE_STATIONS.find(s => s.id === selectedVelStation);
    if (station && !station.tdwr) { const ln = getLayerName(station, 'velocity'); if (ln) { console.log('Loading velocity layer:', NWS_BASE + '/' + station.id + '/ows', ln); const l = makeWMS(NWS_BASE + '/' + station.id + '/ows', ln, 0.82); l.addTo(map); radarLayers.push(l); } }
    updateVelStationHUD();
  }
  updateStationRangeRings();
}

function buildStationMarkers() {
  if (stationMarkerLayer) map.removeLayer(stationMarkerLayer);
  if (!dopplerStationsOn) return;
  stationMarkerLayer = L.layerGroup().addTo(map);

  ACTIVE_STATIONS.forEach(station=>{
    const isSelected = station.id===selectedVelStation;
    const isTdwr = !!station.tdwr;
    const isTest = !!station.test;
    const ringColor = isTdwr ? '#ffb300' : isTest ? '#a078ff' : '#00c8ff';
    const ringBg    = isTdwr ? 'rgba(255,180,0,.08)' : isTest ? 'rgba(160,120,255,.08)' : 'rgba(0,200,255,.08)';
    const selGlow   = (radarType==='velocity'||radarType==='hclass'||splitViewActive)&&isSelected&&!isTdwr
      ? `box-shadow:0 0 14px ${ringColor}99;border-width:2.5px;` : '';

    const icon = L.divIcon({
      className:'',
      html:`<div style="position:relative;width:40px;height:40px;display:flex;align-items:center;justify-content:center">
        <div style="position:absolute;inset:0;border-radius:50%;border:1.5px solid ${ringColor};background:${ringBg};${selGlow}"></div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.5px;color:${ringColor};text-shadow:0 0 6px ${ringColor}88;position:relative;z-index:1;text-align:center;line-height:1.15;pointer-events:none">
          ${station.name}
        </div>
      </div>`,
      iconSize:[40,40],iconAnchor:[20,20]
    });

    const canSelectVel = !isTdwr;
    const btnLabel = isSelected ? '✓ STATION SELECTED' : 'SELECT STATION';
    const popup = `
      <div style="font-family:'JetBrains Mono',monospace;min-width:170px">
        <div style="color:${ringColor};font-size:11px;font-weight:600;margin-bottom:3px">${station.name} · ${station.label}</div>
        <div style="font-size:9px;color:var(--text-dim);margin-bottom:${canSelectVel?'6px':'0'}">${isTdwr?'Terminal Doppler Weather Radar':isTest?'NEXRAD WSR-88D · TEST STATION':'NEXRAD WSR-88D'}</div>
        ${isTdwr
          ? '<div style="font-size:8.5px;color:#ffb300;margin-top:2px">Reflectivity only · No public velocity</div>'
          : `<button onclick="selectVelStation('${station.id}')" style="font-family:'JetBrains Mono',monospace;font-size:8.5px;padding:4px 10px;background:${isSelected&&radarType==='velocity'?'rgba(0,200,255,.2)':'rgba(0,200,255,.1)'};border:1px solid ${ringColor};color:${ringColor};border-radius:3px;cursor:pointer;letter-spacing:.4px;width:100%">${btnLabel}</button>`
        }
      </div>`;

    L.marker([station.lat,station.lon],{icon,zIndexOffset:500,stationData:station})
      .bindPopup(popup,{maxWidth:230})
      .addTo(stationMarkerLayer);
  });
  scheduleOverlapCulling(80);
}

function buildStationLegend() {
  const el = document.getElementById('station-legend');
  if (!el) return;
  if (!dopplerStationsOn) { el.innerHTML = '<div class="river-gauge-list">Doppler station markers are hidden. Toggle Doppler Stations to show them.</div>'; return; }

  el.innerHTML = ACTIVE_STATIONS.map(s => {
    const cls = s.tdwr ? 'tdwr' : s.test ? 'test' : 'wsr';
    const sel = radarType === 'velocity' && s.id === selectedVelStation && !s.tdwr
      ? ' style="border-width:1.5px;opacity:1"'
      : '';

    return `<span class="station-tag ${cls}"${sel}
      title="${s.label}"
      data-station-id="${s.id}"
      role="button"
      tabindex="0"
      aria-label="Go to ${s.name} ${s.label}">
      ${s.name}
    </span>`;
  }).join('');

  el.querySelectorAll('.station-tag').forEach(tag => {
    const stationId = tag.getAttribute('data-station-id');

    tag.addEventListener('click', () => {
      flyToStation(stationId);
    });

    tag.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flyToStation(stationId);
      }
    });
  });
}

function flyToStation(stationId) {
  const station = ACTIVE_STATIONS.find(s => s.id === stationId);
  if (!station) return;

  const targetZoom = Math.max(map.getZoom(), 9);

  map.flyTo([station.lat, station.lon], targetZoom, {
    animate: true,
    duration: 0.65
  });

  if (splitViewActive && compareMap) {
    setTimeout(() => {
      compareMap.setView([station.lat, station.lon], targetZoom, { animate:false });
    }, 700);
  }

  const status = document.getElementById('radar-frames');
  if (status) status.textContent = station.name + ' · ' + station.label;
}

function updateVelStationHUD() {
  const station=ACTIVE_STATIONS.find(s=>s.id===selectedVelStation);
  const el=document.getElementById('vel-station-label');
  if (el&&station) el.textContent=station.name+' · '+station.label;
}

async function loadReflectivityLoopFrames() {
  const config = getRadarLoopConfig();
  const status = document.getElementById('radar-frames');
  const label = document.getElementById('refl-loop-label');
  const playBtn = document.getElementById('refl-loop-play');

  if (!config) {
    if (status) status.textContent = 'NO HISTORY';
    if (label) label.textContent = 'HISTORY UNAVAILABLE';
    reflectivityLoopFrames = [];
    return [];
  }

  try {
    reflectivityLoopConfigKey = config.key;
    if (status) status.textContent = 'LOADING HISTORY';
    if (label) label.textContent = 'FETCHING RECENT FRAMES…';
    if (playBtn) playBtn.textContent = 'LOADING…';
    setReflectivityLoopLoadProgress(3, config.loadingText || 'LOADING RADAR FRAMES');

    reflectivityLoopFrames = await fetchRadarTimesForConfig(config);

    if (!reflectivityLoopFrames.length) throw new Error('No recent radar frames available');

    if (status) status.textContent = `${reflectivityLoopFrames.length} FRAMES`;
    if (label) label.textContent = `${config.productName} READY`;

    return reflectivityLoopFrames;
  } catch (err) {
    console.warn('Radar history loop failed:', err);

    if (status) status.textContent = 'HISTORY UNAVAILABLE';
    if (label) label.textContent = 'HISTORY UNAVAILABLE';
    if (playBtn) playBtn.textContent = '▶ LOOP';
    hideReflectivityLoopLoadProgress();

    reflectivityLoopFrames = [];
    return [];
  }
}

function formatRadarFrameTime(frame) {
  if (!frame || !frame.ms) return '—';

  return new Date(frame.ms).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }) + ' CDT';
}

function waitForLayerReady(layer, timeoutMs = 2200) {
  return new Promise(resolve => {
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      layer.off('load', finish);
      layer.off('tileerror', finish);
      resolve();
    }

    layer.once('load', finish);
    layer.once('tileerror', finish);
    setTimeout(finish, timeoutMs);
  });
}

function clearReflectivityLoopCache() {
  if (reflectivityLoopLayer) {
    map.removeLayer(reflectivityLoopLayer);
    reflectivityLoopLayer = null;
  }

  reflectivityLoopLayerCache.forEach(layer => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });

  reflectivityLoopLayerCache.clear();
  reflectivityLoopPreloaded = false;
  reflectivityLoopPreloading = false;
  clearCompareLoopCache();
  hideReflectivityLoopLoadProgress();
}

function setReflectivityLoopLoadProgress(pct, text) {
  const wrap = document.getElementById('refl-loop-loader');
  const bar = document.getElementById('refl-loop-loader-bar');
  const pctEl = document.getElementById('refl-loop-loader-pct');
  const textEl = document.getElementById('refl-loop-loader-text');

  const safePct = Math.max(0, Math.min(100, Math.round(pct || 0)));

  if (wrap) {
    wrap.classList.add('active');
    wrap.setAttribute('aria-hidden', 'false');
  }

  if (bar) bar.style.width = safePct + '%';
  if (pctEl) pctEl.textContent = safePct + '%';
  if (textEl && text) textEl.textContent = text;
}

function hideReflectivityLoopLoadProgress() {
  const wrap = document.getElementById('refl-loop-loader');
  const bar = document.getElementById('refl-loop-loader-bar');
  const pctEl = document.getElementById('refl-loop-loader-pct');

  if (wrap) {
    wrap.classList.remove('active');
    wrap.setAttribute('aria-hidden', 'true');
  }

  if (bar) bar.style.width = '0%';
  if (pctEl) pctEl.textContent = '0%';
}

async function preloadReflectivityLoopLayers() {
  const config = getRadarLoopConfig();
  if (!config || !reflectivityLoopFrames.length || reflectivityLoopPreloaded || reflectivityLoopPreloading) return;

  reflectivityLoopPreloading = true;
  reflectivityLoopConfigKey = config.key;

  const label = document.getElementById('refl-loop-label');
  const playBtn = document.getElementById('refl-loop-play');
  const status = document.getElementById('radar-frames');

  if (label) label.textContent = 'RENDERING FRAMES…';
  if (playBtn) playBtn.textContent = 'LOADING…';
  if (status) status.textContent = 'PRELOADING';
  setReflectivityLoopLoadProgress(0, config.loadingText || 'LOADING RADAR FRAMES');

  const total = reflectivityLoopFrames.length * config.layers.length;
  let loaded = 0;

  const readyPromises = [];

  reflectivityLoopFrames.forEach(frame => {
    config.layers.forEach(spec => {
      const cacheKey = `${config.key}|${spec.layer}|${frame.iso}`;
      let layer = reflectivityLoopLayerCache.get(cacheKey);

      if (!layer) {
        layer = makeTimedRadarLayer(spec, frame.iso, 0);
        reflectivityLoopLayerCache.set(cacheKey, layer);
      }

      if (!map.hasLayer(layer)) {
        layer.setOpacity(0);
        layer.addTo(map);
      }

      readyPromises.push(waitForLayerReady(layer).then(() => {
        loaded += 1;
        setReflectivityLoopLoadProgress((loaded / total) * 100, config.loadingText || 'LOADING RADAR FRAMES');
      }));
    });
  });

  await Promise.allSettled(readyPromises);

  setReflectivityLoopLoadProgress(100, 'FRAMES READY');

  reflectivityLoopPreloaded = true;
  reflectivityLoopPreloading = false;

  if (!reflectivityLoopPlaying) {
    if (label) label.textContent = 'READY · PRESS LOOP';
    if (playBtn) playBtn.textContent = '▶ LOOP';
  }

  setTimeout(() => {
    if (!reflectivityLoopPreloading) hideReflectivityLoopLoadProgress();
  }, 450);
}


function clearCompareLoopCache() {
  if (!compareMap) return;
  compareLoopLayerCache.forEach(layer => {
    if (compareMap.hasLayer(layer)) compareMap.removeLayer(layer);
  });
  compareLoopLayerCache.clear();
  compareLoopFrames = [];
  compareLoopConfigKey = null;
}

async function loadCompareLoopFrames() {
  const config = getCompareRadarLoopConfig();
  if (!config) { compareLoopFrames = []; return []; }
  compareLoopConfigKey = config.key;
  try {
    compareLoopFrames = await fetchRadarTimesForConfig(config);
    return compareLoopFrames;
  } catch (err) {
    console.warn('Split-view radar history failed:', err);
    compareLoopFrames = [];
    return [];
  }
}

async function preloadCompareLoopLayers() {
  const config = getCompareRadarLoopConfig();
  if (!compareMap || !config || !compareLoopFrames.length) return;
  const total = compareLoopFrames.length * config.layers.length;
  let loaded = 0;
  const readyPromises = [];
  compareLoopFrames.forEach(frame => {
    config.layers.forEach(spec => {
      const cacheKey = `${config.key}|${spec.layer}|${frame.iso}`;
      let layer = compareLoopLayerCache.get(cacheKey);
      if (!layer) {
        layer = makeTimedRadarLayer(spec, frame.iso, 0);
        compareLoopLayerCache.set(cacheKey, layer);
      }
      if (!compareMap.hasLayer(layer)) {
        layer.setOpacity(0);
        layer.addTo(compareMap);
      }
      readyPromises.push(waitForLayerReady(layer).then(() => {
        loaded += 1;
        const baseLoaded = reflectivityLoopFrames.length ? reflectivityLoopFrames.length : 1;
        setReflectivityLoopLoadProgress(50 + (loaded / Math.max(total,1)) * 50, config.loadingText || 'LOADING SPLIT FRAMES');
      }));
    });
  });
  await Promise.allSettled(readyPromises);
}

function hideLiveRadarLayersDuringLoop() {
  if (radarLayers.length) {
    radarLayers.forEach(layer => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    radarLayers = [];
  }
}

function hideLiveCompareLayersDuringLoop() {
  if (!compareMap || !compareRadarLayers.length) return;
  compareRadarLayers.forEach(layer => {
    if (compareMap.hasLayer(layer)) compareMap.removeLayer(layer);
  });
  compareRadarLayers = [];
}

function showCompareLoopFrame(index) {
  const config = getCompareRadarLoopConfig();
  if (!compareMap || !config || !compareLoopFrames.length) return;
  const frameIndex = ((index % compareLoopFrames.length) + compareLoopFrames.length) % compareLoopFrames.length;
  const frame = compareLoopFrames[frameIndex];
  compareLoopLayerCache.forEach(layer => layer.setOpacity(0));
  config.layers.forEach(spec => {
    const cacheKey = `${config.key}|${spec.layer}|${frame.iso}`;
    let layer = compareLoopLayerCache.get(cacheKey);
    if (!layer) {
      layer = makeTimedRadarLayer(spec, frame.iso, 0);
      compareLoopLayerCache.set(cacheKey, layer);
      layer.addTo(compareMap);
    }
    layer.setOpacity(spec.opacity || 0.78);
    layer.bringToFront();
  });

  // Once the split history frame is visible, remove the live split layer so the loop is clean.
  hideLiveCompareLayersDuringLoop();
}

function showReflectivityLoopFrame(index) {
  const config = getRadarLoopConfig();
  if (!config || !reflectivityLoopFrames.length) return;

  reflectivityLoopIndex =
    ((index % reflectivityLoopFrames.length) + reflectivityLoopFrames.length) %
    reflectivityLoopFrames.length;

  const frame = reflectivityLoopFrames[reflectivityLoopIndex];
  const nextFrame = reflectivityLoopFrames[(reflectivityLoopIndex + 1) % reflectivityLoopFrames.length];

  reflectivityLoopLayerCache.forEach(layer => layer.setOpacity(0));

  config.layers.forEach(spec => {
    const cacheKey = `${config.key}|${spec.layer}|${frame.iso}`;
    let layer = reflectivityLoopLayerCache.get(cacheKey);

    if (!layer) {
      layer = makeTimedRadarLayer(spec, frame.iso, 0);
      reflectivityLoopLayerCache.set(cacheKey, layer);
      layer.addTo(map);
    }

    layer.setOpacity(spec.opacity || 0.7);
    layer.bringToFront();
    reflectivityLoopLayer = layer;
  });

  // Keep the next frame attached and rendered at opacity 0 so frame switches feel animated instead of flashing.
  if (nextFrame) {
    config.layers.forEach(spec => {
      const nextKey = `${config.key}|${spec.layer}|${nextFrame.iso}`;
      const nextLayer = reflectivityLoopLayerCache.get(nextKey);
      if (nextLayer && !map.hasLayer(nextLayer)) {
        nextLayer.setOpacity(0);
        nextLayer.addTo(map);
      }
    });
  }

  const radarTime = document.getElementById('radar-time');
  const label = document.getElementById('refl-loop-label');
  const frames = document.getElementById('radar-frames');
  const playBtn = document.getElementById('refl-loop-play');
  const frameTime = formatRadarFrameTime(frame);

  if (radarTime) radarTime.textContent = frameTime + ' · LOOP';
  if (label) label.textContent = `FRAME ${reflectivityLoopIndex + 1}/${reflectivityLoopFrames.length}`;
  if (frames) frames.textContent = 'LOOP ACTIVE';
  if (playBtn) playBtn.textContent = `❚❚ ${frameTime}`;

  // Once the history frame is visible, remove live radar so the loop is not noisy.
  // Live returns when the user presses LIVE or refreshes.
  hideLiveRadarLayersDuringLoop();
}

async function startReflectivityLoop() {
  const configAtStart = getRadarLoopConfig();
  if (!configAtStart) return;

  // Reset any stale history cache, then load the left and right panes independently.
  stopReflectivityLoop(false, true);

  const label = document.getElementById('refl-loop-label');
  const playBtn = document.getElementById('refl-loop-play');
  const status = document.getElementById('radar-frames');

  if (label) label.textContent = 'LOADING HISTORY…';
  if (playBtn) playBtn.textContent = 'LOADING…';
  if (status) status.textContent = splitViewActive ? 'LOADING BOTH PANES' : 'LOADING HISTORY';
  setReflectivityLoopLoadProgress(2, splitViewActive ? 'LOADING BOTH RADAR PANES' : (configAtStart.loadingText || 'LOADING RADAR FRAMES'));

  const mainFramesPromise = loadReflectivityLoopFrames();
  const compareFramesPromise = (splitViewActive && compareMap) ? loadCompareLoopFrames() : Promise.resolve([]);
  const [mainFrames, splitFrames] = await Promise.all([mainFramesPromise, compareFramesPromise]);

  if (!mainFrames.length) {
    if (playBtn) playBtn.textContent = '▶ LOOP';
    if (label) label.textContent = 'HISTORY UNAVAILABLE';
    hideReflectivityLoopLoadProgress();
    return;
  }

  // Pre-render both panes in parallel before playback starts. This prevents one pane
  // from blocking the other and reduces the flash between WMS frames.
  const mainPreload = preloadReflectivityLoopLayers();
  const splitPreload = (splitViewActive && compareMap && splitFrames.length)
    ? preloadCompareLoopLayers()
    : Promise.resolve();

  await Promise.allSettled([mainPreload, splitPreload]);

  // Frames are already preloaded at opacity 0. Playback will show the first frame,
  // then remove the live layer immediately so the loop stays clean without clearing.

  reflectivityLoopPlaying = true;
  reflectivityLoopIndex = 0;
  document.getElementById('hud-radar')?.classList.add('loop-active');

  showReflectivityLoopFrame(reflectivityLoopIndex);
  if (splitViewActive && compareMap && compareLoopFrames.length) {
    showCompareLoopFrame(reflectivityLoopIndex);
  }

  reflectivityLoopTimer = setInterval(() => {
    const nextIndex = reflectivityLoopIndex + 1;
    showReflectivityLoopFrame(nextIndex);
    if (splitViewActive && compareMap && compareLoopFrames.length) {
      showCompareLoopFrame(nextIndex);
    }
  }, REFLECTIVITY_LOOP_SPEED_MS);
}

function stopReflectivityLoop(restoreLive = true, clearCache = true) {
  reflectivityLoopPlaying = false;

  if (reflectivityLoopTimer) {
    clearInterval(reflectivityLoopTimer);
    reflectivityLoopTimer = null;
  }

  const playBtn = document.getElementById('refl-loop-play');
  const label = document.getElementById('refl-loop-label');
  const radarHud = document.getElementById('hud-radar');

  if (playBtn) playBtn.textContent = '▶ LOOP';
  if (label) label.textContent = 'LIVE UNTIL PLAY';
  if (radarHud) radarHud.classList.remove('loop-active');

  if (clearCache) {
    clearReflectivityLoopCache();
  } else {
    reflectivityLoopLayerCache.forEach(layer => layer.setOpacity(0));
    compareLoopLayerCache.forEach(layer => layer.setOpacity(0));
    hideReflectivityLoopLoadProgress();
  }

  if (restoreLive) {
    applyAllRadarLayers();
    if (splitViewActive && compareMap) buildCompareRadarLayer();
    updateRadarTime();

    const frames = document.getElementById('radar-frames');
    if (frames) frames.textContent = 'NWS LIVE';
  }
}

function setRadarType(type) {
  if (type !== radarType) {
    stopReflectivityLoop(false, true);
    reflectivityLoopFrames = [];
    reflectivityLoopConfigKey = null;
  }
  if (splitViewActive && (type === 'velocity' || type === 'hclass')) { setSplitRadarProduct(type === 'hclass' ? 'hclass' : 'velocity'); return; }
  radarType = type;
  ['rtype-refl','rtype-comp','rtype-hydro','rtype-vel'].forEach(id => { const el=document.getElementById(id); if(el) el.classList.remove('on'); });
  if (type === 'reflectivity') { document.getElementById('rtype-refl')?.classList.add('on'); }
  else if (type === 'velocity') { document.getElementById('rtype-vel')?.classList.add('on'); }
  else if (type === 'composite') document.getElementById('rtype-comp')?.classList.add('on');
  else if (type === 'hclass') document.getElementById('rtype-hydro')?.classList.add('on');
  const velRow=document.getElementById('vel-station-row'), loopRow=document.getElementById('refl-loop-row'), hydroLegend=document.getElementById('hydro-legend');
  if (velRow) velRow.style.display = (type === 'velocity' || type === 'hclass') ? 'block' : 'none';
  if (loopRow) loopRow.style.display = (type === 'reflectivity' || type === 'composite' || type === 'velocity' || type === 'hclass') ? 'flex' : 'none';
  if (hydroLegend) hydroLegend.classList.toggle('active', type === 'hclass' || (splitViewActive && splitRadarProduct === 'hclass'));
  updateHydroInspectAvailability();
  applyAllRadarLayers(); buildStationMarkers(); buildStationLegend(); updateRadarTime();
  const frames=document.getElementById('radar-frames');
  if(frames) frames.textContent = type === 'composite' ? 'COMP REFL' : type === 'hclass' ? 'HYDRO CLASS' : type === 'velocity' ? selectedVelStation.toUpperCase() : 'NWS LIVE';
}

function updateRadarTime() {
  const t = new Date().toLocaleTimeString('en-US', {
    timeZone:'America/Chicago',
    hour12:false,
    hour:'2-digit',
    minute:'2-digit'
  });

  const radarTime = document.getElementById('radar-time');
  if (radarTime) radarTime.textContent = t + ' CDT · LIVE';

  const last = document.getElementById('last-refresh');
  if (last) last.textContent = 'LAST ' + t + ' CDT';
}

function refreshRadar() {
  stopReflectivityLoop(false);
  reflectivityLoopFrames = [];
  reflectivityLoopConfigKey = null;

  applyAllRadarLayers();
  if (splitViewActive) buildCompareRadarLayer();
  updateRadarTime();

  const frames = document.getElementById('radar-frames');
  if (frames) frames.textContent = 'NWS LIVE';

  const label = document.getElementById('refl-loop-label');
  if (label) label.textContent = 'LIVE UNTIL PLAY';

  hideReflectivityLoopLoadProgress();
}


// ── LIVE NWS DOPPLER STATIONS ────────────────────────────────────────────────
function updateStationStatus(text){const el=document.getElementById('station-status');if(el)el.textContent=text;}
function normalizeRadarStationFeature(feature){
  const p=feature && feature.properties ? feature.properties : {};
  const coords=feature && feature.geometry && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : null;
  const rawId=p.id || p.radarStationId || p.stationId || p.identifier || (feature.id ? String(feature.id).split('/').pop() : '');
  const code=String(rawId||'').replace(/^K/i,'K').toUpperCase();
  if(!code || !coords || coords.length<2) return null;
  return {
    id:code.toLowerCase(),
    name:code,
    label:p.name || p.location || p.siteName || 'NWS Doppler Radar',
    lat:Number(coords[1]),
    lon:Number(coords[0]),
    live:true,
    tdwr:false,
    test:false
  };
}
function dedupeStations(stations){
  const seen=new Map();
  stations.forEach(s=>{if(s&&Number.isFinite(s.lat)&&Number.isFinite(s.lon)&&!seen.has(s.id))seen.set(s.id,s);});
  return Array.from(seen.values()).sort((a,b)=>a.name.localeCompare(b.name));
}
async function loadLiveDopplerStations(){
  if(dopplerStationFetchController) dopplerStationFetchController.abort();
  dopplerStationFetchController=new AbortController();
  updateStationStatus('Loading live NWS Doppler station list…');
  try{
    const res=await fetch(NWS_RADAR_STATIONS_URL,{cache:'no-store',signal:dopplerStationFetchController.signal,headers:{'Accept':'application/geo+json, application/json'}});
    if(!res.ok) throw new Error('NWS radar station request failed');
    const data=await res.json();
    const live=dedupeStations((data.features||[]).map(normalizeRadarStationFeature));
    if(!live.length) throw new Error('No live radar stations returned');
    ACTIVE_STATIONS=live;
    if(!ACTIVE_STATIONS.some(s=>s.id===selectedVelStation)){
      const nearest=getNearestReflectivityStations(1)[0];
      selectedVelStation=(nearest&&nearest.id)||'kfws';
    }
    updateStationStatus('Showing '+ACTIVE_STATIONS.length+' live NWS Doppler station nodes. Click a station to view velocity.');
  }catch(err){
    if(err.name==='AbortError')return;
    console.warn('Live Doppler station load failed:',err);
    ACTIVE_STATIONS=dedupeStations(ALL_STATIONS);
    updateStationStatus('Live NWS station list unavailable. Using built-in fallback station list.');
  }
  buildStationMarkers();
  buildStationLegend();
  updateVelStationHUD();
  if(radarType==='reflectivity'||radarType==='velocity'||radarType==='hclass') applyAllRadarLayers(); if(splitViewActive) buildCompareRadarLayer();
}
function toggleDopplerStations(){
  dopplerStationsOn=!dopplerStationsOn;
  const btn=document.getElementById('btn-dopplerstations');
  if(btn){btn.classList.toggle('on',dopplerStationsOn);btn.textContent=dopplerStationsOn?'DOPPLER STATIONS':'STATIONS HIDDEN';}
  if(dopplerStationsOn){buildStationMarkers();buildStationLegend();updateStationStatus('Doppler station nodes are visible. Click a station to view velocity.');}
  else{if(stationMarkerLayer){map.removeLayer(stationMarkerLayer);stationMarkerLayer=null;}buildStationLegend();updateStationStatus('Doppler station nodes are hidden.');}
}

// ── RIVER / FLOOD GAUGES ─────────────────────────────────────────────────────
function riverGaugeClass(status){return String(status||'not_defined').toLowerCase().replace(/[^a-z0-9_]+/g,'_');}
function riverGaugeLabel(status){return String(status||'Not Defined').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());}
function riverGaugeIcon(status){
  const cls=riverGaugeClass(status);
  return L.divIcon({className:'',html:'<div class="gauge-dot '+cls+'"></div>',iconSize:[14,14],iconAnchor:[7,7]});
}
function updateRiverGaugeStatus(text){const el=document.getElementById('river-gauge-status');if(el)el.textContent=text;}
async function loadRiverGaugeLayer(){
  if(riverGaugeFetchController) riverGaugeFetchController.abort();
  riverGaugeFetchController=new AbortController();
  if(riverGaugeLayer){map.removeLayer(riverGaugeLayer);riverGaugeLayer=null;}
  updateRiverGaugeStatus('Loading NWPS river/flood gauge nodes for this map view…');
  const b=map.getBounds().pad(0.85);
  const params=new URLSearchParams({
    f:'geojson',
    where:'1=1',
    outFields:'gaugelid,status,location,waterbody,state,obstime,wfo,url,observed,units,action,flood,moderate,major,latitude,longitude',
    returnGeometry:'true',
    geometry:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(','),
    geometryType:'esriGeometryEnvelope',
    inSR:'4326',
    outSR:'4326',
    spatialRel:'esriSpatialRelIntersects'
  });
  try{
    const res=await fetch(NWPS_GAUGE_LAYER_URL+'?'+params.toString(),{cache:'no-store',signal:riverGaugeFetchController.signal});
    if(!res.ok) throw new Error('Gauge layer request failed');
    const data=await res.json();
    riverGaugeCount=data.features?data.features.length:0;
    riverGaugeLayer=L.geoJSON(data,{
      pointToLayer:(feature,latlng)=>L.marker(latlng,{icon:riverGaugeIcon(feature.properties && feature.properties.status),zIndexOffset:650}),
      onEachFeature:(feature,layer)=>{
        const p=feature.properties||{};
        const title=p.location||p.waterbody||p.gaugelid||'River Gauge';
        const status=riverGaugeLabel(p.status);
        layer.bindTooltip((p.gaugelid||'')+' · '+status,{direction:'top',sticky:true});
        layer.on('click',()=>openRiverGaugePanel(p));
        const safeId=String(p.gaugelid||'').replace(/[^a-zA-Z0-9]/g,'');
        const popupHtml =
          '<div style="font-family:JetBrains Mono,monospace;min-width:190px">'+
          '<div style="color:#00c8ff;font-size:10px;font-weight:600;margin-bottom:4px">'+title+'</div>'+
          '<div style="font-size:8.5px;color:rgba(160,200,225,.7);line-height:1.45">'+
          '<b>ID:</b> '+(p.gaugelid||'—')+'<br>'+
          '<b>Waterbody:</b> '+(p.waterbody||'—')+'<br>'+
          '<b>Status:</b> '+status+'<br>'+
          '<b>Observed:</b> '+(p.observed||'—')+' '+(p.units||'')+
          '</div>'+
          '<button onclick="window.openRiverGaugeFromPopup && window.openRiverGaugeFromPopup(\''+safeId+'\')" style="margin-top:7px;font-family:JetBrains Mono,monospace;font-size:8.5px;padding:4px 8px;background:rgba(0,200,255,.1);border:1px solid #00c8ff;color:#00c8ff;border-radius:3px;cursor:pointer;width:100%">OPEN HYDROGRAPH</button>'+
          '</div>';
        layer.bindPopup(popupHtml,{maxWidth:250});
      }
    });
    if(layersOn.riverGauges) riverGaugeLayer.addTo(map);
    updateRiverGaugeStatus(riverGaugeCount ? 'Showing '+riverGaugeCount+' NWPS gauge node'+(riverGaugeCount===1?'':'s')+' in this map view. Click a node to load its hydrograph.' : 'No NWPS gauge nodes found in this map view. Zoom out and toggle again if needed.');
    scheduleOverlapCulling(120);
  }catch(err){
    if(err.name==='AbortError')return;
    console.warn('River gauge layer failed:',err);
    updateRiverGaugeStatus('River gauge nodes could not be loaded from NWPS right now.');
  }
}
function setRiverGaugeButtonState(){
  const btn=document.getElementById('btn-rivergauges');
  if(!btn) return;
  btn.classList.toggle('on',layersOn.riverGauges);
  btn.textContent = layersOn.riverGauges ? 'HIDE GAUGES' : 'SHOW GAUGES';
}
function toggleRiverGaugeLayer(){
  layersOn.riverGauges=!layersOn.riverGauges;
  setRiverGaugeButtonState();
  if(layersOn.riverGauges){openStackPanel('rivergauges');toggleToolsDrawer(true);loadRiverGaugeLayer();}
  else{if(riverGaugeFetchController)riverGaugeFetchController.abort();if(riverGaugeLayer)map.removeLayer(riverGaugeLayer);riverGaugeLayer=null;riverGaugeCount=0;updateRiverGaugeStatus('River/flood gauge layer is off. Toggle gauges here to load NWPS nodes.');closeRiverGaugePanel();}
}
let riverGaugeReloadTimer=null;
map.on('moveend zoomend',()=>{
  if(!layersOn.riverGauges) return;
  clearTimeout(riverGaugeReloadTimer);
  riverGaugeReloadTimer=setTimeout(loadRiverGaugeLayer,650);
});
function openRiverGaugePanel(props){
  const panel=document.getElementById('river-panel'),title=document.getElementById('river-panel-title'),meta=document.getElementById('river-panel-meta'),frame=document.getElementById('river-panel-frame'),loading=document.getElementById('river-panel-loading');
  if(!panel||!frame)return;
  const id=props.gaugelid||'';
  const hydroUrl=props.url||(id?'https://water.noaa.gov/gauges/'+encodeURIComponent(id):'https://water.noaa.gov/');
  if(title)title.textContent=id?'GAUGE '+id:'RIVER GAUGE';
  if(meta)meta.innerHTML='<b>Location:</b> '+(props.location||'—')+'<br><b>Waterbody:</b> '+(props.waterbody||'—')+'<br><b>Status:</b> '+riverGaugeLabel(props.status)+' · <b>Observed:</b> '+(props.observed||'—')+' '+(props.units||'')+'<br><span style="color:rgba(160,200,225,.45)">Only the hydrograph switcher/chart area is shown in this panel.</span>';
  if(loading)loading.style.display='block';
  frame.style.display='none';
  frame.src='about:blank';
  panel.classList.add('open');
  panel.setAttribute('aria-hidden','false');
  frame.onload=()=>{if(loading)loading.style.display='none';frame.style.display='block';};
  setTimeout(()=>{frame.src=hydroUrl;},50);
}
function closeRiverGaugePanel(){
  const panel=document.getElementById('river-panel'),frame=document.getElementById('river-panel-frame');
  if(frame)frame.src='about:blank';
  if(panel){panel.classList.remove('open');panel.setAttribute('aria-hidden','true');}
}
window.openRiverGaugeFromPopup=function(gaugeId){
  if(!riverGaugeLayer||!gaugeId)return;
  riverGaugeLayer.eachLayer(layer=>{const p=(layer.feature&&layer.feature.properties)||{}; if(String(p.gaugelid||'').toLowerCase()===String(gaugeId).toLowerCase()) openRiverGaugePanel(p);});
};

// ── ALERT FILTERS ─────────────────────────────────────────────────────────────
// These are the national warning/watch products that will be drawn on the map.
// The HUD remains focused on the local DFW area so it does not become noisy.

const WATCHED_WARNING_TYPES = [
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
  'Flood Warning',
  'Hurricane Warning',
  'Tropical Storm Warning',
  'Special Marine Warning',
  'Winter Storm Warning',
  'Blizzard Warning',
  'Ice Storm Warning'
];

const WATCHED_WATCH_TYPES = [
  'Tornado Watch',
  'Severe Thunderstorm Watch',
  'Flash Flood Watch',
  'Flood Watch',
  'Hurricane Watch',
  'Tropical Storm Watch',
  'Winter Storm Watch'
];

const WATCHED_ALERT_TYPES = [
  ...WATCHED_WARNING_TYPES,
  ...WATCHED_WATCH_TYPES
];

function normalizeEventName(event) {
  return (event || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesAlertType(event, types) {
  const e = normalizeEventName(event);

  return types.some(type => {
    const t = normalizeEventName(type);

    // Prefer exact match, but allow NWS variants that append details.
    return e === t || e.startsWith(t + ' ');
  });
}

function isWatchedAlertType(event) {
  return matchesAlertType(event, WATCHED_ALERT_TYPES);
}

function isWatchedWarning(event) {
  return matchesAlertType(event, WATCHED_WARNING_TYPES);
}

function isWatchedWatch(event) {
  return matchesAlertType(event, WATCHED_WATCH_TYPES);
}

function isLocalDFWAlert(feature) {
  const p = feature.properties || {};
  const area = (p.areaDesc || '').toLowerCase();
  const geocode = p.geocode || {};

  // NWS geocode SAME county codes for the local North Texas watch area:
  // Collin TX    = 048085
  // Dallas TX    = 048113
  // Denton TX    = 048121
  // Ellis TX     = 048139
  // Hunt TX      = 048231
  // Kaufman TX   = 048257
  // Rockwall TX  = 048397
  // Johnson TX   = 048251
  // Jack TX      = 048237
  // Parker TX    = 048367
  // Montague TX  = 048337
  // Clay TX      = 048077
  // Tarrant TX   = 048439
  // Wise TX      = 048497
  const localSameCodes = new Set([
    '048085', // Collin
    '048113', // Dallas
    '048121', // Denton
    '048139', // Ellis
    '048231', // Hunt
    '048257', // Kaufman
    '048397', // Rockwall
    '048251', // Johnson
    '048237', // Jack
    '048367', // Parker
    '048337', // Montague
    '048077', // Clay
    '048439', // Tarrant
    '048497'  // Wise
  ]);

  const sameCodes = Array.isArray(geocode.SAME) ? geocode.SAME : [];
  if (sameCodes.some(code => localSameCodes.has(String(code)))) {
    return true;
  }

  // Fallback for areaDesc text. Require TX/Texas context so same-name counties in other states do not match.
  const hasTexasContext =
    /tx/.test(area) ||
    /texas/.test(area) ||
    area.includes(', tx') ||
    area.includes(', texas');

  if (!hasTexasContext) return false;

  const localCountyNames = [
    'collin',
    'dallas',
    'denton',
    'ellis',
    'hunt',
    'kaufman',
    'rockwall',
    'johnson',
    'jack',
    'parker',
    'montague',
    'clay',
    'tarrant',
    'wise',
    'frisco'
  ];

  return localCountyNames.some(name => area.includes(name));
}


// ── ALERT PROXIMITY FILTERING ────────────────────────────────────────────────
let ALERT_PANEL_RADIUS_MILES = Number(localStorage.getItem(ALERT_RADIUS_KEY) || 150);
let alertPanelRefreshTimer = null;
let nearbyAlertFeatures = [];
let activeAlertPanelType = null;
const acknowledgedAlertIds = { warnings:new Set(), watches:new Set() };

function getUserLocationContext() {
  const c = userLocationLast && userLocationLast.coords ? userLocationLast.coords : null;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;

  return {
    label: 'Current Location',
    lat: c.latitude,
    lng: c.longitude,
    source: 'device'
  };
}

function getAlertReferenceContexts() {
  const contexts = [];

  if (selectedCityContext && Number.isFinite(Number(selectedCityContext.lat)) && Number.isFinite(Number(selectedCityContext.lng))) {
    contexts.push({
      label: [selectedCityContext.city, selectedCityContext.state].filter(Boolean).join(', ') || 'Searched City',
      lat: Number(selectedCityContext.lat),
      lng: Number(selectedCityContext.lng),
      source: 'city'
    });
  }

  const userCtx = getUserLocationContext();
  if (userCtx) contexts.push(userCtx);

  return contexts;
}

function normalizeLngDelta(delta) {
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function distancePointToSegmentMiles(point, a, b) {
  if (!a || !b) return Infinity;

  const latScale = 69.0;
  const lngScale = 69.172 * Math.cos(point.lat * Math.PI / 180);
  const ax = normalizeLngDelta(a.lng - point.lng) * lngScale;
  const ay = (a.lat - point.lat) * latScale;
  const bx = normalizeLngDelta(b.lng - point.lng) * lngScale;
  const by = (b.lat - point.lat) * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;

  if (!len2) return Math.sqrt(ax * ax + ay * ay);

  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

function coordToPoint(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function isPointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  const x = point.lng;
  const y = point.lat;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = coordToPoint(ring[i]);
    const pj = coordToPoint(ring[j]);
    if (!pi || !pj) continue;

    const xi = pi.lng, yi = pi.lat;
    const xj = pj.lng, yj = pj.lat;
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}

function isPointInPolygonCoords(point, polygonCoords) {
  if (!Array.isArray(polygonCoords) || !polygonCoords.length) return false;
  if (!isPointInRing(point, polygonCoords[0])) return false;

  // Holes should exclude the point if present.
  for (let i = 1; i < polygonCoords.length; i++) {
    if (isPointInRing(point, polygonCoords[i])) return false;
  }

  return true;
}

function geometryContainsPoint(geometry, point) {
  if (!geometry || !point) return false;

  if (geometry.type === 'Polygon') {
    return isPointInPolygonCoords(point, geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some(poly => isPointInPolygonCoords(point, poly));
  }

  return false;
}

function getGeometryRingsAndLines(geometry) {
  const lines = [];
  if (!geometry || !geometry.type) return lines;

  if (geometry.type === 'Polygon') {
    (geometry.coordinates || []).forEach(ring => lines.push(ring));
  } else if (geometry.type === 'MultiPolygon') {
    (geometry.coordinates || []).forEach(poly => (poly || []).forEach(ring => lines.push(ring)));
  } else if (geometry.type === 'LineString') {
    lines.push(geometry.coordinates || []);
  } else if (geometry.type === 'MultiLineString') {
    (geometry.coordinates || []).forEach(line => lines.push(line));
  } else if (geometry.type === 'Point') {
    lines.push([geometry.coordinates]);
  } else if (geometry.type === 'MultiPoint') {
    (geometry.coordinates || []).forEach(pt => lines.push([pt]));
  }

  return lines;
}

function distanceToGeometryMiles(geometry, context) {
  if (!geometry || !context) return Infinity;

  const point = { lat: Number(context.lat), lng: Number(context.lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return Infinity;
  if (geometryContainsPoint(geometry, point)) return 0;

  let min = Infinity;
  const lines = getGeometryRingsAndLines(geometry);

  for (const line of lines) {
    const pts = (line || []).map(coordToPoint).filter(Boolean);
    if (!pts.length) continue;

    if (pts.length === 1) {
      min = Math.min(min, distanceMiles(point.lat, point.lng, pts[0].lat, pts[0].lng));
      continue;
    }

    for (let i = 1; i < pts.length; i++) {
      min = Math.min(min, distancePointToSegmentMiles(point, pts[i - 1], pts[i]));
    }

    // Close polygon rings if the source did not already close them.
    if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && pts.length > 2) {
      min = Math.min(min, distancePointToSegmentMiles(point, pts[pts.length - 1], pts[0]));
    }
  }

  return min;
}

function cloneFeatureWithProximity(feature, proximity) {
  return {
    ...(feature || {}),
    properties: {
      ...((feature && feature.properties) || {}),
      proximity
    }
  };
}

async function getDistanceGeometryFeaturesForAlert(alert) {
  if (!alert) return [];
  if (alert.geometry) return [alert];

  // Many NWS watches are county-based and do not include native polygons.
  // Use the same Census county fallback used by the map shading so the side panel can still detect nearby watches.
  if (isWatchedWatch(alert.properties?.event || '')) {
    return await buildWatchCountyFallbackFeatures([alert]);
  }

  return [];
}

async function filterAlertsByProximity(alerts) {
  const contexts = getAlertReferenceContexts();
  const out = [];

  if (!contexts.length) return out;

  for (const alert of alerts || []) {
    const distanceFeatures = await getDistanceGeometryFeaturesForAlert(alert);
    let best = null;

    for (const ctx of contexts) {
      for (const f of distanceFeatures) {
        const miles = distanceToGeometryMiles(f.geometry, ctx);
        if (miles <= ALERT_PANEL_RADIUS_MILES && (!best || miles < best.miles)) {
          best = {
            miles,
            source: ctx.source,
            label: ctx.label,
            radius: ALERT_PANEL_RADIUS_MILES
          };
        }
      }
    }

    if (best) out.push(cloneFeatureWithProximity(alert, best));
  }

  out.sort((a, b) => {
    const aw = isWatchedWarning(a.properties?.event || '') ? 0 : 1;
    const bw = isWatchedWarning(b.properties?.event || '') ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return (a.properties?.proximity?.miles ?? Infinity) - (b.properties?.proximity?.miles ?? Infinity);
  });

  return out;
}

function alertTypeForFeature(feature) {
  const event = feature?.properties?.event || '';
  if (isWatchedWarning(event)) return 'warnings';
  if (isWatchedWatch(event)) return 'watches';
  return 'other';
}

function getNearbyAlertIds(type) {
  return (nearbyAlertFeatures || [])
    .filter(f => alertTypeForFeature(f) === type)
    .map((f, i) => getAlertId(f, i));
}

function acknowledgeAlertType(type) {
  getNearbyAlertIds(type).forEach(id => acknowledgedAlertIds[type]?.add(id));
  updateAlertButtonBadges();
}

function updateAlertButtonBadges() {
  const counts = { warnings:0, watches:0 };
  (nearbyAlertFeatures || []).forEach(f => {
    const type = alertTypeForFeature(f);
    if (counts[type] !== undefined) counts[type]++;
  });

  [
    ['warnings', 'warning-count-badge'],
    ['watches', 'watch-count-badge']
  ].forEach(([type, id]) => {
    const badge = document.getElementById(id);
    const btn = document.getElementById(type === 'warnings' ? 'btn-warnings' : 'btn-watches');
    if (!badge || !btn) return;
    const count = counts[type] || 0;
    badge.textContent = count;
    badge.classList.toggle('visible', count > 0);
    const hasNew = getNearbyAlertIds(type).some(alertId => !acknowledgedAlertIds[type].has(alertId));
    badge.classList.toggle('flash', count > 0 && hasNew);
    btn.classList.toggle('has-alerts', count > 0);
  });
}

function setAlertPanelVisibility() {
  const card = document.getElementById('hud-alerts');
  if (!card) return;
  const anyOpen = !!(layersOn.warnings || layersOn.watches);
  activeAlertPanelType = layersOn.warnings && layersOn.watches ? 'both' : layersOn.warnings ? 'warnings' : layersOn.watches ? 'watches' : null;
  card.classList.toggle('hidden', !anyOpen);
  if (anyOpen) {
    renderAlerts(nearbyAlertFeatures);
    if (layersOn.warnings) acknowledgeAlertType('warnings');
    if (layersOn.watches) acknowledgeAlertType('watches');
  }
}

function scheduleAlertPanelRefresh() {
  if (!currentWatchedAlerts || !currentWatchedAlerts.length) return;
  clearTimeout(alertPanelRefreshTimer);
  alertPanelRefreshTimer = setTimeout(async () => {
    try {
      nearbyAlertFeatures = await filterAlertsByProximity(currentWatchedAlerts);
      updateAlertButtonBadges();
      if (activeAlertPanelType) renderAlerts(nearbyAlertFeatures);
    } catch (e) {
      console.warn('Unable to refresh nearby alert panel:', e);
    }
  }, 350);
}

// ── ALERTS ────────────────────────────────────────────────────────────────────
async function loadAlerts() {
  setAlertPolygonLoading(true, 'LOADING NWS WATCHES / WARNINGS');
  try {
    let data;

    try {
      // National active alerts.
      // This allows the map to draw all watched warning/watch polygons nationwide.
      const nationalRes = await fetch('https://api.weather.gov/alerts/active?status=actual');

      if (!nationalRes.ok) {
        throw new Error(`National alerts request failed: ${nationalRes.status}`);
      }

      data = await nationalRes.json();
    } catch (nationalErr) {
      console.warn('National NWS alerts unavailable, falling back to Texas only:', nationalErr);

      // Fallback keeps the Frisco/DFW map useful if weather.gov blocks or throttles the national request.
      const txRes = await fetch('https://api.weather.gov/alerts/active/area/TX');

      if (!txRes.ok) {
        throw new Error(`Texas alerts request failed: ${txRes.status}`);
      }

      data = await txRes.json();
    }

    const allFeatures = data.features || [];

    // Only keep the warning/watch products we actually support/color.
    const watchedAlerts = allFeatures.filter(f => {
      const event = f.properties?.event || '';
      return isWatchedAlertType(event);
    });

    const watchedPolygonAlerts = watchedAlerts.filter(f => !!f.geometry);
    currentWatchedAlerts = watchedAlerts;

    // The alert panel stays geographically useful by showing watched alerts within
    // 150 miles of either the searched city center or the user's current location.
    const nearbyAlerts = await filterAlertsByProximity(watchedAlerts);
    nearbyAlertFeatures = nearbyAlerts;
    updateAlertButtonBadges();

    console.log('NWS watched alerts:', {
      total: allFeatures.length,
      watched: watchedAlerts.length,
      polygons: watchedPolygonAlerts.length,
      nearbyPanel: nearbyAlerts.length,
      radiusMiles: ALERT_PANEL_RADIUS_MILES,
      references: getAlertReferenceContexts().map(c => c.label),
      watches: watchedAlerts.filter(f => isWatchedWatch(f.properties?.event || '')).length,
      warnings: watchedAlerts.filter(f => isWatchedWarning(f.properties?.event || '')).length
    });

    if (activeAlertPanelType) renderAlerts(nearbyAlerts);
    await renderAlertPolygons(watchedAlerts);
    setAlertPolygonLoading(false);

  } catch(e) {
    setAlertPolygonLoading(false);
    console.warn('NWS alerts unavailable:', e);

    document.getElementById('alert-list').innerHTML =
      '<div style="font-family:var(--fm);font-size:10px;color:var(--text-dim);text-align:center;padding:6px 0">ALERTS UNAVAILABLE</div>';
  }
}


function getAlertId(feature, fallbackIndex = 0) {
  return feature.id ||
         feature.properties?.id ||
         feature.properties?.['@id'] ||
         feature.properties?.capId ||
         `${feature.properties?.event || 'alert'}-${feature.properties?.areaDesc || 'area'}-${feature.properties?.sent || fallbackIndex}`;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatAlertTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('en-US', {
      timeZone:'America/Chicago',
      month:'short',
      day:'numeric',
      hour:'numeric',
      minute:'2-digit',
      hour12:true
    }) + ' CDT';
  } catch(e) {
    return value;
  }
}

function getAlertSourceUrl(feature) {
  return feature.properties?.['@id'] ||
         feature.properties?.id ||
         feature.id ||
         '';
}

function zoomToAlert(alertId) {
  const layer = alertLayerIndex.get(alertId);
  if (!layer) return;

  try {
    if (typeof layer.getBounds === 'function') {
      map.fitBounds(layer.getBounds(), { padding:[28, 28], maxZoom:10 });
    } else if (typeof layer.getLatLng === 'function') {
      map.flyTo(layer.getLatLng(), Math.max(map.getZoom(), 9), { duration:.6 });
    }
  } catch(e) {
    console.warn('Unable to zoom to alert:', e);
  }
}

function openAlertSource(alertId) {
  const feature = alertFeatureIndex.get(alertId);
  const url = feature ? getAlertSourceUrl(feature) : '';

  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function renderAlertDetails(feature, alertId) {
  const p = feature.properties || {};
  const sourceUrl = getAlertSourceUrl(feature);
  const hasLayer = alertLayerIndex.has(alertId);
  const description = p.description || p.headline || 'No detailed description provided.';
  const instruction = p.instruction || '';

  return `
    <div class="al-full">
      <div class="al-meta">
        <div class="al-meta-label">Area</div>
        <div class="al-meta-value">${escapeHTML(p.areaDesc || '—')}</div>

        <div class="al-meta-label">Office</div>
        <div class="al-meta-value">${escapeHTML(p.senderName || p.sender || '—')}</div>

        <div class="al-meta-label">Severity</div>
        <div class="al-meta-value">${escapeHTML(p.severity || '—')}</div>

        <div class="al-meta-label">Certainty</div>
        <div class="al-meta-value">${escapeHTML(p.certainty || '—')}</div>

        <div class="al-meta-label">Urgency</div>
        <div class="al-meta-value">${escapeHTML(p.urgency || '—')}</div>

        <div class="al-meta-label">Sent</div>
        <div class="al-meta-value">${escapeHTML(formatAlertTime(p.sent))}</div>

        <div class="al-meta-label">Effective</div>
        <div class="al-meta-value">${escapeHTML(formatAlertTime(p.effective))}</div>

        <div class="al-meta-label">Expires</div>
        <div class="al-meta-value">${escapeHTML(formatAlertTime(p.expires))}</div>
      </div>

      <div class="al-section-title">Full Description</div>
      <div class="al-description">${escapeHTML(description)}</div>

      ${instruction ? `
        <div class="al-section-title">Instructions</div>
        <div class="al-description">${escapeHTML(instruction)}</div>
      ` : ''}

      <div class="al-actions">
        ${hasLayer ? `<button class="al-action" data-alert-zoom="${escapeHTML(alertId)}">Zoom to Polygon</button>` : ''}
        ${sourceUrl ? `<button class="al-action" data-alert-source="${escapeHTML(alertId)}">Open NWS Source</button>` : ''}
      </div>

      <div class="al-toggle-hint">Click card to collapse</div>
    </div>
  `;
}

function wireAlertCardInteractions() {
  const list = document.getElementById('alert-list');
  if (!list) return;

  list.querySelectorAll('.al-item').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.al-action')) return;
      card.classList.toggle('expanded');
    });
  });

  list.querySelectorAll('[data-alert-zoom]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      zoomToAlert(btn.getAttribute('data-alert-zoom'));
    });
  });

  list.querySelectorAll('[data-alert-source]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openAlertSource(btn.getAttribute('data-alert-source'));
    });
  });
}

function renderAlerts(alerts) {
  const list=document.getElementById('alert-list');
  const dot=document.getElementById('alert-dot');
  const card=document.getElementById('hud-alerts');

  alerts = alerts || [];
  if (activeAlertPanelType && activeAlertPanelType !== 'both') alerts = alerts.filter(f => alertTypeForFeature(f) === activeAlertPanelType);
  localAlertFeatures = alerts || [];

  if (!alerts.length) {
    const label = activeAlertPanelType === 'warnings' ? 'WARNINGS' : activeAlertPanelType === 'watches' ? 'WATCHES' : 'WARNINGS / WATCHES';
    list.innerHTML='<div class="no-alerts">✓ NO '+label+' WITHIN '+ALERT_PANEL_RADIUS_MILES+' MILES</div>';
    dot.className='dot g';
    card.classList.remove('alert-active');
    return;
  }

  const hasWarn=alerts.some(a=>isWatchedWarning(a.properties?.event || ''));
  const hasWatch=alerts.some(a=>isWatchedWatch(a.properties?.event || ''));
  dot.className=hasWarn?'dot r':hasWatch?'dot y':'dot';
  card.classList.toggle('alert-active',hasWarn);

  list.innerHTML=alerts.slice(0,8).map((f, i)=>{
    const p=f.properties || {};
    const alertId = getAlertId(f, i);
    alertFeatureIndex.set(alertId, f);

    const isW=isWatchedWarning(p.event || '');
    const isA=isWatchedWatch(p.event || '');
    const cls=isW?'W':isA?'A':'Y';
    const exp=p.expires?new Date(p.expires).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour12:true,hour:'numeric',minute:'2-digit'}):'—';
    const col = alertPopupColor(p.event || '');
    const prox = p.proximity;
    const proxLine = prox && Number.isFinite(prox.miles)
      ? `<div class="al-exp">${Math.round(prox.miles)} MI FROM ${escapeHTML(String(prox.label || prox.source || 'REFERENCE').toUpperCase())}</div>`
      : '';

    return `<div class="al-item ${cls}" data-alert-id="${escapeHTML(alertId)}" style="border-color:${col};background:rgba(0,0,0,.22)">
      <div class="al-event" style="color:${col}">${escapeHTML(p.event||'ALERT')}</div>
      <div class="al-head">${escapeHTML((p.headline||'').slice(0,120))}${(p.headline||'').length>120?'…':''}</div>
      ${proxLine}
      <div class="al-exp">EXP ${escapeHTML(exp)} CDT</div>
      <div class="al-toggle-hint">Click for full NWS text + source</div>
      ${renderAlertDetails(f, alertId)}
    </div>`;
  }).join('');

  wireAlertCardInteractions();
}



function setAlertPolygonLoading(active, text = 'LOADING WATCH COUNTY SHADING') {
  const el = document.getElementById('alert-poly-loader');
  const label = document.getElementById('alert-load-text');
  if (!el) return;

  if (label) label.textContent = text;
  el.classList.toggle('active', !!active);
}

function clearAlertPolygonLayers() {
  if (warningLayer) {
    map.removeLayer(warningLayer);
    warningLayer = null;
  }

  if (watchLayer) {
    map.removeLayer(watchLayer);
    watchLayer = null;
  }
}

function getCountyGeoidsFromAlert(feature) {
  const sameCodes = feature.properties?.geocode?.SAME || [];

  if (!Array.isArray(sameCodes)) return [];

  // SAME: 0 + state FIPS + county FIPS.
  // Example: Collin TX SAME 048085 -> Census GEOID 48085.
  return sameCodes
    .map(code => String(code).trim())
    .filter(code => /^0\d{5}$/.test(code))
    .map(code => code.slice(1));
}

async function fetchCountyFeatureByGeoid(geoid) {
  if (countyGeometryCache.has(geoid)) {
    return countyGeometryCache.get(geoid);
  }

  const url =
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query'
    + `?where=GEOID%3D%27${encodeURIComponent(geoid)}%27`
    + '&outFields=NAME,GEOID,STATE,COUNTY'
    + '&outSR=4326'
    + '&f=geojson'
    + '&returnGeometry=true';

  try {
    const res = await fetch(url);
    const data = await res.json();
    const feature = data.features && data.features.length ? data.features[0] : null;

    countyGeometryCache.set(geoid, feature);
    return feature;
  } catch (e) {
    console.warn('County geometry unavailable for GEOID:', geoid, e);
    countyGeometryCache.set(geoid, null);
    return null;
  }
}

async function buildWatchCountyFallbackFeatures(alertFeatures) {
  const out = [];

  for (const alert of alertFeatures || []) {
    const event = alert.properties?.event || '';

    // Important: warnings stay exactly as NWS provides them.
    // County fallback is only for WATCHES that do not have native geometry.
    if (!isWatchedWatch(event)) continue;
    if (alert.geometry) continue;

    const geoids = getCountyGeoidsFromAlert(alert);
    if (!geoids.length) continue;

    for (const geoid of geoids) {
      const countyFeature = await fetchCountyFeatureByGeoid(geoid);
      if (!countyFeature || !countyFeature.geometry) continue;

      out.push({
        type: 'Feature',
        geometry: countyFeature.geometry,
        properties: {
          ...(alert.properties || {}),
          fallbackCounty: true,
          fallbackCountyName: countyFeature.properties?.NAME || '',
          fallbackCountyGeoid: geoid
        },
        id: `${getAlertId(alert)}-watch-county-${geoid}`
      });
    }
  }

  return out;
}


async function renderAlertPolygons(all) {
  const token = ++alertPolygonRenderToken;
  alertLayerIndex.clear();

  clearAlertPolygonLayers();

  const watched = all || [];
  const nativeAlerts = watched.filter(f => !!f.geometry);

  // Warnings stay as native NWS polygons only.
  const warnings = nativeAlerts.filter(f => isWatchedWarning(f.properties?.event || ''));

  // For watches, use exactly ONE source:
  // - If the watch has native geometry, use it.
  // - If not, build county fallback polygons from SAME codes.
  // This avoids double watch layers where one can be toggled and one cannot.
  const nativeWatches = nativeAlerts.filter(f => isWatchedWatch(f.properties?.event || ''));
  const watchAlertsMissingGeometry = watched.filter(f =>
    isWatchedWatch(f.properties?.event || '') && !f.geometry
  );

  let watchCountyFallbacks = [];

  if (watchAlertsMissingGeometry.length) {
    setAlertPolygonLoading(true, 'LOADING WATCH COUNTY SHADING');

    try {
      watchCountyFallbacks = await buildWatchCountyFallbackFeatures(watchAlertsMissingGeometry);
    } finally {
      if (token === alertPolygonRenderToken) {
        setAlertPolygonLoading(false);
      }
    }
  } else {
    setAlertPolygonLoading(false);
  }

  // If a watch has native geometry, do not also build fallback for that same watch.
  const watches = [...nativeWatches, ...watchCountyFallbacks];

  if (token !== alertPolygonRenderToken) {
    return;
  }

  function makeLayer(features, layerOn, paneName) {
    if (!features.length) return null;

    return L.geoJSON({ type:'FeatureCollection', features }, {
      pane: paneName,
      style: f => alertStyle(f.properties.event),

      onEachFeature: (f, l) => {
        const alertId = getAlertId(f);
        alertFeatureIndex.set(alertId, f);
        alertLayerIndex.set(alertId, l);

        const col = alertPopupColor(f.properties.event);
        const exp = f.properties.expires
          ? new Date(f.properties.expires).toLocaleTimeString('en-US', {
              timeZone:'America/Chicago',
              hour12:true,
              hour:'numeric',
              minute:'2-digit'
            }) + ' CDT'
          : '—';

        const fallbackLine = f.properties.fallbackCounty
          ? `County watch shading: ${f.properties.fallbackCountyName || 'County'}<br>`
          : '';

        l.bindPopup(`
          <div style="font-family:'JetBrains Mono',monospace;max-width:280px">
            <div style="color:${col};font-size:10.5px;font-weight:600;margin-bottom:3px">
              ${f.properties.event || 'ALERT'}
            </div>
            <div style="font-size:9.5px;color:var(--text-dim);line-height:1.4;margin-bottom:4px">
              ${(f.properties.headline || '').slice(0,160)}
            </div>
            <div style="font-size:8.5px;color:var(--text-dim);line-height:1.35">
              ${fallbackLine}${f.properties.areaDesc || ''}
            </div>
            <div style="font-size:8.5px;color:var(--text-dim);margin-top:4px">
              EXPIRES ${exp}
            </div>
          </div>
        `, { maxWidth:300 });
      }
    });
  }

  warningLayer = makeLayer(warnings, layersOn.warnings, 'overlayPane');
  if (warningLayer && layersOn.warnings) warningLayer.addTo(map);

  watchLayer = makeLayer(watches, layersOn.watches, 'overlayPane');
  if (watchLayer && layersOn.watches) watchLayer.addTo(map);

  if (localAlertFeatures && localAlertFeatures.length) renderAlerts(localAlertFeatures);

  console.log('Loaded alert polygons:', {
    nativeWarnings: warnings.length,
    nativeWatches: nativeWatches.length,
    fallbackWatchCounties: watchCountyFallbacks.length,
    finalWatchFeatures: watches.length
  });
}

// ── CONDITIONS ────────────────────────────────────────────────────────────────
async function loadConditions() {
  const ctx = selectedCityContext || { city:'Frisco', state:'TX', lat:33.155, lng:-96.823 };
  setConditionsTitle(ctx.city, ctx.state);

  if (conditionsController) conditionsController.abort();
  conditionsController = new AbortController();
  const signal = conditionsController.signal;

  try {
    document.getElementById('c-desc').textContent = 'LOADING CONDITIONS…';

    const lat = Number(ctx.lat).toFixed(4);
    const lng = Number(ctx.lng).toFixed(4);

    // Use the NWS point metadata for the searched city center, then pull the nearest observation station.
    const pointRes = await fetch(`https://api.weather.gov/points/${lat},${lng}`, { cache:'no-store', signal });
    if (!pointRes.ok) throw new Error('Point lookup failed');
    const pointData = await pointRes.json();
    const stationsUrl = pointData.properties && pointData.properties.observationStations;
    if (!stationsUrl) throw new Error('No station list');

    const stationRes = await fetch(stationsUrl, { cache:'no-store', signal });
    if (!stationRes.ok) throw new Error('Station lookup failed');
    const stationData = await stationRes.json();
    const stationUrl = stationData.features && stationData.features[0] && stationData.features[0].id;
    const stationId = stationData.features && stationData.features[0] && stationData.features[0].properties && stationData.features[0].properties.stationIdentifier;
    if (!stationUrl) throw new Error('No nearby station');

    const obsRes = await fetch(`${stationUrl}/observations/latest`, { cache:'no-store', signal });
    if (!obsRes.ok) throw new Error('Latest observation failed');
    const d = (await obsRes.json()).properties || {};

    const tc=d.temperature?.value,tf=tc!=null?Math.round(tc*9/5+32):null;
    const ws=d.windSpeed?.value,wm=ws!=null?Math.round(ws*.621371):null;
    const wd=d.windDirection?.value,hum=d.relativeHumidity?.value;
    const pres=d.barometricPressure?.value,ph=pres!=null?Math.round(pres/100):null;

    document.getElementById('c-temp').innerHTML=tf!=null?`${tf}<sup>°F</sup>`:'—';
    document.getElementById('c-wind').innerHTML=wm!=null?`${wm}<sup style="font-size:10px"> mph ${dirLabel(wd)}</sup>`:'—';
    document.getElementById('c-hum').innerHTML=hum!=null?`${Math.round(hum)}<sup>%</sup>`:'—';
    document.getElementById('c-pres').innerHTML=ph!=null?`${ph}<sup>hPa</sup>`:'—';

    const desc=(d.textDescription||'CURRENT CONDITIONS').toUpperCase();
    document.getElementById('c-desc').textContent = stationId ? `${desc} · SRC: ${stationId}` : desc;
  } catch(e){
    if (e.name === 'AbortError') return;
    console.warn('Conditions unavailable:', e);
    document.getElementById('c-desc').textContent='CONDITIONS UNAVAILABLE';
  }
}
function dirLabel(deg) {
  if(deg==null)return'';
  return['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg/22.5)%16];
}


// ── FRISCO EMERGENCY LAYERS ──────────────────────────────────────────────────
async function ensureFriscoLayer(name) {
  if (!isSelectedCityFrisco()) {
    syncFriscoLayerAvailability();
    return null;
  }
  if (!window.FriscoLayers) return null;
  const ctx = { map, L, layersOn, scheduleOverlapCulling };
  if (name === 'fireStations') {
    if (!fireStationLayer) fireStationLayer = await window.FriscoLayers.buildFireStations(ctx);
    return fireStationLayer;
  }
  if (name === 'fireDistricts') {
    if (!fireDistrictLayer) fireDistrictLayer = await window.FriscoLayers.buildFireDistricts(ctx);
    return fireDistrictLayer;
  }
  if (name === 'sirens') {
    if (!sirenLayer) sirenLayer = window.FriscoLayers.buildSirens(ctx);
    return sirenLayer;
  }
  return null;
}

// ── TXDOT LIVE CAMERAS ───────────────────────────────────────────────────────
const TXDOT_WORKER = 'https://mapmaker.frisco-em2.workers.dev/';
const TXDOT_DEFAULT_DISTRICTS = ['DAL', 'FTW', 'WAC', 'WFS', 'AUS', 'TYL', 'BRY', 'PAR'];
let txdotCameras = [];
let txdotSnapshots = {};
let txdotSnapshotErrors = {};
let txdotSnapLoading = new Set();
let txdotMarkers = {};
let txdotCurrentFilter = 'all';
let txdotCurrentDistrict = 'TX';
let txdotSelectedKey = null;
let txdotHasLoaded = false;
let txdotIsLoading = false;

function txdotCameraKey(cam) {
  return `${cam.district || txdotCurrentDistrict}:${cam.icd_Id}`;
}

function txdotEscHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function txdotEscAttr(value) { return txdotEscHTML(value); }

function txdotEscJS(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function txdotFindCameraByKey(key) {
  return txdotCameras.find(c => txdotCameraKey(c) === key);
}

function txdotSetLoading(message, pct = 0, active = true) {
  const wrap = document.getElementById('cam-load-wrap');
  const text = document.getElementById('cam-load-text');
  const fill = document.getElementById('cam-load-fill');
  if (!wrap || !text || !fill) return;
  text.textContent = message;
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  wrap.classList.toggle('active', !!active);
  wrap.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function txdotSetDistrictLabel(label) {
  const el = document.getElementById('cam-dist-label');
  if (el) el.textContent = label;
}

function txdotExtractSnapshotData(data) {
  if (!data || typeof data !== 'object') return null;
  const possibleImage = data.snippet || data.image || data.img || data.snapshot || data.snapshotImage || data.snapshotBase64 || data.base64 || data.jpeg || data.jpg || data.data;
  if (!possibleImage) return null;
  const cleanImage = String(possibleImage).replace(/^data:image\/[a-zA-Z]+;base64,/, '').trim();
  if (!cleanImage) return null;
  return { img: cleanImage, ts: data.timestampFormatted || data.timestamp || data.timeStamp || data.captureTime || data.capturedAt || '' };
}

async function txdotFetchDistrictCameras(district) {
  const url = `${TXDOT_WORKER}?endpoint=GetCctvStatusListByDistrict&district=${encodeURIComponent(district)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${district} HTTP ${res.status}`);
  const data = await res.json();
  const districtCams = [];
  for (const [roadway, cams] of Object.entries(data.roadwayCctvStatuses || {})) {
    for (const cam of cams) {
      districtCams.push({ ...cam, district, roadwayGroup: roadway });
    }
  }
  return districtCams;
}

function txdotSortCameras() {
  txdotCameras.sort((a, b) => {
    const d = String(a.district || '').localeCompare(String(b.district || ''));
    if (d !== 0) return d;
    return String(a.icd_Id || '').localeCompare(String(b.icd_Id || ''));
  });
}

async function txdotLoadDefaultDistricts() {
  if (txdotIsLoading) return;
  txdotIsLoading = true;
  txdotCurrentDistrict = 'TX';
  txdotSetActiveDistrictButton('TX');
  txdotSetDistrictLabel('TX Districts');
  txdotSetLoading('FETCHING TXDOT DISTRICTS…', 3, true);
  document.getElementById('cam-list-count').textContent = 'Loading…';
  txdotCameras = [];
  txdotSnapshots = {};
  txdotSnapshotErrors = {};
  txdotSnapLoading.clear();
  txdotSelectedKey = null;
  const seen = new Set();
  const failed = [];
  try {
    for (let i = 0; i < TXDOT_DEFAULT_DISTRICTS.length; i++) {
      const district = TXDOT_DEFAULT_DISTRICTS[i];
      const pct = Math.round(((i + 1) / TXDOT_DEFAULT_DISTRICTS.length) * 90);
      txdotSetLoading(`FETCHING ${district} CAMERAS… ${i + 1}/${TXDOT_DEFAULT_DISTRICTS.length}`, pct, true);
      try {
        const districtCams = await txdotFetchDistrictCameras(district);
        for (const cam of districtCams) {
          const key = txdotCameraKey(cam);
          if (!seen.has(key)) { seen.add(key); txdotCameras.push(cam); }
        }
      } catch (err) {
        failed.push(district);
        console.warn(`Failed to load ${district}`, err);
      }
    }
    txdotSortCameras();
    txdotBuildMarkers();
    txdotUpdateStats();
    txdotRenderList();
    txdotHasLoaded = true;
    if (layersOn.cameras && camMarkerLayer && !map.hasLayer(camMarkerLayer)) camMarkerLayer.addTo(map);
    txdotApplyFilter();
    txdotSetLoading(failed.length ? `LOADED WITH ERRORS: ${failed.join(', ')}` : 'CAMERA LAYER READY', 100, true);
    setTimeout(() => txdotSetLoading('CAMERA LAYER READY', 100, false), failed.length ? 2800 : 900);
  } catch (err) {
    txdotSetLoading('ERROR: ' + (err.message || err), 100, true);
    setTimeout(() => txdotSetLoading('CAMERA LAYER READY', 0, false), 3000);
  } finally {
    txdotIsLoading = false;
  }
}

async function txdotLoadSingleDistrict(district) {
  if (txdotIsLoading) return;
  txdotIsLoading = true;
  txdotCurrentDistrict = district;
  txdotSetActiveDistrictButton(district);
  txdotSetDistrictLabel(district + ' District');
  txdotSetLoading('FETCHING ' + district + ' CAMERAS…', 12, true);
  document.getElementById('cam-list-count').textContent = 'Loading…';
  txdotCameras = [];
  txdotSnapshots = {};
  txdotSnapshotErrors = {};
  txdotSnapLoading.clear();
  txdotSelectedKey = null;
  try {
    const cams = await txdotFetchDistrictCameras(district);
    const seen = new Set();
    for (const cam of cams) {
      const key = txdotCameraKey(cam);
      if (!seen.has(key)) { seen.add(key); txdotCameras.push(cam); }
    }
    txdotSortCameras();
    txdotBuildMarkers();
    txdotUpdateStats();
    txdotRenderList();
    txdotHasLoaded = true;
    if (layersOn.cameras && camMarkerLayer && !map.hasLayer(camMarkerLayer)) camMarkerLayer.addTo(map);
    txdotApplyFilter();
    txdotSetLoading('CAMERA LAYER READY', 100, true);
    setTimeout(() => txdotSetLoading('CAMERA LAYER READY', 100, false), 900);
  } catch (err) {
    txdotSetLoading('ERROR: ' + (err.message || err), 100, true);
    setTimeout(() => txdotSetLoading('CAMERA LAYER READY', 0, false), 3000);
  } finally {
    txdotIsLoading = false;
  }
}

function txdotCameraLatLng(cam) {
  const lat = Number(cam.latitude);
  const lng = Number(cam.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return L.latLng(lat, lng);
}

function txdotIsCameraInCurrentView(cam) {
  if (!map) return false;
  const ll = txdotCameraLatLng(cam);
  if (!ll) return false;
  const bounds = map.getBounds();
  return bounds && bounds.isValid() && bounds.contains(ll);
}

// Intentionally no-op: loading or changing camera districts should never move/zoom the map.
function txdotFitToCameraBounds() {}

async function txdotFetchSnapshot(key) {
  const cam = txdotFindCameraByKey(key);
  if (!cam) return;
  const district = cam.district || txdotCurrentDistrict;
  if (txdotSnapshots[key] || txdotSnapLoading.has(key)) return;
  delete txdotSnapshotErrors[key];
  txdotSnapLoading.add(key);
  txdotUpdateMarkerStyle(key);
  txdotRenderListItem(key);
  const initialEntry = txdotMarkers[key];
  if (initialEntry && initialEntry.marker.isPopupOpen()) initialEntry.marker.setPopupContent(txdotBuildPopupHTML(cam));
  try {
    const url = `${TXDOT_WORKER}?endpoint=GetCctvSnapshotByIcdId&district=${encodeURIComponent(district)}&icdId=${encodeURIComponent(cam.icd_Id)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const extracted = txdotExtractSnapshotData(data);
    if (!extracted) { txdotSnapshotErrors[key] = 'No image returned for this camera.'; return; }
    txdotSnapshots[key] = { img: extracted.img, ts: extracted.ts, district, icd_Id: cam.icd_Id };
    txdotUpdateStats();
  } catch (err) {
    console.warn('Snapshot fetch failed for', key, err);
    txdotSnapshotErrors[key] = err.message || 'Snapshot failed to load.';
  } finally {
    txdotSnapLoading.delete(key);
    txdotUpdateMarkerStyle(key);
    txdotRenderListItem(key);
    const latestEntry = txdotMarkers[key];
    if (latestEntry && latestEntry.marker.isPopupOpen()) latestEntry.marker.setPopupContent(txdotBuildPopupHTML(cam));
  }
}

async function txdotRefreshSingle(key, btn) {
  delete txdotSnapshots[key];
  delete txdotSnapshotErrors[key];
  txdotSnapLoading.delete(key);
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  await txdotFetchSnapshot(key);
}

function txdotBuildMarkers() {
  if (!camMarkerLayer) camMarkerLayer = L.layerGroup();
  camMarkerLayer.clearLayers();
  txdotMarkers = {};
  txdotCameras.forEach(cam => {
    if (!cam.latitude || !cam.longitude) return;
    const key = txdotCameraKey(cam);
    const marker = L.marker([Number(cam.latitude), Number(cam.longitude)], { icon: txdotMakeIcon(cam), zIndexOffset: 250 })
      .bindPopup(() => txdotBuildPopupHTML(cam), { maxWidth:340, minWidth:270, autoPan:false })
      .on('click', () => {
        txdotSelectedKey = key;
        txdotRenderList();
        if (!txdotSnapshots[key] && !txdotSnapLoading.has(key)) txdotFetchSnapshot(key);
      });
    if (txdotMatchesFilter(cam, (document.getElementById('cam-search')?.value || '').toLowerCase()) && txdotIsCameraInCurrentView(cam)) camMarkerLayer.addLayer(marker);
    txdotMarkers[key] = { marker, cam };
  });
}

function txdotMakeIcon(cam) {
  const key = txdotCameraKey(cam);
  const hasSnap = !!txdotSnapshots[key];
  const hasErr = !!txdotSnapshotErrors[key];
  const isLoading = txdotSnapLoading.has(key);
  let extraCls = '';
  if (!isLoading && hasSnap) extraCls = 'snap-loaded';
  else if (!isLoading && hasErr) extraCls = 'snap-error';
  return L.divIcon({ className:'', html:`<div class="cm ${extraCls}" title="${txdotEscAttr(cam.district || '')} ${txdotEscAttr(cam.icd_Id)}">${isLoading ? '⟳' : '📷'}</div>`, iconSize:[24,24], iconAnchor:[12,12], popupAnchor:[0,-14] });
}

function txdotUpdateMarkerStyle(key) {
  const entry = txdotMarkers[key];
  if (!entry) return;
  entry.marker.setIcon(txdotMakeIcon(entry.cam));
}

function txdotBuildPopupHTML(cam) {
  if (!cam) return '<div style="padding:.5rem;color:var(--text-dim)">Camera not found</div>';
  const key = txdotCameraKey(cam);
  const snap = txdotSnapshots[key];
  const isLoading = txdotSnapLoading.has(key);
  const errMsg = txdotSnapshotErrors[key];
  const safeKey = txdotEscJS(key);
  const safeName = txdotEscHTML(cam.icd_Id);
  const safeDistrict = txdotEscHTML(cam.district || '');
  const safeRoadway = txdotEscHTML(cam.equipLoc?.roadway || cam.roadwayGroup || '');
  const safeNet = txdotEscHTML(cam.netId || '');
  let imgSection;
  if (isLoading) {
    imgSection = `<div class="popup-img-wrap"><div class="popup-no-img"><div class="icon">⟳</div><div>Loading snapshot…</div></div></div>`;
  } else if (snap) {
    imgSection = `<div class="popup-img-wrap"><img src="data:image/jpeg;base64,${snap.img}" alt="${safeName}" loading="lazy" title="Click to enlarge" onclick="openImageModal('${safeKey}')"></div><div class="popup-ts">Captured: ${txdotEscHTML(snap.ts || 'Unknown time')}</div><button class="popup-fetch-btn" onclick="txdotRefreshSingle('${safeKey}',this)">⟳ Refresh Snapshot</button>`;
  } else if (errMsg) {
    imgSection = `<div class="popup-img-wrap"><div class="popup-no-img"><div class="icon">⚠️</div><div>${txdotEscHTML(errMsg)}</div></div></div><button class="popup-fetch-btn" onclick="txdotFetchSnapshot('${safeKey}');this.disabled=true;this.textContent='Loading…'">Try Again</button>`;
  } else {
    imgSection = `<div class="popup-img-wrap"><div class="popup-no-img"><div class="icon">📷</div><div>Click below to load snapshot</div></div></div><button class="popup-fetch-btn" onclick="txdotFetchSnapshot('${safeKey}');this.disabled=true;this.textContent='Loading…'">Load Snapshot</button>`;
  }
  return `<div class="cam-popup"><div class="popup-header"><div><div class="popup-name">${safeName}</div><div class="popup-meta">${safeDistrict} · ${safeRoadway} · ${safeNet}</div></div></div>${imgSection}</div>`;
}

function openImageModal(key) {
  const snap = txdotSnapshots[key];
  const cam = txdotFindCameraByKey(key);
  if (!snap) return;
  const modal = document.getElementById('image-modal');
  const img = document.getElementById('image-modal-img');
  const title = document.getElementById('image-modal-title');
  img.src = `data:image/jpeg;base64,${snap.img}`;
  const name = cam ? `${cam.district || ''} · ${cam.icd_Id || ''} · ${cam.equipLoc?.roadway || cam.roadwayGroup || ''}` : key;
  title.textContent = `${name}${snap.ts ? ' · ' + snap.ts : ''}`;
  modal.classList.add('show');
}

function closeImageModal() {
  const modal = document.getElementById('image-modal');
  const img = document.getElementById('image-modal-img');
  modal.classList.remove('show');
  setTimeout(() => { if (!modal.classList.contains('show')) img.src = ''; }, 150);
}

function handleImageModalBackdrop(event) {
  if (event.target && event.target.id === 'image-modal') closeImageModal();
}

document.addEventListener('keydown', event => { if (event.key === 'Escape') closeImageModal(); });

function txdotUpdateStats() {
  const snap = document.getElementById('cam-cnt-snap');
  const total = document.getElementById('cam-cnt-total');
  if (snap) snap.textContent = Object.keys(txdotSnapshots).length;
  if (total) total.textContent = txdotCameras.length || '—';
}

function txdotSetFilter(f, btn) {
  txdotCurrentFilter = f;
  document.querySelectorAll('.cam-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  txdotApplyFilter();
}

function txdotApplyFilter() {
  if (!camMarkerLayer) return;
  const q = (document.getElementById('cam-search')?.value || '').toLowerCase();
  camMarkerLayer.clearLayers();
  txdotVisibleCameraEntries(q).forEach(entry => camMarkerLayer.addLayer(entry.marker));
  scheduleOverlapCulling(25);
  txdotRenderList();
}

function txdotMatchesFilter(cam, q) {
  const key = txdotCameraKey(cam);
  const matchF = txdotCurrentFilter === 'all' || (txdotCurrentFilter === 'snap' && txdotSnapshots[key]);
  const searchable = [cam.icd_Id, cam.district, cam.equipLoc?.roadway, cam.roadwayGroup, cam.netId].filter(Boolean).join(' ').toLowerCase();
  const matchQ = !q || searchable.includes(q);
  return matchF && matchQ;
}

function txdotRenderList() {
  const list = document.getElementById('cam-list');
  const count = document.getElementById('cam-list-count');
  if (!list) return;
  if (!layersOn.cameras && !txdotHasLoaded) {
    list.innerHTML = '<div class="cam-empty">Toggle Cameras on to load TxDOT camera pins.</div>';
    if (count) count.textContent = 'Layer off';
    return;
  }
  const q = (document.getElementById('cam-search')?.value || '').toLowerCase();
  const filtered = txdotCameras.filter(c => txdotMatchesFilter(c, q) && txdotIsCameraInCurrentView(c));
  if (count) count.textContent = `${filtered.length} visible of ${txdotCameras.length}`;
  if (!filtered.length) {
    list.innerHTML = `<div class="cam-empty">${txdotIsLoading ? 'Loading cameras…' : 'No cameras in current map view. Pan or zoom the map to reveal nearby cameras.'}</div>`;
    return;
  }
  list.innerHTML = filtered.map(cam => {
    const key = txdotCameraKey(cam);
    const sel = key === txdotSelectedKey ? 'selected' : '';
    const snap = txdotSnapshots[key];
    const loading = txdotSnapLoading.has(key);
    const err = txdotSnapshotErrors[key];
    const badge = loading ? '<span class="loading-badge">⟳</span>' : snap ? '<span class="img-badge">📷</span>' : err ? '<span class="error-badge">!</span>' : '';
    return `<div class="cam-item ${sel}" data-key="${txdotEscAttr(key)}" onclick="txdotSelectCamera('${txdotEscJS(key)}')"><div class="cam-dot" style="background:var(--accent);box-shadow:0 0 5px var(--accent)"></div><div class="cam-name">${txdotEscHTML(cam.icd_Id)}<span class="cam-road">${txdotEscHTML(cam.district || '')} · ${txdotEscHTML(cam.equipLoc?.roadway || cam.roadwayGroup || '')} · ${txdotEscHTML(cam.netId || '')}</span></div>${badge}</div>`;
  }).join('');
}

function txdotCssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function txdotRenderListItem(key) {
  const el = document.querySelector(`.cam-item[data-key="${txdotCssEscape(key)}"]`);
  if (!el) return;
  const snap = txdotSnapshots[key];
  const loading = txdotSnapLoading.has(key);
  const err = txdotSnapshotErrors[key];
  const badge = el.querySelector('.img-badge,.loading-badge,.error-badge');
  if (badge) badge.remove();
  if (loading) el.insertAdjacentHTML('beforeend', '<span class="loading-badge">⟳</span>');
  else if (snap) el.insertAdjacentHTML('beforeend', '<span class="img-badge">📷</span>');
  else if (err) el.insertAdjacentHTML('beforeend', '<span class="error-badge">!</span>');
}

function txdotSelectCamera(key) {
  txdotSelectedKey = key;
  const entry = txdotMarkers[key];
  if (!entry) return;
  const { marker, cam } = entry;
  // Do not pan or zoom the map from the camera list. The camera layer should behave passively.
  if (layersOn.cameras && camMarkerLayer && txdotIsCameraInCurrentView(cam) && !camMarkerLayer.hasLayer(marker)) {
    camMarkerLayer.addLayer(marker);
  }
  if (txdotIsCameraInCurrentView(cam)) marker.openPopup();
  txdotRenderList();
  if (!txdotSnapshots[key] && !txdotSnapLoading.has(key)) txdotFetchSnapshot(key);
  setTimeout(() => {
    const el = document.querySelector('.cam-item.selected');
    if (el) el.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }, 60);
}

function txdotSetActiveDistrictButton(district) {
  document.querySelectorAll('.cam-dist-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.district === district));
}

async function ensureTxDotCamerasLoaded() {
  if (!txdotHasLoaded && !txdotIsLoading) await txdotLoadDefaultDistricts();
}

function setTxDotCameraLayerButtonState() {
  const btn = document.getElementById('btn-cameras');
  if (btn) {
    btn.classList.toggle('on', !!layersOn.cameras);
    btn.textContent = layersOn.cameras ? 'HIDE TXDOT CAMERAS' : 'SHOW TXDOT CAMERAS';
  }
}

window.txdotFetchSnapshot = txdotFetchSnapshot;
window.txdotRefreshSingle = txdotRefreshSingle;
window.openImageModal = openImageModal;
window.closeImageModal = closeImageModal;
window.handleImageModalBackdrop = handleImageModalBackdrop;
window.txdotSelectCamera = txdotSelectCamera;

function initTxDotCameraControls() {
  if (!camMarkerLayer) camMarkerLayer = L.layerGroup();
  document.querySelectorAll('.cam-dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const district = btn.dataset.district;
      if (district === 'TX') txdotLoadDefaultDistricts();
      else txdotLoadSingleDistrict(district);
    });
  });
  document.querySelectorAll('.cam-filter-btn').forEach(btn => btn.addEventListener('click', () => txdotSetFilter(btn.dataset.filter, btn)));
  const search = document.getElementById('cam-search');
  if (search) search.addEventListener('input', txdotApplyFilter);
  const refresh = document.getElementById('cam-refresh');
  if (refresh) refresh.addEventListener('click', () => txdotCurrentDistrict === 'TX' ? txdotLoadDefaultDistricts() : txdotLoadSingleDistrict(txdotCurrentDistrict));
  if (map && !map._txdotCameraViewportListenerAttached) {
    map.on('moveend zoomend resize', () => {
      if (txdotHasLoaded || layersOn.cameras) txdotApplyFilter();
    });
    map._txdotCameraViewportListenerAttached = true;
  }
  txdotUpdateStats();
  txdotRenderList();
  setTxDotCameraLayerButtonState();
}

// ── LAYER TOGGLES ─────────────────────────────────────────────────────────────
async function toggleLayer(name, forceState) {
  layersOn[name] = typeof forceState === 'boolean' ? forceState : !layersOn[name];
  const on=layersOn[name];
  switch(name) {
    case 'cityLimits': if(cityLimitLayer) on ? cityLimitLayer.addTo(map) : map.removeLayer(cityLimitLayer); break;
    case 'fireStations':
      if (on && !fireStationLayer) await ensureFriscoLayer('fireStations');
      if(fireStationLayer) on ? fireStationLayer.addTo(map) : map.removeLayer(fireStationLayer);
      break;
    case 'fireDistricts':
      if (on && !fireDistrictLayer) await ensureFriscoLayer('fireDistricts');
      if(fireDistrictLayer) on ? fireDistrictLayer.addTo(map) : map.removeLayer(fireDistrictLayer);
      break;
    case 'warnings': if(warningLayer) on?warningLayer.addTo(map):map.removeLayer(warningLayer); break;
    case 'watches':  if(watchLayer)   on?watchLayer.addTo(map):map.removeLayer(watchLayer); break;
    case 'sirens':
      if (on && !sirenLayer) await ensureFriscoLayer('sirens');
      if(sirenLayer) on?sirenLayer.addTo(map):map.removeLayer(sirenLayer);
      break;
    case 'cameras':
      if (on) {
        if (!camMarkerLayer) camMarkerLayer = L.layerGroup();
        txdotApplyFilter();
        camMarkerLayer.addTo(map);
        ensureTxDotCamerasLoaded();
      } else if (camMarkerLayer && map.hasLayer(camMarkerLayer)) {
        map.removeLayer(camMarkerLayer);
      }
      break;
  }
}

[
  ['btn-split',    ()=>toggleSplitView()],
  ['btn-warnings', async ()=>{await toggleLayer('warnings');document.getElementById('btn-warnings').classList.toggle('on',layersOn.warnings);setAlertPanelVisibility();}],
  ['btn-watches',  async ()=>{await toggleLayer('watches'); document.getElementById('btn-watches').classList.toggle('on',layersOn.watches);setAlertPanelVisibility();}],
  ['btn-citylayers', () => { toggleToolsDrawer(true); openStackPanel('citylayers'); }],
  ['btn-darkmode-top', () => toggleDarkMode()],
  ['btn-overlapcull', () => toggleOverlapCulling()],
  ['btn-citylimits', async () => { await toggleLayer('cityLimits'); document.getElementById('btn-citylimits').classList.toggle('on', layersOn.cityLimits); }],
  ['btn-sirens', async () => { await toggleLayer('sirens'); document.getElementById('btn-sirens').classList.toggle('on', layersOn.sirens); }],
  ['btn-cameras', async () => { await toggleLayer('cameras'); setTxDotCameraLayerButtonState(); toggleToolsDrawer(true); openStackPanel('cam'); }],
  ['btn-firestations', async () => { await toggleLayer('fireStations'); document.getElementById('btn-firestations').classList.toggle('on', layersOn.fireStations); }],
  ['btn-firedistricts', async () => { await toggleLayer('fireDistricts'); document.getElementById('btn-firedistricts').classList.toggle('on', layersOn.fireDistricts); }],
  ['btn-rivergauges', () => toggleRiverGaugeLayer()],
  ['btn-riverreload', () => { if (!layersOn.riverGauges) { layersOn.riverGauges = true; setRiverGaugeButtonState(); } openStackPanel('rivergauges'); loadRiverGaugeLayer(); }],
  ['btn-dopplerstations', () => toggleDopplerStations()],
  ['btn-stationreload', () => loadLiveDopplerStations()],

].forEach(([id,fn])=>{ const el=document.getElementById(id); if(el) el.addEventListener('click',fn); });




function hydroDebugLog(message, level) {
  const ts = new Date().toLocaleTimeString([], { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const text = `[${ts}] ${message}`;
  hydroInspectDebugEntries.push({ text, level: level || 'info' });
  if (hydroInspectDebugEntries.length > 80) hydroInspectDebugEntries.shift();
  if (hydroInspectDebugEnabled) renderHydroDebugLog();
  try { console.debug('[Hydro Inspect]', message); } catch(e) {}
}

function renderHydroDebugLog() {
  const log = document.getElementById('hydro-debug-log');
  if (!log) return;
  if (!hydroInspectDebugEntries.length) {
    log.textContent = hydroInspectDebugEnabled ? 'Debug ready. Click a Hydro Class pixel to log tile and WMS checks.' : 'Debug off. Turn this on, click a Hydro pixel, then review tile/WMS details here.';
    return;
  }
  log.innerHTML = hydroInspectDebugEntries.map(entry => `<div class="hydro-debug-line ${entry.level || ''}">${String(entry.text).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function setHydroDebugMode(active) {
  hydroInspectDebugEnabled = !!active;
  const btn = document.getElementById('hydro-debug-btn');
  const panel = document.getElementById('hydro-debug-panel');
  if (btn) {
    btn.classList.toggle('on', hydroInspectDebugEnabled);
    btn.textContent = hydroInspectDebugEnabled ? 'DEBUG ON' : 'DEBUG';
  }
  if (panel) {
    panel.classList.toggle('open', hydroInspectDebugEnabled);
    panel.setAttribute('aria-hidden', hydroInspectDebugEnabled ? 'false' : 'true');
  }
  hydroDebugLog(hydroInspectDebugEnabled ? 'Debug enabled.' : 'Debug disabled.');
  renderHydroDebugLog();
}

function clearHydroDebugLog() {
  hydroInspectDebugEntries = [];
  renderHydroDebugLog();
}

function copyHydroDebugLog() {
  const text = hydroInspectDebugEntries.map(e => e.text).join('\n');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function markerLayerToArray(layer) {
  const out = [];
  if (!layer || !layer.eachLayer) return out;
  layer.eachLayer(l => {
    if (l && l.getLatLng && l._icon) out.push(l);
    else if (l && l.eachLayer) out.push(...markerLayerToArray(l));
  });
  return out;
}

function setMarkerCulled(marker, hidden) {
  if (!marker || !marker._icon) return;
  marker._overlapCulled = !!hidden;
  marker._icon.style.display = hidden ? 'none' : '';
  if (marker._shadow) marker._shadow.style.display = hidden ? 'none' : '';
  if (hidden) {
    try { marker.closeTooltip(); } catch(e) {}
    try { marker.closePopup(); } catch(e) {}
  }
}

function getOverlapThresholdPx() {
  const z = map.getZoom ? map.getZoom() : 12;

  // Conservative culling: only hide nodes whose marker centers are very close.
  // The previous thresholds were intentionally broad, but they hid points too early.
  // These values target true pile-ups while keeping nearby-but-distinct points visible.
  if (z >= 16) return 5;
  if (z >= 15) return 6;
  if (z >= 14) return 7;
  if (z >= 13) return 8;
  if (z >= 12) return 9;
  if (z >= 10) return 11;
  return 13;
}

function markerCullPriority(marker) {
  const o = marker.options || {};
  let score = Number(o.zIndexOffset || 0);
  if (marker.isPopupOpen && marker.isPopupOpen()) score += 100000;
  if (o.stationData && o.stationData.id === selectedVelStation) score += 50000;
  return score;
}

function cullOverlapMarkersForLayers() {
  const btn = document.getElementById('btn-overlapcull');
  if (btn) btn.classList.toggle('on', overlapCullingEnabled);

  const layers = [stationMarkerLayer, sirenLayer, fireStationLayer, riverGaugeLayer, camMarkerLayer].filter(Boolean);
  const markers = layers.flatMap(markerLayerToArray).filter(m => m && m._map === map && m._icon && m.options.overlapCull !== false);

  if (!overlapCullingEnabled) {
    markers.forEach(m => setMarkerCulled(m, false));
    return { shown: markers.length, hidden: 0, total: markers.length };
  }

  const threshold = getOverlapThresholdPx();
  const cell = threshold;
  const occupied = new Map();
  let hidden = 0;

  const sorted = markers.slice().sort((a,b) => markerCullPriority(b) - markerCullPriority(a));
  sorted.forEach(marker => {
    const p = map.latLngToContainerPoint(marker.getLatLng());
    const cx = Math.round(p.x / cell);
    const cy = Math.round(p.y / cell);
    let overlaps = false;

    for (let ix = cx - 1; ix <= cx + 1 && !overlaps; ix++) {
      for (let iy = cy - 1; iy <= cy + 1 && !overlaps; iy++) {
        const other = occupied.get(ix + ':' + iy);
        if (!other) continue;
        const dx = p.x - other.x;
        const dy = p.y - other.y;
        if ((dx * dx + dy * dy) < (threshold * threshold)) overlaps = true;
      }
    }

    if (overlaps) {
      setMarkerCulled(marker, true);
      hidden++;
    } else {
      setMarkerCulled(marker, false);
      occupied.set(cx + ':' + cy, { x:p.x, y:p.y, marker });
    }
  });

  return { shown: markers.length - hidden, hidden, total: markers.length };
}

function scheduleOverlapCulling(delay) {
  clearTimeout(overlapCullTimer);
  overlapCullTimer = setTimeout(() => {
    const result = cullOverlapMarkersForLayers();
    const status = document.getElementById('overlap-cull-status');
    if (status && result) status.textContent = overlapCullingEnabled ? `Showing ${result.shown} / ${result.total} nodes. Hidden until zoom: ${result.hidden}.` : 'Overlap hiding is off.';
  }, typeof delay === 'number' ? delay : 60);
}

function toggleOverlapCulling() {
  overlapCullingEnabled = !overlapCullingEnabled;
  scheduleOverlapCulling(0);
}

function txdotVisibleCameraEntries(q) {
  const candidates = [];
  txdotCameras.forEach(cam => {
    const key = txdotCameraKey(cam);
    const entry = txdotMarkers[key];
    if (!entry || !txdotMatchesFilter(cam, q) || !txdotIsCameraInCurrentView(cam)) return;
    candidates.push(entry);
  });

  if (!overlapCullingEnabled) return candidates;

  const threshold = getOverlapThresholdPx();
  const cell = threshold;
  const occupied = new Map();
  const visible = [];

  candidates
    .filter(entry => entry.cam && entry.cam.latitude && entry.cam.longitude)
    .sort((a,b) => {
      const as = txdotSnapshots[txdotCameraKey(a.cam)] ? 10 : 0;
      const bs = txdotSnapshots[txdotCameraKey(b.cam)] ? 10 : 0;
      return bs - as;
    })
    .forEach(entry => {
      const p = map.latLngToContainerPoint([Number(entry.cam.latitude), Number(entry.cam.longitude)]);
      const cx = Math.round(p.x / cell);
      const cy = Math.round(p.y / cell);
      let overlaps = false;
      for (let ix = cx - 1; ix <= cx + 1 && !overlaps; ix++) {
        for (let iy = cy - 1; iy <= cy + 1 && !overlaps; iy++) {
          const other = occupied.get(ix + ':' + iy);
          if (!other) continue;
          const dx = p.x - other.x;
          const dy = p.y - other.y;
          if ((dx * dx + dy * dy) < (threshold * threshold)) overlaps = true;
        }
      }
      if (!overlaps) {
        occupied.set(cx + ':' + cy, { x:p.x, y:p.y });
        visible.push(entry);
      }
    });

  return visible;
}

function renderHydroLegend() {
  const grid = document.getElementById('hydro-grid');
  if (!grid) return;
  grid.innerHTML = HYDRO_CLASSES.map(item => `
    <div class="hydro-key" data-hydro-code="${item.code}">
      <span class="hydro-swatch" style="background:${item.color}"></span>
      <span class="hydro-code">${item.code}</span>
      <span class="hydro-class">${item.cls}</span>
      <span class="hydro-help">What it means</span>
    </div>`).join('');
}

function showHydroMeaning(item, x, y) {
  const pop = document.getElementById('hydro-hover-pop');
  if (!pop || !item) return;
  pop.innerHTML = `<div class="hydro-hover-title"><span style="display:inline-block;width:10px;height:8px;border-radius:2px;background:${item.color};border:1px solid rgba(255,255,255,.25);margin-right:5px"></span>${item.code} · ${item.cls}</div><div>${item.meaning}</div>`;
  pop.classList.add('open');
  pop.setAttribute('aria-hidden','false');
  const width = 310;
  let left = x + 12;
  let top = y + 12;
  if (left + width > window.innerWidth - 10) left = x - width - 12;
  if (top + 92 > window.innerHeight - 10) top = y - 92;
  pop.style.left = Math.max(10, left) + 'px';
  pop.style.top = Math.max(10, top) + 'px';
}

function hideHydroMeaning() {
  const pop = document.getElementById('hydro-hover-pop');
  if (!pop) return;
  pop.classList.remove('open');
  pop.setAttribute('aria-hidden','true');
}

function setupHydroLegendHover() {
  renderHydroLegend();
  const grid = document.getElementById('hydro-grid');
  if (!grid) return;
  grid.addEventListener('mousemove', e => {
    const row = e.target.closest('.hydro-key');
    if (!row) return hideHydroMeaning();
    const item = HYDRO_CLASSES.find(h => h.code === row.dataset.hydroCode);
    showHydroMeaning(item, e.clientX, e.clientY);
  });
  grid.addEventListener('mouseleave', hideHydroMeaning);
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#','');
  const n = parseInt(clean.length === 3 ? clean.split('').map(c=>c+c).join('') : clean, 16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}

const HYDRO_CLASSES_RGB = HYDRO_CLASSES.map(item => ({ ...item, rgb: hexToRgb(item.color) }));

function nearestHydroClass(r,g,b,a) {
  if (!a || a < 20) return null;
  let best = null, bestD = Infinity;
  HYDRO_CLASSES_RGB.forEach(item => {
    const d = Math.pow(r-item.rgb.r,2) + Math.pow(g-item.rgb.g,2) + Math.pow(b-item.rgb.b,2);
    if (d < bestD) { bestD = d; best = item; }
  });

  // The NWS WMS sometimes returns anti-aliased / resampled colors rather than exact legend colors.
  // 12000 ~= 109 RGB units of distance, which is generous enough for tile smoothing but still
  // tight enough to avoid matching dark basemap/background pixels as a Hydro Class.
  return bestD < 12000 ? { item: best, distance: bestD, rgb: { r, g, b }, hex: rgbToHex(r,g,b) } : null;
}

function getNumberFromProp(props, names) {
  const lowerMap = {};
  Object.entries(props || {}).forEach(([k, v]) => {
    lowerMap[String(k).toLowerCase()] = v;
  });

  for (const name of names) {
    const v = lowerMap[String(name).toLowerCase()];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function matchHydroClassFromBandProps(props) {
  if (!props) return null;

  const r = getNumberFromProp(props, ['RED_BAND', 'RED', 'R', 'BAND_1', 'B1']);
  const g = getNumberFromProp(props, ['GREEN_BAND', 'GREEN', 'G', 'BAND_2', 'B2']);
  const b = getNumberFromProp(props, ['BLUE_BAND', 'BLUE', 'B', 'BAND_3', 'B3']);
  const a = getNumberFromProp(props, ['ALPHA_BAND', 'ALPHA', 'A', 'BAND_4', 'B4']);

  if (r === null || g === null || b === null) return null;

  const match = nearestHydroClass(r, g, b, a === null ? 255 : a);
  if (!match || !match.item) return null;

  return {
    ...match,
    source: 'featureinfo',
    rawBands: { r, g, b, a: a === null ? 255 : a }
  };
}


const HYDRO_CLASS_DECADE_VALUE_TO_CODE = {
  10:'BI', 20:'GC', 30:'IC', 40:'DS', 50:'WS', 60:'RA', 70:'HR', 80:'BD', 90:'GR', 100:'HA', 110:'LH', 120:'GH', 130:'UK', 140:'RF'
};

function hydroItemFromCode(code) {
  return HYDRO_CLASSES.find(item => item.code === code) || null;
}

function matchHydroClassFromValueProps(props) {
  if (!props) return null;

  const preferredValue = getNumberFromProp(props, [
    'GRAY_INDEX', 'GRAY', 'VALUE', 'CLASS', 'CLASS_VALUE', 'CATEGORY', 'DN', 'PIXEL', 'BAND_1', 'B1'
  ]);

  const numericValues = [];
  if (preferredValue !== null) numericValues.push(preferredValue);
  Object.values(props || {}).forEach(v => {
    const n = Number(v);
    if (Number.isFinite(n) && !numericValues.includes(n)) numericValues.push(n);
  });

  for (const raw of numericValues) {
    const rounded = Math.round(raw);
    let item = null;

    // Most GeoServer coverage responses return 0-based or 1-based class positions.
    if (rounded >= 0 && rounded < HYDRO_CLASSES.length) item = HYDRO_CLASSES[rounded];
    if (!item && rounded >= 1 && rounded <= HYDRO_CLASSES.length) item = HYDRO_CLASSES[rounded - 1];

    // Some products expose NEXRAD-style decade values instead: 10, 20, 30, etc.
    if (!item && HYDRO_CLASS_DECADE_VALUE_TO_CODE[rounded]) {
      item = hydroItemFromCode(HYDRO_CLASS_DECADE_VALUE_TO_CODE[rounded]);
    }

    if (item) {
      const rgb = hexToRgb(item.color);
      return {
        item,
        source: 'featureinfo-value',
        rawValue: raw,
        rgb,
        hex: item.color
      };
    }
  }

  return null;
}

function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase();
}

function isHydroVisible() {
  return radarType === 'hclass' || (splitViewActive && splitRadarProduct === 'hclass');
}

function setHydroInspectMode(active) {
  hydroInspectMode = !!active && isHydroVisible();
  document.body.classList.toggle('hydro-inspect', hydroInspectMode);
  const btn = document.getElementById('hydro-inspect-btn');
  const status = document.getElementById('hydro-inspect-status');
  const overlay = document.getElementById('hydro-inspect-overlay');

  if (btn) {
    btn.classList.toggle('on', hydroInspectMode);
    btn.textContent = hydroInspectMode ? 'INSPECT ON' : 'INSPECT';
  }
  if (status) {
    status.textContent = hydroInspectMode
      ? 'Map locked. Click a Hydro Class color to identify it.'
      : 'Turn on Inspect to lock the map, then click a Hydro Class color to identify it.';
  }
  if (overlay) overlay.setAttribute('aria-hidden', hydroInspectMode ? 'false' : 'true');

  const method = hydroInspectMode ? 'disable' : 'enable';
  try { map.dragging[method](); } catch(e) {}
  try { map.touchZoom[method](); } catch(e) {}
  try { map.doubleClickZoom[method](); } catch(e) {}
  try { map.scrollWheelZoom[method](); } catch(e) {}
  try { map.boxZoom[method](); } catch(e) {}
  try { map.keyboard[method](); } catch(e) {}
  if (compareMap) {
    try { compareMap.dragging[method](); } catch(e) {}
    try { compareMap.touchZoom[method](); } catch(e) {}
    try { compareMap.doubleClickZoom[method](); } catch(e) {}
    try { compareMap.scrollWheelZoom[method](); } catch(e) {}
    try { compareMap.boxZoom[method](); } catch(e) {}
    try { compareMap.keyboard[method](); } catch(e) {}
  }

  if (!hydroInspectMode) hideHydroMapTip();
}

function updateHydroInspectAvailability() {
  if (!isHydroVisible() && hydroInspectMode) setHydroInspectMode(false);
}

function showHydroMapTip(matchOrItem, originalEvent, pinned) {
  const tip = document.getElementById('hydro-map-tip');
  const item = matchOrItem && matchOrItem.item ? matchOrItem.item : matchOrItem;
  if (!tip || !item) return;
  const sampled = matchOrItem && matchOrItem.hex ? `<br><span style="color:rgba(160,200,225,.55)">Sampled ${matchOrItem.hex}</span>` : '';
  const clickHint = pinned ? '<br><span style="color:rgba(160,200,225,.45)">Click another color to identify it.</span>' : '';
  tip.innerHTML = `<b>${item.code} · ${item.cls}</b><br>${item.meaning}${sampled}${clickHint}`;
  tip.classList.add('open');
  tip.setAttribute('aria-hidden','false');
  const ev = originalEvent || window.event;
  let left = ev && ev.clientX ? ev.clientX + 14 : 20;
  let top = ev && ev.clientY ? ev.clientY + 14 : 20;
  if (left + 260 > window.innerWidth) left -= 280;
  if (top + 78 > window.innerHeight) top -= 88;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

function hideHydroMapTip() {
  const tip = document.getElementById('hydro-map-tip');
  if (!tip) return;
  tip.classList.remove('open');
  tip.setAttribute('aria-hidden','true');
}

function findHydroInspectStationById(stationId) {
  const id = String(stationId || '').toLowerCase();
  if (!id) return null;

  // Important: live NWS stations are stored in ACTIVE_STATIONS, not always ALL_STATIONS.
  // The earlier inspect code only searched ALL_STATIONS, so live stations such as KHDX/KHDC
  // could show Hydro tiles but still have no inspect/WMS context.
  const merged = [...(ACTIVE_STATIONS || []), ...(ALL_STATIONS || [])];
  const found = merged.find(s => String(s.id || '').toLowerCase() === id);
  if (found) return { ...found, id };

  // Last-resort context: GetFeatureInfo and layer names only require the station id.
  // This keeps inspect usable even if the station list refreshes or a station was selected
  // before ACTIVE_STATIONS finished updating.
  return { id, name: id.toUpperCase(), label: id.toUpperCase(), tdwr: false };
}

function getHydroInspectContext(clientX, clientY) {
  const compareEl = document.getElementById('compare-map');
  const compareRect = compareEl ? compareEl.getBoundingClientRect() : null;
  const inCompare = splitViewActive && compareMap && compareRect &&
    clientX >= compareRect.left && clientX <= compareRect.right &&
    clientY >= compareRect.top && clientY <= compareRect.bottom;

  const selectedStation = findHydroInspectStationById(selectedVelStation);
  if (!selectedStation) {
    hydroDebugLog(`Inspect context failed: selected station ${selectedVelStation || 'none'} could not be resolved.`, 'warn');
    return null;
  }

  if (inCompare && splitRadarProduct === 'hclass') {
    const layerName = getLayerName(selectedStation, 'hclass');
    if (!layerName) {
      hydroDebugLog(`Inspect context failed: no Hydro layer name for split station ${selectedStation.id}.`, 'warn');
      return null;
    }
    return { mapObj: compareMap, station: selectedStation, layerName, pane: 'split' };
  }

  if (radarType === 'hclass') {
    const layerName = getLayerName(selectedStation, 'hclass');
    if (!layerName) {
      hydroDebugLog(`Inspect context failed: no Hydro layer name for main station ${selectedStation.id}.`, 'warn');
      return null;
    }
    return { mapObj: map, station: selectedStation, layerName, pane: 'main' };
  }

  hydroDebugLog(`Inspect context skipped: Hydro not active on clicked map. radarType=${radarType} split=${splitViewActive}/${splitRadarProduct}`, 'warn');
  return null;
}

function findHydroTileColorAtClient(clientX, clientY) {
  const inspectCtx = getHydroInspectContext(clientX, clientY);
  if (!inspectCtx || !inspectCtx.mapObj) {
    hydroDebugLog(`No inspect context for click ${Math.round(clientX)},${Math.round(clientY)}. Hydro visible=${isHydroVisible()} radarType=${radarType} split=${splitViewActive}/${splitRadarProduct}`, 'warn');
    return null;
  }

  const container = inspectCtx.mapObj.getContainer();
  const allHydroTiles = Array.from(container.querySelectorAll('img.leaflet-tile.hydro-tile'));
  const tiles = allHydroTiles
    .filter(tile => tile.complete && tile.naturalWidth)
    .filter(tile => {
      const style = window.getComputedStyle(tile);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) < 0.05) return false;
      const r = tile.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });

  hydroDebugLog(`Tile check · pane=${inspectCtx.pane} station=${inspectCtx.station && inspectCtx.station.id} layer=${inspectCtx.layerName || 'none'} loadedHydroTiles=${allHydroTiles.length} tilesUnderClick=${tiles.length}`);

  if (!tiles.length) return null;

  const offsets = [[0,0],[-2,0],[2,0],[0,-2],[0,2],[-4,0],[4,0],[0,-4],[0,4],[-3,-3],[3,-3],[-3,3],[3,3],[-6,0],[6,0],[0,-6],[0,6],[-8,0],[8,0],[0,-8],[0,8]];
  let bestNear = null;

  for (let i = tiles.length - 1; i >= 0; i--) {
    const tile = tiles[i];
    try {
      const r = tile.getBoundingClientRect();
      const c = findHydroTileColorAtClient.canvas || (findHydroTileColorAtClient.canvas = document.createElement('canvas'));
      c.width = tile.naturalWidth;
      c.height = tile.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(tile, 0, 0);

      for (const [dx, dy] of offsets) {
        const x = Math.floor((clientX + dx - r.left) * (tile.naturalWidth / r.width));
        const y = Math.floor((clientY + dy - r.top) * (tile.naturalHeight / r.height));
        if (x < 0 || y < 0 || x >= tile.naturalWidth || y >= tile.naturalHeight) continue;
        const px = ctx.getImageData(x, y, 1, 1).data;
        const match = nearestHydroClass(px[0], px[1], px[2], px[3]);
        const rawHex = rgbToHex(px[0], px[1], px[2]);
        if (!bestNear || (match && match.distance < bestNear.distance)) {
          bestNear = match || { distance: Infinity, hex: rawHex, rgb:{r:px[0],g:px[1],b:px[2]}, alpha:px[3] };
        }
        if (match) {
          hydroDebugLog(`Canvas match · ${match.item.code}/${match.item.cls} sampled=${match.hex} alpha=${px[3]} dist=${Math.round(match.distance)} offset=${dx},${dy}`, 'ok');
          return { ...match, source:'canvas' };
        }
      }
    } catch (err) {
      hydroDebugLog(`Canvas read blocked/failed for tile. Falling back to WMS. ${err && err.message ? err.message : err}`, 'warn');
      continue;
    }
  }

  if (bestNear) hydroDebugLog(`Canvas had tile(s), but no legend match. Nearest sampled=${bestNear.hex || 'unknown'} alpha=${bestNear.alpha ?? 'n/a'} distance=${Number.isFinite(bestNear.distance) ? Math.round(bestNear.distance) : 'n/a'}`, 'warn');
  return null;
}

async function tryHydroGetFeatureInfo(clientX, clientY) {
  const ctx = getHydroInspectContext(clientX, clientY);
  if (!ctx || !ctx.mapObj || !ctx.station || !ctx.layerName) {
    hydroDebugLog('WMS fallback skipped: missing map/station/layer context.', 'warn');
    return null;
  }

  const mapEl = ctx.mapObj.getContainer();
  const rect = mapEl.getBoundingClientRect();
  const x = Math.round(clientX - rect.left);
  const y = Math.round(clientY - rect.top);
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    hydroDebugLog(`WMS fallback skipped: click outside target map. x=${x} y=${y} rect=${Math.round(rect.width)}x${Math.round(rect.height)}`, 'warn');
    return null;
  }

  const size = ctx.mapObj.getSize();
  const crs = ctx.mapObj.options.crs;
  const b = ctx.mapObj.getBounds();
  const sw = crs.project(b.getSouthWest());
  const ne = crs.project(b.getNorthEast());
  const bbox = [sw.x, sw.y, ne.x, ne.y].join(',');
  const url = `${NWS_BASE}/${ctx.station.id}/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
    `&LAYERS=${encodeURIComponent(ctx.layerName)}` +
    `&QUERY_LAYERS=${encodeURIComponent(ctx.layerName)}` +
    `&STYLES=&CRS=EPSG:3857&BBOX=${bbox}` +
    `&WIDTH=${size.x}&HEIGHT=${size.y}&I=${x}&J=${y}` +
    `&FEATURE_COUNT=3&INFO_FORMAT=application/json`;

  hydroDebugLog(`WMS GetFeatureInfo · station=${ctx.station.id} layer=${ctx.layerName} x=${x} y=${y} size=${size.x}x${size.y}`);
  const res = await fetch(url, { cache: 'no-store' });
  hydroDebugLog(`WMS HTTP ${res.status} ${res.statusText || ''}`, res.ok ? 'ok' : 'err');
  if (!res.ok) return null;

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); }
  catch (err) {
    hydroDebugLog(`WMS returned non-JSON: ${text.slice(0, 180).replace(/\s+/g,' ')}`, 'err');
    return null;
  }

  const features = json && json.features ? json.features : [];
  hydroDebugLog(`WMS features=${features.length}`);
  const props = features[0] && features[0].properties;
  if (!props) {
    hydroDebugLog('WMS returned no feature properties at this point.', 'warn');
    return null;
  }

  hydroDebugLog(`WMS prop keys: ${Object.keys(props).join(', ') || 'none'}`);
  hydroDebugLog(`WMS raw props: ${Object.entries(props).slice(0,12).map(([k,v]) => `${k}=${v}`).join(' · ')}`);

  const bandMatch = matchHydroClassFromBandProps(props);
  if (bandMatch && bandMatch.item) {
    hydroDebugLog(`WMS band match · ${bandMatch.item.code}/${bandMatch.item.cls} ${bandMatch.hex || ''}`, 'ok');
    return bandMatch;
  }

  const valueMatch = matchHydroClassFromValueProps(props);
  if (valueMatch && valueMatch.item) {
    hydroDebugLog(`WMS value match · ${valueMatch.item.code}/${valueMatch.item.cls} raw=${valueMatch.rawValue}`, 'ok');
    return valueMatch;
  }

  const raw = Object.values(props).join(' ').toLowerCase();
  for (const item of HYDRO_CLASSES) {
    if (raw.includes(item.code.toLowerCase()) || raw.includes(String(item.cls).toLowerCase())) {
      hydroDebugLog(`WMS text match · ${item.code}/${item.cls}`, 'ok');
      return { item, hex: null, source: 'featureinfo-text' };
    }
  }

  hydroDebugLog('WMS returned data, but no band/value/text mapping matched the Hydro legend.', 'warn');
  return { raw: Object.entries(props).map(([k,v]) => `${k}: ${v}`).join(' · ').slice(0, 220) };
}

async function identifyHydroAtClient(clientX, clientY, originalEvent) {
  if (!hydroInspectMode || !isHydroVisible()) return;

  const status = document.getElementById('hydro-inspect-status');
  if (status) status.textContent = 'Checking Hydro Class color…';
  hydroDebugLog(`Click · client=${Math.round(clientX)},${Math.round(clientY)} zoom=${map.getZoom()} radarType=${radarType} selectedStation=${selectedVelStation} split=${splitViewActive}/${splitRadarProduct}`);

  try {
    const match = findHydroTileColorAtClient(clientX, clientY);
    if (match && match.item) {
      showHydroMapTip(match, originalEvent, true);
      if (status) status.textContent = `${match.item.code} · ${match.item.cls} identified. Click another color to inspect it.`;
      return;
    }
  } catch (err) {
    // Canvas reads can be blocked by browser/CORS policy. Fall through to GetFeatureInfo.
  }

  try {
    const info = await tryHydroGetFeatureInfo(clientX, clientY);
    if (info && info.item) {
      showHydroMapTip(info, originalEvent, true);
      if (status) status.textContent = `${info.item.code} · ${info.item.cls} identified from radar data. Click another color to inspect it.`;
      return;
    }
    if (info && info.raw && status) {
      status.textContent = `The server returned data, but it did not map cleanly to the legend: ${info.raw}`;
      hideHydroMapTip();
      return;
    }
  } catch (err) {}

  hideHydroMapTip();
  if (status) status.textContent = 'No Hydro Class color identified at that point. Try clicking directly on a colored radar pixel.';
  hydroDebugLog('Final result: no Hydro Class match from canvas or WMS fallback.', 'err');
}

function sampleHydroTileAtClient(clientX, clientY, originalEvent) {
  // Passive hover sampling was intentionally replaced with click-to-identify Inspect mode.
  return;
}

function sampleHydroTileAtMouse(e) {
  if (!e || !e.originalEvent) return;
  sampleHydroTileAtClient(e.originalEvent.clientX, e.originalEvent.clientY, e.originalEvent);
}


const RADAR_HELP_TEXT = {
  base: {
    title: 'Base Reflectivity',
    body: '<b>Base reflectivity</b> shows precipitation intensity from the lowest radar scan, roughly 0.5°, which is crucial for ground-level conditions. Best for near-ground rain and hail.'
  },
  comp: {
    title: 'Composite Reflectivity',
    body: '<b>Composite reflectivity</b> displays the highest reflectivity value from all scans, highlighting the most intense storm parts regardless of height. Best for overall storm structure and high-altitude hail.'
  }
};

function showRadarHelp(btn) {
  const pop = document.getElementById('radar-help-popover');
  const key = btn && btn.getAttribute('data-help');
  const data = RADAR_HELP_TEXT[key];
  if (!pop || !data) return;

  pop.innerHTML = `<div class="radar-help-title">${data.title}</div><div>${data.body}</div>`;
  pop.classList.add('open');
  pop.setAttribute('aria-hidden', 'false');

  const r = btn.getBoundingClientRect();
  const top = Math.max(8, r.bottom + 7);
  let left = r.left;
  const width = Math.min(300, window.innerWidth - 28);
  if (left + width > window.innerWidth - 14) left = window.innerWidth - width - 14;
  pop.style.top = top + 'px';
  pop.style.left = Math.max(14, left) + 'px';
}

function hideRadarHelp() {
  const pop = document.getElementById('radar-help-popover');
  if (!pop) return;
  pop.classList.remove('open');
  pop.setAttribute('aria-hidden', 'true');
}

setupHydroLegendHover();
scheduleOverlapCulling(250);
const hydroInspectOverlay = document.getElementById('hydro-inspect-overlay');
if (hydroInspectOverlay) {
  hydroInspectOverlay.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    identifyHydroAtClient(e.clientX, e.clientY, e);
  });
}
document.getElementById('hydro-inspect-btn')?.addEventListener('click', () => setHydroInspectMode(!hydroInspectMode));
document.getElementById('hydro-debug-btn')?.addEventListener('click', () => setHydroDebugMode(!hydroInspectDebugEnabled));
document.getElementById('hydro-debug-clear')?.addEventListener('click', clearHydroDebugLog);
document.getElementById('hydro-debug-copy')?.addEventListener('click', copyHydroDebugLog);

document.querySelectorAll('.rtype-btn.has-help').forEach(btn => {
  btn.addEventListener('mouseenter', () => showRadarHelp(btn));
  btn.addEventListener('focus', () => showRadarHelp(btn));
  btn.addEventListener('mouseleave', hideRadarHelp);
  btn.addEventListener('blur', hideRadarHelp);
});

document.getElementById('rtype-refl').addEventListener('click',()=>{ setRadarType('reflectivity'); });
document.getElementById('rtype-comp').addEventListener('click',()=>{ setRadarType('composite'); });
document.getElementById('rtype-hydro').addEventListener('click',()=>{ setRadarType('hclass'); });
document.getElementById('rtype-vel').addEventListener('click', ()=>{ setRadarType('velocity'); });
document.getElementById('split-btn-velocity')?.addEventListener('click',()=>setSplitRadarProduct('velocity'));
document.getElementById('split-btn-hydro')?.addEventListener('click',()=>setSplitRadarProduct('hclass'));
document.getElementById('refl-loop-play')?.addEventListener('click', () => {
  if (reflectivityLoopPlaying) {
    stopReflectivityLoop(true);
  } else {
    startReflectivityLoop();
  }
});
document.getElementById('refl-loop-live')?.addEventListener('click', () => {
  stopReflectivityLoop(true);
});
document.getElementById('top-refresh-btn').addEventListener('click',()=>{
  refreshRadar();
  loadAlerts();
  loadConditions();
  const btn = document.getElementById('top-refresh-btn');
  btn.textContent='↻ REFRESHED';
  setTimeout(()=>btn.textContent='↻ REFRESH',1500);
});

// ── HUD DRAG ──────────────────────────────────────────────────────────────────
let drag=null,dox=0,doy=0;
function startHudDrag(id, clientX, clientY) {
  const isMobileHud = window.matchMedia('(max-width:760px), (pointer:coarse)').matches;
  if (isMobileHud && (id === 'hud-cond' || id === 'hud-alerts')) {
    drag = null;
    return;
  }
  drag=document.getElementById(id);
  if (!drag) return;
  const r=drag.getBoundingClientRect();
  dox=clientX-r.left; doy=clientY-r.top;
}
function moveHudDrag(clientX, clientY) {
  if(!drag)return;
  let x=clientX-dox,y=clientY-doy;
  x=Math.max(0,Math.min(window.innerWidth-drag.offsetWidth,x));
  y=Math.max(0,Math.min(window.innerHeight-drag.offsetHeight,y));
  drag.style.left=x+'px';drag.style.top=y+'px';drag.style.right='auto';drag.style.bottom='auto';
}
['hud-cond','hud-alerts','hud-radar'].forEach(id=>{
  const head = document.getElementById(id+'-head');
  if (!head) return;

  head.addEventListener('mousedown',e=>{
    startHudDrag(id, e.clientX, e.clientY);
    e.preventDefault();
  });

  head.addEventListener('touchstart',e=>{
    if (!e.touches || !e.touches.length) return;
    startHudDrag(id, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive:true });
});
document.addEventListener('mousemove',e=>moveHudDrag(e.clientX,e.clientY));
document.addEventListener('mouseup',()=>drag=null);
document.addEventListener('touchmove',e=>{
  if(!drag || !e.touches || !e.touches.length) return;
  moveHudDrag(e.touches[0].clientX,e.touches[0].clientY);
}, { passive:true });
document.addEventListener('touchend',()=>drag=null);

['cond','alerts','radar'].forEach(id=>{
  document.getElementById('hud-'+id+'-tog').addEventListener('click',(e)=>{
    e.stopPropagation();
    const card=document.getElementById('hud-'+id);
    card.classList.toggle('collapsed');
    document.getElementById('hud-'+id+'-tog').textContent=card.classList.contains('collapsed')?'▸':'▾';
  });
});



// ── RIGHT TOOLS DRAWER ────────────────────────────────────────────────────────
function toggleToolsDrawer(open) {
  const drawer = document.getElementById('right-drawer');
  const btn = document.getElementById('btn-citylayers');
  if (!drawer) return;

  const shouldOpen = typeof open === 'boolean' ? open : !drawer.classList.contains('open');

  drawer.classList.toggle('open', shouldOpen);
  drawer.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');

  if (btn) btn.classList.toggle('on', shouldOpen);
}

const drawerClose = document.getElementById('drawer-close');
if (drawerClose) {
  drawerClose.addEventListener('click', () => toggleToolsDrawer(false));
}
document.getElementById('river-panel-close')?.addEventListener('click', closeRiverGaugePanel);

// ── RIGHT STACK ACCORDION ─────────────────────────────────────────────────────
function openStackPanel(panelId) {
  const panels = ['citylayers', 'stations', 'rivergauges', 'cam'];
  const target = document.getElementById('hud-' + panelId);
  const shouldOpenTarget = target ? target.classList.contains('collapsed') : true;

  panels.forEach(id => {
    const card = document.getElementById('hud-' + id);
    const tog = document.getElementById('hud-' + id + '-tog');
    const shouldOpen = id === panelId && shouldOpenTarget;

    if (!card || !tog) return;

    card.classList.toggle('collapsed', !shouldOpen);
    tog.textContent = shouldOpen ? '▾' : '▸';
  });
}

['citylayers','stations','rivergauges','cam'].forEach(id => {
  const head = document.getElementById('hud-' + id + '-head');
  const tog = document.getElementById('hud-' + id + '-tog');

  function handleStackClick(e) {
    e.stopPropagation();
    openStackPanel(id);
  }

  if (head) head.addEventListener('click', handleStackClick);
  if (tog) tog.addEventListener('click', handleStackClick);
});

// ── AUTO-REFRESH ──────────────────────────────────────────────────────────────
const INTERVAL=120; let tick2=0;
setInterval(()=>{
  tick2++;
  document.getElementById('rbar').style.width=(tick2/INTERVAL*100)+'%';
  if(tick2>=INTERVAL){tick2=0;document.getElementById('rbar').style.width='0%';refreshRadar();loadAlerts();loadConditions();}
},1000);
setInterval(loadAlerts,60000);

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('selectVelStation',e=>{
  selectedVelStation=e.detail;
  stopReflectivityLoop(true, true);
  if(radarType!=='velocity' && radarType!=='hclass'){setRadarType('velocity');}
  else{applyAllRadarLayers();if(splitViewActive&&compareMap)buildCompareRadarLayer();buildStationMarkers();buildStationLegend();updateRadarTime();}
  map.closePopup();
});



// Mobile space optimization: start secondary controls collapsed on phones.

function initMobileConditionPeek() {
  const head = document.getElementById('hud-cond-head');
  const card = document.getElementById('hud-cond');
  if (!head || !card) return;
  head.addEventListener('click', e => {
    const isMobile = window.matchMedia('(max-width:760px), (pointer:coarse)').matches;
    if (!isMobile) return;
    e.stopPropagation();
    card.classList.toggle('collapsed');
  });
}

function normalizeMobileHudLayout() {
  const isMobile = window.matchMedia('(max-width:760px), (pointer:coarse)').matches;
  ['hud-cond', 'hud-alerts'].forEach(id => {
    const card = document.getElementById(id);
    if (!card) return;
    if (isMobile) {
      card.style.left = '';
      card.style.right = '';
      card.style.bottom = '';
    }
  });
}

function applyMobileSpaceOptimization(){
  const isMobile = window.matchMedia('(max-width:760px), (pointer:coarse)').matches;
  normalizeMobileHudLayout();
  const setCollapsed = (id, collapsed) => {
    const card = document.getElementById('hud-' + id);
    const tog = document.getElementById('hud-' + id + '-tog');
    if (!card || !tog) return;
    card.classList.toggle('collapsed', collapsed);
    tog.textContent = collapsed ? '▸' : '▾';
  };
  if (isMobile) {
    setCollapsed('radar', true);
    setCollapsed('cond', true);
  } else {
    setCollapsed('radar', false);
  }
  setTimeout(() => { try { map.invalidateSize(); } catch(e) {} }, 150);
}
window.addEventListener('resize', applyMobileSpaceOptimization);
window.addEventListener('orientationchange', applyMobileSpaceOptimization);

initCitySearch();
initTopMenus();
initLocateMeControl();
initMobileConditionPeek();
setConditionsTitle(selectedCityContext.city, selectedCityContext.state);
loadRadar();
loadLiveDopplerStations();
setRiverGaugeButtonState();
loadAlerts();
loadConditions();
initTxDotCameraControls();
const startupCity = getSavedCityText();
if (startupCity && startupCity.toLowerCase() !== 'frisco, tx') { setTimeout(()=>searchCityBoundaryAndTower(startupCity), 250); }
syncFriscoLayerAvailability();
applyMobileSpaceOptimization();

})();

function selectVelStation(stationId) {
  document.dispatchEvent(new CustomEvent('selectVelStation',{detail:stationId}));
}
