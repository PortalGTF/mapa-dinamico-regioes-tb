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
}

function plotCity(cityLabel) {
  const coord = Geocode.get(cityLabel);
  if (!coord || coord.lat === null) return;
  if (cityMarkers[cityLabel]) return;

  const marker = L.marker([coord.lat, coord.lng], {
    icon: createCityIcon(colorForCity(cityLabel)),
    draggable: Auth.isAdmin,
  });
  marker.on("click", () => openCityPopup(cityLabel, marker));
  marker.on("dragend", () => onCityDragEnd(cityLabel, marker));
  cityMarkers[cityLabel] = marker;
}

function setMarkersDraggable(enabled) {
  Object.values(cityMarkers).forEach((marker) => {
    if (enabled) marker.dragging.enable();
    else marker.dragging.disable();
  });
}

function onCityDragEnd(cityLabel, marker) {
  const ll = marker.getLatLng();
  Geocode.cache[cityLabel] = { lat: ll.lat, lng: ll.lng, manual: true };
  Geocode.saveLocalCache();
  openCityPopup(cityLabel, marker);
}

function createCityIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div class="city-pin" style="--pin-color:${color}"><div class="pin-body"></div><div class="pin-icon">🚚</div></div>`,
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
    marker.setIcon(createCityIcon(colorForCity(label)));
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
  }

  if (Auth.isAdmin) {
    html += `<div class="row admin-hint">Modo admin: arraste o pin no mapa se a localização estiver errada.</div>`;
    if (coord && coord.manual) {
      html += `<button class="btn-reset-loc" data-city="${cityLabel}">Refazer busca automática</button>`;
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
    const resetBtn = popupEl.querySelector(".btn-reset-loc");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => resetCityLocation(cityLabel, marker));
    }
  }, 50);
}

async function resetCityLocation(cityLabel, marker) {
  delete Geocode.cache[cityLabel];
  Geocode.saveLocalCache();
  marker.closePopup();
  await Geocode.geocodeAll([cityLabel]);
  const coord = Geocode.get(cityLabel);
  if (coord && coord.lat !== null) {
    marker.setLatLng([coord.lat, coord.lng]);
  }
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

  if (!sellerName) {
    Object.values(cityMarkers).forEach((m) => m.setOpacity(1));
    return;
  }

  const cities = SELLERS[sellerName] || [];
  const citySet = new Set(cities);

  Object.entries(cityMarkers).forEach(([label, marker]) => {
    const dim = !citySet.has(label);
    marker.setOpacity(dim ? 0.15 : 1);
  });

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
    row.innerHTML = `
      <span class="swatch" style="background:${region.color}"></span>
      <div class="region-info">
        <div class="region-name">${region.name}</div>
        <div class="region-meta">${region.cities.length} cidade(s) · perfil mínimo: ${region.vehicleProfile}</div>
      </div>
      ${Auth.isAdmin ? '<span class="region-edit">editar</span>' : ""}
    `;
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("region-edit")) {
        openRegionModalForEdit(region.id);
      } else {
        focusRegion(region);
      }
    });
    box.appendChild(row);
  });
}

function focusRegion(region) {
  const coords = region.cities.map((c) => Geocode.get(c)).filter((c) => c && c.lat !== null);
  if (coords.length > 0) {
    map.fitBounds(coords.map((c) => [c.lat, c.lng]), { padding: [50, 50] });
  }
}

// ------------------------------------------------------------
// Desenho de região (admin)
// ------------------------------------------------------------
function onPolygonCreated(e) {
  const layer = e.layer;
  drawnItems.addLayer(layer);

  const polygonGeoJSON = layer.toGeoJSON();
  const captured = [];

  Object.entries(cityMarkers).forEach(([label, marker]) => {
    const pt = turf.point([marker.getLatLng().lng, marker.getLatLng().lat]);
    if (turf.booleanPointInPolygon(pt, polygonGeoJSON)) {
      captured.push(label);
    }
  });

  pendingPolygonCities = captured;
  editingRegionId = null;
  openRegionModal({ name: "", vehicleProfile: VEHICLE_PROFILES[0]?.name, cities: captured });

  // remove o polígono temporário do mapa — ele não precisa ficar desenhado,
  // as cidades capturadas já foram salvas na região
  drawnItems.removeLayer(layer);
}

function openRegionModal({ name, vehicleProfile, cities }) {
  document.getElementById("regionModalTitle").textContent = editingRegionId ? "Editar região" : "Nova região";
  document.getElementById("regionName").value = name || "";

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

  document.getElementById("btnRegionDelete").classList.toggle("hidden", !editingRegionId);
  document.getElementById("regionModal").classList.remove("hidden");
}

function openRegionModalForEdit(regionId) {
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
  const name = document.getElementById("regionName").value.trim();
  const vehicleProfile = document.getElementById("regionVehicleProfile").value;
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
    Regions.update(editingRegionId, { name, vehicleProfile, cities: checked });
  } else {
    Regions.create({ name, vehicleProfile, cities: checked });
  }

  rebuildClusters();
  renderRegionsList();
  closeRegionModal();
}

function deleteRegionFromModal() {
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
function updateAdminUI() {
  const badge = document.getElementById("modeBadge");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
  const adminPanel = document.getElementById("adminPanel");

  if (Auth.isAdmin) {
    badge.textContent = "Modo admin";
    badge.className = "badge badge-admin";
    btnLogin.classList.add("hidden");
    btnLogout.classList.remove("hidden");
    adminPanel.classList.remove("hidden");
    map.addControl(drawControl);
  } else {
    badge.textContent = "Modo visualização";
    badge.className = "badge badge-view";
    btnLogin.classList.remove("hidden");
    btnLogout.classList.add("hidden");
    adminPanel.classList.add("hidden");
    if (map.hasLayer && drawControl._map) map.removeControl(drawControl);
  }

  document.getElementById("draftHint").textContent = Regions.hasDraft()
    ? "Há alterações salvas neste navegador ainda não exportadas/commitadas."
    : "";

  setMarkersDraggable(Auth.isAdmin);
  renderRegionsList();
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
    new L.Draw.Polygon(map, drawControl.options.draw.polygon).enable();
  });

  document.getElementById("btnRegionCancel").addEventListener("click", closeRegionModal);
  document.getElementById("btnRegionSave").addEventListener("click", saveRegionFromModal);
  document.getElementById("btnRegionDelete").addEventListener("click", deleteRegionFromModal);

  document.getElementById("btnExportRegions").addEventListener("click", () => {
    downloadFile("regions.json", Regions.exportJSON());
  });

  document.getElementById("btnExportCities").addEventListener("click", () => {
    downloadFile("cities.json", Geocode.exportJSON());
  });
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
