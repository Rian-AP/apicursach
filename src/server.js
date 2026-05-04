require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const {
  discoverOrphans,
  discoverOrphanBySlug,
  discoverOrphanFromSource,
  discoverOrphanFromMedia,
  mergeOrphanPayloads
} = require('./orphan-discovery');
const {
  loadOrphanIndexPayload,
  saveOrphanIndexPayload,
  normalizeStorageMode
} = require('./orphan-index-store');

const app = express();

const PORT = Number(process.env.PORT || 4000);
const API_BASE_URL = process.env.API_BASE_URL || 'https://hapi.hentaicdn.org/api';
const SITE_ID = String(process.env.SITE_ID || '5');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const PLAYER_RESOLVE_TTL_MS = Number(process.env.PLAYER_RESOLVE_TTL_MS || 10 * 60 * 1000);
const TOP_VIEWS_CACHE_TTL_MS = Number(process.env.TOP_VIEWS_CACHE_TTL_MS || 5 * 60 * 1000);
const ORPHAN_INDEX_PATH = path.resolve(
  process.cwd(),
  process.env.ORPHAN_INDEX_PATH || 'data/orphan-tv-anime.json'
);
const ORPHAN_INDEX_REFRESH_MS = Number(process.env.ORPHAN_INDEX_REFRESH_MS || 30000);
const ORPHAN_SEARCH_MAX_RESULTS = Number(process.env.ORPHAN_SEARCH_MAX_RESULTS || 20);
const ORPHAN_INDEX_STORAGE = normalizeStorageMode(process.env.ORPHAN_INDEX_STORAGE || 'auto');
const ORPHAN_INDEX_BLOB_PATH = process.env.ORPHAN_INDEX_BLOB_PATH || 'orphans/orphan-tv-anime.json';
const ORPHAN_INDEX_BLOB_ACCESS = process.env.ORPHAN_INDEX_BLOB_ACCESS || 'private';
const ORPHAN_SYNC_LOCAL_COPY = /^(1|true|yes)$/i.test(process.env.ORPHAN_SYNC_LOCAL_COPY || 'false');
const ORPHAN_ADMIN_TOKEN = String(process.env.ORPHAN_ADMIN_TOKEN || '');
const CRON_SECRET = String(process.env.CRON_SECRET || '');
const ORPHAN_RUNTIME_DISCOVERY_ENABLED = /^(1|true|yes)$/i.test(process.env.ORPHAN_RUNTIME_DISCOVERY_ENABLED || 'false');
const ORPHAN_RUNTIME_DISCOVERY_MAX_PAGES = Number(process.env.ORPHAN_RUNTIME_DISCOVERY_MAX_PAGES || 5);
const ORPHAN_REBUILD_MAX_PAGES = Number(process.env.ORPHAN_REBUILD_MAX_PAGES || 5);
const ORPHAN_REBUILD_CONCURRENCY = Number(process.env.ORPHAN_REBUILD_CONCURRENCY || 4);
const ORPHAN_REBUILD_SOURCE_SLUGS = String(process.env.ORPHAN_REBUILD_SOURCE_SLUGS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const BROWSER_USER_AGENT = [
  'Mozilla/5.0',
  '(Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36',
  '(KHTML, like Gecko)',
  'Chrome/135.0.0.0',
  'Safari/537.36'
].join(' ');

const playerResolveCache = new Map();
const runtimeDiscoveryCache = new Map();
const topViewsCache = new Map();
const animeDetailsCache = new Map();
const ANIME_DETAILS_CACHE_TTL_MS = Number(process.env.ANIME_DETAILS_CACHE_TTL_MS || 5 * 60 * 1000);
const pendingDiscoveries = new Map();
const DISCOVERY_TIMEOUT_MS = Number(process.env.DISCOVERY_TIMEOUT_MS || 20000);
const orphanState = {
  checkedAt: 0,
  items: [],
  rawPayload: null,
  bySlug: new Map(),
  byRouteKey: new Map(),
  loadPromise: null,
  source: 'none',
  versionTag: null,
  payloadMeta: null,
  lastLoadedAt: null
};

const upstream = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Site-Id': SITE_ID,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: 'https://animelib.org',
    Referer: 'https://animelib.org/',
    'User-Agent': BROWSER_USER_AGENT
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqStrings(values) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

function buildOrphanSearchEntry(item) {
  const relatedAnime = Array.isArray(item?.related_anime) ? item.related_anime : [];
  const aliases = uniqStrings([
    item?.name,
    item?.rus_name,
    item?.eng_name,
    item?.slug,
    item?.slug_url,
    item?.card?.data?.name,
    item?.card?.data?.rus_name,
    item?.card?.data?.eng_name,
    item?.card?.data?.slug,
    item?.card?.data?.slug_url,
    item?.source_manga?.name,
    item?.source_manga?.rus_name,
    item?.source_manga?.eng_name,
    item?.source_manga?.slug,
    item?.source_manga?.slug_url,
    ...relatedAnime.flatMap((entry) => [
      entry?.media?.name,
      entry?.media?.rus_name,
      entry?.media?.eng_name,
      entry?.media?.slug,
      entry?.media?.slug_url
    ])
  ]);

  const normalizedAliases = uniqStrings(aliases.map((alias) => normalizeSearchText(alias)).filter(Boolean));

  return {
    ...item,
    _search: {
      aliases,
      normalizedAliases,
      searchableText: normalizedAliases.join(' ')
    }
  };
}

async function refreshOrphanIndex(force = false) {
  const now = Date.now();
  if (orphanState.loadPromise) {
    return orphanState.loadPromise;
  }

  if (!force && now - orphanState.checkedAt < ORPHAN_INDEX_REFRESH_MS) {
    return orphanState;
  }

  orphanState.loadPromise = (async () => {
    orphanState.checkedAt = now;

    try {
      const loaded = await loadOrphanIndexPayload({
        mode: ORPHAN_INDEX_STORAGE,
        filePath: ORPHAN_INDEX_PATH,
        blobPath: ORPHAN_INDEX_BLOB_PATH,
        blobAccess: ORPHAN_INDEX_BLOB_ACCESS
      });
      const payload = loaded?.payload || { items: [] };
      const items = Array.isArray(payload?.items)
        ? payload.items.map((item) => buildOrphanSearchEntry(item))
        : [];

      orphanState.items = items;
      orphanState.rawPayload = payload;
      orphanState.bySlug = new Map(items.map((item) => [item.slug_url, item]));
      orphanState.byRouteKey = new Map();
      for (const item of items) {
        if (item?.slug_url) {
          orphanState.byRouteKey.set(String(item.slug_url), item);
        }
        if (item?.slug) {
          orphanState.byRouteKey.set(String(item.slug), item);
        }
      }
      orphanState.source = loaded?.source || 'none';
      orphanState.versionTag = loaded?.versionTag || null;
      orphanState.payloadMeta = loaded?.meta || null;
      orphanState.lastLoadedAt = new Date().toISOString();

      return orphanState;
    } catch (error) {
      console.error('Failed to refresh orphan index:', error);
      return orphanState;
    } finally {
      orphanState.loadPromise = null;
    }
  })();

  return orphanState.loadPromise;
}

function scoreOrphanSearchMatch(normalizedQuery, queryTokens, item) {
  if (!normalizedQuery) {
    return 0;
  }

  const aliases = item?._search?.normalizedAliases || [];
  const searchableText = item?._search?.searchableText || '';

  let score = 0;

  for (const alias of aliases) {
    if (alias === normalizedQuery) {
      score = Math.max(score, 500);
    } else if (alias.startsWith(normalizedQuery)) {
      score = Math.max(score, 350);
    } else if (alias.includes(normalizedQuery)) {
      score = Math.max(score, 250);
    }
  }

  if (!score && !searchableText.includes(normalizedQuery)) {
    return 0;
  }

  const matchedTokens = queryTokens.filter((token) => searchableText.includes(token));
  if (matchedTokens.length !== queryTokens.length) {
    return 0;
  }

  score += matchedTokens.length * 40;
  score += Math.min(item.episodes_count || 0, 40);

  if (item?.source_manga?.slug_url && searchableText.includes(normalizeSearchText(item.source_manga.slug_url))) {
    score += 5;
  }

  return score;
}

function mapOrphanToSearchItem(item) {
  const base = item?.card?.data || {};

  return {
    ...base,
    restored: true,
    orphaned: true,
    episodes_count: item.episodes_count,
    first_episode_id: item.first_episode_id,
    source_manga: item.source_manga
      ? {
        id: item.source_manga.id,
        slug_url: item.source_manga.slug_url,
        name: item.source_manga.name,
        rus_name: item.source_manga.rus_name,
        model: item.source_manga.model
      }
      : null
  };
}

function buildRestoredAnimePayload(item) {
  const base = item?.card?.data || {};
  const meta = item?.card?.meta || {};

  return {
    data: {
      ...base,
      restored: true,
      orphaned: true,
      episodes_count: item.episodes_count,
      first_episode_id: item.first_episode_id,
      last_episode_id: item.last_episode_id,
      source_manga: item.source_manga,
      related_anime: item.related_anime
    },
    meta: {
      ...meta,
      restored: true,
      orphaned: true,
      episodes_count: item.episodes_count,
      discovered_from: item.discovered_from
    }
  };
}

function buildRestoredSimilarPayload(item) {
  const relatedAnime = Array.isArray(item?.related_anime) ? item.related_anime : [];

  return {
    data: relatedAnime
      .filter((entry) => entry?.media?.model === 'anime')
      .map((entry) => ({
        id: null,
        similar: entry?.relation_type || 'Связанный тайтл',
        user_id: null,
        media: entry.media,
        restored: true
      })),
    meta: {
      restored: true,
      orphaned: true,
      source_slug_url: item?.slug_url || null
    }
  };
}

function mergeSimilarPayloads(restoredPayload, upstreamPayload) {
  const restoredItems = Array.isArray(restoredPayload?.data) ? restoredPayload.data : [];
  const upstreamItems = Array.isArray(upstreamPayload?.data) ? upstreamPayload.data : [];
  const seen = new Set();
  const merged = [];

  const pushItem = (item) => {
    const media = item?.media || {};
    const key = String(media.slug_url || media.slug || media.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(item);
  };

  restoredItems.forEach(pushItem);
  upstreamItems.forEach(pushItem);

  return {
    data: merged,
    meta: {
      ...(upstreamPayload?.meta || {}),
      ...(restoredPayload?.meta || {}),
      merged: true,
      restored_count: restoredItems.length,
      upstream_count: upstreamItems.length,
      total_count: merged.length
    }
  };
}

function isUpstreamAnimeNotFoundResponse(response) {
  if (response?.status === 404) {
    return true;
  }

  const toastMessage = String(response?.data?.data?.toast?.message || '').trim().toLowerCase();
  return toastMessage === 'not found';
}

function getRestoredAnimeItem(state, routeKey) {
  const key = String(routeKey || '').trim();
  if (!key) {
    return null;
  }

  return state.byRouteKey.get(key) || state.bySlug.get(key) || null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return /^(1|true|yes)$/i.test(String(value));
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseSourceSlugsInput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return '';
  }

  return authHeader.slice(7).trim();
}

function isInternalRequestAuthorized(req, options = {}) {
  const token = getBearerToken(req);
  if (!token) {
    return false;
  }

  if (ORPHAN_ADMIN_TOKEN && token === ORPHAN_ADMIN_TOKEN) {
    return true;
  }

  if (options.allowCron && CRON_SECRET && token === CRON_SECRET) {
    return true;
  }

  return false;
}

function getEmptyOrphanPayload() {
  return {
    generatedAt: new Date().toISOString(),
    upstream: API_BASE_URL,
    siteId: SITE_ID,
    typeId: 16,
    seed: null,
    scannedSourceTitles: 0,
    orphanCount: 0,
    items: []
  };
}

async function persistOrphanPayload(payload) {
  const saveResult = await saveOrphanIndexPayload(payload, {
    mode: ORPHAN_INDEX_STORAGE,
    filePath: ORPHAN_INDEX_PATH,
    blobPath: ORPHAN_INDEX_BLOB_PATH,
    blobAccess: ORPHAN_INDEX_BLOB_ACCESS,
    syncLocalCopy: ORPHAN_SYNC_LOCAL_COPY
  });

  await refreshOrphanIndex(true);
  return saveResult;
}

async function mergeAndPersistOrphanPayload(incomingPayload) {
  const state = await refreshOrphanIndex();
  const basePayload = state.rawPayload || getEmptyOrphanPayload();
  const mergedPayload = mergeOrphanPayloads(basePayload, incomingPayload);
  const saveResult = await persistOrphanPayload(mergedPayload);

  return {
    mergedPayload,
    saveResult
  };
}

async function maybeDiscoverAndPersistOrphan(routeKey) {
  if (!ORPHAN_RUNTIME_DISCOVERY_ENABLED) {
    return null;
  }

  const normalizedRouteKey = String(routeKey || '').trim();
  if (!normalizedRouteKey) {
    return null;
  }

  const currentState = await refreshOrphanIndex();
  const existing = getRestoredAnimeItem(currentState, normalizedRouteKey);
  if (existing) {
    return existing;
  }

  if (runtimeDiscoveryCache.has(normalizedRouteKey)) {
    return runtimeDiscoveryCache.get(normalizedRouteKey);
  }

  const discoveryPromise = (async () => {
    const discoveredPayload = await discoverOrphanBySlug(normalizedRouteKey, {
      maxPages: ORPHAN_RUNTIME_DISCOVERY_MAX_PAGES
    });

    if (!discoveredPayload || !Array.isArray(discoveredPayload.items) || discoveredPayload.items.length === 0) {
      return null;
    }

    await mergeAndPersistOrphanPayload(discoveredPayload);
    const refreshedState = await refreshOrphanIndex(true);
    return getRestoredAnimeItem(refreshedState, normalizedRouteKey);
  })().finally(() => {
    runtimeDiscoveryCache.delete(normalizedRouteKey);
  });

  runtimeDiscoveryCache.set(normalizedRouteKey, discoveryPromise);
  return discoveryPromise;
}

function buildRebuildArgs(input = {}) {
  const sourceSlugs = parseSourceSlugsInput(input.source_slugs || input.sourceSlugs);

  return {
    sourceSlugs: sourceSlugs.length > 0 ? sourceSlugs : ORPHAN_REBUILD_SOURCE_SLUGS,
    maxPages: parsePositiveNumber(input.max_pages || input.maxPages, ORPHAN_REBUILD_MAX_PAGES),
    startPage: parsePositiveNumber(input.start_page || input.startPage, 1),
    concurrency: parsePositiveNumber(input.concurrency, ORPHAN_REBUILD_CONCURRENCY),
    typeId: parsePositiveNumber(input.type_id || input.typeId, 16),
    replace: parseBoolean(input.replace, false)
  };
}

async function runOrphanRebuild(args) {
  const discoveredPayload = await discoverOrphans(args);
  const persisted = args.replace
    ? {
      mergedPayload: discoveredPayload,
      saveResult: await persistOrphanPayload(discoveredPayload)
    }
    : await mergeAndPersistOrphanPayload(discoveredPayload);

  return {
    discoveredPayload,
    persistedPayload: persisted.mergedPayload,
    saveResult: persisted.saveResult
  };
}

function searchOrphanIndex(state, query) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  if (!normalizedQuery || queryTokens.length === 0) {
    return [];
  }

  return state.items
    .map((item) => ({
      item,
      score: scoreOrphanSearchMatch(normalizedQuery, queryTokens, item)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score === right.score) {
        return left.item.slug_url.localeCompare(right.item.slug_url);
      }

      return right.score - left.score;
    })
    .slice(0, ORPHAN_SEARCH_MAX_RESULTS);
}

