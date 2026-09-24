#!/usr/bin/env node
/**
 * Article list snapshot builder for local development.
 *
 * One run walks the public article list API through read-only GET requests and
 * aggregates:
 *   - the full article collection (every list page, in list order)
 *   - pagination positions (page / totalPages / window boundaries)
 *   - the tag collection (derived from the collected articles)
 *   - a tag-filtered result
 *   - an empty result (tag that matches no article)
 *
 * Outputs (overwritten atomically on every successful run):
 *   snapshots/articles/snapshot.json - machine-readable, diff-friendly snapshot
 *   snapshots/articles/summary.txt   - stable, human-readable comparable summary
 *
 * If the backend is unavailable (or any stage fails), the previous snapshot is
 * left untouched and snapshots/articles/failure.json records the failed stage.
 *
 * This script never sends mutating requests: article data cannot be changed.
 *
 * Configuration:
 *   API_BASE_URL           backend base URL (default http://localhost:3001)
 *   SNAPSHOT_PAGE_LIMIT    page size used while walking the list (default 10)
 *   --base=<url>           command-line override for API_BASE_URL
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'snapshots', 'articles');
const SNAPSHOT_PATH = path.join(OUT_DIR, 'snapshot.json');
const SUMMARY_PATH = path.join(OUT_DIR, 'summary.txt');
const FAILURE_PATH = path.join(OUT_DIR, 'failure.json');

const LIMIT = Number(process.env.SNAPSHOT_PAGE_LIMIT) || 10;
const REQUEST_TIMEOUT_MS = 5000;

let apiBase = process.env.API_BASE_URL || 'http://localhost:3001';
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--base=')) {
    apiBase = arg.slice('--base='.length);
  }
}
apiBase = apiBase.replace(/\/+$/, '');

class StageError extends Error {
  constructor(stage, url, code, message) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    this.url = url;
    this.code = code;
  }
}

async function fetchJson(stage, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (err) {
    const code = err.name === 'AbortError' ? 'TIMEOUT' : (err.cause?.code || err.code || 'FETCH_ERROR');
    throw new StageError(
      stage,
      url,
      code,
      err.name === 'AbortError'
        ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : (err.cause?.message || err.message)
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new StageError(stage, url, `HTTP_${response.status}`, `Unexpected status ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new StageError(stage, url, 'INVALID_JSON', err.message);
  }
}

function articlesUrl({ page = 1, tag = null } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
  if (tag) params.set('tag', tag);
  return `${apiBase}/api/articles?${params.toString()}`;
}

async function atomicWrite(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, filePath);
}

async function recordFailure(err) {
  await mkdir(OUT_DIR, { recursive: true });
  const record = {
    status: 'failed',
    failedStage: err.stage || 'unknown',
    apiBase,
    request: { method: 'GET', url: err.url || null },
    attemptedAt: new Date().toISOString(),
    error: { code: err.code || 'UNKNOWN', message: err.message }
  };
  await atomicWrite(FAILURE_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

function positionOf(pagePayload) {
  const { pagination, articles } = pagePayload;
  const ids = articles.map(a => a.id);
  return {
    page: pagination.page,
    total: pagination.total,
    limit: pagination.limit,
    totalPages: pagination.totalPages,
    returned: articles.length,
    firstId: ids[0] ?? null,
    lastId: ids[ids.length - 1] ?? null,
    ids
  };
}

// Unique sorted tags across the collected articles (same rule as the API:
// split on commas, trim, drop empties, sort).
function deriveTags(articles) {
  const tagSet = new Set();
  for (const article of articles) {
    for (const tag of article.tags || []) {
      const trimmed = String(tag).trim();
      if (trimmed) tagSet.add(trimmed);
    }
  }
  return Array.from(tagSet).sort();
}

function renderSummary(snapshot) {
  const lines = [];
  lines.push('ARTICLE LIST SNAPSHOT');
  lines.push('=====================');
  lines.push(`apiBase: ${snapshot.meta.apiBase}`);
  lines.push(`pageLimit: ${snapshot.meta.pageLimit}`);
  lines.push('');

  lines.push('collection');
  lines.push('----------');
  lines.push(`total: ${snapshot.collection.total}`);
  lines.push(`totalPages: ${snapshot.collection.totalPages}`);
  lines.push(`pagesFetched: ${snapshot.pages.length}`);
  lines.push(`articlesCollected: ${snapshot.collection.articles.length}`);
  lines.push('');

  lines.push('tags');
  lines.push('----');
  lines.push(`count: ${snapshot.tags.length}`);
  lines.push(`[${snapshot.tags.join(', ')}]`);
  lines.push('');

  lines.push('articles (list order)');
  lines.push('---------------------');
  snapshot.collection.articles.forEach((article, index) => {
    lines.push(
      `${index + 1}. [${article.id}] ${article.title} ` +
      `tags=[${article.tags.join(',')}] created=${article.created_at}`
    );
  });
  lines.push('');

  lines.push('pagination positions');
  lines.push('--------------------');
  snapshot.pages.forEach(pos => {
    lines.push(
      `page ${pos.page}/${pos.totalPages}: returned=${pos.returned} ` +
      `firstId=${pos.firstId} lastId=${pos.lastId}`
    );
  });
  lines.push('');

  lines.push('tag filter');
  lines.push('----------');
  if (snapshot.tagFilter) {
    lines.push(`tag: ${snapshot.tagFilter.tag}`);
    lines.push(
      `matched: ${snapshot.tagFilter.total} ` +
      `(page ${snapshot.tagFilter.page} of ${snapshot.tagFilter.totalPages}, ` +
      `returned=${snapshot.tagFilter.returned})`
    );
    snapshot.tagFilter.matchedTitles.forEach(title => lines.push(`- ${title}`));
  } else {
    lines.push('skipped: no tags in collection');
  }
  lines.push('');

  lines.push('empty result');
  lines.push('------------');
  lines.push(`filter: ${snapshot.emptyResult.filter}`);
  lines.push(`total: ${snapshot.emptyResult.total}`);
  lines.push(`returned: ${snapshot.emptyResult.returned}`);
  lines.push('');

  return lines.join('\n');
}

async function build() {
  await mkdir(OUT_DIR, { recursive: true });
  const stages = [];

  // Stage 1..N: walk every list page, aggregating the collection and positions
  const firstUrl = articlesUrl({ page: 1 });
  stages.push('articles-page-1');
  const firstPage = await fetchJson('articles-page-1', firstUrl);
  const totalPages = firstPage.pagination.totalPages;
  const pages = [positionOf(firstPage)];
  const articles = [...firstPage.articles];

  for (let page = 2; page <= totalPages; page++) {
    const stage = `articles-page-${page}`;
    stages.push(stage);
    const payload = await fetchJson(stage, articlesUrl({ page }));
    pages.push(positionOf(payload));
    articles.push(...payload.articles);
  }

  // Tag collection derived from the aggregated articles (no extra request)
  const tags = deriveTags(articles);

  // Tag filter stage: first tag of the derived collection
  let tagFilter = null;
  if (tags.length > 0) {
    stages.push('tag-filter');
    const tag = tags[0];
    const payload = await fetchJson('tag-filter', articlesUrl({ page: 1, tag }));
    const pos = positionOf(payload);
    tagFilter = {
      tag,
      total: pos.total,
      page: pos.page,
      totalPages: pos.totalPages,
      returned: pos.returned,
      ids: pos.ids,
      matchedTitles: payload.articles.map(a => a.title)
    };
  }

  // Empty result stage: a tag filter guaranteed to match nothing
  stages.push('empty-result');
  const candidates = ['__snapshot_empty__'];
  for (let i = 0; i < 10; i++) candidates.push(`__snapshot_empty_${i}__`);
  const sentinel = candidates.find(candidate => !tags.includes(candidate));

  let emptyPayload = await fetchJson('empty-result', articlesUrl({ page: 1, tag: sentinel }));
  if (emptyPayload.pagination.total !== 0 || emptyPayload.articles.length !== 0) {
    throw new StageError(
      'empty-result',
      articlesUrl({ page: 1, tag: sentinel }),
      'UNEXPECTED_MATCHES',
      `Empty-result filter "${sentinel}" returned ${emptyPayload.pagination.total} articles`
    );
  }
  const emptyPos = positionOf(emptyPayload);
  const emptyResult = {
    filter: `tag=${sentinel}`,
    total: emptyPos.total,
    returned: emptyPos.returned,
    page: emptyPos.page,
    totalPages: emptyPos.totalPages
  };

  const snapshot = {
    meta: {
      kind: 'article-list-snapshot',
      apiBase,
      pageLimit: LIMIT,
      stages
    },
    tags,
    collection: {
      total: firstPage.pagination.total,
      totalPages,
      articles
    },
    pages,
    tagFilter,
    emptyResult
  };

  // All stages succeeded: replace the previous snapshot as a unit.
  await atomicWrite(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  await atomicWrite(SUMMARY_PATH, renderSummary(snapshot));
  if (existsSync(FAILURE_PATH)) {
    await rm(FAILURE_PATH);
  }

  console.log(`Article snapshot built: ${articles.length} articles, ${pages.length} page(s), ${tags.length} tag(s)`);
  console.log(`  ${SNAPSHOT_PATH}`);
  console.log(`  ${SUMMARY_PATH}`);
}

build().catch(async err => {
  try {
    await recordFailure(err);
  } catch (recordErr) {
    console.error('Failed to write failure record:', recordErr.message);
  }
  const stage = err.stage || 'unknown';
  console.error(`Snapshot build failed at stage "${stage}": ${err.message}`);
  if (err.url) console.error(`  ${err.url}`);
  console.error(`Failure recorded at ${FAILURE_PATH}; previous snapshot was not modified.`);
  process.exitCode = 1;
});
