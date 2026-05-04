require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const API_BASE_URL = process.env.API_BASE_URL || 'https://hapi.hentaicdn.org/api';
const SITE_ID = String(process.env.SITE_ID || '5');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);

const DEFAULT_MAX_PAGES = 250;
const DEFAULT_CONCURRENCY = 6;
const TV_SERIAL_TYPE_ID = 16;
const BROWSER_USER_AGENT = [
  'Mozilla/5.0',
  '(Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36',
  '(KHTML, like Gecko)',
  'Chrome/135.0.0.0',
  'Safari/537.36'
].join(' ');

function createDiscoveryClient() {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'Site-Id': SITE_ID,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Origin: 'https://animelib.org',
      Referer: 'https://animelib.org/',
      'User-Agent': BROWSER_USER_AGENT
    },
    validateStatus: () => true
  });
}

function parseArgs(argv) {
  const args = {
    maxPages: DEFAULT_MAX_PAGES,
    concurrency: DEFAULT_CONCURRENCY,
    out: path.resolve(process.cwd(), 'data', 'orphan-tv-anime.json'),
    sourceSlugs: [],
    typeId: TV_SERIAL_TYPE_ID,
    startPage: 1
  };

  for (const rawArg of argv.slice(2)) {
    const [flag, value = ''] = rawArg.split('=');

    if (flag === '--max-pages' && value) {
      args.maxPages = Number(value);
      continue;
    }

    if (flag === '--start-page' && value) {
      args.startPage = Number(value);
      continue;
    }

    if (flag === '--concurrency' && value) {
      args.concurrency = Number(value);
      continue;
    }

    if (flag === '--out' && value) {
      args.out = path.resolve(process.cwd(), value);
      continue;
    }

    if (flag === '--source-slugs' && value) {
      args.sourceSlugs = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    if (flag === '--type-id' && value) {
      args.typeId = Number(value);
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }

      await worker(next);
    }
  });

  await Promise.all(runners);
}

async function fetchAnimeCard(api, slugUrl, cache) {
  if (cache.has(slugUrl)) {
    return cache.get(slugUrl);
  }

  const request = api.get(`/anime/${encodeURIComponent(slugUrl)}`, {
    params: { 'fields[]': 'background' }
  });
  cache.set(slugUrl, request);
  return request;
}

async function fetchAnimeRelations(api, slugUrl, cache) {
  if (cache.has(slugUrl)) {
    return cache.get(slugUrl);
  }

  const request = api
    .get(`/anime/${encodeURIComponent(slugUrl)}/relations`)
    .then((response) => (response.status === 200 ? response.data.data || [] : []));

  cache.set(slugUrl, request);
  return request;
}

async function fetchEpisodes(api, animeId, cache) {
  const key = String(animeId);
  if (cache.has(key)) {
    return cache.get(key);
  }

  const request = api
    .get('/episodes', { params: { anime_id: key } })
    .then((response) => (response.status === 200 ? response.data.data || [] : []));

  cache.set(key, request);
  return request;
}

async function fetchCatalogPage(api, page, seed, typeId) {
  const params = { page, 'types[]': typeId };
  if (seed) {
    params.seed = seed;
  }

  const response = await api.get('/anime', { params });
  if (response.status !== 200) {
    throw new Error(`Catalog request failed for page=${page}, status=${response.status}`);
  }

  return response.data;
}

async function collectLiveSourceSlugs(maxPages, typeId, options = {}) {
  const api = options.api || createDiscoveryClient();
  const startPage = Math.max(1, Number(options.startPage || 1));
  const slugs = [];

  let seed = options.seed || null;
  let hasNext = true;

  if (!seed) {
    const firstPayload = await fetchCatalogPage(api, 1, null, typeId);
    seed = firstPayload?.meta?.seed || null;

    if (startPage === 1) {
      for (const item of firstPayload?.data || []) {
        if (item?.slug_url) {
          slugs.push(item.slug_url);
        }
      }
    }

    hasNext = Boolean(firstPayload?.links?.next);
    if (maxPages === 1) {
      return {
        seed,
        slugs: Array.from(new Set(slugs))
      };
    }
  }

  const pageStart = startPage === 1 ? 2 : startPage;
  for (let page = pageStart; page <= maxPages; page += 1) {
    if (!hasNext && page > 2) {
      break;
    }

    const payload = await fetchCatalogPage(api, page, seed, typeId);
    const items = payload?.data || [];
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      if (item?.slug_url) {
        slugs.push(item.slug_url);
      }
    }

    hasNext = Boolean(payload?.links?.next);
    if (!hasNext) {
      break;
    }

    await sleep(50);
  }

  return {
    seed,
    slugs: Array.from(new Set(slugs))
  };
}