function mergeAnimeSearchPayload(payload, orphanMatches) {
  const upstreamData = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set(
    upstreamData.map((item) => `${item?.id || ''}:${item?.slug_url || ''}`)
  );

  const topOrphans = [];
  const bottomOrphans = [];

  for (const entry of orphanMatches) {
    const item = mapOrphanToSearchItem(entry.item);
    const key = `${item?.id || ''}:${item?.slug_url || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (entry.score >= 500) {
      topOrphans.push(item);
    } else {
      bottomOrphans.push(item);
    }
  }

  const restoredCount = topOrphans.length + bottomOrphans.length;

  return {
    ...payload,
    data: [...topOrphans, ...upstreamData, ...bottomOrphans],
    meta: {
      ...(payload?.meta || {}),
      restored_count: restoredCount
    }
  };
}

const TOP_VIEWS_GROUPS = [
  { key: 'completed', label: 'Завершённое', popularity: '21' },
  { key: 'ongoing', label: 'Онгоинг', popularity: '22' },
  { key: 'movie', label: 'Полнометражное', popularity: '23' }
];

const TOP_VIEWS_TIME_LABELS = {
  day: 'За день',
  week: 'За неделю',
  month: 'За месяц'
};

function parseTopViewsTime(value) {
  const normalized = String(value ?? 'day').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOP_VIEWS_TIME_LABELS, normalized)
    ? normalized
    : null;
}

function getTopViewsMetricKey(time) {
  return `views_${time}`;
}

function extractUpstreamCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

async function fetchTopViewsGroup(group, options = {}) {
  const response = await upstream.get('/media/top-views', {
    params: {
      time: options.time,
      popularity: group.popularity,
      page: options.page
    },
    validateStatus: () => true
  });

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Top views upstream failed for popularity ${group.popularity}`);
    error.response = response;
    throw error;
  }

  const items = extractUpstreamCollection(response.data);

  return {
    key: group.key,
    label: group.label,
    popularity: group.popularity,
    metric: getTopViewsMetricKey(options.time),
    count: items.length,
    items
  };
}

