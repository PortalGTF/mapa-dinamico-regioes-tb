// ============================================================
// AUTENTICAÇÃO — dois níveis de acesso:
// - "admin": edita tudo (regiões, grade, cidades, pedidos), mas não
//   consegue publicar no GitHub.
// - "publisher" (publicador): tudo que o admin tem, MAIS a capacidade de
//   publicar direto no GitHub. A senha real nunca fica escrita no código —
//   só o hash SHA-256 dela.
// ============================================================

const Auth = {
  isAdmin: false,
  isPublisher: false,

  async sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },

  async tryLogin(password) {
    const hash = await this.sha256(password);

    if (CONFIG.PUBLISHER_PASSWORD_HASH && hash === CONFIG.PUBLISHER_PASSWORD_HASH) {
      this.isAdmin = true;
      this.isPublisher = true;
      sessionStorage.setItem("regioes_admin", "publisher");
      return true;
    }
    if (hash === CONFIG.ADMIN_PASSWORD_HASH) {
      this.isAdmin = true;
      this.isPublisher = false;
      sessionStorage.setItem("regioes_admin", "admin");
      return true;
    }
    return false;
  },

  logout() {
    this.isAdmin = false;
    this.isPublisher = false;
    sessionStorage.removeItem("regioes_admin");
    if (typeof clearPublisherGithubConfig === "function") clearPublisherGithubConfig();
  },

  restoreSession() {
    // Sessão dura só enquanto a aba está aberta (sessionStorage), por segurança.
    const level = sessionStorage.getItem("regioes_admin");
    this.isAdmin = level === "admin" || level === "publisher";
    this.isPublisher = level === "publisher";
    return this.isAdmin;
  },
};
