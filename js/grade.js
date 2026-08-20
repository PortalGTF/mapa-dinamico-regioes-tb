// ============================================================
// GRADE — quadro de carregamento/entrega. Cada coluna é um par
// "Carrega hoje → Entrega amanhã" (Dom→Seg, Seg→Ter, ... Qui→Sex).
// Arraste uma região pra dentro do dia — o perfil de veículo e o
// peso já vêm puxados automaticamente do que está cadastrado na
// região, sem precisar configurar frota antes.
// ============================================================

const GRADE_DAYS = ["DOM", "SEG", "TER", "QUA", "QUI"];
const GRADE_DAY_NAMES = { DOM: "Domingo", SEG: "Segunda", TER: "Terça", QUA: "Quarta", QUI: "Quinta", SEX: "Sexta" };
const GRADE_NEXT_DAY = { DOM: "SEG", SEG: "TER", TER: "QUA", QUA: "QUI", QUI: "SEX" };

const Grade = {
  days: {}, // { DOM: [{id, regionId, profile, quantity}], SEG: [...], ... }

  async load() {
    let published = null;
    try {
      const res = await fetch("data/grade.json", { cache: "no-store" });
      if (res.ok) published = await res.json();
    } catch (e) {}

    const draft = this._loadDraft();
    this.days = draft || published || this._emptyStructure();

    GRADE_DAYS.forEach((d) => {
      if (!Array.isArray(this.days[d])) this.days[d] = [];
    });
  },

  _emptyStructure() {
    const obj = {};
    GRADE_DAYS.forEach((d) => (obj[d] = []));
    return obj;
  },

  _loadDraft() {
    try {
      const raw = localStorage.getItem("regioes_grade_draft");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  _saveDraft() {
    localStorage.setItem("regioes_grade_draft", JSON.stringify(this.days));
  },

  hasDraft() {
    return !!localStorage.getItem("regioes_grade_draft");
  },

  discardDraft() {
    localStorage.removeItem("regioes_grade_draft");
  },

  // Adiciona a região como uma nova rota naquele dia, já puxando o perfil
  // travado na própria região. Pode adicionar a mesma região mais de uma vez
  // no mesmo dia (ex: duas viagens separadas).
  addRoute(day, regionId, defaultProfile) {
    const route = {
      id: "route_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      regionId,
      profile: defaultProfile,
      quantity: 1,
    };
    this.days[day].push(route);
    this._saveDraft();
    return route;
  },

  removeRoute(day, routeId) {
    this.days[day] = this.days[day].filter((r) => r.id !== routeId);
    this._saveDraft();
  },

  setRouteProfile(day, routeId, profile) {
    const route = this.days[day].find((r) => r.id === routeId);
    if (!route) return;
    route.profile = profile;
    this._saveDraft();
  },

  setRouteQuantity(day, routeId, quantity) {
    const route = this.days[day].find((r) => r.id === routeId);
    if (!route) return;
    route.quantity = Math.max(1, quantity);
    this._saveDraft();
  },

  // Todos os dias/rotas em que uma região aparece
  routesForRegion(regionId) {
    const result = [];
    GRADE_DAYS.forEach((day) => {
      this.days[day].forEach((route) => {
        if (route.regionId === regionId) result.push({ day, route });
      });
    });
    return result;
  },

  exportJSON() {
    return JSON.stringify(this.days, null, 2);
  },
};