async function buildTopViewsPayload(options = {}) {
  const cacheKey = `${options.time || 'day'}:${options.page || 1}`;
  const cached = topViewsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const settled = await Promise.allSettled(
    TOP_VIEWS_GROUPS.map((group) => fetchTopViewsGroup(group, options))
  );

  const groups = [];
  const errors = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const group = TOP_VIEWS_GROUPS[index];

    if (result.status === 'fulfilled') {
      groups.push(result.value);
      continue;
    }

    errors.push({
      key: group.key,
      label: group.label,
      popularity: group.popularity,
      message: result.reason?.message || 'Unknown upstream error'
    });
  }

  if (groups.length === 0) {
    const failure = settled.find((entry) => entry.status === 'rejected');
    throw failure?.reason || new Error('Top views upstream unavailable');
  }

  const payload = {
    data: {
      title: 'Сейчас смотрят',
      time: options.time,
      time_label: TOP_VIEWS_TIME_LABELS[options.time],
      page: options.page,
      groups
    },
    meta: {
      partial: errors.length > 0,
      group_count: groups.length,
      errors
    }
  };

  topViewsCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + TOP_VIEWS_CACHE_TTL_MS
  });

  return payload;
}

function sendUpstreamError(res, error) {
  const status = error?.response?.status;
  if (status) {
    return res.status(status).json({
      ok: false,
      error: 'Upstream API error',
      status,
      details: error?.response?.data ?? null
    });
  }

  return res.status(502).json({
    ok: false,
    error: 'Upstream API unavailable'
  });
}