function buildRestoredCard(media, episodes, orphanRelations, sources) {
  const sourceManga = orphanRelations.find(
    (relation) => relation?.related_type?.id === 2 && relation?.media?.model === 'manga'
  )?.media || null;

  const relatedAnime = orphanRelations
    .filter((relation) => relation?.media?.model === 'anime')
    .map((relation) => ({
      relation_type: relation.related_type?.label || null,
      media: relation.media
    }));

  const seasons = Array.from(
    new Set(
      episodes
        .map((episode) => episode?.season)
        .filter(Boolean)
    )
  );

  return {
    id: media.id,
    slug_url: media.slug_url,
    slug: media.slug,
    name: media.name,
    rus_name: media.rus_name,
    eng_name: media.eng_name,
    type: media.type,
    status: media.status,
    ageRestriction: media.ageRestriction,
    cover: media.cover,
    site: media.site,
    restored: true,
    restore_reason: 'anime_route_404_but_relations_and_episodes_exist',
    episodes_count: episodes.length,
    seasons,
    first_episode_id: episodes[0]?.id || null,
    last_episode_id: episodes[episodes.length - 1]?.id || null,
    episodes,
    source_manga: sourceManga,
    related_anime: relatedAnime,
    discovered_from: sources,
    card: {
      data: media,
      meta: {
        restored: true,
        orphaned: true,
        episodes_count: episodes.length,
        seasons,
        discovered_from: sources.map((item) => item.source_slug_url)
      }
    }
  };
}

function sortDiscoveredFrom(entries) {
  return [...entries].sort((left, right) => {
    if (left.source_slug_url === right.source_slug_url) {
      return String(left.relation_type).localeCompare(String(right.relation_type));
    }

    return left.source_slug_url.localeCompare(right.source_slug_url);
  });
}

function finalizeOrphanItems(orphanMap) {
  return Array.from(orphanMap.values())
    .map((item) => ({
      ...item,
      discovered_from: sortDiscoveredFrom(item.discovered_from)
    }))
    .sort((left, right) => left.slug_url.localeCompare(right.slug_url));
}

function buildPayloadFromItems(items, meta = {}) {
  return {
    generatedAt: new Date().toISOString(),
    upstream: meta.upstream || API_BASE_URL,
    siteId: meta.siteId || SITE_ID,
    typeId: meta.typeId || TV_SERIAL_TYPE_ID,
    seed: meta.seed || null,
    scannedSourceTitles: meta.scannedSourceTitles || 0,
    orphanCount: items.length,
    items
  };
}

