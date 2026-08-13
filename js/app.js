// ============================================================
// APP — liga tudo: mapa, marcadores, desenho de região,
// filtro por vendedor, cálculo de distância e modo admin.
// ============================================================

let map;
let originMarker = null;
let originLatLng = null;
let cityMarkers = {}; // { cityLabel: L.Marker }
let regionClusterGroups = {}; // { regionId: L.MarkerClusterGroup }
let unassignedClusterGroup = null; // cidades sem região
let drawnItems; // camada onde os polígonos desenhados ficam
let drawControl;
let editingRegionId = null; // se != null, o modal de região está editando (não criando)
let pendingPolygonCities = []; // cidades capturadas pelo último polígono desenhado
let searchPreviewMarker = null; // pin temporário do campo de busca de endereço
let activeSellerFilter = null; // se != null, só mostra cidades desse vendedor no mapa
let ringLayerGroup = null; // anéis de 50 em 50 km desenhados a partir da origem
let lastRegionMaxBracket = null; // último raio calculado (para o toggle de anéis)
let regionRadiusCache = {}; // { regionId: { citiesKey, bracket } } — usado na lista lateral
let radiiComputing = false; // evita rodar dois cálculos de raio ao mesmo tempo

let SELLERS = {};       // { vendedor: [cidades] }
let CITY_TO_SELLERS = {}; // { cidade: [vendedores] }
let CITIES_LIST = [];   // ["Cidade - UF", ...]
let VEHICLE_PROFILES = []; // [{name, capacity_kg}]

// ------------------------------------------------------------
// Inicialização
// ------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  Auth.restoreSession();

  await loadStaticData();
  await Regions.load();
  await Geocode.loadCommittedCache();

  initMap();
  await placeOrigin();

  renderSellerOptions();
  renderSearchCityOptions();
  renderRegionsList();
  updateAdminUI();

  wireEvents();

  // Geocodifica em segundo plano tudo o que ainda não está no cache
  geocodeCitiesInBackground();
});

async function loadStaticData() {
  const [sellers, cityToSellers, citiesList, profiles] = await Promise.all([
    fetch("data/sellers.json").then((r) => r.json()),
    fetch("data/city_to_sellers.json").then((r) => r.json()),
    fetch("data/cities_list.json").then((r) => r.json()),
    fetch("data/vehicle_profiles.json").then((r) => r.json()),
  ]);
  SELLERS = sellers;
  CITY_TO_SELLERS = cityToSellers;
  CITIES_LIST = citiesList;
  VEHICLE_PROFILES = profiles;
}

// ------------------------------------------------------------
// Mapa
// ------------------------------------------------------------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  drawControl = new L.Control.Draw({
    edit: { featureGroup: drawnItems, edit: false, remove: false },
    draw: {
      polygon: { allowIntersection: false, showArea: true },
      polyline: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false,
    },
  });

  map.on(L.Draw.Event.CREATED, onPolygonCreated);
}

async function placeOrigin() {
  originLatLng = await Geocode.geocodeOrigin();
  if (!originLatLng || originLatLng.lat === null) return;

  const icon = L.divIcon({
    className: "",
    html: `<div class="origin-pin"><div class="pin-body"></div><div class="pin-icon">🏠</div></div>`,
    iconSize: [38, 50],
    iconAnchor: [19, 50],
    popupAnchor: [0, -46],
  });

  originMarker = L.marker([originLatLng.lat, originLatLng.lng], { icon, zIndexOffset: 1000 }).addTo(map);
  originMarker.bindPopup(`<strong>${CONFIG.ORIGIN_LABEL}</strong><br>Ponto de origem das cargas`);
}

// ------------------------------------------------------------
// Geocodificação em segundo plano + plotagem dos marcadores
// ------------------------------------------------------------
async function geocodeCitiesInBackground() {
  const pending = CITIES_LIST.filter((c) => !Geocode.has(c));

  // Plota imediatamente as cidades que já estão no cache
  CITIES_LIST.filter((c) => Geocode.has(c)).forEach(plotCity);
  rebuildClusters();

  if (pending.length === 0) return;

  const progressEl = document.getElementById("geocodeProgress");
  const fillEl = document.getElementById("progressFill");
  const textEl = document.getElementById("progressText");
  progressEl.classList.remove("hidden");

  await Geocode.geocodeAll(CITIES_LIST, (done, total) => {
    fillEl.style.width = `${(done / total) * 100}%`;
    textEl.textContent = `Localizando cidades… ${done}/${total}`;
  });

  pending.forEach(plotCity);
  rebuildClusters();
  progressEl.classList.add("hidden");
  triggerRadiiComputation();
}