function sendUpstreamResponse(res, response) {
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  res.status(response.status);

  if (contentType.includes('application/json') || typeof response.data === 'object') {
    return res.json(response.data);
  }

  return res.send(response.data);
}

async function proxyGet(req, res, upstreamPath) {
  try {
    const upstreamResponse = await upstream.get(upstreamPath, {
      params: req.query,
      validateStatus: () => true
    });
    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
}

function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  return url;
}

function isResolvablePlayer(player) {
  const embedUrl = normalizeUrl(player?.src);
  return Boolean(embedUrl && /kodikplayer\.com/i.test(embedUrl));
}

function decodeKodikUrl(url) {
  if (typeof url !== 'string' || !url) {
    return null;
  }

  if (url.includes('//')) {
    return normalizeUrl(url);
  }

  try {
    const shifted = url.replace(/[a-zA-Z]/g, (char) => {
      const charCode = char.charCodeAt(0) + 18;
      const upperBound = char <= 'Z' ? 90 : 122;
      return String.fromCharCode(upperBound >= charCode ? charCode : charCode - 26);
    });

    return normalizeUrl(Buffer.from(shifted, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function getCachedResolvedPlayer(cacheKey) {
  const cached = playerResolveCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    playerResolveCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCachedResolvedPlayer(cacheKey, value) {
  playerResolveCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + PLAYER_RESOLVE_TTL_MS
  });
}

function extractMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

function parseKodikPage(html) {
  const rawUrlParams = extractMatch(html, /urlParams\s*=\s*'([^']+)'/);
  const type = extractMatch(html, /vInfo\.type\s*=\s*'([^']+)'/);
  const hash = extractMatch(html, /vInfo\.hash\s*=\s*'([^']+)'/);
  const id = extractMatch(html, /vInfo\.id\s*=\s*'([^']+)'/);

  if (!rawUrlParams || !type || !hash || !id) {
    return null;
  }

  return {
    urlParams: JSON.parse(rawUrlParams),
    type,
    hash,
    id
  };
}

