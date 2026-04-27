require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { get, put } = require('@vercel/blob');

const DEFAULT_STORAGE_MODE = String(process.env.ORPHAN_INDEX_STORAGE || 'auto').toLowerCase();
const DEFAULT_BLOB_PATH = process.env.ORPHAN_INDEX_BLOB_PATH || 'orphans/orphan-tv-anime.json';
const DEFAULT_BLOB_ACCESS = process.env.ORPHAN_INDEX_BLOB_ACCESS || 'private';

function normalizeStorageMode(mode) {
  const value = String(mode || DEFAULT_STORAGE_MODE).toLowerCase();
  if (value === 'blob' || value === 'file') {
    return value;
  }

  return 'auto';
}

function hasBlobToken() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function shouldUseBlob(mode) {
  const normalizedMode = normalizeStorageMode(mode);
  return normalizedMode === 'blob' || (normalizedMode === 'auto' && hasBlobToken());
}

function buildBlobOptions(access) {
  return {
    access,
    token: process.env.BLOB_READ_WRITE_TOKEN
  };
}

async function readLocalPayload(filePath) {
  try {
    const stats = await fs.stat(filePath);
    const fileContents = await fs.readFile(filePath, 'utf8');
    return {
      payload: JSON.parse(fileContents),
      source: 'file',
      versionTag: `file:${stats.mtimeMs}`,
      updatedAt: stats.mtimeMs,
      meta: {
        filePath
      }
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function readBlobPayload(blobPath, access) {
  const result = await get(blobPath, buildBlobOptions(access));
  if (!result || result.statusCode === 404) {
    return null;
  }

  const text = await new Response(result.stream).text();
  const blobInfo = result.blob || {};

  return {
    payload: JSON.parse(text),
    source: 'blob',
    versionTag: blobInfo.etag || blobInfo.url || blobInfo.pathname || null,
    updatedAt: blobInfo.uploadedAt ? new Date(blobInfo.uploadedAt).getTime() : Date.now(),
    meta: {
      blobPath,
      blobUrl: blobInfo.url || null,
      pathname: blobInfo.pathname || blobPath,
      uploadedAt: blobInfo.uploadedAt || null,
      etag: blobInfo.etag || null,
      access
    }
  };
}

async function loadOrphanIndexPayload(options = {}) {
  const mode = normalizeStorageMode(options.mode);
  const filePath = path.resolve(process.cwd(), options.filePath || 'data/orphan-tv-anime.json');
  const blobPath = options.blobPath || DEFAULT_BLOB_PATH;
  const blobAccess = options.blobAccess || DEFAULT_BLOB_ACCESS;

  if (shouldUseBlob(mode)) {
    try {
      const blobPayload = await readBlobPayload(blobPath, blobAccess);
      if (blobPayload) {
        return blobPayload;
      }

      if (mode === 'blob') {
        return null;
      }
    } catch (error) {
      if (mode === 'blob') {
        throw error;
      }
    }
  }

  return readLocalPayload(filePath);
}

async function writeLocalPayload(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function saveOrphanIndexPayload(payload, options = {}) {
  const mode = normalizeStorageMode(options.mode);
  const filePath = path.resolve(process.cwd(), options.filePath || 'data/orphan-tv-anime.json');
  const blobPath = options.blobPath || DEFAULT_BLOB_PATH;
  const blobAccess = options.blobAccess || DEFAULT_BLOB_ACCESS;
  const syncLocalCopy = Boolean(options.syncLocalCopy);
  const serialized = JSON.stringify(payload, null, 2);

  if (shouldUseBlob(mode)) {
    const blob = await put(blobPath, serialized, {
      ...buildBlobOptions(blobAccess),
      access: blobAccess,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8'
    });

    if (syncLocalCopy) {
      await writeLocalPayload(filePath, payload);
    }

    return {
      source: 'blob',
      blobPath,
      blobUrl: blob.url,
      pathname: blob.pathname,
      filePath: syncLocalCopy ? filePath : null
    };
  }

  await writeLocalPayload(filePath, payload);
  return {
    source: 'file',
    filePath
  };
}

module.exports = {
  DEFAULT_STORAGE_MODE,
  DEFAULT_BLOB_PATH,
  DEFAULT_BLOB_ACCESS,
  normalizeStorageMode,
  shouldUseBlob,
  loadOrphanIndexPayload,
  saveOrphanIndexPayload
};
