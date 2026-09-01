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
let focusedRegionId = null; // se != null (e showNeighborRegions=false), isola só essa região no mapa
let showNeighborRegions = false; // flag do painel: mostrar as demais regiões junto
let ringLayerGroup = null; // anéis de 50 em 50 km desenhados a partir da origem
let lastRegionMaxBracket = null; // último raio calculado (para o toggle de anéis)
let regionRadiusCache = {}; // { regionId: { citiesKey, bracket } } — usado na lista lateral
let radiiComputing = false; // evita rodar dois cálculos de raio ao mesmo tempo
let regionFenceLayer = null; // "cerca eletrônica" (contorno) da região em foco
let currentDetailRegionId = null; // região atualmente aberta no painel de detalhes

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
  await Grade.load();
  cleanupGhostGradeRoutes();
  await Geocode.loadCommittedCache();

  initMap();
  await placeOrigin();

  Orders.load();
  if (Orders.hasOrders()) {
    plotOrdersOnMap();
    document.getElementById("toggleOrdersLabel").classList.remove("hidden");
  }

  renderSellerOptions();
  renderSearchCityOptions();
  renderRegionsList();
  updateAdminUI();

  document.getElementById("searchAddressInput").value = "";

  wireEvents();
  setupGradeDragDrop();
  makePanelsDraggable();

  // Geocodifica em segundo plano tudo o que ainda não está no cache
  geocodeCitiesInBackground();
});

// Tecla Esc sai do modo apresentação
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("presentation-mode")) {
    togglePresentationMode(false);
  }
});

// Se o usuário sair da tela cheia nativa do navegador (ex: apertando Esc do próprio
// navegador), sincroniza o modo apresentação pra sair junto também.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && document.body.classList.contains("presentation-mode")) {
    togglePresentationMode(false);
  }
});

// Avisa o navegador (com o alerta nativo dele) se tentar fechar a aba ou sair do
// site com alterações não publicadas — última rede de segurança.
window.addEventListener("beforeunload", (e) => {
  if (Auth.isAdmin && (Regions.hasDraft() || hasCityDirectoryDraft())) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ------------------------------------------------------------
// Painéis arrastáveis — segura no cabeçalho (título) e arrasta pra
// qualquer lugar da tela, sem tampar o mapa.
// ------------------------------------------------------------
function makePanelsDraggable() {
  attachDrag("regionDetailModal", document.querySelector("#regionDetailModal .side-panel-header"));
  attachDrag("loginModal", document.getElementById("loginModalHeader"));
  attachDrag("regionModal", document.getElementById("regionModalHeader"));
  attachDrag("newCityModal", document.getElementById("newCityModalHeader"));
  attachDrag("conflictModal", document.getElementById("conflictModalHeader"));
  attachDrag("pdfModal", document.getElementById("pdfModalHeader"));
  attachDrag("editCitySellersModal", document.getElementById("editCitySellersHeader"));
  attachDrag("keyCityModal", document.getElementById("keyCityHeader"));
  attachDrag("changePasswordModal", document.getElementById("changePasswordHeader"));
  attachDrag("githubPublishModal", document.getElementById("githubPublishHeader"));
  attachDrag("importOrdersModal", document.getElementById("importOrdersHeader"));
  attachDrag("gradeCitiesModal", document.getElementById("gradeCitiesHeader"));
  attachDrag("gradeRegionInfoModal", document.getElementById("gradeRegionInfoHeader"));
  attachDrag("dedupeModal", document.getElementById("dedupeModalHeader"));
}

function attachDrag(panelId, headerEl) {
  const panel = document.getElementById(panelId);
  if (!panel || !headerEl) return;

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  function start(clientX, clientY) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.transform = "none";
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    dragging = true;
  }

  function move(clientX, clientY) {
    if (!dragging) return;
    const maxLeft = window.innerWidth - 40;
    const maxTop = window.innerHeight - 40;
    panel.style.left = `${Math.min(Math.max(0, clientX - offsetX), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, clientY - offsetY), maxTop)}px`;
  }

  headerEl.addEventListener("mousedown", (e) => {
    if (e.target.closest(".icon-btn")) return;
    start(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  window.addEventListener("mouseup", () => (dragging = false));

  headerEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.target.closest(".icon-btn")) return;
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    },
    { passive: true }
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    },
    { passive: true }
  );
  window.addEventListener("touchend", () => (dragging = false));
}

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
  loadCityDirectoryDraft();

  // Recalcula SELLERS a partir de CITY_TO_SELLERS toda vez que a página carrega —
  // isso "autocura" qualquer dessincronia antiga que possa ter ficado gravada no
  // navegador antes dessa correção existir, sem precisar de nenhum clique manual.
  rebuildSellersFromCityToSellers();
}

// ------------------------------------------------------------
// Diretório de cidades/vendedores — rascunho local (mesma lógica das regiões):
// fica salvo no navegador até ser exportado e commitado no GitHub.
// ------------------------------------------------------------
// Recalcula o "livro do vendedor" (SELLERS) inteiramente a partir do "livro da
// cidade" (CITY_TO_SELLERS), que passa a ser a única fonte de verdade. Isso evita
// que os dois fiquem dessincronizados por causa de alguma diferença sutil de string
// (ex: maiúscula/minúscula) em algum passo anterior.
function rebuildSellersFromCityToSellers() {
  const newSellers = {};
  Object.keys(SELLERS).forEach((s) => {
    newSellers[s] = []; // mantém todo vendedor já conhecido na lista, mesmo sem cidades
  });
  Object.entries(CITY_TO_SELLERS).forEach(([city, sellers]) => {
    sellers.forEach((s) => {
      newSellers[s] = newSellers[s] || [];
      if (!newSellers[s].includes(city)) newSellers[s].push(city);
    });
  });
  SELLERS = newSellers;
}

function loadCityDirectoryDraft() {
  try {
    const raw = localStorage.getItem("regioes_directory_draft");
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.sellers) SELLERS = draft.sellers;
    if (draft.cityToSellers) CITY_TO_SELLERS = draft.cityToSellers;
    if (draft.citiesList) CITIES_LIST = draft.citiesList;
  } catch (e) {}
}

function saveCityDirectoryDraft() {
  localStorage.setItem(
    "regioes_directory_draft",
    JSON.stringify({ sellers: SELLERS, cityToSellers: CITY_TO_SELLERS, citiesList: CITIES_LIST })
  );
}

function hasCityDirectoryDraft() {
  return !!localStorage.getItem("regioes_directory_draft");
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
    icon: createCityIcon(colorForCity(cityLabel), isSuspect(coord), isKeyCity(cityLabel)),
    draggable: Auth.isAdmin,
  });
  marker.on("click", () => openCityPopup(cityLabel, marker));
  marker.on("dragend", () => onCityDragEnd(cityLabel, marker));
  bindWarnTooltip(marker, coord, cityLabel);
  cityMarkers[cityLabel] = marker;
}

function isSuspect(coord) {
  return !!(coord && coord.suspect && !coord.manual);
}