function plotCity(cityLabel) {
  const coord = Geocode.get(cityLabel);
  if (!coord || coord.lat === null) return;
  if (cityMarkers[cityLabel]) return;

  const marker = L.marker([coord.lat, coord.lng], {
    icon: createCityIcon(colorForCity(cityLabel), isSuspect(coord)),
    draggable: Auth.isAdmin,
  });
  marker.on("click", () => openCityPopup(cityLabel, marker));
  marker.on("dragend", () => onCityDragEnd(cityLabel, marker));
  bindWarnTooltip(marker, coord);
  cityMarkers[cityLabel] = marker;
}

function isSuspect(coord) {
  return !!(coord && coord.suspect && !coord.manual);
}

function bindWarnTooltip(marker, coord) {
  marker.unbindTooltip();
  if (isSuspect(coord)) {
    marker.bindTooltip("⚠️ Verificar localização", {
      permanent: true,
      direction: "top",
      offset: [0, -36],
      className: "warn-tooltip",
    });
  }
}

function setMarkersDraggable(enabled) {
  Object.values(cityMarkers).forEach((marker) => {
    if (enabled) marker.dragging.enable();
    else marker.dragging.disable();
  });
}

function onCityDragEnd(cityLabel, marker) {
  if (!Auth.isAdmin) return;
  const ll = marker.getLatLng();
  Geocode.cache[cityLabel] = { lat: ll.lat, lng: ll.lng, manual: true };
  Geocode.saveLocalCache();
  bindWarnTooltip(marker, Geocode.get(cityLabel));
  marker.setIcon(createCityIcon(colorForCity(cityLabel), false));
  invalidateRegionRadiusCache();
  openCityPopup(cityLabel, marker);
}

function createCityIcon(color, suspect) {
  const badge = suspect ? `<div class="pin-warn-badge">!</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="city-pin" style="--pin-color:${color}"><div class="pin-body"></div><div class="pin-icon">🚚</div>${badge}</div>`,
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    popupAnchor: [0, -36],
  });
}

function colorForCity(cityLabel) {
  const regions = Regions.findByCity(cityLabel);
  if (regions.length > 0) return regions[0].color;
  return "#9a978f"; // sem região
}

function makeClusterIconFactory(color) {
  return function (cluster) {
    return L.divIcon({
      className: "",
      html: `<div class="cluster-bubble" style="--cluster-color:${color}">${cluster.getChildCount()}</div>`,
      iconSize: [38, 38],
    });
  };
}

// Recria os grupos de cluster (um por região + um para "sem região") e
// redistribui cada marcador de cidade no grupo certo, com a cor certa.
function rebuildClusters() {
  Object.values(regionClusterGroups).forEach((g) => map.removeLayer(g));
  if (unassignedClusterGroup) map.removeLayer(unassignedClusterGroup);

  regionClusterGroups = {};
  Regions.list.forEach((r) => {
    regionClusterGroups[r.id] = L.markerClusterGroup({
      iconCreateFunction: makeClusterIconFactory(r.color),
      maxClusterRadius: 50,
    });
  });
  unassignedClusterGroup = L.markerClusterGroup({
    iconCreateFunction: makeClusterIconFactory("#9a978f"),
    maxClusterRadius: 50,
  });

  Object.entries(cityMarkers).forEach(([label, marker]) => {
    if (activeSellerFilter && !(SELLERS[activeSellerFilter] || []).includes(label)) {
      return; // fora do filtro de vendedor ativo: não entra em nenhum grupo (fica invisível)
    }
    const coord = Geocode.get(label);
    marker.setIcon(createCityIcon(colorForCity(label), isSuspect(coord)));
    bindWarnTooltip(marker, coord);
    const regions = Regions.findByCity(label);
    const targetGroup = regions.length > 0 ? regionClusterGroups[regions[0].id] : unassignedClusterGroup;
    if (targetGroup) targetGroup.addLayer(marker);
  });

  Object.values(regionClusterGroups).forEach((g) => map.addLayer(g));
  map.addLayer(unassignedClusterGroup);
}