function buildResolvedQualityLinks(links) {
  if (!links || typeof links !== 'object') {
    return null;
  }

  const entries = Object.entries(links)
    .map(([quality, variants]) => {
      const normalizedVariants = Array.isArray(variants)
        ? variants
          .map((variant) => {
            if (!variant || typeof variant !== 'object') {
              return null;
            }

            const resolvedSrc = decodeKodikUrl(variant.src) || normalizeUrl(variant.src);
            if (!resolvedSrc) {
              return null;
            }

            return {
              ...variant,
              src: resolvedSrc
            };
          })
          .filter(Boolean)
        : [];

      return [quality, normalizedVariants];
    })
    .filter(([, variants]) => variants.length > 0);

  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

function pickDefaultQualityLink(defaultQuality, qualityLinks) {
  if (!qualityLinks || typeof qualityLinks !== 'object') {
    return null;
  }

  const directDefault = qualityLinks[String(defaultQuality)]?.[0]?.src;
  if (directDefault) {
    return directDefault;
  }

  return Object.values(qualityLinks).flat()[0]?.src || null;
}

async function resolveKodikPlayer(player) {
  const embedUrl = normalizeUrl(player?.src);
  if (!isResolvablePlayer(player)) {
    return player;
  }

  const cached = getCachedResolvedPlayer(embedUrl);
  if (cached) {
    return {
      ...player,
      ...cached
    };
  }

  const pageResponse = await axios.get(embedUrl, {
    timeout: REQUEST_TIMEOUT_MS,
    responseType: 'text',
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml'
    }
  });

  const pageData = parseKodikPage(String(pageResponse.data || ''));
  if (!pageData) {
    return player;
  }

  const requestBody = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(pageData.urlParams).map(([key, value]) => [key, String(value)])
    ),
    type: pageData.type,
    hash: pageData.hash,
    id: pageData.id,
    bad_user: 'false',
    cdn_is_working: 'true'
  });

  const ftorResponse = await axios.post('https://kodikplayer.com/ftor', requestBody.toString(), {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: 'https://kodikplayer.com',
      Referer: embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  const qualityLinks = buildResolvedQualityLinks(ftorResponse.data?.links);
  const srcResolved = normalizeUrl(ftorResponse.data?.link) || pickDefaultQualityLink(ftorResponse.data?.default, qualityLinks);

  if (!srcResolved && !qualityLinks) {
    return player;
  }

  const resolvedFields = {
    src_resolved: srcResolved,
    quality_default: ftorResponse.data?.default ?? null,
    quality_links: qualityLinks
  };

  setCachedResolvedPlayer(embedUrl, resolvedFields);

  return {
    ...player,
    ...resolvedFields
  };
}

function selectPlayersToResolve(players, options = {}) {
  const playerId = options.playerId ? String(options.playerId) : null;
  const resolveMode = String(options.resolveMode || 'first').toLowerCase();

  if (!Array.isArray(players) || players.length === 0) {
    return new Set();
  }

  if (playerId) {
    const selectedPlayer = players.find((player) => String(player?.id) === playerId);
    return selectedPlayer ? new Set([selectedPlayer.id]) : new Set();
  }

  if (resolveMode === 'none') {
    return new Set();
  }

  if (resolveMode === 'all') {
    return new Set(
      players
        .filter((player) => isResolvablePlayer(player))
        .map((player) => player.id)
    );
  }

  const defaultPlayer = players.find((player) => isResolvablePlayer(player)) || players[0];
  return defaultPlayer ? new Set([defaultPlayer.id]) : new Set();
}

async function enrichEpisodePlayers(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || !payload.data || !Array.isArray(payload.data.players)) {
    return payload;
  }

  const playersToResolve = selectPlayersToResolve(payload.data.players, options);
  const resolvedPlayers = await Promise.allSettled(
    payload.data.players.map((player) => (
      playersToResolve.has(player.id)
        ? resolveKodikPlayer(player)
        : Promise.resolve(player)
    ))
  );

  return {
    ...payload,
    data: {
      ...payload.data,
      players: payload.data.players.map((player, index) => {
        const result = resolvedPlayers[index];
        return result?.status === 'fulfilled' ? result.value : player;
      })
    },
    meta: {
      ...(payload.meta || {}),
      resolved_player_ids: Array.from(playersToResolve),
      resolve_mode: options.playerId ? 'player_id' : String(options.resolveMode || 'first').toLowerCase()
    }
  }
}

function swaggerHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>animelib-backend Swagger</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      html, body { margin: 0; padding: 0; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;
}

function openApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'animelib-backend',
      version: '1.0.0',
      description: 'Минимальный proxy к hapi.hentaicdn.org для базовых маршрутов.'
    },
    servers: [
      { url: '/' }
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Проверка доступности сервиса',
          responses: {
            '200': { description: 'OK' }
          }
        }
      },
      '/latest-updates': {
        get: {
          summary: 'Прямой proxy: latest updates',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/top-views': {
        get: {
          summary: 'Агрегированный блок "Сейчас смотрят" по AnimeLib top views',
          parameters: [
            { name: 'time', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }
          ],
          responses: {
            '200': { description: 'Aggregated top views payload' },
            '400': { description: 'Invalid query params' }
          }
        }
      },
      '/anime': {
        get: {
          summary: 'Поиск аниме с подмешиванием локально восстановленных orphan-страниц',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/anime/{slug}': {
        get: {
          summary: 'Карточка тайтла с fallback на локально восстановленные orphan-страницы и optional runtime-discovery',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/anime/{slug}/similar': {
        get: {
          summary: 'Похожие тайтлы с fallback на восстановленные orphan-связи',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/episodes': {
        get: {
          summary: 'Прямой proxy: список эпизодов тайтла',
          parameters: [
            { name: 'anime_id', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/episodes/{id}': {
        get: {
          summary: 'Детали эпизода с выборочным резолвом прямых ссылок для Kodik player',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'player_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'resolve', in: 'query', required: false, schema: { type: 'string', enum: ['first', 'all', 'none'] } }
          ],
          responses: {
            '200': { description: 'Upstream response' }
          }
        }
      },
      '/internal/orphans/status': {
        get: {
          summary: 'Внутренний статус orphan-индекса',
          responses: {
            '200': { description: 'Status payload' },
            '401': { description: 'Unauthorized' }
          }
        }
      },
      '/internal/orphans/rebuild': {
        get: {
          summary: 'Cron rebuild orphan-индекса',
          responses: {
            '200': { description: 'Rebuild result' },
            '401': { description: 'Unauthorized' }
          }
        },
        post: {
          summary: 'Manual rebuild orphan-индекса',
          responses: {
            '200': { description: 'Rebuild result' },
            '401': { description: 'Unauthorized' }
          }
        }
      }
    }
  };
}

app.get('/', (_req, res) => {
  res.type('html').send(swaggerHtml());
});

app.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec());
});

app.get('/health', async (_req, res) => {
  const state = await refreshOrphanIndex();
  res.json({
    ok: true,
    service: 'animelib-backend',
    upstream: API_BASE_URL,
    siteId: SITE_ID,
    orphanIndexPath: ORPHAN_INDEX_PATH,
    orphanCount: state.items.length,
    orphanStorage: ORPHAN_INDEX_STORAGE,
    orphanSource: state.source,
    orphanBlobPath: ORPHAN_INDEX_BLOB_PATH
  });
});