function bindWarnTooltip(marker, coord, cityLabel) {
  marker.unbindTooltip();
  if (isSuspect(coord)) {
    marker.bindTooltip(`⚠️ ${cityLabel} — verificar localização`, {
      permanent: true,
      direction: "top",
      offset: [0, -36],
      className: "warn-tooltip",
    });
  } else {
    // Passa o mouse por cima do pin (sem clicar) pra ver o nome da cidade
    marker.bindTooltip(cityLabel, {
      permanent: false,
      direction: "top",
      offset: [0, -36],
      className: "city-name-tooltip",
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
  bindWarnTooltip(marker, Geocode.get(cityLabel), cityLabel);
  marker.setIcon(createCityIcon(colorForCity(cityLabel), false, isKeyCity(cityLabel)));
  invalidateRegionRadiusCache();
  openCityPopup(cityLabel, marker);
}

function createCityIcon(color, suspect, isKey) {
  const warnBadge = suspect ? `<div class="pin-warn-badge">!</div>` : "";
  const keyBadge = isKey ? `<div class="pin-key-badge">🔑</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="city-pin${isKey ? " key-pin" : ""}" style="--pin-color:${color}"><div class="pin-body"></div><div class="pin-icon">🚚</div>${warnBadge}${keyBadge}</div>`,
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    popupAnchor: [0, -36],
  });
}

function isKeyCity(cityLabel) {
  return Regions.findByCity(cityLabel).length > 1;
}

function colorForCity(cityLabel) {
  if (isKeyCity(cityLabel)) return "#d4af37"; // dourado, reservado só pras cidades-chave
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

  // Se uma região está em foco, calcula quais outras regiões estão "ligadas" a ela
  // por causa de alguma cidade-chave — essas aparecem desfocadas automaticamente,
  // mesmo sem o usuário clicar nelas.
  let linkedRegionIds = new Set();
  if (focusedRegionId) {
    const focusedRegion = Regions.list.find((r) => r.id === focusedRegionId);
    if (focusedRegion) {
      focusedRegion.cities.forEach((cityLabel) => {
        const allRegions = Regions.findByCity(cityLabel);
        if (allRegions.length > 1) {
          allRegions.forEach((r) => {
            if (r.id !== focusedRegionId) linkedRegionIds.add(r.id);
          });
        }
      });
    }
  }

  Object.entries(cityMarkers).forEach(([label, marker]) => {
    let dim = false;

    if (focusedRegionId) {
      const focusedRegion = Regions.list.find((r) => r.id === focusedRegionId);
      const inFocusedRegion = focusedRegion && focusedRegion.cities.includes(label);
      const cityRegionIds = Regions.findByCity(label).map((r) => r.id);
      const inLinkedRegion = cityRegionIds.some((id) => linkedRegionIds.has(id));

      if (!showNeighborRegions && !inFocusedRegion && !inLinkedRegion) {
        return; // fora da região em foco (e sem ligação por cidade-chave): fica invisível
      }
      if (activeSellerFilter && inFocusedRegion && !(CITY_TO_SELLERS[label] || []).includes(activeSellerFilter)) {
        dim = true; // dentro da região em foco, mas de outro vendedor: aparece desfocada, não escondida
      }
      if (!inFocusedRegion && inLinkedRegion) {
        dim = true; // região vizinha ligada por cidade-chave: aparece desfocada
      }
    } else if (activeSellerFilter && !(SELLERS[activeSellerFilter] || []).includes(label)) {
      return; // sem região em foco: filtro de vendedor tradicional, esconde quem não é dele
    }

    const coord = Geocode.get(label);
    marker.setIcon(createCityIcon(colorForCity(label), isSuspect(coord), isKeyCity(label)));
    marker.setOpacity(dim ? 0.35 : 1);
    bindWarnTooltip(marker, coord, label);
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
    if (regions.length > 1) {
      html += `<div class="row key-city-tag">🔑 Cidade-chave — compõe ${regions.length} regiões</div>`;
    }
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
    html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="editSellers">Editar vendedor(es)</button>`;
    html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="keyCity">🔑 Cidade-chave (compor mais regiões)</button>`;
    html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="search">Buscar novo endereço</button>`;
    if (coord && coord.manual) {
      html += `<button class="btn-reset-loc" data-city="${cityLabel}" data-action="auto">Refazer busca automática</button>`;
    }
    html += `<button class="btn-reset-loc btn-danger-loc" data-city="${cityLabel}" data-action="delete">🗑 Excluir esta cidade (ponto duplicado)</button>`;
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
        } else if (btn.dataset.action === "editSellers") {
          marker.closePopup();
          openEditCitySellersModal(cityLabel, marker);
        } else if (btn.dataset.action === "keyCity") {
          marker.closePopup();
          openKeyCityModal(cityLabel, marker);
        } else if (btn.dataset.action === "delete") {
          deleteCity(cityLabel);
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
  marker.setIcon(createCityIcon(colorForCity(cityLabel), isSuspect(coord), isKeyCity(cityLabel)));
  bindWarnTooltip(marker, coord, cityLabel);
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
  const currentValue = select.value;
  select.innerHTML = `<option value="">— Todos —</option>`;
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  select.value = currentValue;
}

function applySellerFilter(sellerName) {
  const citiesBox = document.getElementById("sellerCities");
  citiesBox.innerHTML = "";

  activeSellerFilter = sellerName || null;
  if (sellerName) {
    focusedRegionId = null;
    showNeighborRegions = false;
  }
  rebuildClusters();

  // Esconde a lista geral de "Regiões" quando um vendedor está filtrado — a lista
  // enxuta abaixo do filtro já cobre isso, sem duplicar informação na tela.
  const regionsPanel = document.getElementById("regionsListPanel");
  if (regionsPanel) regionsPanel.classList.toggle("hidden", !!sellerName);

  if (!sellerName) {
    return;
  }

  const cities = SELLERS[sellerName] || [];

  // Agrupa por região: quantas cidades desse vendedor caem em cada região
  const regionCounts = {}; // regionId -> { region, count }
  let unassignedCount = 0;
  cities.forEach((cityLabel) => {
    const regions = Regions.findByCity(cityLabel);
    if (regions.length === 0) {
      unassignedCount++;
      return;
    }
    regions.forEach((r) => {
      regionCounts[r.id] = regionCounts[r.id] || { region: r, count: 0 };
      regionCounts[r.id].count++;
    });
  });

  const regionEntries = Object.values(regionCounts).sort((a, b) =>
    a.region.name.localeCompare(b.region.name, "pt-BR")
  );

  if (regionEntries.length === 0 && unassignedCount === 0) {
    citiesBox.innerHTML = `<p class="hint">Esse vendedor ainda não tem cidades cadastradas.</p>`;
  } else {
    regionEntries.forEach(({ region, count }) => {
      const ownCities = region.cities.filter((c) => (CITY_TO_SELLERS[c] || []).includes(sellerName));

      const row = document.createElement("div");
      row.className = "region-row";
      row.innerHTML = `
        <span class="swatch" style="background:${region.color}"></span>
        <div class="region-info">
          <div class="region-name">${region.name}</div>
          <div class="region-meta">Cidade(s): ${ownCities.join(", ")} · perfil mínimo: ${region.vehicleProfile}</div>
        </div>
      `;
      row.addEventListener("click", () => {
        // Mantém o filtro de vendedor ativo — só foca na região, não reseta o filtro
        focusedRegionId = region.id;
        showNeighborRegions = false;
        rebuildClusters();
        focusRegion(region);
        showRegionFence(region);
        showKeyCityLinks(region);
        if (isPresenting()) {
          showPresentationBurst(region);
        } else {
          openRegionDetail(region);
        }
      });
      citiesBox.appendChild(row);

      // Cidades dessa região que pertencem a outro vendedor — agrupadas por
      // vendedor numa linha compacta, cada cidade clicável pra editar na hora
      const foreignBySeller = {};
      region.cities.forEach((c) => {
        if (ownCities.includes(c)) return;
        (CITY_TO_SELLERS[c] || []).forEach((s) => {
          if (s === sellerName) return;
          foreignBySeller[s] = foreignBySeller[s] || [];
          foreignBySeller[s].push(c);
        });
      });

      const otherSellers = Object.keys(foreignBySeller);
      if (otherSellers.length > 0) {
        const block = document.createElement("div");
        block.className = "seller-conflict-block";
        block.innerHTML =
          `<div class="scb-title">⚠️ Também atendida(s) por outro(s) vendedor(es):</div>` +
          otherSellers
            .map(
              (seller) => `
              <div class="scb-seller-line">
                <strong>${seller}:</strong>
                ${foreignBySeller[seller]
                  .map((c) =>
                    Auth.isAdmin
                      ? `<button class="scb-city-link" data-city="${c}">${c}</button>`
                      : `<span>${c}</span>`
                  )
                  .join(", ")}
              </div>`
            )
            .join("");
        citiesBox.appendChild(block);

        block.querySelectorAll(".scb-city-link").forEach((btn) => {
          btn.addEventListener("click", () => {
            openEditCitySellersModal(btn.dataset.city, cityMarkers[btn.dataset.city] || null);
          });
        });
      }
    });

    if (unassignedCount > 0) {
      const warn = document.createElement("p");
      warn.className = "hint hint-small";
      warn.innerHTML = `<span class="c-warn">${unassignedCount} cidade(s) desse vendedor ainda sem região definida.</span>`;
      citiesBox.appendChild(warn);
    }
  }

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

  const sortedRegions = Regions.list.slice().sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  sortedRegions.forEach((region) => {
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
        activeSellerFilter = null;
        document.getElementById("sellerSelect").value = "";
        document.getElementById("sellerCities").innerHTML = "";
        focusedRegionId = region.id;
        showNeighborRegions = false;
        rebuildClusters();

        focusRegion(region);
        showRegionFence(region);
        showKeyCityLinks(region);
        if (isPresenting()) {
          showPresentationBurst(region);
        } else {
          openRegionDetail(region);
        }
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

  const pendingRegions = Regions.list.filter((region) => {
    const key = regionCitiesKey(region);
    return !(regionRadiusCache[region.id] && regionRadiusCache[region.id].citiesKey === key);
  });
  if (pendingRegions.length === 0) return;

  // Junta as cidades de todas as regiões pendentes num único lote — bem mais
  // rápido que calcular uma cidade por vez.
  const allCityLabels = Array.from(new Set(pendingRegions.flatMap((r) => r.cities)));
  const destinations = allCityLabels
    .map((c) => ({ label: c, ...Geocode.get(c) }))
    .filter((d) => d.lat !== null && d.lat !== undefined);

  await Routing.getRouteMatrix(originLatLng, destinations);

  pendingRegions.forEach((region) => {
    const key = regionCitiesKey(region);
    let maxKm = null;
    region.cities.forEach((cityLabel) => {
      const dest = Geocode.get(cityLabel);
      if (!dest || dest.lat === null) return;
      const cacheKey = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
      const route = Routing.cache[cacheKey];
      if (route && (maxKm === null || route.km > maxKm)) maxKm = route.km;
    });
    regionRadiusCache[region.id] = { citiesKey: key, bracket: maxKm === null ? null : bracketFor(maxKm) };
    updateRegionRowRadius(region.id);
  });
}

function updateRegionRowRadius(regionId) {
  const row = document.querySelector(`.region-row[data-region-id="${regionId}"] .region-radius`);
  const region = Regions.list.find((r) => r.id === regionId);
  if (row && region) row.textContent = radiusLabel(region);
}

// ------------------------------------------------------------
// Reconferência em massa (não mexe nas cidades já corrigidas à mão)
// ------------------------------------------------------------
// ------------------------------------------------------------
// Padronizar nomes de cidade (CAIXA ALTA) em tudo que já existe
// ------------------------------------------------------------
// ------------------------------------------------------------
// Excluir uma cidade (ex: pra resolver um ponto duplicado)
// ------------------------------------------------------------
function deleteCity(cityLabel) {
  if (!Auth.isAdmin) return;
  if (
    !confirm(
      `Excluir "${cityLabel}" da base? Ela sai de todas as regiões e vendedores. Não dá pra desfazer (a não ser reimportando os dados antigos).`
    )
  ) {
    return;
  }

  CITIES_LIST = CITIES_LIST.filter((c) => c !== cityLabel);
  delete CITY_TO_SELLERS[cityLabel];
  rebuildSellersFromCityToSellers();
  Regions.list.forEach((r) => {
    r.cities = r.cities.filter((c) => c !== cityLabel);
  });
  Regions._saveDraft();
  delete Geocode.cache[cityLabel];
  Geocode.saveLocalCache();
  saveCityDirectoryDraft();

  const marker = cityMarkers[cityLabel];
  if (marker) {
    marker.closePopup();
    delete cityMarkers[cityLabel];
  }

  rebuildClusters();
  invalidateRegionRadiusCache();
  renderSellerOptions();
  renderSearchCityOptions();
  if (activeSellerFilter) applySellerFilter(activeSellerFilter);
}

// ------------------------------------------------------------
// Varredura de pontos duplicados (mesmo nome de cidade repetido)
// ------------------------------------------------------------
function findDuplicateCityGroups() {
  const groups = {};
  CITIES_LIST.forEach((c) => {
    const key = normalizeStr(c.trim().replace(/\s+/g, " "));
    groups[key] = groups[key] || [];
    groups[key].push(c);
  });
  return Object.values(groups).filter((g) => g.length > 1);
}

function openDedupeModal() {
  if (!Auth.isAdmin) return;
  renderDedupeList();
  document.getElementById("dedupeModal").classList.remove("hidden");
}

function closeDedupeModal() {
  document.getElementById("dedupeModal").classList.add("hidden");
}

function renderDedupeList() {
  const box = document.getElementById("dedupeList");
  const groups = findDuplicateCityGroups();

  if (groups.length === 0) {
    box.innerHTML = `<p class="conflict-none">Nenhum ponto duplicado encontrado — cada cidade aparece uma vez só.</p>`;
    return;
  }

  box.innerHTML = "";
  groups.forEach((group) => {
    const card = document.createElement("div");
    card.className = "conflict-region-card";
    card.innerHTML =
      `<h4>${group.length} pontos parecidos</h4>` +
      group
        .map((variant) => {
          const sellers = (CITY_TO_SELLERS[variant] || []).join(", ") || "—";
          const regionsIn = Regions.findByCity(variant)
            .map((r) => r.name)
            .join(", ") || "sem região";
          return `<div class="dedupe-variant">
            <div class="dv-name">${variant}</div>
            <div class="dv-meta">Vendedor(es): ${sellers} · Região: ${regionsIn}</div>
            <button class="dv-keep-btn" data-keep="${variant}" data-group='${JSON.stringify(group)}'>Manter este e mesclar os outros aqui</button>
          </div>`;
        })
        .join("");
    box.appendChild(card);
  });

  box.querySelectorAll(".dv-keep-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const keep = btn.dataset.keep;
      const group = JSON.parse(btn.dataset.group);
      if (!confirm(`Manter "${keep}" e mesclar os outros ${group.length - 1} ponto(s) nele?`)) return;
      mergeDuplicateCities(keep, group);
      renderDedupeList();
    });
  });
}

function mergeDuplicateCities(keepLabel, group) {
  const others = group.filter((c) => c !== keepLabel);

  others.forEach((other) => {
    const sellersOfOther = CITY_TO_SELLERS[other] || [];
    CITY_TO_SELLERS[keepLabel] = Array.from(
      new Set([...(CITY_TO_SELLERS[keepLabel] || []), ...sellersOfOther])
    );
    delete CITY_TO_SELLERS[other];

    Regions.list.forEach((r) => {
      if (r.cities.includes(other)) {
        r.cities = r.cities.filter((c) => c !== other);
        if (!r.cities.includes(keepLabel)) r.cities.push(keepLabel);
      }
    });

    CITIES_LIST = CITIES_LIST.filter((c) => c !== other);
    delete Geocode.cache[other];
    const m = cityMarkers[other];
    if (m) {
      m.closePopup();
      delete cityMarkers[other];
    }
  });

  rebuildSellersFromCityToSellers();

  Regions._saveDraft();
  Geocode.saveLocalCache();
  saveCityDirectoryDraft();

  rebuildClusters();
  invalidateRegionRadiusCache();
  renderSellerOptions();
  renderSearchCityOptions();
  if (activeSellerFilter) applySellerFilter(activeSellerFilter);
}

function standardizeAllCityNames() {
  if (!Auth.isAdmin) return;

  const renameMap = {};
  let changedCount = 0;
  CITIES_LIST.forEach((c) => {
    const normalized = normalizeCityLabel(c);
    renameMap[c] = normalized;
    if (normalized !== c) changedCount++;
  });

  if (changedCount === 0) {
    // Mesmo sem nome pra padronizar, aproveita pra corrigir qualquer dessincronia
    // entre o "livro do vendedor" e o "livro da cidade" (ex: de edições antigas).
    rebuildSellersFromCityToSellers();
    saveCityDirectoryDraft();
    renderSellerOptions();
    if (activeSellerFilter) applySellerFilter(activeSellerFilter);
    alert(
      "Todos os nomes já estavam em caixa alta. Aproveitei pra conferir e sincronizar o vínculo vendedor ↔ cidade também, por garantia."
    );
    return;
  }

  if (
    !confirm(
      `Isso vai padronizar ${changedCount} nome(s) de cidade para CAIXA ALTA em toda a base — regiões, vendedores e coordenadas já localizadas ficam preservadas. Continuar?`
    )
  ) {
    return;
  }

  // Cidades
  CITIES_LIST = Array.from(new Set(CITIES_LIST.map((c) => renameMap[c] || normalizeCityLabel(c))));

  // Cidade -> vendedores é a fonte de verdade (junta se duas grafias caírem no
  // mesmo nome padronizado); vendedor -> cidades é sempre recalculado a partir dela
  const newCityToSellers = {};
  Object.entries(CITY_TO_SELLERS).forEach(([city, sellers]) => {
    const newCity = renameMap[city] || normalizeCityLabel(city);
    newCityToSellers[newCity] = Array.from(new Set([...(newCityToSellers[newCity] || []), ...sellers]));
  });
  CITY_TO_SELLERS = newCityToSellers;
  rebuildSellersFromCityToSellers();

  // Regiões
  Regions.list.forEach((region) => {
    region.cities = Array.from(
      new Set(region.cities.map((c) => renameMap[c] || normalizeCityLabel(c)))
    );
  });
  Regions._saveDraft();

  // Cache de geocodificação (preserva as coordenadas já buscadas)
  const newGeoCache = {};
  Object.entries(Geocode.cache).forEach(([city, data]) => {
    if (city === "__ORIGIN__") {
      newGeoCache[city] = data;
      return;
    }
    const newCity = renameMap[city] || normalizeCityLabel(city);
    newGeoCache[newCity] = data;
  });
  Geocode.cache = newGeoCache;
  Geocode.saveLocalCache();

  saveCityDirectoryDraft();

  // Reconstrói os marcadores do zero (evita referências antigas presas em closures)
  cityMarkers = {};
  CITIES_LIST.forEach((c) => plotCity(c));
  rebuildClusters();
  invalidateRegionRadiusCache();
  renderSellerOptions();
  renderSearchCityOptions();
  renderRegionsList();
  if (activeSellerFilter) applySellerFilter(activeSellerFilter);

  alert(
    "Nomes padronizados! Agora exporte e suba pro GitHub: regions.json, cities.json, e o diretório (vendedores/cidades) — os cinco arquivos mudaram."
  );
}

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
// "Cerca eletrônica" da região — contorno ao redor de todas as
// cidades da região (casca convexa via Turf.js), no mesmo estilo
// azul tracejado da ferramenta de desenhar polígono.
// ------------------------------------------------------------
function hideRegionFence() {
  if (regionFenceLayer) {
    map.removeLayer(regionFenceLayer);
    regionFenceLayer = null;
  }
}

// Desenha a cerca eletrônica da região unindo o contorno administrativo REAL de
// cada cidade (limite do município), não apenas uma linha ligando os pontos.
// Isso exige buscar o contorno de cada cidade (rede, com limite de uso), então
// mostra uma barra de progresso enquanto calcula.
async function showRegionFence(region) {
  hideRegionFence();

  const progressEl = document.getElementById("geocodeProgress");
  const fillEl = document.getElementById("progressFill");
  const textEl = document.getElementById("progressText");
  progressEl.classList.remove("hidden");
  fillEl.style.width = "0%";

  let combined = null;
  const total = region.cities.length;
  let done = 0;

  for (const cityLabel of region.cities) {
    textEl.textContent = `Desenhando contorno da região… ${done}/${total}`;
    const boundary = await Geocode.getCityBoundary(cityLabel);
    done++;
    fillEl.style.width = `${(done / total) * 100}%`;

    if (boundary) {
      try {
        const feature = turf.feature(boundary);
        combined = combined ? turf.union(combined, feature) : feature;
      } catch (e) {
        // contorno inválido para essa cidade — segue com as demais
      }
    }
    await new Promise((r) => setTimeout(r, 150)); // uso respeitoso do Nominatim
  }

  progressEl.classList.add("hidden");

  if (combined) {
    regionFenceLayer = L.geoJSON(combined, {
      style: { color: "#2980b9", weight: 3, dashArray: "8 6", fillColor: "#2980b9", fillOpacity: 0.08 },
    }).addTo(map);
  } else {
    showRegionFenceHullFallback(region);
  }
}

// Reserva: se nenhuma cidade da região tiver contorno administrativo disponível,
// desenha ao menos uma casca convexa ao redor dos pontos (melhor que nada).
function showRegionFenceHullFallback(region) {
  const coords = region.cities
    .map((c) => Geocode.get(c))
    .filter((c) => c && c.lat !== null)
    .map((c) => [c.lng, c.lat]);

  if (coords.length < 3) return;

  const points = turf.featureCollection(coords.map((c) => turf.point(c)));
  const hull = turf.convex(points);
  if (!hull) return;

  regionFenceLayer = L.geoJSON(hull, {
    style: { color: "#2980b9", weight: 3, dashArray: "8 6", fillColor: "#2980b9", fillOpacity: 0.08 },
  }).addTo(map);
}

// ------------------------------------------------------------
// Raio da região (faixas de 50 em 50 km a partir da origem)
// ------------------------------------------------------------
function bracketFor(km) {
  return Math.ceil(km / 50) * 50;
}

function openRegionDetail(region) {
  currentDetailRegionId = region.id;

  // Isola essa região no mapa (esconde as demais regiões). O filtro de vendedor,
  // se estiver ativo, é mantido — cidades de outros vendedores dentro da região
  // aparecem desfocadas em vez de escondidas (ver rebuildClusters).
  focusedRegionId = region.id;
  showNeighborRegions = false;
  document.getElementById("toggleNeighborRegions").checked = false;
  rebuildClusters();

  document.getElementById("regionDetailTitle").textContent = region.name;
  document.getElementById("regionDetailSummary").textContent = "Calculando distâncias a partir de Terra Boa…";
  document.getElementById("regionDetailList").innerHTML = "";
  document.getElementById("regionDetailModal").classList.remove("hidden", "collapsed");
  document.getElementById("btnMinimizeRegionDetail").textContent = "—";
  document.getElementById("btnToggleFence").textContent = "Esconder cerca da região";
  computeRegionRadius(region);
}

function closeRegionDetail() {
  focusedRegionId = null;
  showNeighborRegions = false;
  rebuildClusters();
  document.getElementById("regionDetailModal").classList.add("hidden");
  document.getElementById("regionDetailModal").classList.remove("collapsed");
  currentDetailRegionId = null;
  hideRegionFence();
  hideKeyCityLinks();
  if (ringLayerGroup) {
    map.removeLayer(ringLayerGroup);
    ringLayerGroup = null;
  }
  document.getElementById("btnToggleRings").textContent = "Mostrar anéis de 50 km no mapa";
}

// Minimiza o painel para uma barrinha pequena, deixando o mapa (com a cerca e os
// anéis) totalmente visível, sem perder o que já foi calculado.
function toggleMinimizeRegionDetail() {
  const panel = document.getElementById("regionDetailModal");
  const btn = document.getElementById("btnMinimizeRegionDetail");
  const collapsed = panel.classList.toggle("collapsed");
  btn.textContent = collapsed ? "▢" : "—";
  btn.title = collapsed ? "Expandir" : "Minimizar (deixa o mapa livre)";
}

function toggleFence() {
  const btn = document.getElementById("btnToggleFence");
  if (regionFenceLayer) {
    hideRegionFence();
    btn.textContent = "Mostrar cerca da região";
  } else {
    const region = Regions.list.find((r) => r.id === currentDetailRegionId);
    if (region) showRegionFence(region);
    btn.textContent = "Esconder cerca da região";
  }
}

async function computeRegionRadius(region) {
  const summaryEl = document.getElementById("regionDetailSummary");

  if (!originLatLng || originLatLng.lat === null) {
    summaryEl.textContent = "Não foi possível calcular: coordenadas da origem indisponíveis.";
    return;
  }

  const destinations = region.cities
    .map((c) => ({ label: c, ...Geocode.get(c) }))
    .filter((d) => d.lat !== null && d.lat !== undefined);

  await Routing.getRouteMatrix(originLatLng, destinations, (done, total) => {
    summaryEl.textContent = `Calculando distâncias a partir de Terra Boa… ${done}/${total}`;
  });

  const results = region.cities.map((cityLabel) => {
    const dest = Geocode.get(cityLabel);
    if (!dest || dest.lat === null) return { cityLabel, km: null };
    const key = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
    const route = Routing.cache[key];
    return { cityLabel, km: route ? route.km : null };
  });
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

  // O bloco de "somar a região existente" só faz sentido ao criar uma região nova
  // a partir de um polígono desenhado — não ao editar uma região já existente.
  const mergeBlock = document.getElementById("regionMergeBlock");
  const mergeSelect = document.getElementById("regionMergeTarget");
  if (!editingRegionId) {
    mergeBlock.classList.remove("hidden");
    mergeSelect.innerHTML = `<option value="">— Criar uma região nova —</option>`;
    Regions.list
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = r.name;
        mergeSelect.appendChild(opt);
      });
    mergeSelect.value = "";
    updateRegionModalMergeState();
  } else {
    mergeBlock.classList.add("hidden");
  }

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

function updateRegionModalMergeState() {
  const mergeId = document.getElementById("regionMergeTarget").value;
  const nameInput = document.getElementById("regionName");
  const profileSelect = document.getElementById("regionVehicleProfile");
  const colorInput = document.getElementById("regionColorPicker");

  if (mergeId) {
    const target = Regions.list.find((r) => r.id === mergeId);
    if (target) {
      nameInput.value = target.name;
      profileSelect.value = target.vehicleProfile;
      colorInput.value = target.color;
    }
    nameInput.disabled = true;
    profileSelect.disabled = true;
    colorInput.disabled = true;
  } else {
    nameInput.disabled = false;
    profileSelect.disabled = false;
    colorInput.disabled = false;
  }
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

// Remove a cidade de qualquer região que não seja excludeRegionId — usada pra
// evitar que uma cidade fique duplicada em duas regiões sem querer, sempre que
// ela for adicionada em outro lugar. Passe null se a região de destino ainda nem
// existe (caso de criar região nova).
function removeCityFromOtherRegions(cityLabel, excludeRegionId) {
  Regions.list.forEach((r) => {
    if (r.id !== excludeRegionId && r.cities.includes(cityLabel)) {
      Regions.update(r.id, { cities: r.cities.filter((c) => c !== cityLabel) });
    }
  });
}

function saveRegionFromModal() {
  if (!Auth.isAdmin) return;
  const name = document.getElementById("regionName").value.trim();
  const vehicleProfile = document.getElementById("regionVehicleProfile").value;
  const color = document.getElementById("regionColorPicker").value;
  const mergeId = editingRegionId ? "" : document.getElementById("regionMergeTarget").value;
  const checked = Array.from(
    document.querySelectorAll("#regionCitiesChecklist input:checked")
  ).map((el) => el.value);

  if (!mergeId && !name) {
    alert("Dê um nome para a região.");
    return;
  }
  if (checked.length === 0) {
    alert("Selecione ao menos uma cidade.");
    return;
  }

  if (mergeId) {
    // Soma as cidades capturadas à região já existente. As que forem novas ali
    // (não estavam nessa região antes) saem de qualquer outra região onde já
    // estivessem — evita duplicar sem querer. Pra manter uma cidade em mais de uma
    // região de propósito, use "Cidade-chave" depois.
    const target = Regions.list.find((r) => r.id === mergeId);
    if (target) {
      const newCities = checked.filter((c) => !target.cities.includes(c));
      newCities.forEach((c) => removeCityFromOtherRegions(c, mergeId));
      const merged = Array.from(new Set([...target.cities, ...checked]));
      Regions.update(mergeId, { cities: merged });
    }
  } else if (editingRegionId) {
    const original = Regions.list.find((r) => r.id === editingRegionId);
    const originalCities = original ? original.cities : [];
    const newCities = checked.filter((c) => !originalCities.includes(c));
    newCities.forEach((c) => removeCityFromOtherRegions(c, editingRegionId));
    Regions.update(editingRegionId, { name, vehicleProfile, cities: checked, color });
  } else {
    // Região nova: qualquer cidade capturada que já pertencia a outra região sai
    // de lá automaticamente, pra não ficar duplicada sem querer.
    checked.forEach((c) => removeCityFromOtherRegions(c, null));
    Regions.create({ name, vehicleProfile, cities: checked, color });
  }

  rebuildClusters();
  invalidateRegionRadiusCache();
  renderRegionsList();
  closeRegionModal();
}

function deleteRegionFromModal() {
  if (!Auth.isAdmin) return;
  if (!editingRegionId) return;
  if (!confirm("Excluir esta região? As cidades voltam para 'sem região'.")) return;
  Regions.remove(editingRegionId);
  removeRegionFromGrade(editingRegionId);
  rebuildClusters();
  renderRegionsList();
  closeRegionModal();
}

// Tira da Grade qualquer rota que aponte pra uma região que acabou de ser
// excluída — evita "rotas fantasma" que ficam contando peso/veículos sem
// aparecer na tabela.
function removeRegionFromGrade(regionId) {
  let changed = false;
  GRADE_DAYS.forEach((day) => {
    const before = Grade.days[day].length;
    Grade.days[day] = Grade.days[day].filter((r) => r.regionId !== regionId);
    if (Grade.days[day].length !== before) changed = true;
  });
  if (changed) {
    Grade._saveDraft();
    updateDraftHint();
  }
}

// Limpeza automática rodada uma vez ao abrir o app: remove qualquer rota que
// já esteja "fantasma" (região excluída antes dessa correção existir, ou
// vagas antigas do sistema anterior sem região nenhuma).
function cleanupGhostGradeRoutes() {
  let changed = false;
  GRADE_DAYS.forEach((day) => {
    const before = Grade.days[day].length;
    Grade.days[day] = Grade.days[day].filter((r) => r.regionId && Regions.list.some((reg) => reg.id === r.regionId));
    if (Grade.days[day].length !== before) changed = true;
  });
  if (changed) Grade._saveDraft();
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


// ------------------------------------------------------------
// Adicionar nova cidade (admin)
// ------------------------------------------------------------
function openNewCityModal() {
  if (!Auth.isAdmin) return;

  document.getElementById("newCityName").value = "";
  document.getElementById("newCityError").textContent = "";

  const ufSelect = document.getElementById("newCityUF");
  ufSelect.innerHTML = "";
  ["PR", "SP"]
    .concat(Object.keys(BR_UF_TO_NAME).filter((uf) => uf !== "PR" && uf !== "SP").sort())
    .forEach((uf) => {
      const opt = document.createElement("option");
      opt.value = uf;
      opt.textContent = `${uf} — ${BR_UF_TO_NAME[uf]}`;
      ufSelect.appendChild(opt);
    });

  const sellersBox = document.getElementById("newCitySellersChecklist");
  sellersBox.innerHTML = "";
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${name}" /> ${name}`;
      sellersBox.appendChild(label);
    });

  const regionSelect = document.getElementById("newCityRegion");
  regionSelect.innerHTML = `<option value="">— Não incluir em nenhuma região agora —</option>`;
  Regions.list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      regionSelect.appendChild(opt);
    });

  document.getElementById("newCityModal").classList.remove("hidden");
}