// ------------------------------------------------------------
// Popup de cidade (vendedor, região, perfil, distância)
// ------------------------------------------------------------
function openCityPopup(cityLabel, marker) {
  const vendedores = CITY_TO_SELLERS[cityLabel] || [];
  const regions = Regions.findByCity(cityLabel);
  const coord = Geocode.get(cityLabel);

  let html = `<div class="city-popup"><h4>${cityLabel}</h4>`;
  html += `<div class="row"><strong>Vendedor(es):</strong> ${vendedores.join(", ") || "—"}</div>`;

  if (regions.length > 0) {
    regions.forEach((r) => {
      html += `<div class="row"><strong>Região:</strong> ${r.name}<br><strong>Perfil mínimo:</strong> ${r.vehicleProfile}</div>`;
    });
  } else {
    html += `<div class="row c-warn-inline">Ainda sem região definida</div>`;
  }

  if (coord && coord.manual) {
    html += `<div class="row loc-manual">📍 Localização corrigida manualmente</div>`;
  } else if (isSuspect(coord)) {
    const expectedUF = extractUF(cityLabel);
    html += `<div class="row c-warn-inline">⚠️ Local pode estar errado — esperado: ${expectedUF}, encontrado: ${coord.stateFound}</div>`;
  }

  if (Auth.isAdmin) {
    html += `<div class="row admin-hint">Modo admin: arraste o pin no mapa, ou use "Buscar" abaixo para corrigir pelo nome.</div>`;
    html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="search">Buscar novo endereço</button>`;
    if (coord && coord.manual) {
      html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="auto">Refazer busca automática</button>`;
    }
  }

  html += `<div class="actions">
    <button data-mode="ida">Distância (ida)</button>
    <button data-mode="volta">Ida e volta</button>
  </div>
  <div class="result hidden" id="popupResult"></div>
  </div>`;

  marker.bindPopup(html).openPopup();

  setTimeout(() => {
    const popupEl = marker.getPopup().getElement();
    if (!popupEl) return;
    popupEl.querySelectorAll("button[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => calcDistance(cityLabel, btn.dataset.mode, popupEl));
    });
    popupEl.querySelectorAll(".btn-reset-loc").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.action === "auto") {
          resetCityLocation(cityLabel, marker);
        } else {
          marker.closePopup();
          openSearchPanelFor(cityLabel);
        }
      });
    });
  }, 50);
}

async function resetCityLocation(cityLabel, marker) {
  if (!Auth.isAdmin) return;
  delete Geocode.cache[cityLabel];
  Geocode.saveLocalCache();
  marker.closePopup();
  await Geocode.geocodeAll([cityLabel]);
  const coord = Geocode.get(cityLabel);
  if (coord && coord.lat !== null) {
    marker.setLatLng([coord.lat, coord.lng]);
  }
  marker.setIcon(createCityIcon(colorForCity(cityLabel), isSuspect(coord)));
  bindWarnTooltip(marker, coord);
  invalidateRegionRadiusCache();
  openCityPopup(cityLabel, marker);
}

async function calcDistance(cityLabel, mode, popupEl) {
  const resultEl = popupEl.querySelector("#popupResult");
  resultEl.classList.remove("hidden");
  resultEl.textContent = "Calculando rota…";

  const dest = Geocode.get(cityLabel);

  if (!originLatLng || originLatLng.lat === null || originLatLng.lng === null) {
    resultEl.textContent = "Coordenadas da origem indisponíveis — confira ORIGIN_LAT/ORIGIN_LNG em js/config.js.";
    return;
  }
  if (!dest || dest.lat === null || dest.lng === null) {
    resultEl.textContent = "Não foi possível localizar essa cidade no mapa (coordenadas indisponíveis).";
    return;
  }

  try {
    const route = await Routing.getRoute(originLatLng, dest);
    const km = mode === "volta" ? route.km * 2 : route.km;
    const min = mode === "volta" ? route.min * 2 : route.min;
    const label = mode === "volta" ? "Ida e volta" : "Ida";
    resultEl.innerHTML = `<strong>${label}:</strong> ${Routing.formatKm(km)} · ${Routing.formatMin(min)}`;
  } catch (e) {
    resultEl.textContent = `Erro ao calcular a rota: ${e.message || "tente novamente em alguns segundos."}`;
  }
}

// ------------------------------------------------------------
// Filtro por vendedor
// ------------------------------------------------------------
function renderSellerOptions() {
  const select = document.getElementById("sellerSelect");
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
}

