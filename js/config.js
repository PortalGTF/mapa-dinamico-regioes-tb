// ============================================================
// CONFIGURAÇÃO DO APP — edite os valores abaixo conforme precisar
// ============================================================

const CONFIG = {
  // Endereço de origem (todas as distâncias são calculadas a partir daqui)
  ORIGIN_LABEL: "GTF - Unidade Terra Boa",
  ORIGIN_ADDRESS: "GTF - Unidade Terra Boa, Terra Boa - PR, 87240-000, Brasil",

  // Hash SHA-256 da senha de administrador.
  // Senha padrão de fábrica: "trocaresta123"
  // TROQUE ISSO antes de publicar! Use o arquivo gerar-senha.html
  // incluído neste projeto para gerar o hash da sua própria senha.
  ADMIN_PASSWORD_HASH:
    "73a534f435ea8de7dbde719b1ddb852f636267abe87ce458e083e40dfce3a6f1",

  // Centro inicial do mapa (região Norte/Noroeste do Paraná)
  MAP_CENTER: [-23.9, -51.9],
  MAP_ZOOM: 8,

  // Serviços gratuitos usados (OpenStreetMap)
  NOMINATIM_URL: "https://nominatim.openstreetmap.org/search",
  OSRM_URL: "https://router.project-osrm.org/route/v1/driving",

  // Paleta de cores usada para desenhar regiões no mapa (cicla automaticamente)
  REGION_COLORS: [
    "#e08a3c", "#3c7ce0", "#3ce0a8", "#e03c6e", "#a83ce0",
    "#e0c93c", "#3ce0d8", "#e0603c", "#6ee03c", "#3c50e0",
  ],
};