function closeNewCityModal() {
  document.getElementById("newCityModal").classList.add("hidden");
}

async function saveNewCity() {
  if (!Auth.isAdmin) return;

  const nameRaw = document.getElementById("newCityName").value.trim();
  const uf = document.getElementById("newCityUF").value;
  const regionId = document.getElementById("newCityRegion").value;
  const sellersChosen = Array.from(
    document.querySelectorAll("#newCitySellersChecklist input:checked")
  ).map((el) => el.value);
  const errorEl = document.getElementById("newCityError");

  if (!nameRaw) {
    errorEl.textContent = "Digite o nome da cidade.";
    return;
  }
  if (sellersChosen.length === 0) {
    errorEl.textContent = "Selecione ao menos um vendedor responsável.";
    return;
  }

  const cityLabel = normalizeCityLabel(`${nameRaw} - ${uf}`);
  if (CITIES_LIST.includes(cityLabel)) {
    errorEl.textContent = `"${cityLabel}" já existe na base — abrindo ela no mapa…`;
    closeNewCityModal();
    const existingMarker = cityMarkers[cityLabel];
    const existingCoord = Geocode.get(cityLabel);
    if (existingCoord && existingCoord.lat !== null) {
      map.setView([existingCoord.lat, existingCoord.lng], 13);
    }
    if (existingMarker) {
      setTimeout(() => openCityPopup(cityLabel, existingMarker), 300);
    }
    return;
  }

  errorEl.textContent = "";
  document.getElementById("btnNewCitySave").disabled = true;
  errorEl.textContent = "Localizando a cidade no mapa…";

  // Registra no diretório (cidades + vendedores) — CITY_TO_SELLERS é a fonte de
  // verdade, SELLERS é sempre recalculado a partir dela
  CITIES_LIST.push(cityLabel);
  CITY_TO_SELLERS[cityLabel] = sellersChosen.slice();
  rebuildSellersFromCityToSellers();
  saveCityDirectoryDraft();

  // Geocodifica a cidade nova (busca restrita ao estado escolhido)
  await Geocode.geocodeAll([cityLabel]);
  plotCity(cityLabel);

  // Se uma região foi escolhida, já inclui a cidade nela
  if (regionId) {
    const region = Regions.list.find((r) => r.id === regionId);
    if (region && !region.cities.includes(cityLabel)) {
      Regions.update(regionId, { cities: [...region.cities, cityLabel] });
    }
  }

  rebuildClusters();
  renderSellerOptions();
  renderSearchCityOptions();
  invalidateRegionRadiusCache();

  // Se a região escolhida é a que está aberta no painel, atualiza cerca e detalhes na hora
  if (regionId && regionId === currentDetailRegionId) {
    const region = Regions.list.find((r) => r.id === regionId);
    if (region) {
      showRegionFence(region);
      openRegionDetail(region);
    }
  }

  document.getElementById("btnNewCitySave").disabled = false;
  closeNewCityModal();

  const coord = Geocode.get(cityLabel);
  if (coord && coord.lat !== null) {
    map.setView([coord.lat, coord.lng], 11);
  }
  if (isSuspect(coord)) {
    alert(`"${cityLabel}" foi adicionada, mas ficou com aviso de localização suspeita — confira o pin no mapa.`);
  }
}

function exportDirectory() {
  downloadFile("sellers.json", JSON.stringify(SELLERS, null, 2));
  setTimeout(() => downloadFile("cities_list.json", JSON.stringify(CITIES_LIST, null, 2)), 300);
  setTimeout(() => downloadFile("city_to_sellers.json", JSON.stringify(CITY_TO_SELLERS, null, 2)), 600);
}

// ------------------------------------------------------------
// Conflitos de vendedor (regiões com cidades de mais de um vendedor)
// ------------------------------------------------------------
function detectConflicts() {
  const conflicts = [];
  Regions.list.forEach((region) => {
    const sellerMap = {}; // vendedor -> [cidades daquele vendedor nessa região]
    region.cities.forEach((city) => {
      (CITY_TO_SELLERS[city] || []).forEach((seller) => {
        sellerMap[seller] = sellerMap[seller] || [];
        sellerMap[seller].push(city);
      });
    });
    const sellerNames = Object.keys(sellerMap);
    if (sellerNames.length > 1) {
      conflicts.push({ region, sellerMap });
    }
  });
  return conflicts;
}

// Sugere a melhor região existente pra uma cidade, com base em qual região aquele
// vendedor já domina (mais cidades dele) — sem fazer chamada de rede, é só análise
// dos dados já carregados.
function suggestRegionForCity(cityLabel, sellerName, excludeRegionId) {
  let best = null;
  let bestScore = 0;
  Regions.list.forEach((region) => {
    if (region.id === excludeRegionId) return;
    const count = region.cities.filter((c) => (CITY_TO_SELLERS[c] || []).includes(sellerName)).length;
    if (count > bestScore) {
      bestScore = count;
      best = region;
    }
  });
  return best ? { region: best, matchCount: bestScore } : null;
}

function moveCityToRegion(cityLabel, targetRegionId) {
  Regions.list.forEach((r) => {
    if (r.id !== targetRegionId && r.cities.includes(cityLabel)) {
      Regions.update(r.id, { cities: r.cities.filter((c) => c !== cityLabel) });
    }
  });
  const target = Regions.list.find((r) => r.id === targetRegionId);
  if (target && !target.cities.includes(cityLabel)) {
    Regions.update(targetRegionId, { cities: [...target.cities, cityLabel] });
  }
  rebuildClusters();
  invalidateRegionRadiusCache();
  renderRegionsList();
}

function openConflictsPanel() {
  if (!Auth.isAdmin) return;
  document.getElementById("conflictCommandInput").value = "";
  document.getElementById("conflictCommandPreview").classList.add("hidden");
  renderConflictList();
  document.getElementById("conflictModal").classList.remove("hidden");
}

function closeConflictsPanel() {
  document.getElementById("conflictModal").classList.add("hidden");
}

function renderConflictList() {
  const box = document.getElementById("conflictList");
  const conflicts = detectConflicts();

  if (conflicts.length === 0) {
    box.innerHTML = `<p class="conflict-none">Nenhum conflito encontrado — todas as regiões têm cidades de um só vendedor.</p>`;
    return;
  }

  box.innerHTML = "";
  conflicts.forEach(({ region, sellerMap }) => {
    const sellersSorted = Object.entries(sellerMap).sort((a, b) => b[1].length - a[1].length);
    const majoritySeller = sellersSorted[0][0];

    const card = document.createElement("div");
    card.className = "conflict-region-card";

    let html = `<h4>${region.name}</h4>`;
    sellersSorted.forEach(([seller, cities]) => {
      const isMajority = seller === majoritySeller;
      html += `<div class="conflict-seller-group">
        <span class="cg-name">${seller}${isMajority ? " (predominante)" : ""}:</span>
        <span class="cg-cities">${cities.join(", ")}</span>
      </div>`;

      if (!isMajority) {
        cities.forEach((city) => {
          const suggestion = suggestRegionForCity(city, seller, region.id);
          if (suggestion) {
            html += `<div class="conflict-suggestion">
              <div class="cs-text">Sugestão: mover <strong>${city}</strong> pra <strong>${suggestion.region.name}</strong>
              (onde ${seller} já atende ${suggestion.matchCount} outra(s) cidade(s)).</div>
              <button data-city="${city}" data-target="${suggestion.region.id}" class="btn-apply-suggestion">Aplicar sugestão</button>
            </div>`;
          } else {
            html += `<div class="conflict-suggestion">
              <div class="cs-text">Nenhuma outra região atende ${seller} ainda — mova manualmente editando a região, ou crie uma região nova pra ele.</div>
            </div>`;
          }
        });
      }
    });

    card.innerHTML = html;
    box.appendChild(card);
  });

  box.querySelectorAll(".btn-apply-suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      const city = btn.dataset.city;
      const targetId = btn.dataset.target;
      const targetRegion = Regions.list.find((r) => r.id === targetId);
      if (!confirm(`Mover "${city}" para a região "${targetRegion?.name}"?`)) return;
      moveCityToRegion(city, targetId);
      renderConflictList();
    });
  });
}

function runConflictCommand() {
  if (!Auth.isAdmin) return;
  const input = document.getElementById("conflictCommandInput");
  const previewBox = document.getElementById("conflictCommandPreview");
  const text = input.value.trim();

  const m = text.match(/^mover\s+(.+?)\s+para\s+(?:a\s+)?(?:regi[aã]o\s+)?(.+)$/i);
  if (!m) {
    previewBox.classList.remove("hidden");
    previewBox.innerHTML = `Não entendi esse comando. Use o formato: <strong>mover [cidade] para [região]</strong> — ou aplique uma das sugestões acima, ou edite a região manualmente pela lista de regiões.`;
    return;
  }

  const cityQuery = normalizeStr(m[1].trim());
  const regionQuery = normalizeStr(m[2].trim());

  const city = CITIES_LIST.find((c) => normalizeStr(c).includes(cityQuery) || cityQuery.includes(normalizeStr(c.split(" - ")[0])));
  const region = Regions.list.find((r) => normalizeStr(r.name).includes(regionQuery) || regionQuery.includes(normalizeStr(r.name)));

  if (!city || !region) {
    previewBox.classList.remove("hidden");
    previewBox.innerHTML = `Não encontrei ${!city ? "essa cidade" : "essa região"} na base. Confira a grafia e tente de novo.`;
    return;
  }

  previewBox.classList.remove("hidden");
  previewBox.innerHTML = `
    <div>Vou mover <strong>${city}</strong> para a região <strong>${region.name}</strong>.</div>
    <div class="cp-actions">
      <button id="btnConfirmCommand">Confirmar</button>
      <button id="btnCancelCommand">Cancelar</button>
    </div>
  `;

  document.getElementById("btnConfirmCommand").addEventListener("click", () => {
    moveCityToRegion(city, region.id);
    input.value = "";
    previewBox.classList.add("hidden");
    renderConflictList();
  });
  document.getElementById("btnCancelCommand").addEventListener("click", () => {
    previewBox.classList.add("hidden");
  });
}