function applySellerFilter(sellerName) {
  const citiesBox = document.getElementById("sellerCities");
  citiesBox.innerHTML = "";

  activeSellerFilter = sellerName || null;
  rebuildClusters();

  if (!sellerName) {
    return;
  }

  const cities = SELLERS[sellerName] || [];

  cities
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((cityLabel) => {
      const regions = Regions.findByCity(cityLabel);
      const row = document.createElement("div");
      row.className = "city-row";
      const regionInfo =
        regions.length > 0
          ? regions.map((r) => `${r.name} (${r.vehicleProfile})`).join(", ")
          : `<span class="c-warn">sem região definida</span>`;

      const outrosVendedores = (CITY_TO_SELLERS[cityLabel] || []).filter((v) => v !== sellerName);
      const coVendedorInfo =
        outrosVendedores.length > 0
          ? `<div class="c-co">Também atendida por: ${outrosVendedores.join(", ")}</div>`
          : "";

      row.innerHTML = `<div class="c-name">${cityLabel}</div><div class="c-meta">${regionInfo}</div>${coVendedorInfo}`;
      citiesBox.appendChild(row);
    });

  // Ajusta o zoom do mapa às cidades do vendedor, se já geocodificadas
  const coords = cities.map((c) => Geocode.get(c)).filter((c) => c && c.lat !== null);
  if (coords.length > 0) {
    map.fitBounds(coords.map((c) => [c.lat, c.lng]), { padding: [40, 40] });
  }
}

// ------------------------------------------------------------
// Regiões — listagem
// ------------------------------------------------------------
function renderRegionsList() {
  const box = document.getElementById("regionsList");
  document.getElementById("regionCount").textContent = Regions.list.length;
  box.innerHTML = "";

  if (Regions.list.length === 0) {
    box.innerHTML = `<p class="hint">Nenhuma região criada ainda.</p>`;
    return;
  }

  Regions.list.forEach((region) => {
    const row = document.createElement("div");
    row.className = "region-row";
    row.dataset.regionId = region.id;
    row.innerHTML = `
      <span class="swatch" style="background:${region.color}"></span>
      <div class="region-info">
        <div class="region-name">${region.name}</div>
        <div class="region-meta">${region.cities.length} cidade(s) · perfil mínimo: ${region.vehicleProfile} · <span class="region-radius">${radiusLabel(region)}</span></div>
      </div>
      ${Auth.isAdmin ? '<span class="region-edit">editar</span>' : ""}
    `;
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("region-edit")) {
        openRegionModalForEdit(region.id);
      } else {
        focusRegion(region);
        openRegionDetail(region);
      }
    });
    box.appendChild(row);
  });

  triggerRadiiComputation();
}

function regionCitiesKey(region) {
  return region.cities.slice().sort().join("|");
}

function radiusLabel(region) {
  const cached = regionRadiusCache[region.id];
  if (cached && cached.citiesKey === regionCitiesKey(region)) {
    return cached.bracket ? `raio até ${cached.bracket} km` : "raio indisponível";
  }
  return "calculando raio…";
}

// Chamado sempre que a localização de alguma cidade muda (arraste, busca manual,
// reconferência), pois o raio calculado antes pode não valer mais.
function invalidateRegionRadiusCache() {
  regionRadiusCache = {};
  renderRegionsList();
}

function triggerRadiiComputation() {
  if (radiiComputing) return;
  radiiComputing = true;
  computeAllRegionRadii().finally(() => {
    radiiComputing = false;
  });
}

async function computeAllRegionRadii() {
  if (!originLatLng || originLatLng.lat === null) return;

  for (const region of Regions.list) {
    const key = regionCitiesKey(region);
    if (regionRadiusCache[region.id] && regionRadiusCache[region.id].citiesKey === key) continue;

    let maxKm = null;
    for (const cityLabel of region.cities) {
      const dest = Geocode.get(cityLabel);
      if (!dest || dest.lat === null) continue;
      try {
        const route = await Routing.getRoute(originLatLng, dest);
        if (maxKm === null || route.km > maxKm) maxKm = route.km;
      } catch (e) {
        // ignora e segue tentando as outras cidades da região
      }
      await new Promise((r) => setTimeout(r, 150)); // uso respeitoso do OSRM
    }

    regionRadiusCache[region.id] = { citiesKey: key, bracket: maxKm === null ? null : bracketFor(maxKm) };
    updateRegionRowRadius(region.id);
  }
}

function updateRegionRowRadius(regionId) {
  const row = document.querySelector(`.region-row[data-region-id="${regionId}"] .region-radius`);
  const region = Regions.list.find((r) => r.id === regionId);
  if (row && region) row.textContent = radiusLabel(region);
}

