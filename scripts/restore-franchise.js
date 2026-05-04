require('dotenv').config();

const { createDiscoveryClient, discoverOrphanFromSource, mergeOrphanPayloads } = require('../src/orphan-discovery');
const fs = require('fs/promises');
const path = require('path');

const INDEX_PATH = path.resolve(__dirname, '../data/orphan-tv-anime.json');

async function scanFranchise(startSlug) {
  const api = createDiscoveryClient();
  const visited = new Set();
  const queue = [startSlug];
  const orphanSlugs = [];
  const liveBySlug = {};

  console.log(`\nScanning franchise from: ${startSlug}`);

  while (queue.length > 0) {
    const slug = queue.shift();
    if (visited.has(slug)) continue;
    visited.add(slug);

    const animeRes = await api.get(`/anime/${encodeURIComponent(slug)}`, {
      params: { 'fields[]': 'background' },
      validateStatus: () => true
    });

    const relRes = await api.get(`/anime/${encodeURIComponent(slug)}/relations`, {
      validateStatus: () => true
    });
    const relations = relRes.status === 200 ? (relRes.data?.data || []) : [];

    for (const rel of relations) {
      const m = rel?.media;
      if (m?.model === 'anime' && m?.site === 5 && m?.slug_url && !visited.has(m.slug_url)) {
        queue.push(m.slug_url);
      }
    }

    if (animeRes.status === 404) {
      console.log(`  ORPHAN: ${slug}`);
      orphanSlugs.push({ orphanSlug: slug, relations });
    } else if (animeRes.status === 200) {
      const data = animeRes.data?.data;
      liveBySlug[slug] = data;
      console.log(`  live:   ${slug} | ${data?.rus_name || data?.name || ''}`);
    }
  }

  return { orphanSlugs, liveBySlug };
}

async function restoreAll(startSlug) {
  const { orphanSlugs, liveBySlug } = await scanFranchise(startSlug);

  if (orphanSlugs.length === 0) {
    console.log('\nNo orphans found.');
    return;
  }

  let index = null;
  try { index = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8')); } catch {}

  for (const { orphanSlug, relations } of orphanSlugs) {
    const liveSource = relations.find(r => {
      const m = r?.media;
      return m?.slug_url && liveBySlug[m.slug_url];
    })?.media?.slug_url;

    if (!liveSource) {
      console.log(`\nSkipping ${orphanSlug} — no live source found`);
      continue;
    }

    process.stdout.write(`\nRestoring ${orphanSlug} via ${liveSource}... `);
    const discovered = await discoverOrphanFromSource(orphanSlug, liveSource).catch(() => null);

    if (!discovered) {
      console.log('FAILED');
      continue;
    }

    const item = discovered.items[0];
    console.log(`OK | ${item.rus_name || item.name} | cover=${item.cover ? 'YES' : 'NO'} | eps=${item.episodes_count}`);
    index = index ? mergeOrphanPayloads(discovered, index) : discovered;
  }

  if (index) {
    await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
    await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
    console.log(`\nSaved! Total orphans: ${index.orphanCount}`);
    index.items.forEach(i => console.log(`  - ${i.rus_name || i.name || i.slug_url} | eps=${i.episodes_count}`));
  }
}

const startSlug = process.argv[2];
if (!startSlug) {
  console.error('Usage: node scripts/restore-franchise.js <slug>');
  console.error('Example: node scripts/restore-franchise.js 26540--witch-watch-2nd-season-anime');
  process.exit(1);
}

restoreAll(startSlug).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
