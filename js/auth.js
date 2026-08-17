// ============================================================
// AUTENTICAÇÃO ADMIN — verifica a senha comparando hashes,
// a senha real nunca fica escrita no código.
// ============================================================

const Auth = {
  isAdmin: false,

  async sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },

  async tryLogin(password) {
    const hash = await this.sha256(password);
    if (hash === CONFIG.ADMIN_PASSWORD_HASH) {
      this.isAdmin = true;
      sessionStorage.setItem("regioes_admin", "1");
      return true;
    }
    return false;
  },

  logout() {
    this.isAdmin = false;
    sessionStorage.removeItem("regioes_admin");
  },

  restoreSession() {
    // Sessão dura só enquanto a aba está aberta (sessionStorage), por segurança.
    this.isAdmin = sessionStorage.getItem("regioes_admin") === "1";
    return this.isAdmin;
  },
};
