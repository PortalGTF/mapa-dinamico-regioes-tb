// ============================================================
// CONFIGURAÇÃO DO APP — edite os valores abaixo conforme precisar
// ============================================================

const CONFIG = {
  // Endereço de origem (todas as distâncias são calculadas a partir daqui)
  ORIGIN_LABEL: "GTF - Unidade Terra Boa",
  ORIGIN_ADDRESS: "GTF - Unidade Terra Boa, Terra Boa - PR, 87240-000, Brasil",

  // Coordenadas fixas da origem. Como "GTF - Unidade Terra Boa" é o nome de uma
  // empresa (não um endereço público), o serviço gratuito de geocodificação não
  // consegue localizá-lo — por isso usamos coordenadas fixas em vez de tentar
  // geocodificar esse endereço toda vez.
  // Valor abaixo = centro da cidade de Terra Boa - PR (fonte: Wikipédia / Prefeitura
  // Municipal de Terra Boa). Se a unidade fica em outro ponto da cidade, ajuste
  // esses dois números — clique com o botão direito no local exato no Google Maps
  // e copie a latitude/longitude que aparece.
  ORIGIN_LAT: -23.7678,
  ORIGIN_LNG: -52.4439,

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

  // Paleta de cores sugeridas para novas regiões (cicla automaticamente).
  // O admin ainda pode escolher qualquer cor livremente no seletor de cores.
  REGION_COLORS: [
    "#e08a3c", "#3c7ce0", "#3ce0a8", "#e03c6e", "#a83ce0",
    "#e0c93c", "#3ce0d8", "#e0603c", "#6ee03c", "#3c50e0",
    "#c0392b", "#8e44ad", "#16a085", "#d35400", "#2980b9",
    "#27ae60", "#f39c12", "#c0392b", "#7f8c8d", "#2c3e50",
    "#e67e22", "#1abc9c", "#9b59b6", "#f1c40f", "#34495e",
    "#e74c3c", "#3498db", "#2ecc71", "#d68910", "#b03a2e",
  ],
};