// ------------------------------------------------------------
// Reconferência em massa (não mexe nas cidades já corrigidas à mão)
// ------------------------------------------------------------
async function reverifyAllCities() {
  if (!Auth.isAdmin) return;

  const toVerify = CITIES_LIST.filter((c) => {
    const coord = Geocode.get(c);
    return !coord || !coord.manual;
  });

  if (toVerify.length === 0) {
    alert("Todas as cidades já foram corrigidas manualmente — nada para reconferir.");
    return;
  }

  if (
    !confirm(
      `Isso vai reconferir a localização de ${toVerify.length} cidade(s) (as corrigidas manualmente não são mexidas). Pode levar alguns minutos. Continuar?`
    )
  ) {
    return;
  }

  toVerify.forEach((c) => delete Geocode.cache[c]);

  const progressEl = document.getElementById("geocodeProgress");
  const fillEl = document.getElementById("progressFill");
  const textEl = document.getElementById("progressText");
  progressEl.classList.remove("hidden");

  await Geocode.geocodeAll(toVerify, (done, total) => {
    fillEl.style.width = `${(done / total) * 100}%`;
    textEl.textContent = `Reconferindo cidades… ${done}/${total}`;
  });

  toVerify.forEach((cityLabel) => {
    const coord = Geocode.get(cityLabel);
    if (!coord || coord.lat === null) return;
    if (cityMarkers[cityLabel]) {
      cityMarkers[cityLabel].setLatLng([coord.lat, coord.lng]);
    } else {
      plotCity(cityLabel);
    }
  });

  rebuildClusters();
  invalidateRegionRadiusCache();
  progressEl.classList.add("hidden");

  const stillSuspect = toVerify.filter((c) => isSuspect(Geocode.get(c)));
  alert(
    stillSuspect.length > 0
      ? `Reconferência concluída. ${stillSuspect.length} cidade(s) ainda com aviso de local suspeito — procure o selo vermelho (!) no mapa.`
      : "Reconferência concluída. Nenhuma cidade com aviso de local suspeito."
  );
}

function focusRegion(region) {
  const coords = region.cities.map((c) => Geocode.get(c)).filter((c) => c && c.lat !== null);
  if (coords.length > 0) {
    map.fitBounds(coords.map((c) => [c.lat, c.lng]), { padding: [50, 50] });
  }
}

// ------------------------------------------------------------
// Raio da região (faixas de 50 em 50 km a partir da origem)
// ------------------------------------------------------------
function bracketFor(km) {
  return Math.ceil(km / 50) * 50;
}

function openRegionDetail(region) {
  document.getElementById("regionDetailTitle").textContent = region.name;
  document.getElementById("regionDetailSummary").textContent = "Calculando distâncias a partir de Terra Boa…";
  document.getElementById("regionDetailList").innerHTML = "";
  document.getElementById("regionDetailModal").classList.remove("hidden");
  computeRegionRadius(region);
}

function closeRegionDetail() {
  document.getElementById("regionDetailModal").classList.add("hidden");
  if (ringLayerGroup) {
    map.removeLayer(ringLayerGroup);
    ringLayerGroup = null;
  }
  document.getElementById("btnToggleRings").textContent = "Mostrar anéis de 50 km no mapa";
}

async function computeRegionRadius(region) {
  const summaryEl = document.getElementById("regionDetailSummary");

  if (!originLatLng || originLatLng.lat === null) {
    summaryEl.textContent = "Não foi possível calcular: coordenadas da origem indisponíveis.";
    return;
  }

  const results = [];
  for (const cityLabel of region.cities) {
    const dest = Geocode.get(cityLabel);
    if (!dest || dest.lat === null) {
      results.push({ cityLabel, km: null });
      renderRegionDetailList(results);
      continue;
    }
    try {
      const route = await Routing.getRoute(originLatLng, dest);
      results.push({ cityLabel, km: route.km });
    } catch (e) {
      results.push({ cityLabel, km: null, error: true });
    }
    renderRegionDetailList(results);
    await new Promise((r) => setTimeout(r, 250)); // uso respeitoso do OSRM
  }

  renderRegionDetailList(results, true);
}

function renderRegionDetailList(results, done) {
  const listEl = document.getElementById("regionDetailList");
  const summaryEl = document.getElementById("regionDetailSummary");

  const valid = results.filter((r) => r.km !== null && !r.error);
  const maxKm = valid.length > 0 ? Math.max(...valid.map((r) => r.km)) : null;
  const maxBracket = maxKm !== null ? bracketFor(maxKm) : null;
  lastRegionMaxBracket = maxBracket;

  if (maxBracket !== null) {
    summaryEl.innerHTML = `<strong>Raio da região: até ${maxBracket} km</strong><br><span class="hint">baseado na cidade mais distante (ida, a partir de Terra Boa - PR)${done ? "" : " · calculando…"}</span>`;
  } else if (done) {
    summaryEl.textContent = "Não foi possível calcular nenhuma distância para essa região.";
  }

  listEl.innerHTML = "";
  results
    .slice()
    .sort((a, b) => (b.km || 0) - (a.km || 0))
    .forEach((r) => {
      const row = document.createElement("div");
      row.className = "region-detail-row";
      if (r.km === null) {
        row.innerHTML = `<span class="rd-city">${r.cityLabel}</span><span class="rd-km">—</span>`;
      } else {
        const bracket = bracketFor(r.km);
        const isMax = bracket === maxBracket;
        row.innerHTML = `<span class="rd-city">${r.cityLabel}</span><span class="rd-km">${r.km.toFixed(0)} km</span><span class="rd-bracket ${isMax ? "rd-bracket-max" : ""}">até ${bracket} km</span>`;
      }
      listEl.appendChild(row);
    });
}