app.post('/internal/orphans/add', async (req, res) => {
  if (!isInternalRequestAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const slug = String((req.body?.slug || req.query.slug || '')).trim();
  const sourceSlug = String((req.body?.sourceSlug || req.query.sourceSlug || '')).trim();

  if (!slug || !sourceSlug) {
    return res.status(400).json({ ok: false, error: 'slug and sourceSlug are required' });
  }

  try {
    const discovered = await discoverOrphanFromSource(slug, sourceSlug);
    if (!discovered) {
      return res.status(404).json({ ok: false, error: 'Orphan not found in source relations or not a 404 anime' });
    }

    const existingState = await refreshOrphanIndex();
    const merged = mergeOrphanPayloads(discovered, existingState.rawPayload);
    const saveResult = await saveOrphanIndexPayload(merged);

    orphanState.checkedAt = 0;
    await refreshOrphanIndex(true);

    return res.json({
      ok: true,
      slug,
      sourceSlug,
      orphanCount: merged.orphanCount,
      saveSource: saveResult.source
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/internal/cache/clear', (req, res) => {
  if (!isInternalRequestAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const count = animeDetailsCache.size;
  animeDetailsCache.clear();
  playerResolveCache.clear();
  topViewsCache.clear();

  return res.json({ ok: true, cleared: count });
});

app.get('/internal/orphans/status', async (req, res) => {
  if (!isInternalRequestAuthorized(req, { allowCron: true })) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  const state = await refreshOrphanIndex();
  return res.json({
    ok: true,
    storage: ORPHAN_INDEX_STORAGE,
    source: state.source,
    versionTag: state.versionTag,
    orphanCount: state.items.length,
    runtimeDiscoveryEnabled: ORPHAN_RUNTIME_DISCOVERY_ENABLED,
    runtimeDiscoveryMaxPages: ORPHAN_RUNTIME_DISCOVERY_MAX_PAGES,
    localPath: ORPHAN_INDEX_PATH,
    blobPath: ORPHAN_INDEX_BLOB_PATH,
    blobAccess: ORPHAN_INDEX_BLOB_ACCESS,
    lastLoadedAt: state.lastLoadedAt,
    payloadMeta: state.payloadMeta
  });
});

app.get('/internal/orphans/rebuild', async (req, res) => {
  if (!isInternalRequestAuthorized(req, { allowCron: true })) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  try {
    const rebuildArgs = buildRebuildArgs(req.query);
    const result = await runOrphanRebuild(rebuildArgs);

    return res.json({
      ok: true,
      trigger: 'cron',
      args: rebuildArgs,
      discovered: {
        orphanCount: result.discoveredPayload.orphanCount,
        scannedSourceTitles: result.discoveredPayload.scannedSourceTitles
      },
      persisted: {
        orphanCount: result.persistedPayload.orphanCount,
        source: result.saveResult.source
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Orphan rebuild failed',
      details: error?.message || String(error)
    });
  }
});

app.post('/internal/orphans/rebuild', async (req, res) => {
  if (!isInternalRequestAuthorized(req, { allowCron: true })) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  try {
    const rebuildArgs = buildRebuildArgs({
      ...req.query,
      ...(req.body || {})
    });
    const result = await runOrphanRebuild(rebuildArgs);

    return res.json({
      ok: true,
      trigger: 'manual',
      args: rebuildArgs,
      discovered: {
        orphanCount: result.discoveredPayload.orphanCount,
        scannedSourceTitles: result.discoveredPayload.scannedSourceTitles
      },
      persisted: {
        orphanCount: result.persistedPayload.orphanCount,
        source: result.saveResult.source
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Orphan rebuild failed',
      details: error?.message || String(error)
    });
  }
});

app.get('/latest-updates', async (req, res) => {
  return proxyGet(req, res, '/latest-updates');
});

app.get('/top-views', async (req, res) => {
  const time = parseTopViewsTime(req.query.time);
  if (!time) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid time value',
      allowed: Object.keys(TOP_VIEWS_TIME_LABELS)
    });
  }

  const page = parsePositiveNumber(req.query.page, 1);

  try {
    const payload = await buildTopViewsPayload({ time, page });
    return res.json(payload);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/anime', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const page = Number(req.query.page || 1);

  if (!query || page > 1) {
    return proxyGet(req, res, '/anime');
  }

  try {
    const upstreamResponse = await upstream.get('/anime', {
      params: req.query,
      validateStatus: () => true
    });

    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      return sendUpstreamResponse(res, upstreamResponse);
    }

    const state = await refreshOrphanIndex();
    const orphanMatches = searchOrphanIndex(state, query);
    const mergedPayload = mergeAnimeSearchPayload(upstreamResponse.data, orphanMatches);

    return res.status(upstreamResponse.status).json(mergedPayload);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/anime/:slug/similar', async (req, res) => {
  try {
    const upstreamResponse = await upstream.get(`/anime/${encodeURIComponent(req.params.slug)}/similar`, {
      validateStatus: () => true
    });

    let state = await refreshOrphanIndex();
    let restoredItem = getRestoredAnimeItem(state, req.params.slug);
    if (!restoredItem && isUpstreamAnimeNotFoundResponse(upstreamResponse)) {
      restoredItem = await maybeDiscoverAndPersistOrphan(req.params.slug);
      state = await refreshOrphanIndex();
      restoredItem = restoredItem || getRestoredAnimeItem(state, req.params.slug);
    }

    const restoredSimilarPayload = restoredItem ? buildRestoredSimilarPayload(restoredItem) : null;
    const hasRestoredSimilar = Array.isArray(restoredSimilarPayload?.data) && restoredSimilarPayload.data.length > 0;
    const upstreamSimilarItems = Array.isArray(upstreamResponse?.data?.data) ? upstreamResponse.data.data : null;
    const shouldUseRestoredSimilar = restoredItem && hasRestoredSimilar;

    if (shouldUseRestoredSimilar) {
      const mergedSimilarPayload = mergeSimilarPayloads(restoredSimilarPayload, upstreamResponse.data);
      return res.status(200).json(mergedSimilarPayload);
    }

    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/anime/:slug', async (req, res) => {
  try {
    const cacheKey = String(req.params.slug);
    const cached = animeDetailsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.status(200).json(cached.data);
    }

    const [upstreamResponse, relationsResponse] = await Promise.all([
      upstream.get(`/anime/${encodeURIComponent(req.params.slug)}`, {
        params: { 'fields[]': ['background', 'summary', 'genres'] },
        validateStatus: () => true
      }),
      upstream.get(`/anime/${encodeURIComponent(req.params.slug)}/relations`, {
        validateStatus: () => true
      }).catch(() => null)
    ]);

    if (
      upstreamResponse.status === 200 &&
      typeof upstreamResponse.data === 'object' &&
      upstreamResponse.data?.data
    ) {
      const relations = relationsResponse?.status === 200 && Array.isArray(relationsResponse?.data?.data)
        ? relationsResponse.data.data
        : [];

      if (relations.length > 0) {
        upstreamResponse.data.data.related_anime = relations.map((entry) => ({
          relation_type: entry?.related_type?.label || null,
          media: entry?.media || null
        }));
      }

      animeDetailsCache.set(cacheKey, {
        data: upstreamResponse.data,
        expiresAt: Date.now() + ANIME_DETAILS_CACHE_TTL_MS
      });
    }

    if (isUpstreamAnimeNotFoundResponse(upstreamResponse)) {
      let state = await refreshOrphanIndex();
      let restoredItem = getRestoredAnimeItem(state, req.params.slug);

      if (!restoredItem) {
        const slugKey = String(req.params.slug).toLowerCase();
        const sourceSlug = String(req.query.sourceSlug || '').trim();

        const slugIdMatch = req.params.slug.match(/^(\d+)--/);
        const slugNumericId = slugIdMatch ? Number(slugIdMatch[1]) : null;
        const hintCover = String(req.query.hintCover || '').trim() || null;
        const hintName = String(req.query.hintName || '').trim() || null;
        const hintRus = String(req.query.hintRus || '').trim() || null;
        const hintEng = String(req.query.hintEng || '').trim() || null;
        const minimalMedia = slugNumericId ? {
          id: slugNumericId,
          slug_url: req.params.slug,
          slug: req.params.slug,
          model: 'anime',
          site: 5,
          name: hintName || hintEng || hintRus || null,
          rus_name: hintRus || null,
          eng_name: hintEng || null,
          cover: hintCover ? { default: hintCover, md: hintCover, thumbnail: hintCover } : null,
        } : null;

        if (!pendingDiscoveries.has(slugKey)) {
          const discoveryPromise = (async () => {
            try {
              let discovered = null;

              if (sourceSlug && minimalMedia) {
                const timeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('discovery timeout')), DISCOVERY_TIMEOUT_MS)
                );
                discovered = await Promise.race([
                  discoverOrphanFromSource(req.params.slug, sourceSlug, { api: upstream }),
                  timeout
                ]).catch(() => null);

                if (!discovered) {
                  discovered = await Promise.race([
                    discoverOrphanFromMedia(minimalMedia, sourceSlug),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DISCOVERY_TIMEOUT_MS))
                  ]).catch(() => null);
                }
              } else if (minimalMedia) {
                const timeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('discovery timeout')), DISCOVERY_TIMEOUT_MS)
                );
                discovered = await Promise.race([
                  discoverOrphanFromMedia(minimalMedia, req.params.slug),
                  timeout
                ]).catch(() => null);
              }

              if (discovered) {
                refreshOrphanIndex().then((existing) => {
                  const merged = mergeOrphanPayloads(discovered, existing.rawPayload);
                  return saveOrphanIndexPayload(merged).then(() => {
                    orphanState.checkedAt = 0;
                  });
                }).catch(() => {});
              }

              return discovered;
            } finally {
              pendingDiscoveries.delete(slugKey);
            }
          })();

          pendingDiscoveries.set(slugKey, discoveryPromise);
        }

        const pending = pendingDiscoveries.get(slugKey);
        const result = pending ? await pending.catch(() => null) : null;
        const discoveredItem = result?.items?.[0] || null;

        if (discoveredItem) {
          return res.status(200).json(buildRestoredAnimePayload(discoveredItem));
        }

        return res.status(404).json({
          ok: false,
          error: 'Not found',
          discovering: false,
          message: 'Anime not found'
        });
      }

      if (restoredItem) {
        return res.status(200).json(buildRestoredAnimePayload(restoredItem));
      }
    }

    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/episodes', async (req, res) => {
  return proxyGet(req, res, '/episodes');
});

app.get('/episodes/:id', async (req, res) => {
  try {
    const upstreamResponse = await upstream.get(`/episodes/${encodeURIComponent(req.params.id)}`, {
      validateStatus: () => true
    });

    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      return sendUpstreamResponse(res, upstreamResponse);
    }

    const enrichedPayload = await enrichEpisodePlayers(upstreamResponse.data, {
      playerId: req.query.player_id,
      resolveMode: req.query.resolve
    });
    return res.status(upstreamResponse.status).json(enrichedPayload);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/img', async (req, res) => {
  const url = String(req.query.u || '').trim();
  if (!url || !url.startsWith('https://cover.hentaicdn.org/')) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing url param' });
  }

  try {
    const imageResponse = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Referer': 'https://animelib.org/',
        'Origin': 'https://animelib.org',
        'Accept': 'image/webp,image/jpeg,image/*,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    res.setHeader('Content-Type', imageResponse.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(imageResponse.data));
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

refreshOrphanIndex(true).catch((error) => {
  console.error('Initial orphan index load failed:', error);
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`animelib-backend running on http://localhost:${PORT}`);
  });
}
