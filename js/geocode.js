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

// UF -> nome completo do estado (usado para montar a busca no formato que o
// Nominatim entende melhor: "Cidade, Estado, Brasil" em vez de "Cidade - UF, Brasil")
const BR_UF_TO_NAME = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
  CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
  MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
  PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
  RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo",
  SE: "Sergipe", TO: "Tocantins",
};

// Monta a string de busca no formato que o Nominatim reconhece melhor.
// "Santa Fé - PR" -> "Santa Fé, Paraná, Brasil" (em vez de "Santa Fé - PR, Brasil",
// que confunde a busca e faz ela cair fora da restrição de estado sem avisar).
function buildNominatimQuery(cityLabel) {
  const uf = extractUF(cityLabel);
  if (!uf || !BR_UF_TO_NAME[uf]) return `${cityLabel}, Brasil`;
  const cityName = cityLabel.replace(/-\s*[A-Za-z]{2}\s*$/, "").trim();
  return `${cityName}, ${BR_UF_TO_NAME[uf]}, Brasil`;
}

// Padroniza o nome da cidade: sempre em CAIXA ALTA, mantendo o formato "CIDADE - UF".
function normalizeCityLabel(cityLabel) {
  const uf = extractUF(cityLabel);
  if (!uf) return cityLabel.toUpperCase().trim();
  const cityName = cityLabel.replace(/-\s*[A-Za-z]{2}\s*$/, "").trim();
  return `${cityName.toUpperCase()} - ${uf}`;
}

// Caixa delimitadora aproximada de cada estado (min-lon, min-lat, max-lon, max-lat),
// com uma margem de segurança. Usada para restringir a busca do Nominatim ao estado
// certo, evitando que ele ache uma cidade de nome parecido em outro canto do Brasil.
const BR_STATE_BBOX = {
  PR: [-55.2, -27.2, -47.8, -22.3],
  SP: [-53.6, -25.6, -43.9, -19.6],
};