function toggleRings() {
  const btn = document.getElementById("btnToggleRings");
  if (ringLayerGroup) {
    map.removeLayer(ringLayerGroup);
    ringLayerGroup = null;
    btn.textContent = "Mostrar anéis de 50 km no mapa";
    return;
  }
  if (!lastRegionMaxBracket || !originLatLng) return;

  ringLayerGroup = L.layerGroup();
  for (let r = 50; r <= lastRegionMaxBracket; r += 50) {
    L.circle([originLatLng.lat, originLatLng.lng], {
      radius: r * 1000,
      color: r === lastRegionMaxBracket ? "#c0392b" : "#7f8c8d",
      weight: r === lastRegionMaxBracket ? 2 : 1,
      dashArray: "4 4",
      fillOpacity: 0,
    }).addTo(ringLayerGroup);
  }
  ringLayerGroup.addTo(map);
  btn.textContent = "Esconder anéis do mapa";

  const outerCircle = L.circle([originLatLng.lat, originLatLng.lng], { radius: lastRegionMaxBracket * 1000 });
  map.fitBounds(outerCircle.getBounds(), { padding: [30, 30] });
}

// ------------------------------------------------------------
// Desenho de região (admin)
// ------------------------------------------------------------
function onPolygonCreated(e) {
  if (!Auth.isAdmin) return;
  const layer = e.layer;
  drawnItems.addLayer(layer);

  const polygonGeoJSON = layer.toGeoJSON();
  const captured = [];

  Object.entries(cityMarkers).forEach(([label, marker]) => {
    if (activeSellerFilter && !(SELLERS[activeSellerFilter] || []).includes(label)) return;
    const pt = turf.point([marker.getLatLng().lng, marker.getLatLng().lat]);
    if (turf.booleanPointInPolygon(pt, polygonGeoJSON)) {
      captured.push(label);
    }
  });

  pendingPolygonCities = captured;
  editingRegionId = null;
  openRegionModal({ name: "", vehicleProfile: VEHICLE_PROFILES[0]?.name, cities: captured, color: Regions.nextColor() });

  // remove o polígono temporário do mapa — ele não precisa ficar desenhado,
  // as cidades capturadas já foram salvas na região
  drawnItems.removeLayer(layer);
}

function openRegionModal({ name, vehicleProfile, cities, color }) {
  document.getElementById("regionModalTitle").textContent = editingRegionId ? "Editar região" : "Nova região";
  document.getElementById("regionName").value = name || "";
  document.getElementById("regionColorPicker").value = color || Regions.nextColor();

  const select = document.getElementById("regionVehicleProfile");
  select.innerHTML = "";
  VEHICLE_PROFILES.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (até ${p.capacity_kg.toLocaleString("pt-BR")} kg)`;
    if (p.name === vehicleProfile) opt.selected = true;
    select.appendChild(opt);
  });

  const checklist = document.getElementById("regionCitiesChecklist");
  checklist.innerHTML = "";
  if (cities.length === 0) {
    checklist.innerHTML = `<p class="hint">Nenhuma cidade dentro do polígono desenhado.</p>`;
  }
  cities
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((c) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${c}" checked /> ${c}`;
      checklist.appendChild(label);
    });

  const addSelect = document.getElementById("addCitySelect");
  addSelect.innerHTML = `<option value="">+ Adicionar cidade à região…</option>`;
  CITIES_LIST.slice()
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .filter((c) => !cities.includes(c))
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      addSelect.appendChild(opt);
    });

  document.getElementById("btnRegionDelete").classList.toggle("hidden", !editingRegionId);
  document.getElementById("regionModal").classList.remove("hidden");
}

