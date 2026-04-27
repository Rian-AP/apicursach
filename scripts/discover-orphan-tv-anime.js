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

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Site-Id': SITE_ID,
    'User-Agent': 'animelib-orphan-discovery/1.0'
  },
  validateStatus: () => true
});

function parseArgs(argv) {
  const args = {
    maxPages: DEFAULT_MAX_PAGES,
    concurrency: DEFAULT_CONCURRENCY,
    out: path.resolve(process.cwd(), 'data', 'orphan-tv-anime.json'),
    sourceSlugs: [],
    typeId: TV_SERIAL_TYPE_ID
  };

  for (const rawArg of argv.slice(2)) {
    const [flag, value = ''] = rawArg.split('=');

    if (flag === '--max-pages' && value) {
      args.maxPages = Number(value);
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

async function fetchAnimeCard(slugUrl, cache) {
  if (cache.has(slugUrl)) {
    return cache.get(slugUrl);
  }

  const request = api.get(`/anime/${encodeURIComponent(slugUrl)}`);
  cache.set(slugUrl, request);
  return request;
}

async function fetchAnimeRelations(slugUrl, cache) {
  if (cache.has(slugUrl)) {
    return cache.get(slugUrl);
  }

  const request = api
    .get(`/anime/${encodeURIComponent(slugUrl)}/relations`)
    .then((response) => (response.status === 200 ? response.data.data || [] : []));

  cache.set(slugUrl, request);
  return request;
}

async function fetchEpisodes(animeId, cache) {
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

async function fetchCatalogPage(page, seed, typeId) {
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

async function collectLiveSourceSlugs(maxPages, typeId) {
  const slugs = [];
  let seed = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await fetchCatalogPage(page, seed, typeId);
    if (!seed) {
      seed = payload?.meta?.seed || null;
    }

    const items = payload?.data || [];
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      if (item?.slug_url) {
        slugs.push(item.slug_url);
      }
    }

    if (!payload?.links?.next) {
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

async function discoverOrphans(args) {
  const animeCardCache = new Map();
  const relationsCache = new Map();
  const episodesCache = new Map();
  const orphanMap = new Map();

  let sourceSlugs = args.sourceSlugs;
  let seed = null;

  if (sourceSlugs.length === 0) {
    const collected = await collectLiveSourceSlugs(args.maxPages, args.typeId);
    sourceSlugs = collected.slugs;
    seed = collected.seed;
  }

  await runPool(sourceSlugs, args.concurrency, async (sourceSlugUrl) => {
    const relations = await fetchAnimeRelations(sourceSlugUrl, relationsCache);

    for (const relation of relations) {
      const media = relation?.media;
      if (!media || media.model !== 'anime' || media.site !== 5 || media?.type?.id !== args.typeId) {
        continue;
      }

      const animeResponse = await fetchAnimeCard(media.slug_url, animeCardCache);
      if (animeResponse.status !== 404) {
        continue;
      }

      const episodes = await fetchEpisodes(media.id, episodesCache);
      if (episodes.length === 0) {
        continue;
      }

      const orphanRelations = await fetchAnimeRelations(media.slug_url, relationsCache);
      const sourceInfo = {
        source_slug_url: sourceSlugUrl,
        relation_type: relation?.related_type?.label || null
      };

      const existing = orphanMap.get(media.slug_url);
      if (existing) {
        existing.discovered_from.push(sourceInfo);
        continue;
      }

      orphanMap.set(
        media.slug_url,
        buildRestoredCard(media, episodes, orphanRelations, [sourceInfo])
      );
    }
  });

  const items = Array.from(orphanMap.values())
    .map((item) => ({
      ...item,
      discovered_from: item.discovered_from.sort((left, right) => {
        if (left.source_slug_url === right.source_slug_url) {
          return String(left.relation_type).localeCompare(String(right.relation_type));
        }

        return left.source_slug_url.localeCompare(right.source_slug_url);
      })
    }))
    .sort((left, right) => left.slug_url.localeCompare(right.slug_url));

  return {
    generatedAt: new Date().toISOString(),
    upstream: API_BASE_URL,
    siteId: SITE_ID,
    typeId: args.typeId,
    seed,
    scannedSourceTitles: sourceSlugs.length,
    orphanCount: items.length,
    items
  };
}

async function main() {
  const args = parseArgs(process.argv);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
