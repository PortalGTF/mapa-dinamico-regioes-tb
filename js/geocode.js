// ============================================================
// GEOCODIFICAÇÃO — converte "Cidade - UF" em lat/lng usando o
// Nominatim (OpenStreetMap), gratuito. Guarda tudo em cache
// (localStorage + arquivo data/cities.json) para não repetir
// as buscas toda vez que alguém abre o app.
// ============================================================

// Nome completo do estado (como o Nominatim costuma retornar) -> sigla
const BR_STATES = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA",
  ceara: "CE", "distrito federal": "DF", "espirito santo": "ES", goias: "GO",
  maranhao: "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
  "minas gerais": "MG", para: "PA", paraiba: "PB", parana: "PR",
  pernambuco: "PE", piaui: "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO",
  roraima: "RR", "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE",
  tocantins: "TO",
};

function normalizeStr(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function extractUF(cityLabel) {
  const m = cityLabel.match(/-\s*([A-Za-z]{2})\s*$/);
  return m ? m[1].toUpperCase() : null;
}

const Geocode = {
  cache: {}, // { "Cidade - UF": {lat, lng} }
  queue: [],
  processing: false,

  async loadCommittedCache() {
    try {
      const res = await fetch("data/cities.json", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        this.cache = { ...data, ...this.cache };
      }
    } catch (e) {
      // arquivo pode ainda não existir na primeira execução — tudo bem
    }
    this.loadLocalCache();
  },

  loadLocalCache() {
    try {
      const raw = localStorage.getItem("regioes_cities_cache");
      if (raw) this.cache = { ...this.cache, ...JSON.parse(raw) };
    } catch (e) {}
  },

  saveLocalCache() {
    try {
      localStorage.setItem("regioes_cities_cache", JSON.stringify(this.cache));
    } catch (e) {}
  },

  has(cityLabel) {
    return !!this.cache[cityLabel];
  },

  get(cityLabel) {
    return this.cache[cityLabel] || null;
  },

  // Geocodifica uma lista de cidades respeitando 1 req/seg (regra de uso do Nominatim).
  // onProgress(done, total) é chamado a cada cidade processada.
  async geocodeAll(cityLabels, onProgress) {
    const pending = cityLabels.filter((c) => !this.has(c));
    let done = cityLabels.length - pending.length;
    if (onProgress) onProgress(done, cityLabels.length);

    for (const label of pending) {
      await this._geocodeOne(label);
      done++;
      if (onProgress) onProgress(done, cityLabels.length);
      await new Promise((r) => setTimeout(r, 1100)); // respeita limite do Nominatim
    }
    this.saveLocalCache();
  },

  async _geocodeOne(label) {
    try {
      const query = `${label}, Brasil`;
      const url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&addressdetails=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      if (data && data[0]) {
        const entry = {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
        };

        // Confere se o estado devolvido pela busca bate com a UF do nome da
        // cidade (ex: "Moreira Sales - PR" tem que cair no Paraná). Se não
        // bater, marca como suspeito para avisar visualmente no mapa.
        const expectedUF = extractUF(label);
        const stateFound = data[0].address && data[0].address.state;
        if (expectedUF && stateFound) {
          const stateUF = BR_STATES[normalizeStr(stateFound)];
          entry.stateFound = stateFound;
          entry.suspect = stateUF !== expectedUF;
        }

        this.cache[label] = entry;
      } else {
        this.cache[label] = { lat: null, lng: null, error: "não encontrado" };
      }
    } catch (e) {
      this.cache[label] = { lat: null, lng: null, error: String(e) };
    }
  },

  // Busca livre de endereço (usada no campo de busca manual). Não mexe no
  // cache — quem chamou decide se aplica o resultado a alguma cidade.
  async searchAddress(query) {
    try {
      const url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&addressdetails=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (data && data[0]) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          displayName: data[0].display_name,
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  async geocodeOrigin() {
    const key = "__ORIGIN__";

    // Se coordenadas fixas foram definidas em config.js, usa elas direto —
    // mais confiável do que tentar geocodificar o nome de uma empresa.
    if (typeof CONFIG.ORIGIN_LAT === "number" && typeof CONFIG.ORIGIN_LNG === "number") {
      const fixed = { lat: CONFIG.ORIGIN_LAT, lng: CONFIG.ORIGIN_LNG };
      this.cache[key] = fixed;
      return fixed;
    }

    if (this.has(key)) return this.get(key);
    await this._geocodeOne(CONFIG.ORIGIN_ADDRESS);
    const result = this.cache[CONFIG.ORIGIN_ADDRESS];
    if (result) {
      this.cache[key] = result;
      delete this.cache[CONFIG.ORIGIN_ADDRESS];
    }
    this.saveLocalCache();
    return this.get(key);
  },

  exportJSON() {
    const clean = {};
    Object.keys(this.cache)
      .sort()
      .forEach((k) => (clean[k] = this.cache[k]));
    return JSON.stringify(clean, null, 2);
  },
};