function addCityToRegionChecklist() {
  if (!Auth.isAdmin) return;
  const select = document.getElementById("addCitySelect");
  const city = select.value;
  if (!city) return;

  const checklist = document.getElementById("regionCitiesChecklist");
  const emptyMsg = checklist.querySelector("p.hint");
  if (emptyMsg) emptyMsg.remove();

  const label = document.createElement("label");
  label.innerHTML = `<input type="checkbox" value="${city}" checked /> ${city}`;
  checklist.appendChild(label);

  const opt = Array.from(select.options).find((o) => o.value === city);
  if (opt) opt.remove();
  select.value = "";
}

function openRegionModalForEdit(regionId) {
  if (!Auth.isAdmin) return;
  const region = Regions.list.find((r) => r.id === regionId);
  if (!region) return;
  editingRegionId = regionId;
  openRegionModal(region);
}

function closeRegionModal() {
  document.getElementById("regionModal").classList.add("hidden");
  editingRegionId = null;
  pendingPolygonCities = [];
}

function saveRegionFromModal() {
  if (!Auth.isAdmin) return;
  const name = document.getElementById("regionName").value.trim();
  const vehicleProfile = document.getElementById("regionVehicleProfile").value;
  const color = document.getElementById("regionColorPicker").value;
  const checked = Array.from(
    document.querySelectorAll("#regionCitiesChecklist input:checked")
  ).map((el) => el.value);

  if (!name) {
    alert("Dê um nome para a região.");
    return;
  }
  if (checked.length === 0) {
    alert("Selecione ao menos uma cidade.");
    return;
  }

  if (editingRegionId) {
    Regions.update(editingRegionId, { name, vehicleProfile, cities: checked, color });
  } else {
    Regions.create({ name, vehicleProfile, cities: checked, color });
  }

  rebuildClusters();
  renderRegionsList();
  closeRegionModal();
}

function deleteRegionFromModal() {
  if (!Auth.isAdmin) return;
  if (!editingRegionId) return;
  if (!confirm("Excluir esta região? As cidades voltam para 'sem região'.")) return;
  Regions.remove(editingRegionId);
  rebuildClusters();
  renderRegionsList();
  closeRegionModal();
}

// ------------------------------------------------------------
// Admin: login/logout, UI e exportação
// ------------------------------------------------------------
// ------------------------------------------------------------
// Busca manual de endereço (geolocalização por nome)
// ------------------------------------------------------------
function renderSearchCityOptions() {
  const select = document.getElementById("searchCitySelect");
  select.innerHTML = `<option value="">— Selecione a cidade —</option>`;
  CITIES_LIST.slice()
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
}

