// ============================================================
// REGIÕES — carrega o regions.json publicado no repositório e
// permite que o admin crie/edite regiões. As edições ficam
// salvas no navegador (localStorage) até serem exportadas e
// commitadas no GitHub, quando passam a valer pra todo mundo.
// ============================================================

const Regions = {
  list: [], // [{id, name, vehicleProfile, cities:[...], color}]

  async load() {
    let published = [];
    try {
      const res = await fetch("data/regions.json", { cache: "no-store" });
      if (res.ok) published = await res.json();
    } catch (e) {}

    const draft = this._loadDraft();
    // Se existir rascunho local mais recente, ele tem prioridade (é o que o
    // admin está editando); senão usa o publicado no repositório.
    this.list = draft || published;
  },

  _loadDraft() {
    try {
      const raw = localStorage.getItem("regioes_draft");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  _saveDraft() {
    localStorage.setItem("regioes_draft", JSON.stringify(this.list));
  },

  hasDraft() {
    return !!localStorage.getItem("regioes_draft");
  },

  discardDraft() {
    localStorage.removeItem("regioes_draft");
  },

  nextColor() {
    const used = this.list.length;
    return CONFIG.REGION_COLORS[used % CONFIG.REGION_COLORS.length];
  },

  create({ name, vehicleProfile, cities, color }) {
    const region = {
      id: "r_" + Date.now(),
      name,
      vehicleProfile,
      cities,
      color: color || this.nextColor(),
    };
    this.list.push(region);
    this._saveDraft();
    return region;
  },

  update(id, changes) {
    const r = this.list.find((r) => r.id === id);
    if (!r) return;
    Object.assign(r, changes);
    this._saveDraft();
  },

  remove(id) {
    this.list = this.list.filter((r) => r.id !== id);
    this._saveDraft();
  },

  findByCity(cityLabel) {
    return this.list.filter((r) => r.cities.includes(cityLabel));
  },

  exportJSON() {
    return JSON.stringify(this.list, null, 2);
  },
};