function Geocode_buildUrl(query, expectedUF, bounded) {
  let url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&addressdetails=1&q=${encodeURIComponent(query)}`;
  const bbox = expectedUF && BR_STATE_BBOX[expectedUF];
  if (bbox && bounded) {
    // viewbox = left(minLon),top(maxLat),right(maxLon),bottom(minLat)
    url += `&viewbox=${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}&bounded=1`;
  }
  return url;
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
    const query = buildNominatimQuery(label);
    const expectedUF = extractUF(label);

    try {
      // 1ª tentativa: restrita ao estado esperado (evita pegar cidade de nome
      // parecido em outro canto do Brasil, ex: Santa Fé - PR vs Santa Fé no ES)
      let data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, true));
      let fellBackUnbounded = false;

      // Se não achou nada dentro do estado esperado, tenta de novo sem restrição
      if ((!data || !data[0]) && expectedUF && BR_STATE_BBOX[expectedUF]) {
        data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, false));
        fellBackUnbounded = true;
      }

      if (data && data[0]) {
        const entry = {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
        };

        const stateFound = data[0].address && data[0].address.state;
        if (expectedUF && stateFound) {
          const stateUF = BR_STATES[normalizeStr(stateFound)];
          entry.stateFound = stateFound;
          // Se caiu fora do estado esperado mesmo tendo tentado restringir a
          // busca, marca como suspeito para avisar visualmente no mapa.
          entry.suspect = stateUF !== expectedUF || fellBackUnbounded;
        }

        this.cache[label] = entry;
      } else {
        this.cache[label] = { lat: null, lng: null, error: "não encontrado" };
      }
    } catch (e) {
      this.cache[label] = { lat: null, lng: null, error: String(e) };
    }
  },

  async _fetchNominatim(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return res.json();
  },

  // Busca o contorno administrativo real da cidade (limite do município), usado
  // para desenhar a "cerca eletrônica" da região pelas bordas de verdade, e não só
  // uma linha ligando os pontos. Fica em cache junto com as coordenadas da cidade.
  async getCityBoundary(label) {
    const existing = this.cache[label];
    if (existing && Object.prototype.hasOwnProperty.call(existing, "boundary")) {
      return existing.boundary;
    }

    const expectedUF = extractUF(label);
    const query = buildNominatimQuery(label);
    const extra = "&polygon_geojson=1&polygon_threshold=0.003";

    try {
      let data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, true) + extra);
      if ((!data || !data[0]) && expectedUF && BR_STATE_BBOX[expectedUF]) {
        data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, false) + extra);
      }

      let boundary = null;
      if (data && data[0] && data[0].geojson) {
        const t = data[0].geojson.type;
        if (t === "Polygon" || t === "MultiPolygon") boundary = data[0].geojson;
      }

      if (this.cache[label]) this.cache[label].boundary = boundary;
      this.saveLocalCache();
      return boundary;
    } catch (e) {
      if (this.cache[label]) this.cache[label].boundary = null;
      return null;
    }
  },

  // Busca livre de endereço (usada no campo de busca manual). Não mexe no
  // cache — quem chamou decide se aplica o resultado a alguma cidade.
  // Se expectedUF for informado, restringe a busca àquele estado primeiro
  // (mesma lógica usada na geocodificação automática).
  async searchAddress(query, expectedUF) {
    try {
      let data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, true));

      if ((!data || !data[0]) && expectedUF && BR_STATE_BBOX[expectedUF]) {
        data = await this._fetchNominatim(Geocode_buildUrl(query, expectedUF, false));
      }

      if (data && data[0]) {
        const stateFound = data[0].address && data[0].address.state;
        const stateUF = expectedUF && stateFound ? BR_STATES[normalizeStr(stateFound)] : null;
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          displayName: data[0].display_name,
          suspect: !!(expectedUF && stateUF && stateUF !== expectedUF),
          stateFound,
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  // Busca coordenadas por CEP, sempre amarrada ao estado esperado — se o CEP
  // vier de outro estado (ou cair fora da caixa delimitadora daquele estado),
  // descarta o resultado em vez de arriscar cair no lugar errado do Brasil.
  async searchByCep(cep, expectedUF) {
    const cleanCep = String(cep || "").replace(/\D/g, "");
    if (cleanCep.length !== 8) return null;

    const stateName = BR_UF_TO_NAME[expectedUF];
    let url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&addressdetails=1&postalcode=${cleanCep}&country=Brasil`;
    if (stateName) url += `&state=${encodeURIComponent(stateName)}`;

    try {
      const data = await this._fetchNominatim(url);
      if (!data || !data[0]) return null;

      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      const stateFound = data[0].address && data[0].address.state;
      const stateUF = expectedUF && stateFound ? BR_STATES[normalizeStr(stateFound)] : null;

      // Se o Nominatim disse explicitamente que é de outro estado, não confia
      if (expectedUF && stateUF && stateUF !== expectedUF) return null;

      // Segunda checagem, por segurança: o ponto tem que cair dentro da caixa
      // delimitadora do estado esperado
      if (expectedUF && BR_STATE_BBOX[expectedUF]) {
        const [minLon, minLat, maxLon, maxLat] = BR_STATE_BBOX[expectedUF];
        if (lng < minLon || lng > maxLon || lat < minLat || lat > maxLat) return null;
      }

      return { lat, lng };
    } catch (e) {
      return null;
    }
  },

  // Busca o endereço/coordenadas mais precisos possível, combinando CEP,
  // bairro, cidade e UF (o que tiver disponível) — usado no cadastro/edição
  // de cliente, pra não depender só do centro da cidade.
  async searchAddressDetailed({ cep, bairro, cidade, uf }) {
    const stateName = BR_UF_TO_NAME[String(uf || "").toUpperCase()] || "";
    const cleanCep = String(cep || "").replace(/\D/g, "");

    let url = `${CONFIG.NOMINATIM_URL}?format=json&limit=1&countrycodes=br&addressdetails=1&country=Brasil`;
    if (cleanCep.length === 8) url += `&postalcode=${cleanCep}`;
    if (cidade) url += `&city=${encodeURIComponent(cidade)}`;
    if (stateName) url += `&state=${encodeURIComponent(stateName)}`;

    try {
      const data = await this._fetchNominatim(url);
      if (data && data[0]) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);

        // Mesma checagem de segurança: se caiu fora da caixa do estado
        // esperado, não confia no resultado
        const expectedUF = String(uf || "").toUpperCase();
        if (expectedUF && BR_STATE_BBOX[expectedUF]) {
          const [minLon, minLat, maxLon, maxLat] = BR_STATE_BBOX[expectedUF];
          if (lng < minLon || lng > maxLon || lat < minLat || lat > maxLat) return null;
        }

        return { lat, lng, displayName: data[0].display_name };
      }
    } catch (e) {}
    return null;
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
