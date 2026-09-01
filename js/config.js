// ============================================================
// CONFIGURAÇÃO DO APP — edite os valores abaixo conforme precisar
// ============================================================

const CONFIG = {
  // Endereço de origem (todas as distâncias são calculadas a partir daqui)
  ORIGIN_LABEL: "GTF - Unidade Terra Boa",
  ORIGIN_ADDRESS: "GTF - Unidade Terra Boa, Terra Boa - PR, 87240-000, Brasil",

  // Coordenadas fixas da origem
  ORIGIN_LAT: -23.7678,
  ORIGIN_LNG: -52.4439,

  // Hash SHA-256 da senha de ADMIN — edita tudo, menos publicar no GitHub
  // (gerado pelo app em 01/09/2026)
  ADMIN_PASSWORD_HASH:
    "4ca1e4ef32bb1a521b6fb04a4661e8abbae9beeb4d5271b2c0cd88ce6217f0e6",

  // Hash SHA-256 da senha de PUBLICADOR — tudo do admin + publicar no GitHub
  // (gerado pelo app em 01/09/2026)
  PUBLISHER_PASSWORD_HASH:
    "8582f6bb6e5420ebcca035198114b7bf5b3b6b2a95858363878b8215eee07fdd",

  // Centro inicial do mapa
  MAP_CENTER: [-23.9, -51.9],
  MAP_ZOOM: 8,

  // Serviços gratuitos usados (OpenStreetMap)
  NOMINATIM_URL: "https://nominatim.openstreetmap.org/search",
  OSRM_URL: "https://router.project-osrm.org/route/v1/driving",

  // Paleta de cores sugeridas para novas regiões (cicla automaticamente).
  // O admin ainda pode escolher qualquer cor livremente no seletor de cores.
  REGION_COLORS: [
    "#e08a3c", "#3c7ce0", "#3ce0a8", "#e03c6e", "#a83ce0", "#e0c93c", "#3ce0d8", "#e0603c", "#6ee03c", "#3c50e0", "#c0392b", "#8e44ad", "#16a085", "#d35400", "#2980b9", "#27ae60", "#f39c12", "#c0392b", "#7f8c8d", "#2c3e50", "#e67e22", "#1abc9c", "#9b59b6", "#f1c40f", "#34495e", "#e74c3c", "#3498db", "#2ecc71", "#d68910", "#b03a2e"
  ],
};
