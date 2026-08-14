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
  await Geocode.loadCommittedCache();

  initMap();
  await placeOrigin();

  renderSellerOptions();
  renderSearchCityOptions();
  renderRegionsList();
  updateAdminUI();

  document.getElementById("searchAddressInput").value = "";

  wireEvents();
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

// Descarta qualquer edição salva só no navegador (regiões e diretório) e recarrega
// a página, forçando o uso do que está publicado no GitHub. Não apaga nada que já
// foi publicado — só limpa o que estava só localmente.
function discardAllLocalDrafts() {
  if (!Auth.isAdmin) return;
  if (
    !confirm(
      "Isso descarta qualquer edição salva só neste navegador (regiões e diretório de vendedores/cidades) e recarrega a página, usando só o que está publicado no GitHub. Não afeta o que já foi publicado. Continuar?"
    )
  ) {
    return;
  }
  Regions.discardDraft();
  localStorage.removeItem("regioes_directory_draft");
  location.reload();
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
    let dim = false;

    if (focusedRegionId) {
      const focusedRegion = Regions.list.find((r) => r.id === focusedRegionId);
      const inFocusedRegion = focusedRegion && focusedRegion.cities.includes(label);

      if (!showNeighborRegions && !inFocusedRegion) {
        return; // fora da região em foco: fica invisível, a não ser que "mostrar vizinhas" esteja marcado
      }
      if (activeSellerFilter && inFocusedRegion && !(CITY_TO_SELLERS[label] || []).includes(activeSellerFilter)) {
        dim = true; // dentro da região em foco, mas de outro vendedor: aparece desfocada, não escondida
      }
    } else if (activeSellerFilter && !(SELLERS[activeSellerFilter] || []).includes(label)) {
      return; // sem região em foco: filtro de vendedor tradicional, esconde quem não é dele
    }

    const coord = Geocode.get(label);
    marker.setIcon(createCityIcon(colorForCity(label), isSuspect(coord)));
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
  marker.setIcon(createCityIcon(colorForCity(cityLabel), isSuspect(coord)));
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
      const row = document.createElement("div");
      row.className = "region-row";
      row.innerHTML = `
        <span class="swatch" style="background:${region.color}"></span>
        <div class="region-info">
          <div class="region-name">${region.name}</div>
          <div class="region-meta">${count} cidade(s) de ${sellerName} · perfil mínimo: ${region.vehicleProfile}</div>
        </div>
      `;
      row.addEventListener("click", () => {
        // Mantém o filtro de vendedor ativo — só foca na região, não reseta o filtro
        focusedRegionId = region.id;
        showNeighborRegions = false;
        rebuildClusters();
        focusRegion(region);
        showRegionFence(region);
        if (isPresenting()) {
          showPresentationBurst(region);
        } else {
          openRegionDetail(region);
        }
      });
      citiesBox.appendChild(row);

      // Cidades dessa região que pertencem a outro vendedor (não o filtrado)
      const foreignCities = region.cities.filter((c) => !(CITY_TO_SELLERS[c] || []).includes(sellerName));
      if (foreignCities.length > 0) {
        const block = document.createElement("div");
        block.className = "seller-conflict-block";
        block.innerHTML =
          `<div class="scb-title">⚠️ ${foreignCities.length} cidade(s) dessa região está(ão) no nome de outro vendedor:</div>` +
          foreignCities
            .map(
              (c) => `
            <div class="scb-city">
              <span class="scb-city-name">${c}</span>
              <span class="scb-city-seller">${(CITY_TO_SELLERS[c] || []).join(", ") || "—"}</span>
              ${Auth.isAdmin ? `<button class="scb-edit-btn" data-city="${c}">editar</button>` : ""}
            </div>`
            )
            .join("");
        citiesBox.appendChild(block);

        block.querySelectorAll(".scb-edit-btn").forEach((btn) => {
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
    // Soma as cidades capturadas à região já existente, sem duplicar as que já estavam nela
    const target = Regions.list.find((r) => r.id === mergeId);
    if (target) {
      const merged = Array.from(new Set([...target.cities, ...checked]));
      Regions.update(mergeId, { cities: merged });
    }
  } else if (editingRegionId) {
    Regions.update(editingRegionId, { name, vehicleProfile, cities: checked, color });
  } else {
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

function openEditCitySellersModal(cityLabel, marker) {
  if (!Auth.isAdmin) return;
  editingCitySellersLabel = cityLabel;
  editingCitySellersMarker = marker;

  document.getElementById("editCitySellersTitle").textContent = `Editar vendedor(es) — ${cityLabel}`;

  const current = CITY_TO_SELLERS[cityLabel] || [];
  const checklist = document.getElementById("editCitySellersChecklist");
  checklist.innerHTML = `<p class="hint hint-small">Atende hoje: ${current.join(", ") || "ninguém"}. Marque abaixo quem deve atender daqui pra frente (nada vem pré-marcado).</p>`;
  Object.keys(SELLERS)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((name) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${name}" /> ${name}`;
      checklist.appendChild(label);
    });

  document.getElementById("editCitySellersModal").classList.remove("hidden");
}

function closeEditCitySellersModal() {
  document.getElementById("editCitySellersModal").classList.add("hidden");
  editingCitySellersLabel = null;
  editingCitySellersMarker = null;
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
  const pendingDrafts = [];
  if (Regions.hasDraft()) pendingDrafts.push("regiões (regions.json)");
  if (hasCityDirectoryDraft()) pendingDrafts.push("cidades/vendedores (diretório)");
  document.getElementById("draftHint").textContent =
    pendingDrafts.length > 0 ? `Alterações não publicadas: ${pendingDrafts.join(" e ")}.` : "";

  const marker = editingCitySellersMarker;
  closeEditCitySellersModal();
  if (marker) openCityPopup(city, marker);

  rebuildClusters();
  invalidateRegionRadiusCache();
  if (activeSellerFilter) {
    applySellerFilter(activeSellerFilter); // refaz a lista lateral: a cidade some do aviso se não estiver mais em conflito
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
    closeConflictsPanel();
    closePdfModal();
    closeEditCitySellersModal();
    closeDedupeModal();
    clearSearchPreview();
    if (map.hasLayer && drawControl._map) map.removeControl(drawControl);
  }

  const pendingDrafts = [];
  if (Regions.hasDraft()) pendingDrafts.push("regiões (regions.json)");
  if (hasCityDirectoryDraft()) pendingDrafts.push("cidades/vendedores (diretório)");
  document.getElementById("draftHint").textContent =
    pendingDrafts.length > 0
      ? `Alterações não publicadas: ${pendingDrafts.join(" e ")}.`
      : "";

  setMarkersDraggable(Auth.isAdmin);
  renderRegionsList();
  setTimeout(() => map.invalidateSize(), 60);
}

function wireEvents() {
  document.getElementById("btnPresentMode").addEventListener("click", () => togglePresentationMode());
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
    if (!wantRegions && !wantCities && !wantDirectory) {
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
  document.getElementById("btnDiscardDraftsFromMenu").addEventListener("click", () => {
    document.getElementById("otherActionsDropdown").classList.add("hidden");
    discardAllLocalDrafts();
  });

  document.getElementById("btnNewCity").addEventListener("click", openNewCityModal);
  document.getElementById("btnNewCityCancel").addEventListener("click", closeNewCityModal);
  document.getElementById("btnNewCitySave").addEventListener("click", saveNewCity);

  document.getElementById("btnConflicts").addEventListener("click", openConflictsPanel);
  document.getElementById("btnCloseConflicts").addEventListener("click", closeConflictsPanel);
  document.getElementById("btnCloseEditCitySellers").addEventListener("click", closeEditCitySellersModal);
  document.getElementById("btnCancelEditCitySellers").addEventListener("click", closeEditCitySellersModal);
  document.getElementById("btnSaveEditCitySellers").addEventListener("click", saveEditCitySellers);
  document.getElementById("btnCloseDedupe").addEventListener("click", closeDedupeModal);
  document.getElementById("btnRunCommand").addEventListener("click", runConflictCommand);

  document.getElementById("btnOpenPdf").addEventListener("click", openPdfModal);
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
