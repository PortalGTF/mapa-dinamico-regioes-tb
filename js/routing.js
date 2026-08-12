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
    const data = await res.json();

    if (!data.routes || !data.routes[0]) {
      throw new Error("Não foi possível calcular a rota.");
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

  formatKm(km) {
    return `${km.toFixed(0)} km`;
  },

  formatMin(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${m}min` : `${m}min`;
  },
};
