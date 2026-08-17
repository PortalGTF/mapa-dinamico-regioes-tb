// ============================================================
// ROTEAMENTO — calcula distância e tempo via terrestre entre a
// origem e uma cidade usando o OSRM (gratuito, sem chave).
// ============================================================

const Routing = {
  cache: {}, // { "lat,lng": {km, min, geometry} }

  async getRoute(originLatLng, destLatLng) {
    const key = `${originLatLng.lat},${originLatLng.lng}|${destLatLng.lat},${destLatLng.lng}`;
    if (this.cache[key]) return this.cache[key];

    const coords = `${originLatLng.lng},${originLatLng.lat};${destLatLng.lng},${destLatLng.lat}`;
    const url = `${CONFIG.OSRM_URL}/${coords}?overview=full&geometries=geojson`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OSRM respondeu ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    if (!data.routes || !data.routes[0]) {
      throw new Error(data.message || "nenhuma rota encontrada entre os pontos.");
    }

    const route = data.routes[0];
    const result = {
      km: route.distance / 1000,
      min: route.duration / 60,
      geometry: route.geometry, // GeoJSON LineString
    };
    this.cache[key] = result;
    return result;
  },

  // Calcula a distância da origem até MUITOS destinos de uma vez só (usando o
  // serviço de matriz do OSRM), em vez de uma requisição por cidade — bem mais
  // rápido. Preenche o mesmo cache usado por getRoute, então tudo que já usa
  // getRoute automaticamente aproveita o resultado.
  async getRouteMatrix(originLatLng, destinations, onProgress) {
    const BATCH_SIZE = 60; // limite seguro por requisição no servidor público
    const pending = destinations.filter((d) => {
      const key = `${originLatLng.lat},${originLatLng.lng}|${d.lat},${d.lng}`;
      return !this.cache[key];
    });

    let done = destinations.length - pending.length;
    if (onProgress) onProgress(done, destinations.length);
    if (pending.length === 0) return;

    const tableUrl = CONFIG.OSRM_URL.replace("/route/", "/table/");

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const coordsList = [`${originLatLng.lng},${originLatLng.lat}`, ...batch.map((d) => `${d.lng},${d.lat}`)];
      const url = `${tableUrl}/${coordsList.join(";")}?sources=0&annotations=duration,distance`;

      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.distances && data.distances[0]) {
          batch.forEach((d, idx) => {
            const distM = data.distances[0][idx + 1];
            const durS = data.durations ? data.durations[0][idx + 1] : null;
            if (distM !== null && distM !== undefined) {
              const key = `${originLatLng.lat},${originLatLng.lng}|${d.lat},${d.lng}`;
              this.cache[key] = { km: distM / 1000, min: durS !== null && durS !== undefined ? durS / 60 : null };
            }
          });
        }
      } catch (e) {
        // segue tentando os próximos lotes mesmo se um lote falhar
      }

      done += batch.length;
      if (onProgress) onProgress(done, destinations.length);
      await new Promise((r) => setTimeout(r, 300)); // pausa educada entre lotes
    }
  },

  formatKm(km) {
    return `${km.toFixed(0)} km`;
  },

  formatMin(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${m}min` : `${m}min`;
  },
};
