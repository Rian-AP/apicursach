require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');

const app = express();

const PORT = Number(process.env.PORT || 4000);
const API_BASE_URL = process.env.API_BASE_URL || 'https://hapi.hentaicdn.org/api';
const SITE_ID = String(process.env.SITE_ID || '5');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const PLAYER_RESOLVE_TTL_MS = Number(process.env.PLAYER_RESOLVE_TTL_MS || 10 * 60 * 1000);
const ORPHAN_INDEX_PATH = path.resolve(
  process.cwd(),
  process.env.ORPHAN_INDEX_PATH || 'data/orphan-tv-anime.json'
);
const ORPHAN_INDEX_REFRESH_MS = Number(process.env.ORPHAN_INDEX_REFRESH_MS || 30000);
const ORPHAN_SEARCH_MAX_RESULTS = Number(process.env.ORPHAN_SEARCH_MAX_RESULTS || 20);
const BROWSER_USER_AGENT = [
  'Mozilla/5.0',
  '(Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36',
  '(KHTML, like Gecko)',
  'Chrome/135.0.0.0',
  'Safari/537.36'
].join(' ');

const playerResolveCache = new Map();
const orphanState = {
  checkedAt: 0,
  mtimeMs: null,
  items: [],
  bySlug: new Map(),
  byRouteKey: new Map(),
  loadPromise: null
};

const upstream = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Site-Id': SITE_ID,
    'User-Agent': 'animelib-backend/1.0'
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
      const stats = await fs.stat(ORPHAN_INDEX_PATH);
      if (!force && orphanState.mtimeMs === stats.mtimeMs) {
        return orphanState;
      }

      const fileContents = await fs.readFile(ORPHAN_INDEX_PATH, 'utf8');
      const payload = JSON.parse(fileContents);
      const items = Array.isArray(payload?.items)
        ? payload.items.map((item) => buildOrphanSearchEntry(item))
        : [];

      orphanState.mtimeMs = stats.mtimeMs;
      orphanState.items = items;
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

      return orphanState;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        orphanState.mtimeMs = null;
        orphanState.items = [];
        orphanState.bySlug = new Map();
        orphanState.byRouteKey = new Map();
        return orphanState;
      }

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

  const restoredItems = orphanMatches
    .map((entry) => mapOrphanToSearchItem(entry.item))
    .filter((item) => {
      const key = `${item?.id || ''}:${item?.slug_url || ''}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

  return {
    ...payload,
    data: [...upstreamData, ...restoredItems],
    meta: {
      ...(payload?.meta || {}),
      restored_count: restoredItems.length
    }
  };
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
          summary: 'Карточка тайтла с fallback на локально восстановленные orphan-страницы',
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
          summary: 'Прямой proxy: похожие тайтлы',
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
  await refreshOrphanIndex();
  res.json({
    ok: true,
    service: 'animelib-backend',
    upstream: API_BASE_URL,
    siteId: SITE_ID,
    orphanIndexPath: ORPHAN_INDEX_PATH,
    orphanCount: orphanState.items.length
  });
});

app.get('/latest-updates', async (req, res) => {
  return proxyGet(req, res, '/latest-updates');
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

    const state = await refreshOrphanIndex();
    const restoredItem = getRestoredAnimeItem(state, req.params.slug);
    const restoredSimilarPayload = restoredItem ? buildRestoredSimilarPayload(restoredItem) : null;
    const hasRestoredSimilar = Array.isArray(restoredSimilarPayload?.data) && restoredSimilarPayload.data.length > 0;
    const upstreamSimilarItems = Array.isArray(upstreamResponse?.data?.data) ? upstreamResponse.data.data : null;
    const shouldUseRestoredSimilar = restoredItem && hasRestoredSimilar && (
      isUpstreamAnimeNotFoundResponse(upstreamResponse) ||
      (Array.isArray(upstreamSimilarItems) && upstreamSimilarItems.length === 0)
    );

    if (shouldUseRestoredSimilar) {
      return res.status(200).json(restoredSimilarPayload);
    }

    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    return sendUpstreamError(res, error);
  }
});

app.get('/anime/:slug', async (req, res) => {
  try {
    const upstreamResponse = await upstream.get(`/anime/${encodeURIComponent(req.params.slug)}`, {
      validateStatus: () => true
    });

    if (isUpstreamAnimeNotFoundResponse(upstreamResponse)) {
      const state = await refreshOrphanIndex();
      const restoredItem = getRestoredAnimeItem(state, req.params.slug);

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
