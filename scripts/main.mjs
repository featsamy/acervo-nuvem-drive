// Módulo: Acervo na Nuvem e Explorador de ZIP (Google Drive)
// Compatível com Foundry VTT v11, v12 e v13+

import { GoogleDriveZipSource, BlobZipSource, ZipRangeArchive } from "./zip-range-reader.mjs";
import { GoogleDriveClient } from "./gdrive-client.mjs";
import { translateName } from "./translator.mjs";
import { installSingleMapFromZip, installTokenFolderFromZip } from "./installer.mjs";

const MODULE_ID = "acervo-nuvem-drive";

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getBaseStem(fileName) {
  return (fileName || "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export class AcervoNuvemExplorerApp extends Application {
  constructor(options = {}) {
    super(options);
    this.activeTab = "zip"; // 'zip' | 'drive' | 'installed'
    this.translateEnabled = true;
    this.saveToCompendium = true;

    this.currentArchive = null;
    this.folderGroups = new Map();
    this.stillImageIndex = new Map();
    this.selectedFolder = null;
    this.lightboxEntry = null;
    this.lightboxUrl = null;
    this.lightboxIsVideoPlaying = false;
    this.statusMessage = "Selecione um arquivo .ZIP ou conecte sua aba 'Compartilhados comigo' do Google Drive.";

    const savedToken = game.settings.get(MODULE_ID, "googleAccessToken") || "";
    this.driveClient = new GoogleDriveClient(savedToken);
    this.driveBreadcrumbs = [{ id: "sharedWithMe", name: "Compartilhados comigo" }];
    this.driveFiles = [];
    this.driveSearch = "";
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "acervo-nuvem-explorer",
      title: "Acervo na Nuvem e Visualizador de .ZIP",
      width: Math.min(1320, window.innerWidth - 60),
      height: Math.min(840, window.innerHeight - 50),
      resizable: true,
      popOut: true,
      classes: ["acervo-nuvem-app"]
    });
  }

  async _renderInner() {
    const wrapper = $(`<div class="acervo-nuvem-window"></div>`);

    const topbar = $(`
      <div class="acervo-nuvem-topbar">
        <div class="acervo-nuvem-tabs">
          <button type="button" class="acervo-nuvem-tab ${this.activeTab === "zip" ? "active" : ""}" data-tab="zip">
            Visualizador de .ZIP
          </button>
          <button type="button" class="acervo-nuvem-tab ${this.activeTab === "drive" ? "active" : ""}" data-tab="drive">
            Google Drive (Compartilhados)
          </button>
          <button type="button" class="acervo-nuvem-tab ${this.activeTab === "installed" ? "active" : ""}" data-tab="installed">
            Instalados no Mundo
          </button>
        </div>
        <div class="acervo-nuvem-controls">
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;">
            <input type="checkbox" class="toggle-translate" ${this.translateEnabled ? "checked" : ""} />
            <span>Traduzir p/ Português</span>
          </label>
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;">
            <input type="checkbox" class="toggle-compendium" ${this.saveToCompendium ? "checked" : ""} />
            <span>Salvar no Compêndio</span>
          </label>
          <button type="button" class="acervo-nuvem-btn primary btn-open-local-zip">
            Abrir Arquivo .ZIP (PC / Drive Desktop)
          </button>
          <input type="file" class="hidden-zip-input" accept=".zip" style="display:none;" />
        </div>
      </div>
    `);
    wrapper.append(topbar);

    const body = $(`<div class="acervo-nuvem-body"></div>`);
    if (this.activeTab === "zip") {
      body.append(this._buildZipTab());
    } else if (this.activeTab === "drive") {
      body.append(this._buildDriveTab());
    } else {
      body.append(this._buildInstalledTab());
    }
    wrapper.append(body);

    if (this.lightboxEntry && this.lightboxUrl) {
      wrapper.append(this._buildLightboxOverlay());
    }

    const status = $(`
      <div class="acervo-status-bar">
        <span class="status-text">${this.statusMessage}</span>
        <span>Clique na miniatura ou em "Ver Maior" para abrir em tela cheia.</span>
      </div>
    `);
    wrapper.append(status);

    return wrapper;
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._bindEvents(html);
  }

  _buildLightboxOverlay() {
    const entry = this.lightboxEntry;
    const isVideo = ["webm", "mp4", "m4v"].includes(entry.ext);
    const ptName = translateName(entry.fileName, this.translateEnabled);

    return $(`
      <div class="acervo-lightbox-overlay">
        <div class="acervo-lightbox-header">
          <div>
            <strong style="font-size:15px;color:#fff;">${ptName}</strong>
            <span style="font-size:12px;color:#999;margin-left:10px;">
              (${entry.fileName} - ${formatBytes(entry.uncompressedSize)})
            </span>
          </div>
          <div style="display:flex;gap:8px;">
            ${isVideo && !this.lightboxIsVideoPlaying ? `
              <button type="button" class="acervo-nuvem-btn primary btn-play-lightbox-video">
                Carregar Animação em Vídeo
              </button>
            ` : ""}
            <button type="button" class="acervo-nuvem-btn danger btn-close-lightbox">
              Fechar
            </button>
          </div>
        </div>
        <div class="acervo-lightbox-media-wrap">
          ${this.lightboxIsVideoPlaying
            ? `<video src="${this.lightboxUrl}" controls autoplay loop playsinline></video>`
            : `<img src="${this.lightboxUrl}" alt="${entry.fileName}" />`
          }
        </div>
        <div class="acervo-lightbox-footer">
          <button type="button" class="acervo-nuvem-btn primary btn-lightbox-install-map" style="height:34px !important;padding:0 16px !important;font-size:12px !important;">
            Instalar Mapa como Cena (Grid 100px)
          </button>
          <button type="button" class="acervo-nuvem-btn success btn-install-token-folder" style="height:34px !important;padding:0 16px !important;font-size:12px !important;">
            Instalar Pasta como Token Wildcard
          </button>
          <button type="button" class="acervo-nuvem-btn btn-close-lightbox" style="height:34px !important;padding:0 16px !important;font-size:12px !important;">
            Voltar
          </button>
        </div>
      </div>
    `);
  }

  _buildZipTab() {
    if (!this.currentArchive) {
      return $(`
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;gap:12px;">
          <h2 style="margin:0;color:#e0e0e0;border:none;">Visualizador de pacotes .ZIP</h2>
          <p style="max-width:620px;color:#9e9e9e;font-size:13px;line-height:1.5;">
            Abra um arquivo <code>.zip</code> direto da aba Google Drive ou selecione um arquivo do seu computador / Google Drive Desktop para ver as miniaturas dos mapas e tokens antes de extrair.
          </p>
          <div style="display:flex;gap:10px;margin-top:6px;">
            <button type="button" class="acervo-nuvem-btn primary btn-open-local-zip" style="height:36px !important;padding:0 18px !important;font-size:13px !important;">
              Escolher Arquivo .ZIP (PC / Drive Desktop)
            </button>
            <button type="button" class="acervo-nuvem-btn btn-switch-drive" style="height:36px !important;padding:0 18px !important;font-size:13px !important;">
              Abrir Aba Google Drive
            </button>
          </div>
        </div>
      `);
    }

    const container = $(`<div style="flex:1;display:flex;overflow:hidden;min-height:0;"></div>`);

    const sidebar = $(`<div class="acervo-zip-sidebar"></div>`);
    sidebar.append(`
      <div class="acervo-zip-sidebar-header">
        ${this.currentArchive.source.name}<br/>
        <span style="font-weight:400;color:#999999;font-size:11px;">
          ${this.folderGroups.size} pasta(s) - ${formatBytes(this.currentArchive.source.size)}
        </span>
      </div>
    `);

    const folderList = $(`<div class="acervo-zip-folder-list"></div>`);
    for (const [folderPath, entries] of this.folderGroups.entries()) {
      const shortName = folderPath === "Raiz do Pacote" ? folderPath : folderPath.split("/").pop();
      const ptName = translateName(shortName, this.translateEnabled);
      const isActive = this.selectedFolder === folderPath;
      const item = $(`
        <div class="acervo-zip-folder-item ${isActive ? "active" : ""}" data-folder="${folderPath.replace(/"/g, "&quot;")}">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            <strong>${ptName}</strong>
            ${ptName !== shortName ? `<div style="font-size:10px;color:#888;">(${shortName})</div>` : ""}
          </div>
          <span style="background:#333;color:#ccc;padding:2px 6px;border-radius:3px;font-size:11px;">
            ${entries.length}
          </span>
        </div>
      `);
      folderList.append(item);
    }
    sidebar.append(folderList);
    container.append(sidebar);

    const main = $(`<div class="acervo-zip-main"></div>`);
    const currentEntries = this.folderGroups.get(this.selectedFolder) || [];
    const rawShort = this.selectedFolder === "Raiz do Pacote" ? this.selectedFolder : (this.selectedFolder || "").split("/").pop();
    const ptFolderTitle = translateName(rawShort, this.translateEnabled);

    const hasImages = currentEntries.some((e) => ["png", "webp", "jpg", "jpeg"].includes(e.ext));

    const toolbar = $(`
      <div class="acervo-zip-toolbar">
        <div>
          <strong style="font-size:14px;color:#e8e8e8;">${ptFolderTitle}</strong>
          <span style="font-size:12px;color:#8c8c8c;margin-left:8px;">(${currentEntries.length} arquivos)</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${hasImages ? `
            <button type="button" class="acervo-nuvem-btn success btn-install-token-folder">
              Instalar Pasta como Token Wildcard (${currentEntries.length} poses)
            </button>
          ` : ""}
          <button type="button" class="acervo-nuvem-btn primary btn-install-all-maps-folder">
            Instalar Todos desta Pasta como Cenas
          </button>
        </div>
      </div>
    `);
    main.append(toolbar);

    const grid = $(`<div class="acervo-zip-grid"></div>`);
    for (let i = 0; i < currentEntries.length; i++) {
      const entry = currentEntries[i];
      const ptFile = translateName(entry.fileName, this.translateEnabled);
      const isVideo = ["webm", "mp4", "m4v"].includes(entry.ext);
      const isTokenImg = ["png", "webp"].includes(entry.ext);

      const card = $(`
        <div class="acervo-media-card" data-entry-idx="${i}">
          <div class="acervo-media-thumb-box ${isTokenImg ? "is-token" : ""}" title="Clique para ampliar">
            <span class="thumb-loading" style="font-size:11px;color:#888;">Carregando...</span>
          </div>
          <div class="acervo-media-card-body">
            <div>
              <div class="acervo-media-title" title="${ptFile}">${ptFile}</div>
              <div class="acervo-media-orig" title="${entry.fileName}">${entry.fileName} (${formatBytes(entry.uncompressedSize)})</div>
            </div>
            <div class="acervo-card-actions">
              <button type="button" class="acervo-nuvem-btn btn-preview-modal" data-idx="${i}" style="flex:1;">
                Ver Maior
              </button>
              <button type="button" class="acervo-nuvem-btn primary btn-install-single-map" data-idx="${i}" style="flex:1;">
                Criar Cena
              </button>
            </div>
          </div>
        </div>
      `);
      grid.append(card);

      this._loadThumbnailAsync(card.find(".acervo-media-thumb-box"), entry, isVideo);
    }

    main.append(grid);
    container.append(main);
    return container;
  }

  async _loadThumbnailAsync(thumbBox, entry, isVideo) {
    try {
      const stem = getBaseStem(entry.fileName);
      const companionImg = isVideo ? this.stillImageIndex.get(stem) : null;

      if (companionImg) {
        const imgUrl = await this.currentArchive.getPreviewUrl(companionImg);
        thumbBox.empty();
        thumbBox.append(`<img src="${imgUrl}" alt="${entry.fileName}" loading="lazy" />`);
        thumbBox.append(`
          <span style="position:absolute;bottom:5px;right:5px;background:rgba(20,20,20,0.88);color:#ccc;font-weight:600;font-size:10px;padding:2px 5px;border-radius:2px;border:1px solid #444;">
            .${entry.ext.toUpperCase()}
          </span>
        `);
        return;
      }

      const url = await this.currentArchive.getPreviewUrl(entry);
      thumbBox.empty();
      if (isVideo) {
        const vid = $(`<video src="${url}#t=0.5" muted loop playsinline preload="metadata"></video>`);
        vid.on("loadeddata", function () {
          if (this.currentTime === 0) this.currentTime = 0.5;
        });
        vid.on("mouseenter", function () { this.play().catch(() => {}); });
        vid.on("mouseleave", function () { this.pause(); });
        thumbBox.append(vid);
        thumbBox.append(`
          <span style="position:absolute;bottom:5px;right:5px;background:rgba(20,20,20,0.88);color:#ccc;font-weight:600;font-size:10px;padding:2px 5px;border-radius:2px;border:1px solid #444;">
            .${entry.ext.toUpperCase()}
          </span>
        `);
      } else {
        thumbBox.append(`<img src="${url}" alt="${entry.fileName}" loading="lazy" />`);
      }
    } catch (err) {
      thumbBox.html(`<span style="font-size:11px;color:#999;padding:6px;text-align:center;">Clique em "Ver Maior" (${entry.ext})</span>`);
    }
  }

  _buildDriveTab() {
    const container = $(`<div class="acervo-drive-container"></div>`);

    const authBar = $(`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:#232323;border:1px solid #363636;border-radius:3px;margin-bottom:10px;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;">
          <span style="white-space:nowrap;"><strong>Token do Google Drive:</strong></span>
          <input type="password" class="input-drive-token" value="${this.driveClient.accessToken}" placeholder="Cole seu Access Token do Google Drive (ya29...)" style="flex:1;background:#161616;color:#e0e0e0;border:1px solid #3d3d3d;border-radius:3px;padding:4px 8px;height:30px;" />
          <button type="button" class="acervo-nuvem-btn primary btn-save-token">Conectar e Listar</button>
          <button type="button" class="acervo-nuvem-btn btn-help-token">Como pegar o Token</button>
        </div>
      </div>
    `);
    container.append(authBar);

    const navBar = $(`<div class="acervo-drive-breadcrumbs"></div>`);
    this.driveBreadcrumbs.forEach((crumb, idx) => {
      if (idx > 0) navBar.append(`<span>/</span>`);
      navBar.append(`<span class="acervo-drive-crumb" data-crumb-idx="${idx}">${crumb.name}</span>`);
    });
    navBar.append(`
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <input type="text" class="input-drive-search" value="${this.driveSearch}" placeholder="Filtrar pasta ou arquivo..." style="background:#161616;color:#e0e0e0;border:1px solid #3d3d3d;border-radius:3px;padding:3px 8px;font-size:12px;height:26px;width:200px;" />
        <button type="button" class="acervo-nuvem-btn btn-drive-refresh">Buscar</button>
      </div>
    `);
    container.append(navBar);

    const list = $(`<div class="acervo-drive-list"></div>`);
    if (!this.driveFiles.length) {
      list.html(`
        <div style="grid-column:1/-1;padding:30px;text-align:center;color:#888888;">
          ${this.driveClient.hasToken()
            ? "Clique em 'Buscar' para listar as pastas compartilhadas."
            : "Cole seu Token do Google Drive acima ou use o botão 'Abrir Arquivo .ZIP' no topo."}
        </div>
      `);
    } else {
      for (const f of this.driveFiles) {
        const isFolder = f.mimeType === "application/vnd.google-apps.folder";
        const isZip = f.name?.toLowerCase().endsWith(".zip") || f.mimeType?.includes("zip");
        const ptTitle = translateName(f.name, this.translateEnabled);

        const item = $(`
          <div class="acervo-drive-item" data-file-id="${f.id}" data-file-name="${f.name.replace(/"/g, "&quot;")}" data-file-size="${f.size || 0}" data-is-folder="${isFolder}" data-is-zip="${isZip}">
            <div class="acervo-drive-item-info">
              <div class="acervo-drive-item-title" title="${f.name}">${ptTitle}</div>
              <div class="acervo-drive-item-sub">
                ${f.name} ${f.size ? `- ${formatBytes(f.size)}` : ""} ${f.owners?.[0]?.displayName ? `- por ${f.owners[0].displayName}` : ""}
              </div>
            </div>
            <span class="acervo-nuvem-btn ${isZip ? "primary" : ""}" style="font-size:11px;padding:0 10px !important;height:26px !important;">
              ${isFolder ? "Abrir" : isZip ? "Ver Imagens" : "Abrir"}
            </span>
          </div>
        `);
        list.append(item);
      }
    }

    container.append(list);
    return container;
  }

  _buildInstalledTab() {
    const installedScenes = game.scenes.filter((s) => s.getFlag(MODULE_ID, "installedPath"));
    const installedActors = game.actors.filter((a) => a.getFlag(MODULE_ID, "installedFolder"));

    const container = $(`<div class="acervo-drive-container"></div>`);
    container.append(`
      <div style="margin-bottom:12px;flex-shrink:0;">
        <h3 style="margin:0 0 4px 0;color:#e0e0e0;">Cenas e Tokens Instalados Neste Mundo</h3>
        <p style="margin:0;font-size:12px;color:#888888;">
          Mapas e pacotes de tokens extraídos para este mundo.
        </p>
      </div>
    `);

    const list = $(`<div class="acervo-drive-list"></div>`);
    for (const scene of installedScenes) {
      const size = scene.getFlag(MODULE_ID, "uncompressedSize") || 0;
      const zip = scene.getFlag(MODULE_ID, "sourceZip") || "ZIP";
      list.append(`
        <div class="acervo-drive-item">
          <div class="acervo-drive-item-info">
            <div class="acervo-drive-item-title">[Cena] ${scene.name}</div>
            <div class="acervo-drive-item-sub">Origem: ${zip} - ${formatBytes(size)}</div>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" class="acervo-nuvem-btn btn-view-scene" data-scene-id="${scene.id}">Ver</button>
            <button type="button" class="acervo-nuvem-btn danger btn-remove-scene" data-scene-id="${scene.id}">Remover</button>
          </div>
        </div>
      `);
    }

    for (const actor of installedActors) {
      const size = actor.getFlag(MODULE_ID, "uncompressedSize") || 0;
      const zip = actor.getFlag(MODULE_ID, "sourceZip") || "ZIP";
      list.append(`
        <div class="acervo-drive-item">
          <div class="acervo-drive-item-info">
            <div class="acervo-drive-item-title">[Token] ${actor.name}</div>
            <div class="acervo-drive-item-sub">Origem: ${zip} - ${formatBytes(size)}</div>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" class="acervo-nuvem-btn btn-view-actor" data-actor-id="${actor.id}">Ficha</button>
            <button type="button" class="acervo-nuvem-btn danger btn-remove-actor" data-actor-id="${actor.id}">Remover</button>
          </div>
        </div>
      `);
    }

    if (!installedScenes.length && !installedActors.length) {
      list.html(`<div style="grid-column:1/-1;padding:30px;text-align:center;color:#888888;">Nenhum mapa ou token instalado ainda neste mundo.</div>`);
    }

    container.append(list);
    return container;
  }

  _bindEvents(html) {
    html.find(".acervo-nuvem-tab").on("click", (ev) => {
      this.activeTab = ev.currentTarget.dataset.tab;
      this.lightboxEntry = null;
      this.render(true);
    });

    html.find(".btn-switch-drive").on("click", () => {
      this.activeTab = "drive";
      this.render(true);
    });

    html.find(".toggle-translate").on("change", (ev) => {
      this.translateEnabled = ev.currentTarget.checked;
      this.render(true);
    });

    html.find(".toggle-compendium").on("change", (ev) => {
      this.saveToCompendium = ev.currentTarget.checked;
    });

    html.find(".btn-open-local-zip").on("click", (ev) => {
      ev.preventDefault();
      html.find(".hidden-zip-input").trigger("click");
    });

    html.find(".hidden-zip-input").on("change", async (ev) => {
      const file = ev.currentTarget.files?.[0];
      if (!file) return;
      await this.openZipSource(new BlobZipSource(file, file.name));
    });

    html.find(".acervo-zip-folder-item").on("click", (ev) => {
      this.selectedFolder = ev.currentTarget.dataset.folder;
      this.lightboxEntry = null;
      this.render(true);
    });

    html.find(".acervo-media-thumb-box, .btn-preview-modal").on("click", async (ev) => {
      ev.stopPropagation();
      const card = $(ev.currentTarget).closest(".acervo-media-card");
      const idx = Number(card.data("entry-idx"));
      const entries = this.folderGroups.get(this.selectedFolder) || [];
      const entry = entries[idx];
      if (!entry) return;

      try {
        const isVideo = ["webm", "mp4", "m4v"].includes(entry.ext);
        const companionImg = isVideo ? this.stillImageIndex.get(getBaseStem(entry.fileName)) : null;

        if (companionImg) {
          const url = await this.currentArchive.getPreviewUrl(companionImg);
          this.lightboxEntry = entry;
          this.lightboxUrl = url;
          this.lightboxIsVideoPlaying = false;
          this.statusMessage = `Visualizando: ${entry.fileName}`;
          this.render(true);
        } else {
          this.statusMessage = `Carregando visualização de "${entry.fileName}"...`;
          const url = await this.currentArchive.getPreviewUrl(entry);
          this.lightboxEntry = entry;
          this.lightboxUrl = url;
          this.lightboxIsVideoPlaying = isVideo;
          this.statusMessage = `Visualizando: ${entry.fileName}`;
          this.render(true);
        }
      } catch (err) {
        ui.notifications.error(`Erro ao abrir preview: ${err.message}`);
      }
    });

    html.find(".btn-play-lightbox-video").on("click", async () => {
      if (!this.lightboxEntry) return;
      try {
        this.statusMessage = `Descompactando vídeo "${this.lightboxEntry.fileName}" na memória...`;
        const url = await this.currentArchive.getPreviewUrl(this.lightboxEntry);
        this.lightboxUrl = url;
        this.lightboxIsVideoPlaying = true;
        this.statusMessage = `Reproduzindo vídeo: ${this.lightboxEntry.fileName}`;
        this.render(true);
      } catch (err) {
        ui.notifications.error(`Erro ao carregar vídeo: ${err.message}`);
      }
    });

    html.find(".btn-close-lightbox").on("click", () => {
      this.lightboxEntry = null;
      this.lightboxUrl = null;
      this.render(true);
    });

    html.find(".btn-lightbox-install-map").on("click", async () => {
      if (!this.lightboxEntry) return;
      const entry = this.lightboxEntry;
      this.lightboxEntry = null;
      await this._handleInstallSingleMap(entry);
    });

    html.find(".btn-install-single-map").on("click", async (ev) => {
      ev.stopPropagation();
      const idx = Number(ev.currentTarget.dataset.idx);
      const entries = this.folderGroups.get(this.selectedFolder) || [];
      const entry = entries[idx];
      if (entry) await this._handleInstallSingleMap(entry);
    });

    html.find(".btn-install-token-folder").on("click", async () => {
      const entries = this.folderGroups.get(this.selectedFolder) || [];
      if (!entries.length) return;
      try {
        this.lightboxEntry = null;
        this.statusMessage = `Extraindo e configurando Token Wildcard (${entries.length} poses)...`;
        this.render(true);
        const actor = await installTokenFolderFromZip(this.currentArchive, this.selectedFolder, entries, {
          translate: this.translateEnabled,
          saveToCompendium: this.saveToCompendium
        });
        ui.notifications.info(`Token Wildcard "${actor.name}" criado com sucesso!`);
        this.statusMessage = `Token Wildcard "${actor.name}" instalado!`;
        this.render(true);
      } catch (err) {
        console.error(err);
        ui.notifications.error(`Erro ao instalar tokens: ${err.message}`);
      }
    });

    html.find(".btn-install-all-maps-folder").on("click", async () => {
      const entries = this.folderGroups.get(this.selectedFolder) || [];
      if (!entries.length) return;
      let count = 0;
      for (const entry of entries) {
        this.statusMessage = `Instalando cena (${count + 1}/${entries.length}): ${entry.fileName}...`;
        await installSingleMapFromZip(this.currentArchive, entry, {
          translate: this.translateEnabled,
          saveToCompendium: this.saveToCompendium
        });
        count++;
      }
      ui.notifications.info(`${count} Cena(s) criada(s) com sucesso!`);
      this.statusMessage = `${count} Cena(s) instalada(s) com sucesso!`;
      this.render(true);
    });

    html.find(".btn-save-token").on("click", async () => {
      const token = html.find(".input-drive-token").val().trim();
      await game.settings.set(MODULE_ID, "googleAccessToken", token);
      this.driveClient.setToken(token);
      this.driveBreadcrumbs = [{ id: "sharedWithMe", name: "Compartilhados comigo" }];
      await this._loadDriveFolder("sharedWithMe");
    });

    html.find(".btn-drive-refresh").on("click", async () => {
      this.driveSearch = html.find(".input-drive-search").val().trim();
      const currentCrumb = this.driveBreadcrumbs[this.driveBreadcrumbs.length - 1];
      await this._loadDriveFolder(currentCrumb.id);
    });

    html.find(".acervo-drive-crumb").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.crumbIdx);
      this.driveBreadcrumbs = this.driveBreadcrumbs.slice(0, idx + 1);
      await this._loadDriveFolder(this.driveBreadcrumbs[idx].id);
    });

    html.find(".acervo-drive-item[data-file-id]").on("click", async (ev) => {
      const el = ev.currentTarget;
      const fileId = el.dataset.fileId;
      const fileName = el.dataset.fileName;
      const fileSize = Number(el.dataset.fileSize) || 0;
      const isFolder = el.dataset.isFolder === "true";
      const isZip = el.dataset.isZip === "true";

      if (isFolder) {
        this.driveBreadcrumbs.push({ id: fileId, name: fileName });
        this.driveSearch = "";
        await this._loadDriveFolder(fileId);
      } else if (isZip) {
        const source = new GoogleDriveZipSource(fileId, fileSize, this.driveClient.accessToken, fileName);
        await this.openZipSource(source);
      } else {
        ui.notifications.info(`Para instalar mapas/tokens, clique em uma pasta ou arquivo .ZIP.`);
      }
    });

    html.find(".btn-help-token").on("click", () => {
      new Dialog({
        title: "Como Conectar seu Google Drive",
        content: `
          <div style="font-size:13px;line-height:1.5;">
            <p>Para acessar os arquivos compartilhados com o seu e-mail:</p>
            <ol>
              <li>Acesse o <a href="https://developers.google.com/oauthplayground/#step1&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly" target="_blank"><strong>Google OAuth Playground</strong></a>.</li>
              <li>No Passo 1, clique no botão <strong>"Authorize APIs"</strong> e escolha a sua conta do Google.</li>
              <li>No Passo 2, clique em <strong>"Exchange authorization code for tokens"</strong>.</li>
              <li>Copie o código do campo <strong>"Access token"</strong> (começa com <code>ya29.</code>) e cole na barra do módulo.</li>
            </ol>
            <hr/>
            <p><strong>Alternativa sem token:</strong> Se você tiver o <em>Google Drive para Desktop</em> instalado no Windows, basta clicar em <strong>"Abrir Arquivo .ZIP"</strong> no topo da janela e selecionar qualquer <code>.zip</code> direto do seu Drive virtual.</p>
          </div>
        `,
        buttons: { ok: { label: "Fechar" } }
      }, { width: 560 }).render(true);
    });

    html.find(".btn-view-scene").on("click", (ev) => {
      const scene = game.scenes.get(ev.currentTarget.dataset.sceneId);
      if (scene) scene.view();
    });

    html.find(".btn-remove-scene").on("click", async (ev) => {
      const scene = game.scenes.get(ev.currentTarget.dataset.sceneId);
      if (scene) {
        await scene.delete();
        this.render(true);
      }
    });

    html.find(".btn-view-actor").on("click", (ev) => {
      const actor = game.actors.get(ev.currentTarget.dataset.actorId);
      if (actor) actor.sheet.render(true);
    });

    html.find(".btn-remove-actor").on("click", async (ev) => {
      const actor = game.actors.get(ev.currentTarget.dataset.actorId);
      if (actor) {
        await actor.delete();
        this.render(true);
      }
    });
  }

  async openZipSource(source) {
    try {
      this.statusMessage = `Lendo índice do arquivo ${source.name}...`;
      this.lightboxEntry = null;
      this.render(true);

      if (this.currentArchive) {
        this.currentArchive.dispose();
      }

      const archive = new ZipRangeArchive(source);
      await archive.init();

      this.currentArchive = archive;
      this.folderGroups = archive.getGroupedByFolder();

      this.stillImageIndex.clear();
      for (const entry of archive.getMediaEntries()) {
        if (["jpg", "jpeg", "png", "webp"].includes(entry.ext)) {
          this.stillImageIndex.set(getBaseStem(entry.fileName), entry);
        }
      }

      let defaultFolder = this.folderGroups.keys().next().value || null;
      for (const k of this.folderGroups.keys()) {
        if (k.toLowerCase().includes("webm")) {
          defaultFolder = k;
          break;
        }
      }

      this.selectedFolder = defaultFolder;
      this.activeTab = "zip";
      this.statusMessage = `${source.name} aberto (${archive.getMediaEntries().length} arquivos em ${this.folderGroups.size} pastas).`;
      this.render(true);
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Falha ao abrir .ZIP: ${err.message}`);
      this.statusMessage = `Erro ao ler .ZIP: ${err.message}`;
      this.render(true);
    }
  }

  async _loadDriveFolder(folderId) {
    try {
      this.statusMessage = "Consultando Google Drive...";
      this.render(true);
      if (folderId === "sharedWithMe") {
        this.driveFiles = await this.driveClient.listSharedWithMe(this.driveSearch);
      } else {
        this.driveFiles = await this.driveClient.listFolderChildren(folderId, this.driveSearch);
      }
      this.statusMessage = `${this.driveFiles.length} itens listados do Google Drive.`;
      this.render(true);
    } catch (err) {
      console.error(err);
      ui.notifications.error(err.message);
      this.statusMessage = `${err.message}`;
      this.render(true);
    }
  }

  async _handleInstallSingleMap(entry) {
    try {
      this.statusMessage = `Extraindo e configurando cena "${entry.fileName}"...`;
      this.render(true);
      const scene = await installSingleMapFromZip(this.currentArchive, entry, {
        translate: this.translateEnabled,
        saveToCompendium: this.saveToCompendium
      });
      ui.notifications.info(`Cena "${scene.name}" criada (${scene.width}x${scene.height}px, Grid 100px).`);
      this.statusMessage = `Cena "${scene.name}" criada com sucesso.`;
      this.render(true);
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Erro ao instalar mapa: ${err.message}`);
    }
  }
}