function openSearchPanelFor(cityLabel) {
  const select = document.getElementById("searchCitySelect");
  select.value = cityLabel;
  document.getElementById("searchAddressInput").value = buildNominatimQuery(cityLabel);
  document.getElementById("searchCitySelect").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function doSearchAddress() {
  if (!Auth.isAdmin) return;
  const city = document.getElementById("searchCitySelect").value;
  const input = document.getElementById("searchAddressInput");
  const resultBox = document.getElementById("searchResultBox");

  if (!city) {
    alert("Selecione primeiro qual cidade você quer localizar/corrigir.");
    return;
  }
  const query = input.value.trim() || buildNominatimQuery(city);
  const expectedUF = extractUF(city);

  resultBox.classList.remove("hidden");
  resultBox.innerHTML = "Buscando…";

  const found = await Geocode.searchAddress(query, expectedUF);
  if (!found) {
    resultBox.innerHTML = "Endereço não encontrado. Tente descrever de outro jeito (ex: adicionar bairro, rodovia, referência).";
    return;
  }

  clearSearchPreview();
  searchPreviewMarker = L.marker([found.lat, found.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="city-pin search-pin"><div class="pin-body"></div><div class="pin-icon">🔍</div></div>`,
      iconSize: [30, 40],
      iconAnchor: [15, 40],
      popupAnchor: [0, -36],
    }),
    draggable: true,
    zIndexOffset: 900,
  }).addTo(map);

  map.setView([found.lat, found.lng], 13);

  const warnHtml = found.suspect
    ? `<div class="c-warn-inline">⚠️ Esse resultado caiu fora de ${expectedUF} (achou em ${found.stateFound}) — confira com atenção antes de confirmar.</div>`
    : "";

  resultBox.innerHTML = `
    <div><strong>Encontrado:</strong> ${found.displayName}</div>
    ${warnHtml}
    <div class="hint">Arraste o pin azul no mapa se precisar ajustar antes de confirmar.</div>
    <div class="sr-actions">
      <button id="btnApplySearch">Usar esta localização para "${city}"</button>
      <button id="btnCancelSearch">Cancelar</button>
    </div>
  `;

  document.getElementById("btnApplySearch").addEventListener("click", () => applySearchResult(city));
  document.getElementById("btnCancelSearch").addEventListener("click", () => {
    clearSearchPreview();
    resultBox.classList.add("hidden");
  });
}

function applySearchResult(cityLabel) {
  if (!Auth.isAdmin) return;
  if (!searchPreviewMarker) return;
  const ll = searchPreviewMarker.getLatLng();
  Geocode.cache[cityLabel] = { lat: ll.lat, lng: ll.lng, manual: true };
  Geocode.saveLocalCache();

  if (cityMarkers[cityLabel]) {
    cityMarkers[cityLabel].setLatLng(ll);
  } else {
    plotCity(cityLabel);
  }
  rebuildClusters();
  invalidateRegionRadiusCache();
  clearSearchPreview();
  document.getElementById("searchResultBox").classList.add("hidden");
}

function clearSearchPreview() {
  if (searchPreviewMarker) {
    map.removeLayer(searchPreviewMarker);
    searchPreviewMarker = null;
  }
}


function updateAdminUI() {
  const badge = document.getElementById("modeBadge");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
  const adminToolbar = document.getElementById("adminToolbar");

  if (Auth.isAdmin) {
    badge.textContent = "Modo admin";
    badge.className = "badge badge-admin";
    btnLogin.classList.add("hidden");
    btnLogout.classList.remove("hidden");
    adminToolbar.classList.remove("hidden");
    map.addControl(drawControl);
  } else {
    badge.textContent = "Modo visualização";
    badge.className = "badge badge-view";
    btnLogin.classList.remove("hidden");
    btnLogout.classList.add("hidden");
    adminToolbar.classList.add("hidden");
    document.getElementById("searchResultBox").classList.add("hidden");
    closeRegionModal();
    clearSearchPreview();
    if (map.hasLayer && drawControl._map) map.removeControl(drawControl);
  }

  document.getElementById("draftHint").textContent = Regions.hasDraft()
    ? "Há alterações salvas neste navegador ainda não exportadas/commitadas."
    : "";

  setMarkersDraggable(Auth.isAdmin);
  renderRegionsList();
  setTimeout(() => map.invalidateSize(), 60);
}

function wireEvents() {
  document.getElementById("btnLogin").addEventListener("click", () => {
    document.getElementById("loginModal").classList.remove("hidden");
    document.getElementById("loginPassword").value = "";
    document.getElementById("loginError").classList.add("hidden");
  });

  document.getElementById("btnLoginCancel").addEventListener("click", () => {
    document.getElementById("loginModal").classList.add("hidden");
  });

  document.getElementById("btnLoginConfirm").addEventListener("click", async () => {
    const pwd = document.getElementById("loginPassword").value;
    const ok = await Auth.tryLogin(pwd);
    if (ok) {
      document.getElementById("loginModal").classList.add("hidden");
      updateAdminUI();
    } else {
      document.getElementById("loginError").classList.remove("hidden");
    }
  });

  document.getElementById("loginPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btnLoginConfirm").click();
  });

  document.getElementById("btnLogout").addEventListener("click", () => {
    Auth.logout();
    updateAdminUI();
  });

  document.getElementById("sellerSelect").addEventListener("change", (e) => {
    applySellerFilter(e.target.value);
  });

  document.getElementById("btnDrawRegion").addEventListener("click", () => {
    if (!Auth.isAdmin) return;
    new L.Draw.Polygon(map, drawControl.options.draw.polygon).enable();
  });

  document.getElementById("btnRegionCancel").addEventListener("click", closeRegionModal);
  document.getElementById("btnRegionSave").addEventListener("click", saveRegionFromModal);
  document.getElementById("btnRegionDelete").addEventListener("click", deleteRegionFromModal);
  document.getElementById("btnAddCityToRegion").addEventListener("click", addCityToRegionChecklist);

  document.getElementById("btnExportRegions").addEventListener("click", () => {
    downloadFile("regions.json", Regions.exportJSON());
  });

  document.getElementById("btnExportCities").addEventListener("click", () => {
    downloadFile("cities.json", Geocode.exportJSON());
  });

  document.getElementById("btnReverifyCities").addEventListener("click", reverifyAllCities);

  document.getElementById("searchCitySelect").addEventListener("change", (e) => {
    if (e.target.value) {
      document.getElementById("searchAddressInput").value = buildNominatimQuery(e.target.value);
    }
  });

  document.getElementById("btnSearchAddress").addEventListener("click", doSearchAddress);

  document.getElementById("btnCloseRegionDetail").addEventListener("click", closeRegionDetail);
  document.getElementById("btnToggleRings").addEventListener("click", toggleRings);
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