// ------------------------------------------------------------
// Gerar PDF do roteiro (por vendedor, por região, ou tudo)
// ------------------------------------------------------------
function openPdfModal() {
  if (!Auth.isAdmin) return;

  const vendorSelect = document.getElementById("pdfVendorSelect");
  vendorSelect.innerHTML = "";
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      vendorSelect.appendChild(opt);
    });

  const regionSelect = document.getElementById("pdfRegionSelect");
  regionSelect.innerHTML = "";
  Regions.list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      regionSelect.appendChild(opt);
    });

  document.getElementById("pdfStatus").textContent = "";
  document.getElementById("pdfModal").classList.remove("hidden");
}

function closePdfModal() {
  document.getElementById("pdfModal").classList.add("hidden");
}

async function generatePdf() {
  if (!Auth.isAdmin) return;

  const scope = document.querySelector('input[name="pdfScope"]:checked').value;
  const incKm = document.getElementById("pdfIncKm").checked;
  const incRound = document.getElementById("pdfIncRoundtrip").checked;
  const incSeller = document.getElementById("pdfIncSeller").checked;
  const incProfile = document.getElementById("pdfIncProfile").checked;
  const statusEl = document.getElementById("pdfStatus");

  let regionsToInclude = [];
  let scopeLabel = "";
  let sellerFilterName = null;

  if (scope === "vendedor") {
    sellerFilterName = document.getElementById("pdfVendorSelect").value;
    if (!sellerFilterName) {
      alert("Selecione um vendedor.");
      return;
    }
    scopeLabel = sellerFilterName;
    regionsToInclude = Regions.list.filter((r) =>
      r.cities.some((c) => (CITY_TO_SELLERS[c] || []).includes(sellerFilterName))
    );
  } else if (scope === "regiao") {
    const rid = document.getElementById("pdfRegionSelect").value;
    const region = Regions.list.find((r) => r.id === rid);
    if (!region) {
      alert("Selecione uma região.");
      return;
    }
    regionsToInclude = [region];
    scopeLabel = region.name;
  } else {
    regionsToInclude = Regions.list.slice();
    scopeLabel = "Todas as regiões";
  }

  if (regionsToInclude.length === 0) {
    alert("Não encontrei nada pra incluir nesse PDF (talvez esse vendedor ainda não tenha cidades numa região).");
    return;
  }

  if (!originLatLng || originLatLng.lat === null) {
    alert("Não foi possível calcular distâncias: coordenadas da origem indisponíveis.");
    return;
  }

  // Sempre calcula as distâncias (mesmo que as colunas de km não apareçam no PDF),
  // porque são necessárias pra ordenar as regiões da mais longe para a mais perto.
  let allCities = [];
  regionsToInclude.forEach((r) => {
    r.cities.forEach((c) => {
      if (sellerFilterName && !(CITY_TO_SELLERS[c] || []).includes(sellerFilterName)) return;
      allCities.push(c);
    });
  });
  allCities = Array.from(new Set(allCities));

  const destinations = allCities
    .map((c) => ({ label: c, ...Geocode.get(c) }))
    .filter((d) => d.lat !== null && d.lat !== undefined);

  await Routing.getRouteMatrix(originLatLng, destinations, (done, total) => {
    statusEl.textContent = `Calculando distâncias… ${done}/${total}`;
  });

  // Km máximo de cada região no escopo — usado pra ordenar e pra mostrar o raio
  const regionMaxKm = {};
  regionsToInclude.forEach((region) => {
    let maxKm = null;
    region.cities.forEach((city) => {
      if (sellerFilterName && !(CITY_TO_SELLERS[city] || []).includes(sellerFilterName)) return;
      const dest = Geocode.get(city);
      if (!dest || dest.lat === null) return;
      const key = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
      const route = Routing.cache[key];
      if (route && (maxKm === null || route.km > maxKm)) maxKm = route.km;
    });
    regionMaxKm[region.id] = maxKm;
  });

  regionsToInclude = regionsToInclude
    .slice()
    .sort((a, b) => (regionMaxKm[b.id] ?? -1) - (regionMaxKm[a.id] ?? -1));

  statusEl.textContent = "Montando o PDF…";
  await buildPdfDocument({ regionsToInclude, scopeLabel, sellerFilterName, incKm, incRound, incSeller, incProfile, regionMaxKm });
  statusEl.textContent = "";
  closePdfModal();
}

// ------------------------------------------------------------
// Excel no formato "Filial" — uma linha por cidade, com a região e o raio
// que ela pertence, pronto pra importar em outro sistema.
// ------------------------------------------------------------
async function exportFilialExcel() {
  if (!Auth.isAdmin) return;
  if (typeof XLSX === "undefined") {
    alert("A biblioteca de Excel ainda não carregou — aguarde alguns segundos e tente de novo.");
    return;
  }
  if (!originLatLng || originLatLng.lat === null) {
    alert("Não foi possível calcular distâncias: coordenadas da origem indisponíveis.");
    return;
  }
  if (Regions.list.length === 0) {
    alert("Nenhuma região cadastrada ainda.");
    return;
  }

  const btn = document.getElementById("btnExportFilialExcel");
  const originalText = btn.textContent;
  btn.disabled = true;

  // Junta todas as cidades de todas as regiões (sem duplicar) e calcula a
  // distância de todas de uma vez (rápido, em lote).
  let allCities = [];
  Regions.list.forEach((r) => r.cities.forEach((c) => allCities.push(c)));
  allCities = Array.from(new Set(allCities));

  const destinations = allCities
    .map((c) => ({ label: c, ...Geocode.get(c) }))
    .filter((d) => d.lat !== null && d.lat !== undefined);

  await Routing.getRouteMatrix(originLatLng, destinations, (done, total) => {
    btn.textContent = `Calculando… ${done}/${total}`;
  });

  // Km máximo de cada região — é isso que define o "raio" dela (mesma lógica
  // usada na lista de regiões e no PDF).
  const regionMaxKm = {};
  Regions.list.forEach((region) => {
    let maxKm = null;
    region.cities.forEach((cityLabel) => {
      const dest = Geocode.get(cityLabel);
      if (!dest || dest.lat === null) return;
      const key = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
      const route = Routing.cache[key];
      if (route && (maxKm === null || route.km > maxKm)) maxKm = route.km;
    });
    regionMaxKm[region.id] = maxKm;
  });

  const rows = [];
  Regions.list
    .slice()
    .sort((a, b) => a.name.localeCompare(b, "pt-BR"))
    .forEach((region) => {
      const regionKm = regionMaxKm[region.id];
      const raio = regionKm !== null && regionKm !== undefined ? bracketFor(regionKm) : "";

      region.cities
        .slice()
        .sort((a, b) => a.localeCompare(b, "pt-BR"))
        .forEach((cityLabel) => {
          const uf = extractUF(cityLabel) || "";
          const cityName = cityLabel.replace(/-\s*[A-Za-z]{2}\s*$/, "").trim();
          const dest = Geocode.get(cityLabel);
          let km = "";
          if (dest && dest.lat !== null) {
            const key = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
            const route = Routing.cache[key];
            if (route) km = Math.round(route.km);
          }

          rows.push({
            FILIAL: "TERRA BOA",
            CIDADE: cityName,
            UF: `${cityName}-${uf}`,
            "REGIÃO V": region.name,
            KM: km,
            "Raio Disp": raio,
          });
        });
    });

  const ws = XLSX.utils.json_to_sheet(rows, { header: ["FILIAL", "CIDADE", "UF", "REGIÃO V", "KM", "Raio Disp"] });
  ws["!cols"] = [{ wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 24 }, { wch: 8 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Filial");
  XLSX.writeFile(wb, "regioes-filial-terra-boa.xlsx");

  btn.disabled = false;
  btn.textContent = originalText;
}

// ------------------------------------------------------------
// PDF da Grade — paisagem, tudo numa página só, no mesmo formato da planilha
// "GRADE DE ATENDIMENTO": Vendedor + Veic/Rota/Peso/Perfil por dia.
// ------------------------------------------------------------
async function generateGradePdf() {
  if (typeof window.jspdf === "undefined") {
    alert("A biblioteca de PDF ainda não carregou — aguarde alguns segundos e tente de novo.");
    return;
  }

  const packedRows = computePackedGradeRows();
  if (packedRows.length === 0) {
    alert("A Grade ainda está vazia — arraste alguma região pra algum dia antes de gerar o PDF.");
    return;
  }

  const btn = document.getElementById("btnGradePdf");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Gerando…";

  const { jsPDF } = window.jspdf;
  // A3 paisagem — dá espaço suficiente pra caber vendedor + 5 dias × 4
  // colunas cada, tudo numa página só, sem espremer demais o texto.
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3" });
  const pageWidth = doc.internal.pageSize.getWidth();

  // Cabeçalho: logo (mantendo a proporção real dela, 136×107 — sem espremer
  // num quadrado) + título
  try {
    const logoDataUrl = await imageUrlToDataUrl("img/logo.png");
    const logoW = 26;
    const logoH = logoW * (107 / 136);
    doc.addImage(logoDataUrl, "PNG", 14, 12, logoW, logoH);
  } catch (e) {
    // segue sem logo se não conseguir carregar
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("GRADE DE ATENDIMENTO — GTF TERRA BOA", pageWidth / 2, 20, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Gerado em ${new Date().toLocaleDateString("pt-BR")}`, pageWidth / 2, 27, { align: "center" });

  // Cabeçalho da tabela: linha 1 = dia (com capacidade total), linha 2 = Veic/Rota/Peso/Perfil
  const headRow1 = [{ content: "VENDEDOR", rowSpan: 2, styles: { valign: "middle" } }];
  const headRow2 = [];
  GRADE_DAYS.forEach((day) => {
    const total = Grade.days[day]
      .filter((r) => Regions.list.some((reg) => reg.id === r.regionId))
      .reduce((sum, r) => sum + (profileCapacity(r.profile) || 0) * (r.quantity || 1), 0);
    headRow1.push({
      content: `CARREG: ${day} > ENTREG: ${GRADE_NEXT_DAY[day]}\n${total.toLocaleString("pt-BR")} kg`,
      colSpan: 4,
      styles: { halign: "center" },
    });
    headRow2.push("Veic", "Rota", "Peso", "Perfil");
  });

  // Corpo: mesmas linhas já empacotadas usadas na tela. O jsPDF não desenha
  // emoji (viravam símbolos quebrados tipo "Ø-Y") — troca por um "*" comum,
  // com legenda explicando embaixo da tabela.
  let hasSharedRoute = false;
  const body = packedRows.map((rowData) => {
    const cells = [rowData.vendorKey];
    GRADE_DAYS.forEach((day) => {
      const entry = rowData.cells[day];
      if (!entry) {
        cells.push("—", "—", "—", "—");
        return;
      }
      const cap = profileCapacity(entry.route.profile);
      const quantity = entry.route.quantity || 1;
      const weight = cap !== null ? cap * quantity : null;
      const shared = entry.coSellers && entry.coSellers.length > 0;
      if (shared) hasSharedRoute = true;
      cells.push(
        String(quantity),
        entry.region.name + (shared ? " *" : ""),
        weight !== null ? `${weight.toLocaleString("pt-BR")} kg` : "—",
        entry.route.profile
      );
    });
    return cells;
  });

  const tableResult = doc.autoTable({
    head: [headRow1, headRow2],
    body,
    startY: 32,
    theme: "plain",
    styles: { fontSize: 6.5, cellPadding: 1.2, valign: "middle" },
    headStyles: { fillColor: [26, 43, 74], textColor: 255, fontSize: 6.5, halign: "center" },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 30, valign: "middle" } },
    margin: { left: 8, right: 8 },
    didParseCell: (data) => {
      // Colore de leve a linha do cabeçalho de dia (segunda linha do head)
      if (data.section === "head" && data.row.index === 1) {
        data.cell.styles.fillColor = [42, 62, 100];
      }
      // Alinhamento por tipo de sub-coluna (Veic/Rota/Peso/Perfil, repetido a
      // cada dia): Veic e Peso centralizados, Rota em negrito e à esquerda
      // (mas centralizado verticalmente na célula), Perfil centralizado.
      if (data.section === "body" && data.column.index > 0) {
        const offset = (data.column.index - 1) % 4;
        data.cell.styles.valign = "middle";
        if (offset === 0 || offset === 2 || offset === 3) {
          data.cell.styles.halign = "center";
        } else if (offset === 1) {
          data.cell.styles.halign = "left";
          data.cell.styles.fontStyle = "bold";
        }
      }
    },
    didDrawCell: (data) => {
      const { cell, column, section } = data;

      // Topo da tabela: linha sólida
      if (section === "head" && data.row.index === 0) {
        doc.setDrawColor(26, 43, 74);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([], 0);
        doc.line(cell.x, cell.y, cell.x + cell.width, cell.y);
      }

      // Início de cada dia (Vendedor, e a coluna "Veic" de cada grupo de 4) —
      // linha sólida e mais grossa, separando visualmente cada dia da semana.
      const isDayBoundary = column.index === 0 || (column.index - 1) % 4 === 0;

      if (isDayBoundary) {
        doc.setDrawColor(26, 43, 74);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([], 0);
        doc.line(cell.x, cell.y, cell.x, cell.y + cell.height);
      } else {
        doc.setDrawColor(150, 150, 150);
        doc.setLineWidth(0.15);
        doc.setLineDashPattern([0.6, 0.6], 0);
        doc.line(cell.x, cell.y, cell.x, cell.y + cell.height);
      }

      // Borda direita da última coluna: sólida, fechando a tabela
      if (column.index === headRow2.length) {
        doc.setDrawColor(26, 43, 74);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([], 0);
        doc.line(cell.x + cell.width, cell.y, cell.x + cell.width, cell.y + cell.height);
      }

      // Linha horizontal embaixo de cada célula: sólida separando cabeçalho
      // do corpo, tracejada fina entre as linhas do corpo
      const isHeaderBottom = section === "head" && data.row.index === 1;
      if (isHeaderBottom) {
        doc.setDrawColor(26, 43, 74);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([], 0);
      } else {
        doc.setDrawColor(190, 190, 190);
        doc.setLineWidth(0.15);
        doc.setLineDashPattern([0.6, 0.6], 0);
      }
      doc.line(cell.x, cell.y + cell.height, cell.x + cell.width, cell.y + cell.height);

      doc.setLineDashPattern([], 0); // reseta pro resto do desenho não herdar o tracejado
    },
  });

  if (hasSharedRoute) {
    const finalY = doc.lastAutoTable.finalY || 32;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.text(
      "* Rota compartilhada — atendida por mais de um vendedor. Mesmo aparecendo repetida em várias linhas,",
      14,
      finalY + 6
    );
    doc.text(
      "a quantidade de veículos e o peso contam UMA VEZ SÓ no total do dia (não some cada linha em que aparece).",
      14,
      finalY + 10.5
    );
  }

  doc.save("grade-atendimento-terra-boa.pdf");

  btn.disabled = false;
  btn.textContent = originalText;
}

async function imageUrlToDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function buildPdfDocument({ regionsToInclude, scopeLabel, sellerFilterName, incKm, incRound, incSeller, incProfile, regionMaxKm }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  let logoDataUrl = null;
  try {
    logoDataUrl = await imageUrlToDataUrl("img/logo.png");
  } catch (e) {}

  function drawHeader() {
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, "PNG", 40, 24, 26, 26);
      } catch (e) {}
    }
    const textX = logoDataUrl ? 76 : 40;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(14, 26, 43);
    doc.text("Regiões de Atendimento — Terra Boa/PR", textX, 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90, 100, 110);
    doc.text(`Roteiro: ${scopeLabel}`, textX, 52);
    doc.text(
      `Origem: GTF - Unidade Terra Boa   ·   Gerado em ${new Date().toLocaleDateString("pt-BR")}`,
      40,
      70
    );
    doc.setDrawColor(220, 225, 230);
    doc.line(40, 80, pageWidth - 40, 80);
  }

  drawHeader();
  let y = 96;

  regionsToInclude.forEach((region) => {
    if (y > 700) {
      doc.addPage();
      drawHeader();
      y = 96;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(13, 158, 148);
    doc.text(region.name, 40, y);
    y += 14;

    const metaBits = [];
    if (incProfile) metaBits.push(`Perfil mínimo: ${region.vehicleProfile}`);
    const maxKmForRegion = regionMaxKm ? regionMaxKm[region.id] : null;
    if (maxKmForRegion !== null && maxKmForRegion !== undefined) {
      metaBits.push(`Raio: até ${bracketFor(maxKmForRegion)} km`);
    }
    if (metaBits.length > 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(90, 100, 110);
      doc.text(metaBits.join("   ·   "), 40, y);
      y += 12;
    }

    const head = ["Cidade"];
    if (incSeller) head.push("Vendedor(es)");
    if (incKm) head.push("Ida");
    if (incRound) head.push("Ida e volta");

    // Helper pra pegar a distância (ida, em km) já calculada de uma cidade
    const kmOf = (city) => {
      const dest = Geocode.get(city);
      if (!originLatLng || !dest || dest.lat === null) return null;
      const key = `${originLatLng.lat},${originLatLng.lng}|${dest.lat},${dest.lng}`;
      const route = Routing.cache[key];
      return route ? route.km : null;
    };

    const cities = region.cities
      .filter((c) => !sellerFilterName || (CITY_TO_SELLERS[c] || []).includes(sellerFilterName))
      .sort((a, b) => {
        const kmA = kmOf(a);
        const kmB = kmOf(b);
        if (kmA === null && kmB === null) return a.localeCompare(b, "pt-BR");
        if (kmA === null) return 1; // sem distância calculada vai pro fim
        if (kmB === null) return -1;
        return kmB - kmA; // do mais longe pro mais perto
      });

    const body = cities.map((city) => {
      const row = [city];
      if (incSeller) row.push((CITY_TO_SELLERS[city] || []).join(", "));
      if (incKm || incRound) {
        const km = kmOf(city);
        const kmText = km !== null ? `${km.toFixed(0)} km` : "—";
        const roundText = km !== null ? `${(km * 2).toFixed(0)} km` : "—";
        if (incKm) row.push(kmText);
        if (incRound) row.push(roundText);
      }
      return row;
    });

    doc.autoTable({
      startY: y + 4,
      head: [head],
      body,
      margin: { left: 40, right: 40 },
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [14, 26, 43], textColor: 255 },
      alternateRowStyles: { fillColor: [244, 246, 248] },
    });

    y = doc.lastAutoTable.finalY + 24;
  });

  const fileScope = scopeLabel
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  doc.save(`roteiro-${fileScope || "atendimento"}.pdf`);
}

// ------------------------------------------------------------
// Modo apresentação — some com topo, barra do admin e barra lateral,
// deixando só o mapa. Tenta abrir em tela cheia de verdade também.
// ------------------------------------------------------------
function togglePresentationMode(forceState) {
  const body = document.body;
  const turningOn = forceState !== undefined ? forceState : !body.classList.contains("presentation-mode");

  body.classList.toggle("presentation-mode", turningOn);
  document.getElementById("btnExitPresent").classList.toggle("hidden", !turningOn);
  if (!turningOn) {
    hidePresentationBurst();
    hideKeyCityLinks();
    focusedRegionId = null;
    showNeighborRegions = false;
    rebuildClusters();
  }

  if (turningOn) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) {
      try {
        req.call(el).catch(() => {});
      } catch (e) {}
    }
  } else if (document.fullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) {
      try {
        exit.call(document).catch(() => {});
      } catch (e) {}
    }
  }

  setTimeout(() => map && map.invalidateSize(), 150);
}

function isPresenting() {
  return document.body.classList.contains("presentation-mode");
}

function showPresentationBurst(region) {
  const box = document.getElementById("presentationBurst");
  const cities = region.cities.slice().sort((a, b) => a.localeCompare(b, "pt-BR"));
  box.innerHTML = `
    <button class="pb-close" id="btnClosePresentBurst">✕</button>
    <h2>${region.name}</h2>
    <div class="pb-meta">${cities.length} cidade(s) · Perfil mínimo: ${region.vehicleProfile}</div>
    <div class="pb-cities">${cities.map((c) => `<span class="pb-city">${c}</span>`).join("")}</div>
  `;
  box.classList.add("active");
  document.getElementById("btnClosePresentBurst").addEventListener("click", hidePresentationBurst);
}

function hidePresentationBurst() {
  document.getElementById("presentationBurst").classList.remove("active");
}

// ------------------------------------------------------------
// Editar vendedor(es) de uma cidade já existente
// ------------------------------------------------------------
let editingCitySellersLabel = null;
let editingCitySellersMarker = null;

// ------------------------------------------------------------
// Cidade-chave — uma cidade pode compor mais de uma região ao
// mesmo tempo (ex: Campo Mourão compondo Goioerê e Ubiratã).
// ------------------------------------------------------------
let editingKeyCityLabel = null;

function openKeyCityModal(cityLabel) {
  if (!Auth.isAdmin) return;
  editingKeyCityLabel = cityLabel;
  document.getElementById("keyCityTitle").textContent = `Regiões que "${cityLabel}" compõe`;

  const checklist = document.getElementById("keyCityChecklist");
  checklist.innerHTML = "";
  Regions.list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .forEach((r) => {
      const checked = r.cities.includes(cityLabel);
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${r.id}" ${checked ? "checked" : ""} /> ${r.name}`;
      checklist.appendChild(label);
    });

  if (Regions.list.length === 0) {
    checklist.innerHTML = `<p class="hint">Nenhuma região criada ainda.</p>`;
  }

  // Popula o seletor de perfil do formulário de "criar região nova"
  const profileSelect = document.getElementById("newRegionInKeyCityProfile");
  profileSelect.innerHTML = VEHICLE_PROFILES.map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
  document.getElementById("newRegionInKeyCityForm").classList.add("hidden");
  document.getElementById("newRegionInKeyCityName").value = "";

  document.getElementById("keyCityModal").classList.remove("hidden");
}

function closeKeyCityModal() {
  document.getElementById("keyCityModal").classList.add("hidden");
  editingKeyCityLabel = null;
}

// Cria uma região nova, só com a cidade que está sendo editada, direto do
// modal de cidade-chave. Diferente de desenhar região nova no mapa, essa NÃO
// tira a cidade de nenhuma outra região — é exatamente o ponto de ser uma
// cidade-chave.
function createRegionFromKeyCityModal() {
  if (!Auth.isAdmin || !editingKeyCityLabel) return;
  const name = document.getElementById("newRegionInKeyCityName").value.trim();
  const vehicleProfile = document.getElementById("newRegionInKeyCityProfile").value;

  if (!name) {
    alert("Digite um nome pra região antes de criar.");
    return;
  }

  const region = Regions.create({ name, vehicleProfile, cities: [editingKeyCityLabel] });

  // Já marca a região recém-criada no checklist, e limpa/esconde o formulário
  const checklist = document.getElementById("keyCityChecklist");
  const emptyMsg = checklist.querySelector("p.hint");
  if (emptyMsg) checklist.innerHTML = "";
  const label = document.createElement("label");
  label.innerHTML = `<input type="checkbox" value="${region.id}" checked /> ${region.name}`;
  checklist.appendChild(label);

  document.getElementById("newRegionInKeyCityForm").classList.add("hidden");
  document.getElementById("newRegionInKeyCityName").value = "";

  rebuildClusters();
  renderRegionsList();
}

function saveKeyCityRegions() {
  if (!Auth.isAdmin || !editingKeyCityLabel) return;
  const city = editingKeyCityLabel;
  const checkedIds = Array.from(document.querySelectorAll("#keyCityChecklist input:checked")).map(
    (el) => el.value
  );

  if (checkedIds.length === 0) {
    alert("Marque ao menos uma região.");
    return;
  }

  Regions.list.forEach((r) => {
    const shouldHave = checkedIds.includes(r.id);
    const has = r.cities.includes(city);
    if (shouldHave && !has) Regions.update(r.id, { cities: [...r.cities, city] });
    if (!shouldHave && has) Regions.update(r.id, { cities: r.cities.filter((c) => c !== city) });
  });

  rebuildClusters();
  invalidateRegionRadiusCache();
  closeKeyCityModal();

  if (checkedIds.length > 1) {
    alert(`"${city}" agora é uma cidade-chave, compondo ${checkedIds.length} regiões.`);
  }
}

// Calcula o centro aproximado de uma região (média das coordenadas das cidades dela)
function regionCentroid(region) {
  const coords = region.cities.map((c) => Geocode.get(c)).filter((c) => c && c.lat !== null);
  if (coords.length === 0) return null;
  const lat = coords.reduce((sum, c) => sum + c.lat, 0) / coords.length;
  const lng = coords.reduce((sum, c) => sum + c.lng, 0) / coords.length;
  return { lat, lng };
}

let keyCityLinksLayer = null;

// Desenha linhas tracejadas das cidades-chave da região em foco até o centro das
// outras regiões que elas também compõem.
function showKeyCityLinks(region) {
  hideKeyCityLinks();
  const lines = [];

  region.cities.forEach((cityLabel) => {
    const allRegions = Regions.findByCity(cityLabel);
    if (allRegions.length <= 1) return; // não é cidade-chave

    const cityCoord = Geocode.get(cityLabel);
    if (!cityCoord || cityCoord.lat === null) return;

    allRegions.forEach((otherRegion) => {
      if (otherRegion.id === region.id) return;
      const centroid = regionCentroid(otherRegion);
      if (!centroid) return;

      const line = L.polyline(
        [
          [cityCoord.lat, cityCoord.lng],
          [centroid.lat, centroid.lng],
        ],
        { color: "#8e44ad", weight: 2.5, dashArray: "6 8", opacity: 0.75 }
      );
      line.bindTooltip(`🔑 ${cityLabel} também compõe: ${otherRegion.name}`, {
        sticky: true,
        className: "city-name-tooltip",
      });
      lines.push(line);
    });
  });

  if (lines.length > 0) {
    keyCityLinksLayer = L.layerGroup(lines).addTo(map);
  }
}

function hideKeyCityLinks() {
  if (keyCityLinksLayer) {
    map.removeLayer(keyCityLinksLayer);
    keyCityLinksLayer = null;
  }
}

function openEditCitySellersModal(cityLabel, marker) {
  if (!Auth.isAdmin) return;
  editingCitySellersLabel = cityLabel;
  editingCitySellersMarker = marker;

  document.getElementById("editCitySellersTitle").textContent = `Editar vendedor(es) — ${cityLabel}`;

  const current = CITY_TO_SELLERS[cityLabel] || [];
  const checklist = document.getElementById("editCitySellersChecklist");
  checklist.innerHTML = "";
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const label = document.createElement("label");
      const checked = current.includes(name) ? "checked" : "";
      label.innerHTML = `<input type="checkbox" value="${name}" ${checked} /> ${name}`;
      checklist.appendChild(label);
    });

  document.getElementById("newSellerNameInput").value = "";
  document.getElementById("editCitySellersModal").classList.remove("hidden");
}

