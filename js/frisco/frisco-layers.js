(function() {
  'use strict';

  const FRISCO_CENTER = [33.155, -96.823];
  const FRISCO_GEOID = '4827684';
  const TIGER_PLACES_QUERY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query';
  const CITY_SERVICES_BASE = 'https://maps.friscotexas.gov/gis/rest/services/Public/External_City_Services/MapServer';

  const FALLBACK_BOUNDARY = [
    [-96.9298,33.2075],[-96.8954,33.2211],[-96.8617,33.2211],[-96.8198,33.2211],[-96.7853,33.2075],[-96.7509,33.1939],[-96.7337,33.1735],[-96.7165,33.1462],[-96.7165,33.1189],[-96.7337,33.0984],[-96.7681,33.0848],[-96.8026,33.0780],[-96.8370,33.0780],[-96.8715,33.0848],[-96.9059,33.0984],[-96.9231,33.1189],[-96.9404,33.1462],[-96.9404,33.1735],[-96.9298,33.2075]
  ];

  const FIRE_STATION_ICON = `<div style="
    width:14px;height:14px;background:#ff3b30;border:2px solid #ff6b6b;
    border-radius:3px;box-shadow:0 0 6px rgba(255,59,48,.5);
    display:flex;align-items:center;justify-content:center;
    font-size:8px;color:#fff;font-weight:700;line-height:1;
  ">F</div>`;

  const FIRE_DISTRICT_STYLE = {
    color:'#ff3b30', weight:1.5, fillColor:'#ff3b30', fillOpacity:0.06, dashArray:'4 3'
  };

  const SIRENS = [
    {id:'1001',lat:33.212666,lon:-96.754569,name:'Red Bud Estates'},
    {id:'1002',lat:33.159629,lon:-96.738656,name:'Custer Creek Farms'},
    {id:'1003',lat:33.158582,lon:-96.870102,name:'Wilma Fisher Elementary School'},
    {id:'1004',lat:33.135827,lon:-96.824044,name:'Frisco Police Department'},
    {id:'1005',lat:33.105576,lon:-96.840227,name:'Fire Station 3'},
    {id:'1006',lat:33.128538,lon:-96.796025,name:'Collin College Frisco'},
    {id:'1007',lat:33.169369,lon:-96.812036,name:'Warren Sports Complex'},
    {id:'1008',lat:33.149541,lon:-96.822368,name:'Old Water Tower on Main'},
    {id:'1009',lat:33.148628,lon:-96.789149,name:'J.W. & Ruth Christie Elementary School'},
    {id:'1010',lat:33.116403,lon:-96.779393,name:'Lebanon Rd @ White Rock Creek'},
    {id:'1011',lat:33.111269,lon:-96.814685,name:'Parkwood Blvd Water Tower'},
    {id:'1012',lat:33.134309,lon:-96.768296,name:'Centennial High School'},
    {id:'1013',lat:33.12084,lon:-96.866635,name:'Lebanon Rd & Quail Hollow Rd'},
    {id:'1014',lat:33.130127,lon:-96.737443,name:'Superior Water System @ Custer'},
    {id:'1015',lat:33.145947,lon:-96.831897,name:'Cotton Gin Rd'},
    {id:'1016',lat:33.141666,lon:-96.876566,name:'Pioneer Middle School'},
    {id:'1017',lat:33.150645,lon:-96.752147,name:'Harold Bacchus Community Park'},
    {id:'1018',lat:33.162728,lon:-96.758456,name:'Yucca Ridge Park / Independence High School'},
    {id:'1019',lat:33.175387,lon:-96.796408,name:'Eldorado @ Gladstone'},
    {id:'1020',lat:33.123136,lon:-96.846921,name:'Legacy @ Beavers Bend Park'},
    {id:'1021',lat:33.159556,lon:-96.849237,name:'Caroll Elementary School'},
    {id:'1022',lat:33.186322,lon:-96.845277,name:'Trent Middle School'},
    {id:'1023',lat:33.190199,lon:-96.866733,name:'Lone Star High School'},
    {id:'1024',lat:33.089808,lon:-96.842177,name:'Town & Country Blvd'},
    {id:'1025',lat:33.145668,lon:-96.893902,name:'Fire Station 7'},
    {id:'1026',lat:33.12628,lon:-96.887258,name:'Lebanon Rd & Dustwhirl Dr'},
    {id:'1027',lat:33.14876,lon:-96.808159,name:'Central Fire Station'},
    {id:'1028',lat:33.192472,lon:-96.790133,name:'Miramonte Park/Hays Middle School'},
    {id:'1029',lat:33.177283,lon:-96.865579,name:'George and Debra Purefoy Elementary School'},
    {id:'1030',lat:33.178774,lon:-96.771906,name:'Libby Cash Maus Middle School'},
    {id:'1031',lat:33.174342,lon:-96.744382,name:'Eldorado @ Palm Springs'},
    {id:'1032',lat:33.109807,lon:-96.801823,name:'Fire Station 2'},
    {id:'1033',lat:33.136883,lon:-96.860217,name:'Vaughn Elementary School'},
    {id:'1034',lat:33.175718,lon:-96.832198,name:'Frisco St @ Eldorado'},
    {id:'1035',lat:33.101069,lon:-96.818123,name:'Parkwood Blvd and Gaylord Pkwy'},
    {id:'1036',lat:33.138791,lon:-96.909829,name:'Crown Park Ln @ Golf Club at Frisco Lakes'},
    {id:'1037',lat:33.141455,lon:-96.776996,name:'Bessie Gunstream Elementary School'},
    {id:'1038',lat:33.128926,lon:-96.750927,name:'Billy Thompson Vandeventer Middle School'},
    {id:'1039',lat:33.211194,lon:-96.877611,name:'Minett Elementary'},
    {id:'1040',lat:33.203674,lon:-96.805065,name:'Fire Station 9'},
    {id:'1042',lat:33.2079,lon:-96.83823,name:'Legacy @ PGA'},
    {id:'1043',lat:33.211061,lon:-96.862525,name:'Panther Creek High School'}
  ];

  function boundaryStyle() {
    return { color:'rgba(0,200,255,0.75)', weight:1.5, fillColor:'rgba(0,200,255,0.03)', fillOpacity:1, dashArray:'6 4', interactive:false };
  }

  async function loadBoundary({ map, L, layersOn }) {
    try {
      const url = `${TIGER_PLACES_QUERY_URL}?where=GEOID%3D%27${FRISCO_GEOID}%27&outFields=NAME,GEOID&outSR=4326&f=geojson&returnGeometry=true`;
      const res = await fetch(url, { cache:'no-store' });
      const data = await res.json();
      if (data.features && data.features.length) {
        const layer = L.geoJSON(data, { style: boundaryStyle });
        if (layersOn.cityLimits) layer.addTo(map);
        return layer;
      }
    } catch(e) {
      console.warn('Frisco boundary request failed; using fallback boundary.', e);
    }
    const layer = L.polygon(FALLBACK_BOUNDARY.map(c => [c[1], c[0]]), boundaryStyle());
    if (layersOn.cityLimits) layer.addTo(map);
    return layer;
  }

  function addDefaultLabel({ map, L }) {
    return L.marker(FRISCO_CENTER, {
      icon:L.divIcon({className:'', html:'<div style="font-family:\'JetBrains Mono\',monospace;font-size:9px;letter-spacing:3px;color:rgba(0,200,255,.4);pointer-events:none;white-space:nowrap;text-shadow:0 0 8px rgba(0,200,255,.25)">FRISCO TX</div>', iconAnchor:[35,8]}),
      interactive:false
    }).addTo(map);
  }

  async function buildFireStations({ map, L, layersOn, scheduleOverlapCulling }) {
    const url = `${CITY_SERVICES_BASE}/2/query?f=geojson&where=1%3D1&outFields=NAME%2CADDRESS%2CWEBLINK&outSR=4326`;
    const res = await fetch(url, { cache:'no-store' });
    const data = await res.json();
    const layer = L.geoJSON(data, {
      pointToLayer: (feature, latlng) => L.marker(latlng, {
        icon:L.divIcon({ className:'', html:FIRE_STATION_ICON, iconSize:[14,14], iconAnchor:[7,7] }),
        zIndexOffset:400
      }),
      onEachFeature: (feature, marker) => {
        const p = feature.properties || {};
        const link = p.WEBLINK ? `<br><a href="${p.WEBLINK}" target="_blank" style="color:var(--accent);font-size:9px">More info →</a>` : '';
        marker.bindPopup(`<div style="font-family:'JetBrains Mono',monospace"><div style="color:#ff3b30;font-size:11px;font-weight:600;margin-bottom:3px">🔴 ${p.NAME || 'Fire Station'}</div><div style="font-size:9.5px;color:var(--text-dim)">${p.ADDRESS || ''}</div>${link}</div>`);
      }
    });
    if (layersOn.fireStations) { layer.addTo(map); if (scheduleOverlapCulling) scheduleOverlapCulling(100); }
    return layer;
  }

  async function buildFireDistricts({ map, L, layersOn }) {
    const url = `${CITY_SERVICES_BASE}/3/query?f=geojson&where=1%3D1&outFields=NAME&outSR=4326`;
    const res = await fetch(url, { cache:'no-store' });
    const data = await res.json();
    const layer = L.geoJSON(data, {
      style:FIRE_DISTRICT_STYLE,
      onEachFeature: (feature, layer) => {
        const name = (feature.properties && feature.properties.NAME) || 'Fire District';
        layer.bindPopup(`<div style="font-family:'JetBrains Mono',monospace"><div style="color:#ff3b30;font-size:11px;font-weight:600">${name}</div><div style="font-size:9px;color:var(--text-dim);margin-top:2px">Frisco Fire District</div></div>`);
        layer.on('mouseover', () => layer.setStyle({ fillOpacity:0.15 }));
        layer.on('mouseout', () => layer.setStyle({ fillOpacity:FIRE_DISTRICT_STYLE.fillOpacity }));
      }
    });
    if (layersOn.fireDistricts) layer.addTo(map);
    return layer;
  }

  function buildSirens({ map, L, layersOn, scheduleOverlapCulling }) {
    const layer = L.layerGroup();
    SIRENS.forEach(s => {
      L.marker([s.lat, s.lon], { icon:L.divIcon({ className:'siren-dot', iconSize:[9,9], iconAnchor:[4.5,4.5] }) })
        .bindPopup(`<b style="color:var(--accent)">${s.id}</b> · ${s.name}`)
        .addTo(layer);
    });
    if (layersOn.sirens) layer.addTo(map);
    if (scheduleOverlapCulling) scheduleOverlapCulling(80);
    return layer;
  }

  window.FriscoLayers = { loadBoundary, addDefaultLabel, buildFireStations, buildFireDistricts, buildSirens };
})();
