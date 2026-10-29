// Leitor Inteligente de Arquivos .ZIP por Streaming (HTTP Range / Slice)
// Permite listar pastas e exibir miniaturas/previews de imagens (.png/.jpg/.webp) e vídeos (.webm/.mp4)
// dentro de arquivos .ZIP na nuvem (Google Drive) ou locais SEM baixar/descompactar o .ZIP inteiro!

export class GoogleDriveZipSource {
  constructor(fileId, fileSize, accessToken, fileName = "arquivo.zip") {
    this.fileId = fileId;
    this.size = Number(fileSize);
    this.accessToken = accessToken;
    this.name = fileName;
  }

  async readRange(start, length) {
    const safeStart = Math.max(0, start);
    const end = Math.min(this.size - 1, safeStart + length - 1);
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.fileId)}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Range: `bytes=${safeStart}-${end}`
      }
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Erro ao ler bytes do Google Drive (HTTP ${res.status})`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}

export class BlobZipSource {
  constructor(fileOrBlob, fileName) {
    this.blob = fileOrBlob;
    this.size = fileOrBlob.size;
    this.name = fileName || fileOrBlob.name || "arquivo.zip";
  }

  async readRange(start, length) {
    const safeStart = Math.max(0, start);
    const end = Math.min(this.size, safeStart + length);
    const slice = this.blob.slice(safeStart, end);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }
}

export class ZipRangeArchive {
  constructor(source) {
    this.source = source;
    this.entries = [];
    this.blobUrlCache = new Map();
  }

  async init() {
    // Lê os últimos 128 KB do arquivo .zip para encontrar o End of Central Directory (EOCD)
    const tailLength = Math.min(this.source.size, 131072);
    const tailOffset = this.source.size - tailLength;
    const tail = await this.source.readRange(tailOffset, tailLength);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos === -1) {
      throw new Error("Não foi possível localizar o índice (Central Directory) deste arquivo .ZIP.");
    }

    let cdCount = view.getUint16(eocdPos + 10, true);
    let cdSize = view.getUint32(eocdPos + 12, true);
    let cdOffset = view.getUint32(eocdPos + 16, true);

    // Verifica ZIP64 EOCD Locator (0x07064b50)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdCount === 0xffff) {
      if (eocdPos >= 20 && view.getUint32(eocdPos - 20, true) === 0x07064b50) {
        const zip64EocdOffset = Number(view.getBigUint64(eocdPos - 12, true));
        const z64Buf = await this.source.readRange(zip64EocdOffset, 56);
        const z64View = new DataView(z64Buf.buffer, z64Buf.byteOffset, z64Buf.byteLength);
        if (z64View.getUint32(0, true) === 0x06064b50) {
          cdCount = Number(z64View.getBigUint64(32, true));
          cdSize = Number(z64View.getBigUint64(40, true));
          cdOffset = Number(z64View.getBigUint64(48, true));
        }
      }
    }

    // Se o Central Directory já está contido dentro do tail lido, reaproveita sem nova requisição!
    let cdBytes;
    if (cdOffset >= tailOffset && cdOffset + cdSize <= this.source.size) {
      const startInTail = cdOffset - tailOffset;
      cdBytes = tail.subarray(startInTail, startInTail + cdSize);
    } else {
      cdBytes = await this.source.readRange(cdOffset, cdSize);
    }

    this._parseCentralDirectory(cdBytes);
    return this.entries;
  }

  _parseCentralDirectory(cdBytes) {
    const view = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);
    const decoder = new TextDecoder("utf-8");
    let pos = 0;
    this.entries = [];

    while (pos + 46 <= cdBytes.length) {
      const sig = view.getUint32(pos, true);
      if (sig !== 0x02014b50) break;

      const flags = view.getUint16(pos + 8, true);
      const compressionMethod = view.getUint16(pos + 10, true);
      let compressedSize = view.getUint32(pos + 20, true);
      let uncompressedSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      let localHeaderOffset = view.getUint32(pos + 42, true);

      const nameBytes = cdBytes.subarray(pos + 46, pos + 46 + nameLen);
      const fullPath = decoder.decode(nameBytes).replace(/\\/g, "/");

      // Suporte a campos extras ZIP64
      if (extraLen > 0 && (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff)) {
        const extraStart = pos + 46 + nameLen;
        let ep = extraStart;
        while (ep + 4 <= extraStart + extraLen) {
          const headerId = view.getUint16(ep, true);
          const dataSize = view.getUint16(ep + 2, true);
          if (headerId === 0x0001) {
            let zp = ep + 4;
            if (uncompressedSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
              uncompressedSize = Number(view.getBigUint64(zp, true));
              zp += 8;
            }
            if (compressedSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
              compressedSize = Number(view.getBigUint64(zp, true));
              zp += 8;
            }
            if (localHeaderOffset === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
              localHeaderOffset = Number(view.getBigUint64(zp, true));
              zp += 8;
            }
            break;
          }
          ep += 4 + dataSize;
        }
      }

      const isDirectory = fullPath.endsWith("/");
      const parts = fullPath.replace(/\/$/, "").split("/");
      const fileName = parts[parts.length - 1] || "";
      const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";

      // Ignora arquivos ocultos do macOS (__MACOSX, .DS_Store)
      if (!fullPath.startsWith("__MACOSX/") && !fileName.startsWith("._") && fileName !== ".DS_Store") {
        this.entries.push({
          fullPath,
          fileName,
          folderPath,
          isDirectory,
          compressionMethod,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
          flags,
          ext: fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : ""
        });
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }
  }

  getMediaEntries() {
    const validExts = new Set(["png", "jpg", "jpeg", "webp", "webm", "mp4", "m4v", "ogg", "mp3", "wav"]);
    return this.entries.filter((e) => !e.isDirectory && validExts.has(e.ext));
  }

  getGroupedByFolder() {
    const groups = new Map();
    for (const entry of this.getMediaEntries()) {
      const folder = entry.folderPath || "Raiz do Pacote";
      if (!groups.has(folder)) {
        groups.set(folder, []);
      }
      groups.get(folder).push(entry);
    }
    return groups;
  }

  async extractEntryBlob(entry) {
    // Lê o Local File Header (30 bytes + nome + extra) + dados comprimidos em uma única chamada Range!
    const readSize = 30 + 512 + entry.compressedSize;
    const chunk = await this.source.readRange(entry.localHeaderOffset, readSize);
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (view.getUint32(0, true) !== 0x04034b50) {
      throw new Error(`Cabeçalho ZIP local inválido para ${entry.fileName}`);
    }

    const localNameLen = view.getUint16(26, true);
    const localExtraLen = view.getUint16(28, true);
    const dataStart = 30 + localNameLen + localExtraLen;

    let compressedData;
    if (dataStart + entry.compressedSize <= chunk.length) {
      compressedData = chunk.subarray(dataStart, dataStart + entry.compressedSize);
    } else {
      compressedData = await this.source.readRange(entry.localHeaderOffset + dataStart, entry.compressedSize);
    }

    const mime = this._getMimeType(entry.ext);

    if (entry.compressionMethod === 0) {
      // STORE (Sem compressão)
      return new Blob([compressedData], { type: mime });
    } else if (entry.compressionMethod === 8) {
      // DEFLATE (Descompacta na memória RAM usando DecompressionStream nativo do Chrome/Foundry!)
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      writer.write(compressedData);
      writer.close();
      const decompressedResponse = new Response(ds.readable);
      const ab = await decompressedResponse.arrayBuffer();
      return new Blob([ab], { type: mime });
    } else {
      throw new Error(`Método de compressão ZIP (${entry.compressionMethod}) não suportado para preview rápido.`);
    }
  }

  async getPreviewUrl(entry) {
    if (this.blobUrlCache.has(entry.fullPath)) {
      return this.blobUrlCache.get(entry.fullPath);
    }
    const blob = await this.extractEntryBlob(entry);
    const url = URL.createObjectURL(blob);
    this.blobUrlCache.set(entry.fullPath, url);
    return url;
  }

  dispose() {
    for (const url of this.blobUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrlCache.clear();
  }

  _getMimeType(ext) {
    const map = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      webm: "video/webm",
      mp4: "video/mp4",
      m4v: "video/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wav: "audio/wav"
    };
    return map[ext] || "application/octet-stream";
  }
}