function closeEditCitySellersModal() {
  document.getElementById("editCitySellersModal").classList.add("hidden");
  editingCitySellersLabel = null;
  editingCitySellersMarker = null;
}

// Adiciona um vendedor novo direto na lista do modal, já marcado. Ele só passa
// a existir de verdade quando o modal for salvo (rebuildSellersFromCityToSellers
// cria o vendedor automaticamente assim que ele aparece em alguma cidade).
function addNewSellerToChecklist() {
  if (!Auth.isAdmin) return;
  const input = document.getElementById("newSellerNameInput");
  const name = input.value.trim();
  if (!name) {
    alert("Digite o nome do vendedor antes de adicionar.");
    return;
  }

  const checklist = document.getElementById("editCitySellersChecklist");
  const existing = Array.from(checklist.querySelectorAll("input")).find(
    (el) => el.value.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    existing.checked = true;
    input.value = "";
    return;
  }

  const label = document.createElement("label");
  label.innerHTML = `<input type="checkbox" value="${name}" checked /> ${name}`;
  checklist.appendChild(label);
  input.value = "";
  input.focus();
}

function saveEditCitySellers() {
  if (!Auth.isAdmin || !editingCitySellersLabel) return;
  const city = editingCitySellersLabel;
  const checked = Array.from(
    document.querySelectorAll("#editCitySellersChecklist input:checked")
  ).map((el) => el.value);

  if (checked.length === 0) {
    alert("Marque pelo menos um vendedor responsável por essa cidade.");
    return;
  }

  // CITY_TO_SELLERS é a fonte de verdade — SELLERS é sempre recalculado a partir dela
  CITY_TO_SELLERS[city] = checked;
  rebuildSellersFromCityToSellers();
  saveCityDirectoryDraft();

  renderSellerOptions();
  updateDraftHint();

  const marker = editingCitySellersMarker;
  closeEditCitySellersModal();
  if (marker) openCityPopup(city, marker);

  rebuildClusters();
  invalidateRegionRadiusCache();
  if (activeSellerFilter) {
    applySellerFilter(activeSellerFilter); // refaz a lista lateral: a cidade some do aviso se não estiver mais em conflito
  }
}

// Mostra (ou esconde) o banner de alterações não publicadas, com um botão que
// exporta tudo de uma vez — pensado pra nunca mais esquecer de publicar algo.
function updateDraftHint() {
  const pendingDrafts = [];
  if (Regions.hasDraft()) pendingDrafts.push("regiões");
  if (hasCityDirectoryDraft()) pendingDrafts.push("cidades/vendedores");
  if (Grade.hasDraft()) pendingDrafts.push("grade");

  const hintEl = document.getElementById("draftHint");
  const textEl = document.getElementById("draftHintText");

  if (pendingDrafts.length === 0) {
    hintEl.classList.add("hidden");
    return;
  }
  textEl.textContent = `⚠️ Alterações não publicadas: ${pendingDrafts.join(" e ")}`;
  hintEl.classList.remove("hidden");
}

// Baixa de uma vez só TODOS os arquivos de dados (regiões, cidades e diretório) —
// um único clique de "backup completo", pra usar sempre que for parar de mexer.
function exportEverythingNow() {
  downloadFile("regions.json", Regions.exportJSON());
  setTimeout(() => downloadFile("cities.json", Geocode.exportJSON()), 300);
  setTimeout(() => exportDirectory(), 600);
  setTimeout(() => downloadFile("grade.json", Grade.exportJSON()), 1200);
}

