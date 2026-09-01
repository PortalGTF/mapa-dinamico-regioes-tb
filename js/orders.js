// ============================================================
// PEDIDOS — importados de uma planilha (Excel/CSV), casados com as
// cidades/regiões já cadastradas, e plotados no mapa. Diferente das
// regiões/grade, pedidos são dados do dia-a-dia (mudam toda hora), então
// ficam só no navegador — não fazem parte do que é publicado no GitHub.
// ============================================================

const Orders = {
  list: [], // [{id, client, rawCity, cityLabel, matched, weight, seller, regionId}]

  load() {
    try {
      const raw = localStorage.getItem("regioes_orders_draft");
      this.list = raw ? JSON.parse(raw) : [];
    } catch (e) {
      this.list = [];
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
};
