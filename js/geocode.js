// ============================================================
// GEOCODIFICAÇÃO — converte "Cidade - UF" em lat/lng usando o
// Nominatim (OpenStreetMap), gratuito. Guarda tudo em cache
// (localStorage + arquivo data/cities.json) para não repetir
// as buscas toda vez que alguém abre o app.
// ============================================================

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
      const url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      if (data && data[0]) {
        this.cache[label] = {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
        };
      } else {
        this.cache[label] = { lat: null, lng: null, error: "não encontrado" };
      }
    } catch (e) {
      this.cache[label] = { lat: null, lng: null, error: String(e) };
    }
  },

  async geocodeOrigin() {
    const key = "__ORIGIN__";
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