// ------------------------------------------------------------
// Trocar senha do admin — gera um novo js/config.js já com o
// hash da senha nova, pronto pra subir no GitHub.
// ------------------------------------------------------------
// ------------------------------------------------------------
// Publicar direto no GitHub — sem precisar baixar/subir manual. Usa a API
// do GitHub direto do navegador, com um token de acesso pessoal que fica
// salvo só localmente (localStorage), nunca é enviado pra mais ninguém.
// ------------------------------------------------------------
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function getGithubConfig() {
  try {
    const raw = localStorage.getItem("regioes_github_config");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveGithubConfig(config) {
  localStorage.setItem("regioes_github_config", JSON.stringify(config));
}

// ------------------------------------------------------------
// Importar pedidos de uma planilha — lê o arquivo, deixa escolher qual
// coluna é o quê, casa cada linha com a cidade/região já cadastrada, e
// plota tudo no mapa.
// ------------------------------------------------------------
let importedOrderRows = []; // linhas cruas da planilha, antes de processar
let ordersLayerGroup = null;

function openImportOrdersModal() {
  if (!Auth.isAdmin) return;
  document.getElementById("importOrdersStep1").classList.remove("hidden");
  document.getElementById("importOrdersStep2").classList.add("hidden");
  document.getElementById("importOrdersStep3").classList.add("hidden");
  document.getElementById("ordersFileInput").value = "";
  document.getElementById("importOrdersModal").classList.remove("hidden");
}

function closeImportOrdersModal() {
  document.getElementById("importOrdersModal").classList.add("hidden");
}

async function handleOrdersFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (typeof XLSX === "undefined") {
    alert("A biblioteca de planilhas ainda não carregou — aguarde alguns segundos e tente de novo.");
    return;
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (rows.length === 0) {
    alert("Não encontrei nenhuma linha de dados nessa planilha.");
    return;
  }

  importedOrderRows = rows;
  const headers = Object.keys(rows[0]);

  // Tenta adivinhar qual coluna é qual, pelo nome do cabeçalho
  const guess = (keywords) => headers.find((h) => keywords.some((k) => normalizeStr(h).includes(k))) || "";

  fillColumnSelect("mapColCity", headers, guess(["cidade", "municipio"]));
  fillColumnSelect("mapColUf", headers, guess(["uf", "estado"]), true);
  fillColumnSelect("mapColWeight", headers, guess(["peso", "kg"]), true);
  fillColumnSelect("mapColClient", headers, guess(["cliente", "nome", "razao", "pedido"]), true);
  fillColumnSelect("mapColSeller", headers, guess(["vendedor", "representante", "rca"]), true);

  document.getElementById("importOrdersStep1").classList.add("hidden");
  document.getElementById("importOrdersStep2").classList.remove("hidden");
}

function fillColumnSelect(selectId, headers, preselect, optional) {
  const select = document.getElementById(selectId);
  select.innerHTML =
    (optional ? `<option value="">— nenhuma —</option>` : "") +
    headers.map((h) => `<option value="${h}">${h}</option>`).join("");
  if (preselect) select.value = preselect;
}

// Casa o texto de cidade da planilha com uma cidade já cadastrada no app —
// ignora acento/maiúscula e a UF, se der pra desempatar com ela.
function matchCityToKnown(rawCityText, ufHint) {
  if (!rawCityText) return null;
  const target = normalizeStr(String(rawCityText).replace(/-\s*[A-Za-z]{2}\s*$/, "").trim());
  if (!target) return null;

  const candidates = CITIES_LIST.filter((c) => {
    const cityNameOnly = c.replace(/-\s*[A-Za-z]{2}\s*$/, "").trim();
    return normalizeStr(cityNameOnly) === target;
  });

  if (candidates.length <= 1) return candidates[0] || null;
  if (ufHint) {
    const withUf = candidates.find((c) => extractUF(c) === String(ufHint).trim().toUpperCase());
    if (withUf) return withUf;
  }
  return candidates[0];
}

function processImportOrders() {
  const colCity = document.getElementById("mapColCity").value;
  const colUf = document.getElementById("mapColUf").value;
  const colWeight = document.getElementById("mapColWeight").value;
  const colClient = document.getElementById("mapColClient").value;
  const colSeller = document.getElementById("mapColSeller").value;

  if (!colCity) {
    alert("Selecione qual coluna é a cidade — é a única obrigatória.");
    return;
  }

  const orders = importedOrderRows.map((row, idx) => {
    const rawCity = row[colCity];
    const uf = colUf ? row[colUf] : "";
    const cityLabel = matchCityToKnown(rawCity, uf);
    const regions = cityLabel ? Regions.findByCity(cityLabel) : [];
    const weightRaw = colWeight ? row[colWeight] : "";
    const weight = weightRaw !== "" && !isNaN(parseFloat(String(weightRaw).replace(",", "."))) ? parseFloat(String(weightRaw).replace(",", ".")) : null;

    return {
      id: "order_" + idx + "_" + Date.now(),
      client: colClient ? String(row[colClient] || "") : "",
      rawCity: String(rawCity || ""),
      cityLabel,
      matched: !!cityLabel,
      weight,
      seller: colSeller ? String(row[colSeller] || "") : "",
      regionId: regions.length > 0 ? regions[0].id : null,
      regionName: regions.length > 0 ? regions[0].name : null,
    };
  });

  Orders.setAll(orders);
  plotOrdersOnMap();
  renderImportOrdersSummary();

  document.getElementById("importOrdersStep2").classList.add("hidden");
  document.getElementById("importOrdersStep3").classList.remove("hidden");
  document.getElementById("toggleOrdersLabel").classList.remove("hidden");
}

function renderImportOrdersSummary() {
  const matched = Orders.list.filter((o) => o.matched);
  const unmatched = Orders.list.filter((o) => !o.matched);

  document.getElementById("importOrdersSummaryText").textContent =
    `${Orders.list.length} pedido(s) importado(s) — ${matched.length} casado(s) com região, ${unmatched.length} sem cidade reconhecida.`;

  // Resumo por região: contagem de pedidos + soma de peso
  const byRegion = {};
  matched.forEach((o) => {
    const key = o.regionName || "—";
    byRegion[key] = byRegion[key] || { count: 0, weight: 0 };
    byRegion[key].count++;
    if (o.weight) byRegion[key].weight += o.weight;
  });

  const summaryBox = document.getElementById("importOrdersRegionSummary");
  summaryBox.innerHTML = Object.keys(byRegion)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((name) => {
      const info = byRegion[name];
      return `<div class="order-region-summary-row"><span class="orsr-name">${name}</span><span class="orsr-count">${info.count} pedido(s)</span><span class="orsr-weight">${info.weight.toLocaleString("pt-BR")} kg</span></div>`;
    })
    .join("");

  const unmatchedBox = document.getElementById("importOrdersUnmatchedBox");
  if (unmatched.length > 0) {
    const uniqueUnmatched = Array.from(new Set(unmatched.map((o) => o.rawCity)));
    document.getElementById("importOrdersUnmatchedList").textContent = uniqueUnmatched.join(", ");
    unmatchedBox.classList.remove("hidden");
  } else {
    unmatchedBox.classList.add("hidden");
  }
}

function plotOrdersOnMap() {
  if (ordersLayerGroup) {
    map.removeLayer(ordersLayerGroup);
    ordersLayerGroup = null;
  }
  if (!Orders.hasOrders()) return;

  const markers = [];
  const cityJitterCount = {}; // pra não empilhar vários pedidos exatamente no mesmo ponto

  Orders.list.forEach((order) => {
    let lat, lng;
    if (order.matched) {
      const coord = Geocode.get(order.cityLabel);
      if (!coord || coord.lat === null) return;
      const n = (cityJitterCount[order.cityLabel] = (cityJitterCount[order.cityLabel] || 0) + 1);
      // Espalha um pouquinho os pedidos da mesma cidade, em círculo, pra não
      // ficarem 100% empilhados um em cima do outro
      const angle = n * 2.4;
      const radius = 0.01 + n * 0.002;
      lat = coord.lat + Math.cos(angle) * radius;
      lng = coord.lng + Math.sin(angle) * radius;
    } else {
      return; // sem cidade reconhecida, não dá pra plotar
    }

    const icon = L.divIcon({
      className: "",
      html: `<div class="order-pin order-matched"><span>📦</span></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 18],
    });
    const marker = L.marker([lat, lng], { icon });
    const popupHtml = `
      <div class="city-popup">
        <strong>${order.client || "Pedido"}</strong><br>
        Cidade: ${order.cityLabel}<br>
        ${order.regionName ? `Região: ${order.regionName}<br>` : ""}
        ${order.weight ? `Peso: ${order.weight.toLocaleString("pt-BR")} kg<br>` : ""}
        ${order.seller ? `Vendedor: ${order.seller}<br>` : ""}
      </div>`;
    marker.bindPopup(popupHtml);
    markers.push(marker);
  });

  ordersLayerGroup = L.layerGroup(markers).addTo(map);
}

function clearImportedOrders() {
  if (!confirm("Tirar todos os pedidos importados do mapa?")) return;
  Orders.clear();
  if (ordersLayerGroup) {
    map.removeLayer(ordersLayerGroup);
    ordersLayerGroup = null;
  }
  document.getElementById("toggleOrdersLabel").classList.add("hidden");
  closeImportOrdersModal();
}

function openGithubPublishModal() {
  if (!Auth.isAdmin) return;
  const config = getGithubConfig();
  document.getElementById("ghOwner").value = (config && config.owner) || "";
  document.getElementById("ghRepo").value = (config && config.repo) || "";
  document.getElementById("ghBranch").value = (config && config.branch) || "main";
  document.getElementById("ghToken").value = (config && config.token) || "";
  document.getElementById("githubPublishStatus").textContent = "";
  document.getElementById("githubPublishModal").classList.remove("hidden");
}

function closeGithubPublishModal() {
  document.getElementById("githubPublishModal").classList.add("hidden");
}

function saveGithubConfigFromForm() {
  const owner = document.getElementById("ghOwner").value.trim();
  const repo = document.getElementById("ghRepo").value.trim();
  const branch = document.getElementById("ghBranch").value.trim() || "main";
  const token = document.getElementById("ghToken").value.trim();

  if (!owner || !repo || !token) {
    alert("Preencha usuário, repositório e token antes de salvar.");
    return;
  }
  saveGithubConfig({ owner, repo, branch, token });
  const statusEl = document.getElementById("githubPublishStatus");
  statusEl.style.color = "";
  statusEl.textContent = "Configuração salva neste navegador.";
}

async function githubGetFileSha(owner, repo, path, branch, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null; // arquivo ainda não existe nesse caminho
  if (!res.ok) throw new Error(`Erro ao consultar ${path} (${res.status})`);
  const data = await res.json();
  return data.sha;
}

async function githubPutFile(owner, repo, path, branch, token, content, message) {
  const sha = await githubGetFileSha(owner, repo, path, branch, token);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: utf8ToBase64(content), branch };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${path}: ${res.status} — ${err.message || "erro desconhecido"}`);
  }
}

async function publishAllToGitHub() {
  const config = getGithubConfig();
  if (!config || !config.owner || !config.repo || !config.token) {
    alert("Preencha e salve a configuração do GitHub antes de publicar.");
    return;
  }

  const statusEl = document.getElementById("githubPublishStatus");
  const btn = document.getElementById("btnPublishNow");
  btn.disabled = true;
  statusEl.style.color = "";

  const branch = config.branch || "main";
  const message = `Atualização via app — ${new Date().toLocaleString("pt-BR")}`;

  const files = [
    { path: "data/regions.json", content: Regions.exportJSON() },
    { path: "data/cities.json", content: Geocode.exportJSON() },
    { path: "data/grade.json", content: Grade.exportJSON() },
    { path: "data/sellers.json", content: JSON.stringify(SELLERS, null, 2) },
    { path: "data/city_to_sellers.json", content: JSON.stringify(CITY_TO_SELLERS, null, 2) },
    { path: "data/cities_list.json", content: JSON.stringify(CITIES_LIST, null, 2) },
  ];

  try {
    for (let i = 0; i < files.length; i++) {
      statusEl.textContent = `Publicando ${files[i].path}… (${i + 1}/${files.length})`;
      await githubPutFile(config.owner, config.repo, files[i].path, branch, config.token, files[i].content, message);
    }
    statusEl.style.color = "#1a7d3c";
    statusEl.textContent = "✅ Tudo publicado! O GitHub Pages costuma atualizar em 1-2 minutos.";

    // Já que está tudo publicado agora, descarta os rascunhos locais — não tem
    // mais nada "pendente", published = draft.
    Regions.discardDraft();
    localStorage.removeItem("regioes_directory_draft");
    Grade.discardDraft();
    updateDraftHint();
  } catch (e) {
    statusEl.style.color = "#c0392b";
    statusEl.textContent = `❌ Erro ao publicar: ${e.message}`;
  }

  btn.disabled = false;
}

function openChangePasswordModal() {
  if (!Auth.isAdmin) return;
  document.getElementById("newAdminPassword").value = "";
  document.getElementById("newAdminPasswordConfirm").value = "";
  document.getElementById("changePasswordError").textContent = "";
  document.getElementById("changePasswordModal").classList.remove("hidden");
}

function closeChangePasswordModal() {
  document.getElementById("changePasswordModal").classList.add("hidden");
}

async function generateNewConfigFile() {
  if (!Auth.isAdmin) return;
  const pwd = document.getElementById("newAdminPassword").value;
  const pwd2 = document.getElementById("newAdminPasswordConfirm").value;
  const errorEl = document.getElementById("changePasswordError");

  if (!pwd || pwd.length < 4) {
    errorEl.textContent = "Digite uma senha com pelo menos 4 caracteres.";
    return;
  }
  if (pwd !== pwd2) {
    errorEl.textContent = "As senhas digitadas não coincidem.";
    return;
  }

  const enc = new TextEncoder().encode(pwd);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const hash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const colorsFormatted = CONFIG.REGION_COLORS.map((c) => `"${c}"`).join(", ");

  const configContent = `// ============================================================
// CONFIGURAÇÃO DO APP — edite os valores abaixo conforme precisar
// ============================================================

const CONFIG = {
  // Endereço de origem (todas as distâncias são calculadas a partir daqui)
  ORIGIN_LABEL: "${CONFIG.ORIGIN_LABEL}",
  ORIGIN_ADDRESS: "${CONFIG.ORIGIN_ADDRESS}",

  // Coordenadas fixas da origem
  ORIGIN_LAT: ${CONFIG.ORIGIN_LAT},
  ORIGIN_LNG: ${CONFIG.ORIGIN_LNG},

  // Hash SHA-256 da senha de administrador (gerado pelo app em ${new Date().toLocaleDateString("pt-BR")})
  ADMIN_PASSWORD_HASH:
    "${hash}",

  // Centro inicial do mapa
  MAP_CENTER: [${CONFIG.MAP_CENTER[0]}, ${CONFIG.MAP_CENTER[1]}],
  MAP_ZOOM: ${CONFIG.MAP_ZOOM},

  // Serviços gratuitos usados (OpenStreetMap)
  NOMINATIM_URL: "${CONFIG.NOMINATIM_URL}",
  OSRM_URL: "${CONFIG.OSRM_URL}",

  // Paleta de cores sugeridas para novas regiões (cicla automaticamente).
  // O admin ainda pode escolher qualquer cor livremente no seletor de cores.
  REGION_COLORS: [
    ${colorsFormatted}
  ],
};
`;

  downloadFile("config.js", configContent);
  closeChangePasswordModal();
  alert(
    "Novo config.js baixado! Suba esse arquivo no GitHub, dentro da pasta js/, substituindo o antigo. A senha nova passa a valer assim que publicar."
  );
}

// ------------------------------------------------------------
// ABA GRADE — quadro de carregamento/entrega com arrastar-e-soltar
// ------------------------------------------------------------
let currentTab = "map";
let draggedRegionId = null;
let pendingRouteDrop = null; // { day, regionId, defaultProfile } — enquanto o modal de vendedores está aberto

let gradeDragDropReady = false;

// Liga os eventos de arrastar-e-soltar da Grade UMA ÚNICA VEZ (nunca de novo a
// cada render) — grudar de novo a cada redesenho da tabela é o que causava
// duplicação: um "soltar" disparava vários listeners acumulados de uma vez.
function setupGradeDragDrop() {
  if (gradeDragDropReady) return;
  gradeDragDropReady = true;

  const board = document.getElementById("gradeBoard");

  board.addEventListener("dragover", (e) => {
    if (!Auth.isAdmin) return;
    const cell = e.target.closest("[data-day]");
    if (!cell) return;
    e.preventDefault();
    cell.classList.add("drag-over");
  });

  board.addEventListener("dragleave", (e) => {
    const cell = e.target.closest("[data-day]");
    if (cell) cell.classList.remove("drag-over");
  });

  board.addEventListener("drop", (e) => {
    if (!Auth.isAdmin) return;
    const cell = e.target.closest("[data-day]");
    if (!cell) return;
    e.preventDefault();
    cell.classList.remove("drag-over");
    const day = cell.dataset.day;
    const regionId = e.dataTransfer.getData("text/plain") || draggedRegionId;
    if (!regionId || !day) return;
    handleRegionDrop(day, regionId);
  });
}

// Decide o que fazer quando uma região é solta num dia: se ela tem só um
// vendedor, cria a rota direto (sem abrir nada). Se tem mais de um, abre a
// caixa pra escolher quem vai dividir esse carregamento.
function handleRegionDrop(day, regionId) {
  const region = Regions.list.find((r) => r.id === regionId);
  if (!region) return;
  const sellers = regionSellers(region);

  if (sellers.length <= 1) {
    Grade.addRoute(day, regionId, region.vehicleProfile, sellers);
    updateDraftHint();
    renderGradeBoard();
    renderGradeRegionList();
    return;
  }

  pendingRouteDrop = { day, regionId, defaultProfile: region.vehicleProfile };
  openRouteSellersModal(region, sellers);
}

function openRouteSellersModal(region, sellers) {
  document.getElementById("routeSellersTitle").textContent = `Quem atende ${region.name}?`;
  const checklist = document.getElementById("routeSellersChecklist");
  checklist.innerHTML = "";
  sellers.forEach((name) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${name}" /> ${name}`;
    checklist.appendChild(label);
  });
  document.getElementById("routeSellersOverlay").classList.remove("hidden");
}

function closeRouteSellersModal() {
  document.getElementById("routeSellersOverlay").classList.add("hidden");
  pendingRouteDrop = null;
}

function confirmRouteSellers() {
  if (!pendingRouteDrop) return;
  const checked = Array.from(document.querySelectorAll("#routeSellersChecklist input:checked")).map(
    (el) => el.value
  );
  if (checked.length === 0) {
    alert("Marque ao menos um vendedor.");
    return;
  }
  Grade.addRoute(pendingRouteDrop.day, pendingRouteDrop.regionId, pendingRouteDrop.defaultProfile, checked);
  updateDraftHint();
  renderGradeBoard();
  renderGradeRegionList();
  closeRouteSellersModal();
}

function switchTab(tab) {
  // Some é admin, a aba Veículos não existe pra visualização — cai pro mapa
  if (tab === "vehicles" && !Auth.isAdmin) tab = "map";

  currentTab = tab;
  document.getElementById("layout").classList.toggle("hidden", tab !== "map");
  document.getElementById("adminToolbar").classList.toggle("hidden", tab !== "map" || !Auth.isAdmin);
  document.getElementById("gradeView").classList.toggle("hidden", tab !== "grade");
  document.getElementById("gradeTabExtras").classList.toggle("hidden", tab !== "grade");
  document.getElementById("vehiclesView").classList.toggle("hidden", tab !== "vehicles");

  document.getElementById("tabMapBtn").classList.toggle("active", tab === "map");
  document.getElementById("tabGradeBtn").classList.toggle("active", tab === "grade");
  document.getElementById("tabVehiclesBtn").classList.toggle("active", tab === "vehicles");

  if (tab === "map") {
    setTimeout(() => map && map.invalidateSize(), 60);
  } else if (tab === "grade") {
    renderGradeBoard();
    renderGradeRegionList();
  } else if (tab === "vehicles") {
    renderVehiclesView();
  }
}

// Vendedores que atendem uma região — todos os vendedores distintos entre as
// cidades dela (usado pra exibir "Vendedor(es)" no cartão da grade).
// "Alessandra Borgato" -> "Alessandra B." — usado no resumo de quem divide
// veículo, pra caber numa linha só embaixo do nome do vendedor principal.
function abbreviateName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

function regionSellers(region) {
  const sellers = new Set();
  region.cities.forEach((c) => {
    (CITY_TO_SELLERS[c] || []).forEach((s) => sellers.add(s));
  });
  return Array.from(sellers).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function profileCapacity(profileName) {
  const p = VEHICLE_PROFILES.find((p) => p.name === profileName);
  return p ? p.capacity_kg : null;
}

function renderGradeRegionList() {
  const box = document.getElementById("gradeRegionList");
  box.innerHTML = "";

  Regions.list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .forEach((region) => {
      const card = document.createElement("div");
      card.className = "grade-region-card";
      card.draggable = Auth.isAdmin;
      card.dataset.regionId = region.id;
      card.innerHTML = `
        <div class="grc-name">
          <span class="grc-swatch" style="background:${region.color}"></span>
          <span class="gri-region-clickable" data-region-id="${region.id}">${region.name}</span>
        </div>
        <div class="grc-meta">${region.cities.length} cidade(s) · perfil: ${region.vehicleProfile}</div>
      `;
      card.querySelector(".gri-region-clickable").addEventListener("click", (e) => {
        e.stopPropagation();
        openGradeRegionInfo(region.id);
      });
      if (Auth.isAdmin) {
        card.addEventListener("dragstart", (e) => {
          draggedRegionId = region.id;
          card.classList.add("dragging");
          e.dataTransfer.setData("text/plain", region.id);
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("dragging");
          draggedRegionId = null;
        });
      }
      box.appendChild(card);
    });
}

// Monta as linhas já "empacotadas" (uma linha por vendedor, dias preenchidos
// quando possível na mesma linha) — usado tanto pra desenhar a tabela na tela
// quanto pra gerar o PDF da grade, garantindo que os dois fiquem idênticos.
function computePackedGradeRows() {
  // Junta toda rota de todo dia numa lista só: {day, route, region}
  const allEntries = [];
  GRADE_DAYS.forEach((day) => {
    Grade.days[day].forEach((route) => {
      const region = Regions.list.find((r) => r.id === route.regionId);
      if (region) allEntries.push({ day, route, region });
    });
  });

  // Agrupa por vendedor INDIVIDUAL — cada rota pode ter mais de um vendedor
  // escolhido (dividindo o mesmo veículo), então ela entra na linha de cada um
  // deles. Rotas antigas (de antes dessa escolha existir) caem de volta pra
  // todos os vendedores da região, como já era.
  const vendorGroups = {};
  allEntries.forEach((entry) => {
    const sellersForRoute =
      entry.route.sellers && entry.route.sellers.length > 0 ? entry.route.sellers : regionSellers(entry.region);
    const sellerList = sellersForRoute.length > 0 ? sellersForRoute : ["—"];
    sellerList.forEach((sellerName) => {
      vendorGroups[sellerName] = vendorGroups[sellerName] || [];
      vendorGroups[sellerName].push({
        ...entry,
        coSellers: sellerList.filter((s) => s !== sellerName),
      });
    });
  });

  // "Empacota" as rotas de cada vendedor em linhas: reaproveita uma linha já
  // existente daquele vendedor se o dia estiver livre nela; só cria linha nova
  // quando o vendedor já tem outra rota no mesmo dia (ex: duas cidades no mesmo dia)
  const packedRows = [];
  Object.keys(vendorGroups)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((vendorKey) => {
      const entries = vendorGroups[vendorKey].slice().sort(
        (a, b) => GRADE_DAYS.indexOf(a.day) - GRADE_DAYS.indexOf(b.day)
      );
      const rowsForVendor = [];
      entries.forEach((entry) => {
        let targetRow = rowsForVendor.find((r) => !r.cells[entry.day]);
        if (!targetRow) {
          const cells = {};
          GRADE_DAYS.forEach((d) => (cells[d] = null));
          targetRow = { vendorKey, cells };
          rowsForVendor.push(targetRow);
        }
        targetRow.cells[entry.day] = entry;
      });
      packedRows.push(...rowsForVendor);
    });

  return packedRows;
}

function renderGradeBoard() {
  const board = document.getElementById("gradeBoard");
  document.getElementById("gradeAdminHint").classList.toggle("hidden", !Auth.isAdmin);
  board.innerHTML = "";

  const packedRows = computePackedGradeRows();

  const table = document.createElement("table");
  table.className = "grade-table";

  // Larguras em porcentagem (soma 100%) — garante que a semana inteira caiba na
  // tela, sem precisar de rolagem lateral, não importa o tamanho da janela.
  const colgroup = document.createElement("colgroup");
  const vendorCol = document.createElement("col");
  vendorCol.style.width = "15%";
  colgroup.appendChild(vendorCol);
  GRADE_DAYS.forEach(() => {
    [3, 7, 4, 3].forEach((pct) => {
      const col = document.createElement("col");
      col.style.width = `${(85 / GRADE_DAYS.length) * (pct / 17)}%`;
      colgroup.appendChild(col);
    });
  });
  table.appendChild(colgroup);

  // Cabeçalho: linha 1 = dia (carreg/entrega + capacidade), linha 2 = Veic/Rota/Peso/Perfil
  const thead = document.createElement("thead");
  const dayRow = document.createElement("tr");
  dayRow.innerHTML = `<th rowspan="2" class="gt-col-vendor">Vendedor</th>`;
  const subRow = document.createElement("tr");

  GRADE_DAYS.forEach((day) => {
    const total = Grade.days[day]
      .filter((r) => Regions.list.some((reg) => reg.id === r.regionId))
      .reduce((sum, r) => sum + (profileCapacity(r.profile) || 0) * (r.quantity || 1), 0);
    const th = document.createElement("th");
    th.colSpan = 4;
    th.className = "gt-day-group-th";
    th.dataset.day = day;
    th.innerHTML = `CARREG. ${GRADE_DAY_NAMES[day]} <span class="gt-day-sub">→ ENTREGA ${GRADE_DAY_NAMES[GRADE_NEXT_DAY[day]]}</span><br><span class="gt-day-total">${total.toLocaleString("pt-BR")} kg</span>`;
    dayRow.appendChild(th);

    ["Veic", "Rota", "Peso", "Perfil"].forEach((label) => {
      const subTh = document.createElement("th");
      subTh.className = "gt-sub-th";
      subTh.dataset.day = day;
      subTh.textContent = label;
      subRow.appendChild(subTh);
    });
  });
  thead.appendChild(dayRow);
  thead.appendChild(subRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  if (packedRows.length === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `<td colspan="${1 + GRADE_DAYS.length * 4}" class="gt-empty-msg">Arraste uma região da lista lateral até a coluna do dia certo pra começar a grade.</td>`;
    tbody.appendChild(emptyRow);
  }

  packedRows.forEach((rowData) => {
    const row = document.createElement("tr");

    // Junta quem divide veículo em qualquer dia dessa linha, num resumo só,
    // abreviado, embaixo do nome do vendedor — em vez de repetir por célula.
    const coSellersSet = new Set();
    GRADE_DAYS.forEach((day) => {
      const entry = rowData.cells[day];
      if (entry && entry.coSellers && entry.coSellers.length > 0) {
        entry.coSellers.forEach((s) => coSellersSet.add(s));
      }
    });
    const sharedNote =
      coSellersSet.size > 0
        ? `<div class="gt-vendor-shared-note">com: ${Array.from(coSellersSet).map(abbreviateName).join(", ")}</div>`
        : "";
    row.innerHTML = `<td class="gt-col-vendor">${rowData.vendorKey}${sharedNote}</td>`;

    GRADE_DAYS.forEach((day) => {
      const entry = rowData.cells[day];
      if (!entry) {
        const dash = document.createElement("td");
        dash.className = "gt-dash-cell";
        dash.colSpan = 4;
        dash.dataset.day = day;
        dash.innerHTML = `<span class="gt-dash">—</span>`;
        row.appendChild(dash);
        return;
      }
      buildGradeRouteCells(row, day, entry.route, entry.region, entry.coSellers);
    });

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  board.appendChild(table);

  board.appendChild(buildGradeFleetSummary());
}

// Tabela resumo: quantos veículos de cada perfil são necessários em cada dia,
// somando a quantidade de todas as rotas daquele perfil naquele dia.
// ------------------------------------------------------------
// Aba Veículos — mesmo resumo que já aparece embaixo da Grade, só que numa
// aba própria, maior, com gráfico — só visível pro admin.
// ------------------------------------------------------------
const PROFILE_CHART_COLORS = {
  Vuc: "#3498db",
  "3/4 Leve": "#2ecc71",
  "3/4 Adaptado": "#f39c12",
  Toco: "#9b59b6",
  Truck: "#e74c3c",
};

function renderVehiclesView() {
  document.getElementById("vehiclesChart").innerHTML = buildFleetChartSVG();
  const tableWrap = document.getElementById("vehiclesTableWrap");
  tableWrap.innerHTML = "";
  tableWrap.appendChild(buildGradeFleetSummary());
}

function buildFleetChartSVG() {
  const width = 900;
  const height = 260;
  const marginLeft = 34;
  const marginBottom = 26;
  const marginTop = 14;
  const chartW = width - marginLeft - 16;
  const chartH = height - marginBottom - marginTop;

  const data = GRADE_DAYS.map((day) => {
    const counts = {};
    VEHICLE_PROFILES.forEach((p) => {
      counts[p.name] = Grade.days[day]
        .filter((r) => r.profile === p.name && Regions.list.some((reg) => reg.id === r.regionId))
        .reduce((s, r) => s + (r.quantity || 1), 0);
    });
    return { day, counts };
  });

  let maxVal = 1;
  data.forEach((d) => VEHICLE_PROFILES.forEach((p) => { if (d.counts[p.name] > maxVal) maxVal = d.counts[p.name]; }));
  maxVal = Math.max(2, Math.ceil(maxVal / 2) * 2);

  const groupWidth = chartW / GRADE_DAYS.length;
  const barGap = 3;
  const barWidth = (groupWidth - barGap * (VEHICLE_PROFILES.length + 1)) / VEHICLE_PROFILES.length;

  let gridLines = "";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = Math.round((maxVal / steps) * i);
    const y = marginTop + chartH - (val / maxVal) * chartH;
    gridLines += `<line x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${width - 16}" y2="${y.toFixed(1)}" stroke="#e2e6ea" stroke-width="1" />`;
    gridLines += `<text x="${marginLeft - 8}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#767066" text-anchor="end">${val}</text>`;
  }

  let bars = "";
  let labels = "";
  data.forEach((d, di) => {
    const groupX = marginLeft + di * groupWidth;
    VEHICLE_PROFILES.forEach((p, pi) => {
      const val = d.counts[p.name] || 0;
      const barH = (val / maxVal) * chartH;
      const x = groupX + barGap + pi * (barWidth + barGap);
      const y = marginTop + chartH - barH;
      const color = PROFILE_CHART_COLORS[p.name] || "#7f8c8d";
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="2"><title>${p.name} — ${GRADE_DAY_NAMES[d.day]}: ${val}</title></rect>`;
      if (val > 0) {
        bars += `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" fill="#1a2332" text-anchor="middle" font-weight="700">${val}</text>`;
      }
    });
    labels += `<text x="${(groupX + groupWidth / 2).toFixed(1)}" y="${height - 8}" font-size="10.5" fill="#1a2332" text-anchor="middle" font-weight="700">${GRADE_DAY_NAMES[d.day].toUpperCase()}</text>`;
  });

  const legend = VEHICLE_PROFILES.map((p) => {
    const color = PROFILE_CHART_COLORS[p.name] || "#7f8c8d";
    return `<span class="vc-legend-item"><span class="vc-legend-dot" style="background:${color}"></span>${p.name}</span>`;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="vc-svg">
      ${gridLines}
      ${bars}
      ${labels}
    </svg>
    <div class="vc-legend">${legend}</div>
  `;
}

function buildGradeFleetSummary() {
  const summary = document.createElement("table");
  summary.className = "grade-fleet-summary";
  summary.innerHTML = `<caption>Resumo de veículos por dia (quantidade por perfil)</caption>`;

  // Mesma largura em porcentagem da tabela principal (15% + 5 × 17%), pra ficar
  // sempre alinhado visualmente com as colunas de cima, em qualquer tela.
  const colgroup = document.createElement("colgroup");
  const firstCol = document.createElement("col");
  firstCol.style.width = "15%";
  colgroup.appendChild(firstCol);
  GRADE_DAYS.forEach(() => {
    const col = document.createElement("col");
    col.style.width = "17%";
    colgroup.appendChild(col);
  });
  summary.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = `<th class="gfs-profile-col">Perfil</th>`;
  GRADE_DAYS.forEach((day) => {
    const th = document.createElement("th");
    th.innerHTML = `CARREG. ${GRADE_DAY_NAMES[day]} <span class="gt-day-sub">→ ENTREGA ${GRADE_DAY_NAMES[GRADE_NEXT_DAY[day]]}</span>`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  summary.appendChild(thead);

  const tbody = document.createElement("tbody");
  VEHICLE_PROFILES.forEach((profile) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="gfs-profile-col">${profile.name}</td>`;
    GRADE_DAYS.forEach((day) => {
      // Só conta rotas cuja região ainda existe de verdade — igual a tabela de
      // cima já faz. Antes, uma rota "fantasma" (de região já apagada) ainda
      // entrava na soma aqui, mesmo sem aparecer na tabela — daí a conta batia
      // errado.
      const count = Grade.days[day]
        .filter((r) => r.profile === profile.name && Regions.list.some((reg) => reg.id === r.regionId))
        .reduce((sum, r) => sum + (r.quantity || 1), 0);
      const td = document.createElement("td");
      td.className = count > 0 ? "gfs-nonzero" : "gfs-zero";
      td.textContent = count > 0 ? count : "—";
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  summary.appendChild(tbody);

  return summary;
}

// Monta as 4 células (Veic | Rota | Peso | Perfil) de uma rota, e insere na linha
function buildGradeRouteCells(row, day, route, region, coSellers) {
  const cap = profileCapacity(route.profile);
  const quantity = route.quantity || 1;
  const totalWeight = cap !== null ? cap * quantity : null;
  const regionProfileCap = profileCapacity(region.vehicleProfile);
  const underCapacity = totalWeight !== null && regionProfileCap !== null && totalWeight < regionProfileCap;
  const isShared = coSellers && coSellers.length > 0;

  // Veic (quantidade)
  const veicTd = document.createElement("td");
  veicTd.className = "gt-cell gt-cell-veic";
  veicTd.dataset.day = day;
  veicTd.innerHTML = `
    <div class="qty-stepper">
      <button class="qty-btn" data-op="dec" ${!Auth.isAdmin ? "disabled" : ""}>−</button>
      <span class="qty-value">${quantity}</span>
      <button class="qty-btn" data-op="inc" ${!Auth.isAdmin ? "disabled" : ""}>+</button>
    </div>
  `;

  // Rota (nome da região) + selo de compartilhado + botão de remover
  const rotaTd = document.createElement("td");
  rotaTd.className = "gt-cell gt-cell-rota";
  rotaTd.dataset.day = day;
  rotaTd.innerHTML = `
    <span class="grc-swatch" style="background:${region.color}"></span><span class="gri-region-clickable">${region.name}</span>
    ${isShared ? `<span class="gt-shared-tag" title="Divide veículo com: ${coSellers.join(", ")} — conta uma vez só no total do dia">🔗 compartilhado</span>` : ""}
    ${Auth.isAdmin ? `<button class="gt-remove" title="Remover">✕</button>` : ""}
  `;
  rotaTd.querySelector(".gri-region-clickable").addEventListener("click", () => {
    openGradeRegionInfo(region.id);
  });

  // Peso
  const pesoTd = document.createElement("td");
  pesoTd.className = "gt-cell gt-cell-peso";
  pesoTd.dataset.day = day;
  pesoTd.innerHTML = `${totalWeight !== null ? `${totalWeight.toLocaleString("pt-BR")} kg` : "—"}${
    underCapacity
      ? `<span class="gt-warn-icon" title="Abaixo do perfil mínimo da região (${region.vehicleProfile}, ${regionProfileCap.toLocaleString("pt-BR")} kg)">⚠️</span>`
      : ""
  }`;

  // Perfil
  const perfilTd = document.createElement("td");
  perfilTd.className = "gt-cell gt-cell-perfil";
  perfilTd.dataset.day = day;
  perfilTd.innerHTML = Auth.isAdmin
    ? `<select class="gt-profile-select">${VEHICLE_PROFILES.map(
        (p) => `<option value="${p.name}" ${p.name === route.profile ? "selected" : ""}>${p.name}</option>`
      ).join("")}</select>`
    : `<span class="gt-profile-fixed">${route.profile}</span>`;

  row.appendChild(veicTd);
  row.appendChild(rotaTd);
  row.appendChild(pesoTd);
  row.appendChild(perfilTd);

  if (Auth.isAdmin) {
    veicTd.querySelectorAll(".qty-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = btn.dataset.op === "inc" ? 1 : -1;
        Grade.setRouteQuantity(day, route.id, quantity + delta);
        updateDraftHint();
        renderGradeBoard();
      });
    });
    rotaTd.querySelector(".gt-remove").addEventListener("click", () => {
      Grade.removeRoute(day, route.id);
      updateDraftHint();
      renderGradeBoard();
      renderGradeRegionList();
    });
    const select = perfilTd.querySelector(".gt-profile-select");
    select.addEventListener("change", (e) => {
      Grade.setRouteProfile(day, route.id, e.target.value);
      updateDraftHint();
      renderGradeBoard();
    });
  }
}

// Detalhes de uma região (cidades + cidades-chave) — disponível pra qualquer
// pessoa que clicar numa região dentro da Grade, admin ou não.
// ------------------------------------------------------------
function openGradeRegionInfo(regionId) {
  const region = Regions.list.find((r) => r.id === regionId);
  if (!region) return;

  document.getElementById("gradeRegionInfoTitle").textContent = region.name;
  document.getElementById("gradeRegionInfoMeta").textContent =
    `${region.cities.length} cidade(s) · perfil mínimo: ${region.vehicleProfile}`;

  const box = document.getElementById("gradeRegionInfoCities");
  box.innerHTML = "";
  region.cities
    .slice()
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((city) => {
      const allRegions = Regions.findByCity(city);
      const key = allRegions.length > 1;
      const row = document.createElement("div");
      row.className = "gri-city-row" + (key ? " gri-key" : "");
      let html = `${key ? '<span class="gri-key-badge">🔑</span>' : ""}<span class="gri-city-name">${city}</span>`;
      if (key) {
        const others = allRegions
          .filter((r) => r.id !== region.id)
          .map((r) => r.name)
          .join(", ");
        html += `<div class="gri-key-note">Cidade-chave — também compõe: ${others}</div>`;
      }
      row.innerHTML = html;
      box.appendChild(row);
    });

  document.getElementById("gradeRegionInfoModal").classList.remove("hidden");
}

function closeGradeRegionInfo() {
  document.getElementById("gradeRegionInfoModal").classList.add("hidden");
}

// Relatório: Grade Cidades-Roteiros
// ------------------------------------------------------------
function openGradeCitiesModal() {
  document.getElementById("gradeCitiesSearch").value = "";
  renderGradeCitiesList("");
  document.getElementById("gradeCitiesModal").classList.remove("hidden");
}

function closeGradeCitiesModal() {
  document.getElementById("gradeCitiesModal").classList.add("hidden");
}

function renderGradeCitiesList(filterText) {
  const box = document.getElementById("gradeCitiesList");
  const filter = normalizeStr(filterText || "");
  box.innerHTML = "";

  CITIES_LIST.slice()
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .filter((c) => !filter || normalizeStr(c).includes(filter))
    .forEach((city) => {
      const regions = Regions.findByCity(city);
      const row = document.createElement("div");
      row.className = "gcl-row";
      const key = isKeyCity(city) ? `<span class="gcl-key">🔑</span>` : `<span style="width:16px;display:inline-block;"></span>`;
      const regionNames = regions.length > 0 ? regions.map((r) => r.name).join(", ") : "sem região definida";
      row.innerHTML = `${key}<span class="gcl-name">${city}</span><span class="gcl-regions">${regionNames}</span>`;
      box.appendChild(row);
    });
}

function updateAdminUI() {
  const badge = document.getElementById("modeBadge");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");
  const adminToolbar = document.getElementById("adminToolbar");

  document.body.classList.toggle("is-admin", Auth.isAdmin);
  if (!Auth.isAdmin && currentTab === "vehicles") switchTab("map");

  if (Auth.isAdmin) {
    badge.textContent = "Modo admin";
    badge.className = "badge badge-admin";
    btnLogin.classList.add("hidden");
    btnLogout.classList.remove("hidden");
    adminToolbar.classList.toggle("hidden", currentTab !== "map");
    map.addControl(drawControl);
  } else {
    badge.textContent = "Modo visualização";
    badge.className = "badge badge-view";
    btnLogin.classList.remove("hidden");
    btnLogout.classList.add("hidden");
    adminToolbar.classList.add("hidden");
    document.getElementById("searchResultBox").classList.add("hidden");
    closeRegionModal();
    closeConflictsPanel();
    closePdfModal();
    closeEditCitySellersModal();
    closeKeyCityModal();
    closeDedupeModal();
    closeChangePasswordModal();
    closeGithubPublishModal();
    closeImportOrdersModal();
    closeGradeCitiesModal();
    closeRouteSellersModal();
    clearSearchPreview();
    if (map.hasLayer && drawControl._map) map.removeControl(drawControl);
  }

  updateDraftHint();
  if (currentTab === "grade") {
    renderGradeBoard();
    renderGradeRegionList();
  }

  setMarkersDraggable(Auth.isAdmin);
  renderRegionsList();
  setTimeout(() => map.invalidateSize(), 60);
}

function wireEvents() {
  document.getElementById("btnPresentMode").addEventListener("click", () => togglePresentationMode());

  document.getElementById("tabMapBtn").addEventListener("click", () => switchTab("map"));
  document.getElementById("tabGradeBtn").addEventListener("click", () => switchTab("grade"));
  document.getElementById("tabVehiclesBtn").addEventListener("click", () => switchTab("vehicles"));

  document.getElementById("btnCancelRouteSellers").addEventListener("click", closeRouteSellersModal);
  document.getElementById("btnConfirmRouteSellers").addEventListener("click", confirmRouteSellers);
  document.getElementById("routeSellersOverlay").addEventListener("click", (e) => {
    if (e.target.id === "routeSellersOverlay") closeRouteSellersModal(); // clicar fora fecha
  });

  document.getElementById("btnGradeCitiesReport").addEventListener("click", openGradeCitiesModal);
  document.getElementById("btnGradePdf").addEventListener("click", generateGradePdf);
  document.getElementById("btnCloseGradeCities").addEventListener("click", closeGradeCitiesModal);
  document.getElementById("btnCloseGradeRegionInfo").addEventListener("click", closeGradeRegionInfo);
  document.getElementById("gradeCitiesSearch").addEventListener("input", (e) => {
    renderGradeCitiesList(e.target.value);
  });
  document.getElementById("btnExitPresent").addEventListener("click", () => togglePresentationMode(false));

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
    if (Regions.hasDraft() || hasCityDirectoryDraft()) {
      const wantsExport = confirm(
        "Você tem alterações não publicadas (regiões e/ou cidades/vendedores). Clique em OK pra exportar tudo agora antes de sair, ou Cancelar pra sair sem exportar (não recomendado)."
      );
      if (wantsExport) {
        exportEverythingNow();
      }
    }
    Auth.logout();
    updateAdminUI();
  });

  document.getElementById("btnDraftHintExport").addEventListener("click", exportEverythingNow);

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
  document.getElementById("regionMergeTarget").addEventListener("change", updateRegionModalMergeState);

  document.getElementById("btnExportMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    document.getElementById("exportDropdown").classList.toggle("hidden");
  });
  document.getElementById("btnOtherActionsMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("exportDropdown").classList.add("hidden");
    document.getElementById("otherActionsDropdown").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".export-dropdown-wrap")) {
      document.getElementById("exportDropdown").classList.add("hidden");
      document.getElementById("otherActionsDropdown").classList.add("hidden");
    }
  });
  document.getElementById("btnDoExport").addEventListener("click", () => {
    const wantRegions = document.getElementById("expRegions").checked;
    const wantCities = document.getElementById("expCities").checked;
    const wantDirectory = document.getElementById("expDirectory").checked;
    const wantGrade = document.getElementById("expGrade").checked;
    if (!wantRegions && !wantCities && !wantDirectory && !wantGrade) {
      alert("Selecione ao menos um item para exportar.");
      return;
    }
    let delay = 0;
    if (wantRegions) {
      setTimeout(() => downloadFile("regions.json", Regions.exportJSON()), delay);
      delay += 300;
    }
    if (wantCities) {
      setTimeout(() => downloadFile("cities.json", Geocode.exportJSON()), delay);
      delay += 300;
    }
    if (wantDirectory) {
      setTimeout(exportDirectory, delay);
      delay += 900;
    }
    if (wantGrade) {
      setTimeout(() => downloadFile("grade.json", Grade.exportJSON()), delay);
    }
    document.getElementById("exportDropdown").classList.add("hidden");
  });

  document.getElementById("btnDedupeFromMenu").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    openDedupeModal();
  });
  document.getElementById("btnStandardizeFromMenu").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    standardizeAllCityNames();
  });
  document.getElementById("btnReverifyFromMenu").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    reverifyAllCities();
  });
  document.getElementById("btnChangePasswordFromMenu").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    openChangePasswordModal();
  });
  document.getElementById("btnCloseChangePassword").addEventListener("click", closeChangePasswordModal);
  document.getElementById("btnCancelChangePassword").addEventListener("click", closeChangePasswordModal);
  document.getElementById("btnGenerateNewConfig").addEventListener("click", generateNewConfigFile);
  document.getElementById("btnOpenGithubPublish").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    openGithubPublishModal();
  });
  document.getElementById("btnCloseGithubPublish").addEventListener("click", closeGithubPublishModal);
  document.getElementById("btnSaveGithubConfig").addEventListener("click", saveGithubConfigFromForm);
  document.getElementById("btnPublishNow").addEventListener("click", publishAllToGitHub);

  document.getElementById("btnOpenImportOrders").addEventListener("click", openImportOrdersModal);
  document.getElementById("btnCloseImportOrders").addEventListener("click", closeImportOrdersModal);
  document.getElementById("btnCancelImportOrders").addEventListener("click", closeImportOrdersModal);
  document.getElementById("btnCloseImportOrdersStep3").addEventListener("click", closeImportOrdersModal);
  document.getElementById("ordersFileInput").addEventListener("change", handleOrdersFileSelected);
  document.getElementById("btnProcessImportOrders").addEventListener("click", processImportOrders);
  document.getElementById("btnClearOrders").addEventListener("click", clearImportedOrders);
  document.getElementById("toggleOrdersLayer").addEventListener("change", (e) => {
    if (!ordersLayerGroup) return;
    if (e.target.checked) {
      map.addLayer(ordersLayerGroup);
    } else {
      map.removeLayer(ordersLayerGroup);
    }
  });

  document.getElementById("btnNewCity").addEventListener("click", openNewCityModal);
  document.getElementById("btnNewCityCancel").addEventListener("click", closeNewCityModal);
  document.getElementById("btnNewCitySave").addEventListener("click", saveNewCity);

  document.getElementById("btnConflicts").addEventListener("click", openConflictsPanel);
  document.getElementById("btnCloseConflicts").addEventListener("click", closeConflictsPanel);
  document.getElementById("btnCloseEditCitySellers").addEventListener("click", closeEditCitySellersModal);
  document.getElementById("btnCancelEditCitySellers").addEventListener("click", closeEditCitySellersModal);
  document.getElementById("btnSaveEditCitySellers").addEventListener("click", saveEditCitySellers);
  document.getElementById("btnAddNewSeller").addEventListener("click", addNewSellerToChecklist);
  document.getElementById("newSellerNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNewSellerToChecklist();
    }
  });
  document.getElementById("btnCloseKeyCity").addEventListener("click", closeKeyCityModal);
  document.getElementById("btnCancelKeyCity").addEventListener("click", closeKeyCityModal);
  document.getElementById("btnSaveKeyCity").addEventListener("click", saveKeyCityRegions);
  document.getElementById("btnToggleNewRegionInKeyCity").addEventListener("click", () => {
    document.getElementById("newRegionInKeyCityForm").classList.toggle("hidden");
  });
  document.getElementById("btnCreateRegionInKeyCity").addEventListener("click", createRegionFromKeyCityModal);
  document.getElementById("btnCloseDedupe").addEventListener("click", closeDedupeModal);
  document.getElementById("btnRunCommand").addEventListener("click", runConflictCommand);

  document.getElementById("btnOpenPdf").addEventListener("click", openPdfModal);
  document.getElementById("btnExportFilialExcel").addEventListener("click", exportFilialExcel);
  document.getElementById("btnClosePdf").addEventListener("click", closePdfModal);
  document.getElementById("btnGeneratePdf").addEventListener("click", generatePdf);
  document.querySelectorAll('input[name="pdfScope"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      document.getElementById("pdfVendorBlock").classList.toggle("hidden", e.target.value !== "vendedor");
      document.getElementById("pdfRegionBlock").classList.toggle("hidden", e.target.value !== "regiao");
    });
  });

  document.getElementById("searchCitySelect").addEventListener("change", (e) => {
    if (e.target.value) {
      document.getElementById("searchAddressInput").value = buildNominatimQuery(e.target.value);
    }
  });

  document.getElementById("btnSearchAddress").addEventListener("click", doSearchAddress);

  document.getElementById("btnCloseRegionDetail").addEventListener("click", closeRegionDetail);
  document.getElementById("btnMinimizeRegionDetail").addEventListener("click", toggleMinimizeRegionDetail);
  document.getElementById("btnToggleRings").addEventListener("click", toggleRings);
  document.getElementById("btnToggleFence").addEventListener("click", toggleFence);
  document.getElementById("toggleNeighborRegions").addEventListener("change", (e) => {
    showNeighborRegions = e.target.checked;
    rebuildClusters();
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