function injectButtonIntoElement(el) {
  if (!game.user?.isGM || !el) return;
  const root = el instanceof HTMLElement ? $(el) : el;
  if (root.find(".acervo-nuvem-sidebar-btn").length) return;

  const btn = $(`
    <button type="button" class="acervo-nuvem-sidebar-btn">
      <span>Explorador Drive e .ZIP</span>
    </button>
  `);
  btn.on("click", (ev) => {
    ev.preventDefault();
    new AcervoNuvemExplorerApp().render(true);
  });

  const header = root.find(".directory-header").first();
  if (header.length) {
    header.prepend(btn);
  } else {
    root.prepend(btn);
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "googleAccessToken", {
    name: "Token de Acesso do Google Drive (Pessoal)",
    hint: "Token OAuth2 temporário da sua própria conta Google para listar sua aba 'Compartilhados comigo'.",
    scope: "client",
    config: true,
    type: String,
    default: ""
  });

  game.settings.registerMenu(MODULE_ID, "openExplorerMenu", {
    name: "Explorador Google Drive e Visualizador de .ZIP",
    label: "Abrir Explorador de .ZIP e Google Drive",
    hint: "Visualize imagens e vídeos dentro de pacotes .ZIP antes de baixar e instale apenas o que for usar.",
    icon: "fas fa-folder-open",
    type: AcervoNuvemExplorerApp,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  window.AbrirExploradorNuvem = () => new AcervoNuvemExplorerApp().render(true);
  document.querySelectorAll("#scenes, #actors, #compendium").forEach((el) => injectButtonIntoElement(el));
});

Hooks.on("renderCompendiumDirectory", (app, html) => injectButtonIntoElement(html));
Hooks.on("renderSceneDirectory", (app, html) => injectButtonIntoElement(html));
Hooks.on("renderActorDirectory", (app, html) => injectButtonIntoElement(html));
