// Cliente Google Drive API v3 para listar "Compartilhados comigo", subpastas e ler .ZIP por Range

export class GoogleDriveClient {
  constructor(accessToken) {
    this.accessToken = this._cleanToken(accessToken);
  }

  _cleanToken(raw) {
    return (raw || "")
      .trim()
      .replace(/^Bearer\s+/i, "")
      .replace(/^["']+|["']+$/g, "")
      .trim();
  }

  setToken(token) {
    this.accessToken = this._cleanToken(token);
  }

  hasToken() {
    return Boolean(this.accessToken && this.accessToken.length > 15);
  }

  async _request(endpoint, params = {}) {
    if (!this.hasToken()) {
      throw new Error("Conecte sua conta Google (Token de Acesso) primeiro.");
    }
    if (this.accessToken.startsWith("4/")) {
      throw new Error("Você colou o 'Authorization code' (começa com 4/). No Passo 2 do site do Google, clique no botão azul 'Exchange authorization code for tokens' e copie o 'Access token' (que começa com ya29.)!");
    }

    const url = new URL(`https://www.googleapis.com/drive/v3/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`
      }
    });
    if (res.status === 401) {
      throw new Error("Token do Google Drive expirado ou inválido (401). Gere um novo 'Access token' (ya29...) no botão 'Como pegar meu Token'.");
    }
    if (res.status === 403) {
      let detail = "";
      try {
        const errJson = await res.json();
        detail = errJson?.error?.message || "";
      } catch (e) {}
      throw new Error(`Permissão negada pelo Google Drive (403): certifique-se de que o escopo 'https://www.googleapis.com/auth/drive.readonly' estava preenchido no Passo 1 antes de clicar em Authorize APIs. ${detail}`);
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Erro na API do Google Drive (${res.status}): ${errText}`);
    }
    return res.json();
  }

  async listSharedWithMe(searchQuery = "") {
    let q = "sharedWithMe = true and trashed = false";
    if (searchQuery && searchQuery.trim()) {
      const safe = searchQuery.trim().replace(/'/g, "\\'");
      q += ` and name contains '${safe}'`;
    }
    const data = await this._request("files", {
      q,
      pageSize: 100,
      fields: "files(id, name, mimeType, size, iconLink, thumbnailLink, owners(displayName), modifiedTime)",
      orderBy: "folder,name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return data.files || [];
  }

  async listFolderChildren(folderId, searchQuery = "") {
    let q = `'${folderId}' in parents and trashed = false`;
    if (searchQuery && searchQuery.trim()) {
      const safe = searchQuery.trim().replace(/'/g, "\\'");
      q += ` and name contains '${safe}'`;
    }
    const data = await this._request("files", {
      q,
      pageSize: 200,
      fields: "files(id, name, mimeType, size, iconLink, thumbnailLink, owners(displayName), modifiedTime)",
      orderBy: "folder,name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return data.files || [];
  }

  async downloadFileBlob(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`
      }
    });
    if (!res.ok) {
      throw new Error(`Falha ao baixar arquivo do Google Drive (HTTP ${res.status})`);
    }
    return res.blob();
  }
}
