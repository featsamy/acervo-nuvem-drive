// Instalador Inteligente Sob Demanda (Cenas e Tokens Wildcard) para Foundry VTT (v11/v12/v13)
import { translateName, isNightMap } from "./translator.mjs";

const FP = () => foundry?.applications?.apps?.FilePicker?.implementation || FilePicker;

export async function ensureFoundryDirectory(dirPath) {
  const parts = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FP().createDirectory("data", current, {});
    } catch (err) {
      // Ignora se a pasta já existir (EEXIST)
    }
  }
}

export function sanitizeFileName(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export async function getMediaDimensions(blob, ext) {
  const url = URL.createObjectURL(blob);
  try {
    if (["webm", "mp4", "m4v"].includes(ext)) {
      return await new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => resolve({ width: video.videoWidth || 1920, height: video.videoHeight || 1080 });
        video.onerror = () => resolve({ width: 1920, height: 1080 });
        video.src = url;
      });
    } else {
      return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth || 2000, height: img.naturalHeight || 2000 });
        img.onerror = () => resolve({ width: 2000, height: 2000 });
        img.src = url;
      });
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function getOrCreateWorldFolder(folderName, documentType, parentId = null) {
  const existing = game.folders.find(
    (f) => f.type === documentType && f.name === folderName && (f.folder?.id || null) === parentId
  );
  if (existing) return existing;
  return Folder.create({
    name: folderName,
    type: documentType,
    folder: parentId,
    sorting: "a"
  });
}

export function getBestActorType() {
  const types = Object.keys(CONFIG.Actor?.dataModels || game.system?.documentTypes?.Actor || {});
  if (types.includes("npc")) return "npc";
  if (types.includes("character")) return "character";
  if (types.includes("creature")) return "creature";
  return types.find((t) => t !== "base") || "npc";
}

export async function installSingleMapFromZip(archive, entry, options = {}) {
  const { translate = true, packName = "Mapas da Nuvem", saveToCompendium = false } = options;
  const worldId = game.world.id;
  const rawFolder = entry.folderPath ? entry.folderPath.split("/").pop() : packName;
  const ptFolder = translateName(rawFolder, translate) || "Mapas Importados";
  const ptMapName = translateName(entry.fileName, translate);

  const safeFolder = sanitizeFileName(ptFolder);
  const safeFile = `${sanitizeFileName(ptMapName)}.${entry.ext}`;
  const targetDir = `worlds/${worldId}/assets/acervo-nuvem/mapas/${safeFolder}`;

  await ensureFoundryDirectory(targetDir);

  const blob = await archive.extractEntryBlob(entry);
  const dims = await getMediaDimensions(blob, entry.ext);
  const fileObj = new File([blob], safeFile, { type: blob.type });

  await FP().upload("data", targetDir, fileObj, {}, { notify: false });
  const uploadedPath = `${targetDir}/${safeFile}`;

  const rootFolder = await getOrCreateWorldFolder("Mapas da Nuvem", "Scene", null);
  const subFolder = await getOrCreateWorldFolder(ptFolder, "Scene", rootFolder.id);

  const sceneData = {
    name: ptMapName,
    folder: subFolder.id,
    navigation: false,
    background: { src: uploadedPath },
    width: dims.width,
    height: dims.height,
    padding: 0,
    grid: {
      type: 1,
      size: 100,
      distance: 1.5,
      units: "m",
      alpha: 0.2
    },
    tokenVision: true,
    environment: {
      darknessLevel: isNightMap(entry.fileName) ? 0.5 : 0
    },
    flags: {
      "acervo-nuvem-drive": {
        installedPath: uploadedPath,
        installedFolder: targetDir,
        sourceZip: archive.source.name,
        uncompressedSize: entry.uncompressedSize
      }
    }
  };

  const createdScene = await Scene.create(sceneData);

  if (saveToCompendium) {
    const comp = game.packs.get("acervo-nuvem-drive.cenas-nuvem");
    if (comp) {
      if (comp.locked) await comp.configure({ locked: false });
      await comp.importDocument(createdScene);
    }
  }

  return createdScene;
}

export async function installTokenFolderFromZip(archive, folderPath, entries, options = {}) {
  const { translate = true, saveToCompendium = false } = options;
  const worldId = game.world.id;
  const imageEntries = entries.filter((e) => ["png", "webp", "jpg", "jpeg"].includes(e.ext));
  if (!imageEntries.length) {
    throw new Error("Nenhuma imagem de token (.png/.webp/.jpg) encontrada nesta pasta.");
  }

  const rawFolderName = folderPath === "Raiz do Pacote"
    ? archive.source.name.replace(/\.zip$/i, "")
    : folderPath.split("/").pop();
  const ptCreatureName = translateName(rawFolderName, translate) || rawFolderName;
  const safeCreatureFolder = sanitizeFileName(ptCreatureName);

  const zipTitle = translateName(archive.source.name.replace(/\.zip$/i, ""), translate) || "Pacote";
  const safeZipFolder = sanitizeFileName(zipTitle);

  const targetDir = `worlds/${worldId}/assets/acervo-nuvem/tokens/${safeZipFolder}/${safeCreatureFolder}`;
  await ensureFoundryDirectory(targetDir);

  let firstUploadedPath = "";
  let totalBytes = 0;

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const blob = await archive.extractEntryBlob(entry);
    totalBytes += entry.uncompressedSize || blob.size;
    const ptFile = translateName(entry.fileName, translate);
    const safeFile = `${sanitizeFileName(ptFile || `token_${i + 1}`)}.${entry.ext}`;
    const fileObj = new File([blob], safeFile, { type: blob.type });
    await FP().upload("data", targetDir, fileObj, {}, { notify: false });
    if (i === 0) {
      firstUploadedPath = `${targetDir}/${safeFile}`;
    }
  }

  const rootFolder = await getOrCreateWorldFolder("Tokens da Nuvem", "Actor", null);
  const subFolder = await getOrCreateWorldFolder(zipTitle, "Actor", rootFolder.id);

  const actorData = {
    name: `${ptCreatureName} (${imageEntries.length} poses)`,
    type: getBestActorType(),
    folder: subFolder.id,
    img: firstUploadedPath,
    prototypeToken: {
      name: ptCreatureName,
      displayName: 20,
      actorLink: false,
      randomImg: imageEntries.length > 1,
      texture: {
        src: imageEntries.length > 1 ? `${targetDir}/*` : firstUploadedPath,
        scaleX: 1,
        scaleY: 1
      },
      sight: {
        enabled: true
      }
    },
    flags: {
      "acervo-nuvem-drive": {
        installedFolder: targetDir,
        sourceZip: archive.source.name,
        tokenCount: imageEntries.length,
        uncompressedSize: totalBytes
      }
    }
  };

  const createdActor = await Actor.create(actorData);

  if (saveToCompendium) {
    const comp = game.packs.get("acervo-nuvem-drive.tokens-nuvem");
    if (comp) {
      if (comp.locked) await comp.configure({ locked: false });
      await comp.importDocument(createdActor);
    }
  }

  return createdActor;
}