function mergeDiscoveredFrom(existingEntries = [], incomingEntries = []) {
  const seen = new Set();
  const merged = [];

  for (const entry of [...existingEntries, ...incomingEntries]) {
    const key = `${entry?.source_slug_url || ''}:${entry?.relation_type || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(entry);
  }

  return sortDiscoveredFrom(merged);
}

function mergeOrphanPayloads(existingPayload = {}, incomingPayload = {}) {
  const mergedMap = new Map();
  const existingItems = Array.isArray(existingPayload?.items) ? existingPayload.items : [];
  const incomingItems = Array.isArray(incomingPayload?.items) ? incomingPayload.items : [];

  for (const item of existingItems) {
    if (item?.slug_url) {
      mergedMap.set(item.slug_url, item);
    }
  }

  let inserted = 0;
  let replaced = 0;

  for (const item of incomingItems) {
    if (!item?.slug_url) {
      continue;
    }

    const existing = mergedMap.get(item.slug_url);
    if (existing) {
      replaced += 1;
      mergedMap.set(item.slug_url, {
        ...existing,
        ...item,
        discovered_from: mergeDiscoveredFrom(existing.discovered_from, item.discovered_from)
      });
      continue;
    }

    inserted += 1;
    mergedMap.set(item.slug_url, item);
  }

  const mergedItems = Array.from(mergedMap.values()).sort((left, right) => left.slug_url.localeCompare(right.slug_url));

  return {
    generatedAt: new Date().toISOString(),
    upstream: incomingPayload?.upstream || existingPayload?.upstream || API_BASE_URL,
    siteId: incomingPayload?.siteId || existingPayload?.siteId || SITE_ID,
    typeId: incomingPayload?.typeId || existingPayload?.typeId || TV_SERIAL_TYPE_ID,
    seed: incomingPayload?.seed || existingPayload?.seed || null,
    scannedSourceTitles: incomingPayload?.scannedSourceTitles || existingPayload?.scannedSourceTitles || 0,
    orphanCount: mergedItems.length,
    items: mergedItems,
    mergeMeta: {
      inserted,
      replaced,
      existingCount: existingItems.length,
      incomingCount: incomingItems.length
    }
  };
}

async function discoverOrphans(args = {}) {
  const api = args.api || createDiscoveryClient();
  const animeCardCache = new Map();
  const relationsCache = new Map();
  const episodesCache = new Map();
  const orphanMap = new Map();

  let sourceSlugs = Array.isArray(args.sourceSlugs) ? args.sourceSlugs : [];
  let seed = args.seed || null;

  if (sourceSlugs.length === 0) {
    const collected = await collectLiveSourceSlugs(args.maxPages || DEFAULT_MAX_PAGES, args.typeId || TV_SERIAL_TYPE_ID, {
      api,
      startPage: args.startPage || 1,
      seed
    });
    sourceSlugs = collected.slugs;
    seed = collected.seed;
  }

  await runPool(sourceSlugs, args.concurrency || DEFAULT_CONCURRENCY, async (sourceSlugUrl) => {
    const relations = await fetchAnimeRelations(api, sourceSlugUrl, relationsCache);

    for (const relation of relations) {
      const media = relation?.media;
      if (!media || media.model !== 'anime' || media.site !== 5 || media?.type?.id !== (args.typeId || TV_SERIAL_TYPE_ID)) {
        continue;
      }

      const animeResponse = await fetchAnimeCard(api, media.slug_url, animeCardCache);
      if (animeResponse.status !== 404) {
        continue;
      }

      const episodes = await fetchEpisodes(api, media.id, episodesCache);
      if (episodes.length === 0) {
        continue;
      }

      const orphanRelations = await fetchAnimeRelations(api, media.slug_url, relationsCache);
      const sourceInfo = {
        source_slug_url: sourceSlugUrl,
        relation_type: relation?.related_type?.label || null
      };

      const existing = orphanMap.get(media.slug_url);
      if (existing) {
        existing.discovered_from.push(sourceInfo);
        continue;
      }

      const enrichedMedia = animeResponse.status === 200 && animeResponse.data?.data
        ? { ...media, ...animeResponse.data.data }
        : media;

      orphanMap.set(
        media.slug_url,
        buildRestoredCard(enrichedMedia, episodes, orphanRelations, [sourceInfo])
      );
    }
  });

  const items = finalizeOrphanItems(orphanMap);

  return buildPayloadFromItems(items, {
    upstream: API_BASE_URL,
    siteId: SITE_ID,
    typeId: args.typeId || TV_SERIAL_TYPE_ID,
    seed,
    scannedSourceTitles: sourceSlugs.length
  });
}

async function discoverOrphanBySlug(targetRouteKey, args = {}) {
  const targetKey = String(targetRouteKey || '').trim().toLowerCase();
  if (!targetKey) {
    return null;
  }

  const api = args.api || createDiscoveryClient();
  const animeCardCache = new Map();
  const relationsCache = new Map();
  const episodesCache = new Map();
  const { slugs: sourceSlugs, seed } = await collectLiveSourceSlugs(args.maxPages || 40, args.typeId || TV_SERIAL_TYPE_ID, {
    api,
    startPage: args.startPage || 1,
    seed: args.seed || null
  });

  for (const sourceSlugUrl of sourceSlugs) {
    const relations = await fetchAnimeRelations(api, sourceSlugUrl, relationsCache);

    for (const relation of relations) {
      const media = relation?.media;
      if (!media || media.model !== 'anime' || media.site !== 5 || media?.type?.id !== (args.typeId || TV_SERIAL_TYPE_ID)) {
        continue;
      }

      const mediaRouteKeys = [String(media.slug_url || '').toLowerCase(), String(media.slug || '').toLowerCase()];
      if (!mediaRouteKeys.includes(targetKey)) {
        continue;
      }

      const animeResponse = await fetchAnimeCard(api, media.slug_url, animeCardCache);
      if (animeResponse.status !== 404) {
        return null;
      }

      const episodes = await fetchEpisodes(api, media.id, episodesCache);
      if (episodes.length === 0) {
        return null;
      }

      const orphanRelations = await fetchAnimeRelations(api, media.slug_url, relationsCache);
      const enrichedMedia = animeResponse.status === 200 && animeResponse.data?.data
        ? { ...media, ...animeResponse.data.data }
        : media;
      const item = buildRestoredCard(enrichedMedia, episodes, orphanRelations, [{
        source_slug_url: sourceSlugUrl,
        relation_type: relation?.related_type?.label || null
      }]);

      return buildPayloadFromItems([item], {
        upstream: API_BASE_URL,
        siteId: SITE_ID,
        typeId: args.typeId || TV_SERIAL_TYPE_ID,
        seed,
        scannedSourceTitles: sourceSlugs.length
      });
    }
  }

  return null;
}

async function discoverOrphanFromSource(targetRouteKey, sourceSlugUrl, args = {}) {
  const targetKey = String(targetRouteKey || '').trim().toLowerCase();
  const sourceKey = String(sourceSlugUrl || '').trim();
  if (!targetKey || !sourceKey) return null;

  const api = args.api || createDiscoveryClient();
  const relationsCache = new Map();
  const episodesCache = new Map();

  const relations = await fetchAnimeRelations(api, sourceKey, relationsCache);

  for (const relation of relations) {
    const media = relation?.media;
    if (!media || media.model !== 'anime' || media.site !== 5) continue;

    const mediaKeys = [
      String(media.slug_url || '').toLowerCase(),
      String(media.slug || '').toLowerCase()
    ];
    if (!mediaKeys.includes(targetKey)) continue;

    const animeResponse = await fetchAnimeCard(api, media.slug_url, new Map());
    if (animeResponse.status !== 404) return null;

    const episodes = await fetchEpisodes(api, media.id, episodesCache);
    if (episodes.length === 0) return null;

    const orphanRelations = await fetchAnimeRelations(api, media.slug_url, relationsCache);
    const item = buildRestoredCard(media, episodes, orphanRelations, [{
      source_slug_url: sourceKey,
      relation_type: relation?.related_type?.label || null
    }]);

    return buildPayloadFromItems([item], {
      upstream: API_BASE_URL,
      siteId: SITE_ID,
      typeId: args.typeId || TV_SERIAL_TYPE_ID,
      seed: null,
      scannedSourceTitles: 1
    });
  }

  return null;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const payload = await discoverOrphans(args);

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(payload, null, 2));

  console.log(`saved=${args.out}`);
  console.log(`scanned=${payload.scannedSourceTitles}`);
  console.log(`orphans=${payload.orphanCount}`);

  for (const item of payload.items.slice(0, 10)) {
    console.log(
      `- ${item.slug_url} | episodes=${item.episodes_count} | via=${item.discovered_from
        .map((entry) => `${entry.source_slug_url}:${entry.relation_type}`)
        .join(', ')}`
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  API_BASE_URL,
  SITE_ID,
  TV_SERIAL_TYPE_ID,
  DEFAULT_MAX_PAGES,
  DEFAULT_CONCURRENCY,
  createDiscoveryClient,
  parseArgs,
  discoverOrphans,
  discoverOrphanBySlug,
  discoverOrphanFromSource,
  mergeOrphanPayloads,
  main
};
