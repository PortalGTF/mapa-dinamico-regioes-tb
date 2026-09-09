// ============================================================
// FROTA — cadastro de veículos/placas de verdade, com transportadora,
// perfil (capacidade) e status. Base pra fase 3 do roteirizador (emplacar
// pedidos automaticamente). Publicável no GitHub, igual regiões/grade.
// ============================================================

const Vehicles = {
  list: [], // [{id, placa, carrierName, carrierCode, profile, driver, status}]

  async load() {
    let published = [];
    try {
      const res = await fetch("data/vehicles.json", { cache: "no-store" });
      if (res.ok) published = await res.json();
    } catch (e) {
      // arquivo pode ainda não existir — tudo bem, começa vazio
    }

    try {
      const raw = localStorage.getItem("regioes_vehicles_draft");
      this.list = raw ? JSON.parse(raw) : published;
    } catch (e) {
      this.list = published;
    }
  },

  save() {
    localStorage.setItem("regioes_vehicles_draft", JSON.stringify(this.list));
  },

  create({ placa, carrierName, carrierCode, profile, driver, status }) {
    const vehicle = {
      id: "veh_" + Date.now(),
      placa: (placa || "").toUpperCase().trim(),
      carrierName: carrierName || "",
      carrierCode: carrierCode || "",
      profile: profile || "",
      driver: driver || "",
      status: status || "Livre",
    };
    this.list.push(vehicle);
    this.save();
    return vehicle;
  },

  update(id, changes) {
    const v = this.list.find((v) => v.id === id);
    if (!v) return;
    Object.assign(v, changes);
    this.save();
  },

  remove(id) {
    this.list = this.list.filter((v) => v.id !== id);
    this.save();
  },

  hasDraft() {
    return !!localStorage.getItem("regioes_vehicles_draft");
  },

  discardDraft() {
    localStorage.removeItem("regioes_vehicles_draft");
  },

  exportJSON() {
    return JSON.stringify(this.list, null, 2);
  },
};
