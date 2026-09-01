// ============================================================
// PEDIDOS — importados de uma planilha (Excel/CSV), casados com as
// cidades/regiões já cadastradas, e plotados no mapa do Roteirizador.
// Agora TAMBÉM entram no que pode ser publicado no GitHub (data/orders.json),
// pra não depender só do navegador de quem importou — o trabalho de
// localização/edição de cada pedido fica salvo de verdade.
// ============================================================

const Orders = {
  list: [], // [{id, client, rawCity, cityLabel, matched, weight, seller, regionId, ...}]

  async load() {
    let published = [];
    try {
      const res = await fetch("data/orders.json", { cache: "no-store" });
      if (res.ok) published = await res.json();
    } catch (e) {
      // arquivo pode ainda não existir — tudo bem, começa vazio
    }

    try {
      const raw = localStorage.getItem("regioes_orders_draft");
      this.list = raw ? JSON.parse(raw) : published;
    } catch (e) {
      this.list = published;
    }
  },

  save() {
    try {
      localStorage.setItem("regioes_orders_draft", JSON.stringify(this.list));
    } catch (e) {
      // se a planilha for gigante e passar do limite do localStorage, segue
      // funcionando na sessão atual, só não persiste entre recarregamentos
    }
  },

  setAll(orders) {
    this.list = orders;
    this.save();
  },

  clear() {
    this.list = [];
    localStorage.removeItem("regioes_orders_draft");
  },

  hasOrders() {
    return this.list.length > 0;
  },

  hasDraft() {
    return !!localStorage.getItem("regioes_orders_draft");
  },

  discardDraft() {
    localStorage.removeItem("regioes_orders_draft");
  },

  exportJSON() {
    return JSON.stringify(this.list, null, 2);
  },
};
