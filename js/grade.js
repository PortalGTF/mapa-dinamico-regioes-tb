// ============================================================
// GRADE — quadro semanal de roteiros. Cada dia tem "vagas" de
// caminhão (com um perfil definido), e você arrasta regiões pra
// dentro de uma vaga pra montar o roteiro daquele dia.
// ============================================================

const GRADE_DAYS = ["SEG", "TER", "QUA", "QUI", "SEX", "SAB"];

const Grade = {
  days: {}, // { SEG: [{id, profile, regionId}], TER: [...], ... }

  async load() {
    let published = null;
    try {
      const res = await fetch("data/grade.json", { cache: "no-store" });
      if (res.ok) published = await res.json();
    } catch (e) {}

    const draft = this._loadDraft();
    this.days = draft || published || this._emptyStructure();

    // Garante que todo dia da semana exista, mesmo em dados antigos/incompletos
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

  addSlot(day, profile) {
    const slot = { id: "slot_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), profile, regionId: null };
    this.days[day].push(slot);
    this._saveDraft();
    return slot;
  },

  removeSlot(day, slotId) {
    this.days[day] = this.days[day].filter((s) => s.id !== slotId);
    this._saveDraft();
  },

  assignRegion(day, slotId, regionId) {
    const slot = this.days[day].find((s) => s.id === slotId);
    if (!slot) return;
    slot.regionId = regionId;
    if (!slot.quantity) slot.quantity = 1;
    this._saveDraft();
  },

  setQuantity(day, slotId, quantity) {
    const slot = this.days[day].find((s) => s.id === slotId);
    if (!slot) return;
    slot.quantity = Math.max(1, quantity);
    this._saveDraft();
  },

  unassignSlot(day, slotId) {
    const slot = this.days[day].find((s) => s.id === slotId);
    if (!slot) return;
    slot.regionId = null;
    this._saveDraft();
  },

  // Todas as vagas (de todos os dias) que têm uma região específica atribuída
  slotsForRegion(regionId) {
    const result = [];
    GRADE_DAYS.forEach((day) => {
      this.days[day].forEach((slot) => {
        if (slot.regionId === regionId) result.push({ day, slot });
      });
    });
    return result;
  },

  exportJSON() {
    return JSON.stringify(this.days, null, 2);
  },
};
