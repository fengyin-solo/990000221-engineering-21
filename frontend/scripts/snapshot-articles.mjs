#!/usr/bin/env node
/**
 * Local development snapshot builder for the article list.
 *
 * One run aggregates the three article-list states exercised by the UI:
 *   - collection (文章集合): first page of the article list
 *   - position   (当前位置): the last page, covering the pagination position
 *   - empty      (空结果) : a tag filter that matches nothing (read-only)
 *
 * The tag universe shown by the tag filter is derived from the list responses,
 * so no extra endpoint is required.
 *
 * The script is strictly read-only: it only ever sends GET requests, so the
 * article data and the runtime behavior of the list / pagination / tag filter
 * are never modified.
 *
 * Outputs (default: frontend/dev-snapshots/articles/):
 *   - latest.json   full responses for inspection (contains timestamps)
 *   - summary.json  deterministic, comparable summary with per-stage and
 *                   overall sha256 digests (no timestamps -> safe to diff)
 *   - failed.json   written only when a build fails (e.g. service unavailable);
 *                   records the failed stage(s). The previous good
 *                   latest.json / summary.json is left untouched.
 *
 * A successful build overwrites the previous snapshot. On failure the failure
 * stage is preserved in failed.json and the process exits non-zero.
 *
 * Usage:
 *   node scripts/snapshot-articles.mjs
 *   node scripts/snapshot-articles.mjs --base http://localhost:3001 \
 *       --out dev-snapshots/articles --baseline dev-snapshots/articles/summary.json
 *
 * Environment overrides:
 *   SNAPSHOT_API_BASE, SNAPSHOT_OUT_DIR, SNAPSHOT_BASELINE, SNAPSHOT_TIMEOUT
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SCHEMA_VERSION = 1
const PAGE_SIZE = 10
// Synthetic tag that must never match a real article. Read-only empty result.
const EMPTY_TAG = '__snapshot_no_such_tag__'

const STAGE_LABELS = {
  collection: '文章集合',
  position: '当前位置',
  empty: '空结果'
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const inline = arg.startsWith('--') && arg.includes('=')
    const name = inline ? arg.slice(2, arg.indexOf('=')) : arg.slice(2)
    const value = inline ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
    opts[name] = value
  }
  return opts
}

const args = parseArgs(process.argv.slice(2))
const baseUrl = (args.base || process.env.SNAPSHOT_API_BASE || 'http://localhost:3001').replace(/\/+$/, '')
const outDir = path.resolve(
  frontendRoot,
  args.out || process.env.SNAPSHOT_OUT_DIR || path.join('dev-snapshots', 'articles')
)
const baselinePath = args.baseline || process.env.SNAPSHOT_BASELINE || null
const timeoutMs = Number(args.timeout || process.env.SNAPSHOT_TIMEOUT || 8000)

const latestFile = path.join(outDir, 'latest.json')
const summaryFile = path.join(outDir, 'summary.json')
const failedFile = path.join(outDir, 'failed.json')

/** Recursively sort object keys so JSON serialization is deterministic. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
    return out
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function atomicWrite(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(stable(value), null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** GET JSON only. Never mutates server data. */
async function getJson(apiPath, query = {}) {
  const url = new URL(apiPath, `${baseUrl}/`)
  for (const [key, val] of Object.entries(query)) {
    if (val !== undefined && val !== null) url.searchParams.set(key, String(val))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    const text = await res.text()
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: {
          message: `HTTP ${res.status} ${res.statusText}`,
          code: 'HTTP_ERROR',
          body: text.slice(0, 200)
        }
      }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        error: { message: 'Response was not valid JSON', code: 'BAD_RESPONSE' }
      }
    }
    return { ok: true, httpStatus: res.status, body }
  } catch (err) {
    // No HTTP response at all (refused, aborted/timeout, DNS, reset...) means
    // the service is effectively unavailable. better-sqlite/Express errors
    // arrive as normal responses (5xx) and are therefore not caught here.
    const code = err?.code === 'ECONNREFUSED' ||
      err?.cause?.code === 'ECONNREFUSED' ||
      err?.name === 'AbortError' ||
      err?.name === 'TypeError'
      ? 'SERVICE_UNAVAILABLE'
      : (err?.code || 'FETCH_ERROR')
    return {
      ok: false,
      httpStatus: null,
      error: {
        message: err?.message || String(err),
        code
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function validateListBody(body) {
  return (
    body &&
    typeof body === 'object' &&
    Array.isArray(body.articles) &&
    body.pagination &&
    typeof body.pagination === 'object'
  )
}

function summarizeStage(name, request, result) {
  if (!result.ok) {
    return {
      name,
      label: STAGE_LABELS[name],
      request,
      ok: false,
      httpStatus: result.httpStatus,
      error: result.error
    }
  }

  if (!validateListBody(result.body)) {
    return {
      name,
      label: STAGE_LABELS[name],
      request,
      ok: false,
      httpStatus: result.httpStatus,
      error: { message: 'Malformed article list response', code: 'BAD_RESPONSE' }
    }
  }

  const { articles, pagination } = result.body
  return {
    name,
    label: STAGE_LABELS[name],
    request,
    ok: true,
    httpStatus: result.httpStatus,
    articleCount: articles.length,
    articleIds: articles.map((a) => a.id),
    articleTitles: articles.map((a) => a.title),
    tagUnion: [...new Set(articles.flatMap((a) => (Array.isArray(a.tags) ? a.tags : [])))].sort(),
    pagination: {
      total: pagination.total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: pagination.totalPages
    },
    digest: sha256(result.body)
  }
}

function compareWithBaseline(summary) {
  if (!baselinePath) return null
  let baseline
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  } catch (err) {
    return { compared: false, error: `Cannot read baseline: ${err.message}` }
  }

  const stageDiffs = []
  for (const name of Object.keys(STAGE_LABELS)) {
    const before = baseline.stages?.[name]
    const after = summary.stages[name]
    if (!before || before.digest !== after.digest) {
      stageDiffs.push({
        stage: name,
        label: STAGE_LABELS[name],
        before: before?.digest ?? null,
        after: after.digest
      })
    }
  }

  return {
    compared: true,
    baseline: baselinePath,
    match: stageDiffs.length === 0 && baseline.digest === summary.digest,
    digestChanged: baseline.digest !== summary.digest,
    stageDiffs
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`Building article list snapshot from ${baseUrl}`)
  console.log(`Output directory: ${outDir}\n`)

  const requests = {
    collection: { method: 'GET', path: '/api/articles', query: { page: 1, limit: PAGE_SIZE } },
    empty: { method: 'GET', path: '/api/articles', query: { page: 1, limit: PAGE_SIZE, tag: EMPTY_TAG } }
  }

  // 1) Article collection (first page).
  const collectionResult = await getJson(requests.collection.path, requests.collection.query)
  const collectionStage = summarizeStage('collection', requests.collection, collectionResult)

  // 2) Current position: the last page derived from the collection's pagination,
  //    so the position page is meaningful regardless of the article count.
  let positionPage = 1
  if (collectionResult.ok && validateListBody(collectionResult.body)) {
    positionPage = Math.max(1, collectionResult.body.pagination.totalPages)
  }
  requests.position = { method: 'GET', path: '/api/articles', query: { page: positionPage, limit: PAGE_SIZE } }
  const positionResult = await getJson(requests.position.path, requests.position.query)
  const positionStage = summarizeStage('position', requests.position, positionResult)

  // 3) Empty result via a non-matching tag filter.
  const emptyResult = await getJson(requests.empty.path, requests.empty.query)
  const emptyStage = summarizeStage('empty', requests.empty, emptyResult)

  const stages = {
    collection: collectionStage,
    position: positionStage,
    empty: emptyStage
  }
  const failedStages = Object.values(stages).filter((s) => !s.ok)

  // Tag universe is derived from the list responses themselves (collection +
  // position cover every article when the list fits two pages), so the
  // snapshot stays a faithful view of the article list and never depends on a
  // separate endpoint. Strictly read-only.
  const tags = [...new Set(
    Object.values(stages).flatMap((s) => (s.ok ? s.tagUnion : []))
  )].sort()

  if (failedStages.length > 0) {
    // Preserve the failure stage. Keep the last good snapshot untouched so a
    // service outage can never masquerade as an empty/changed article list.
    const serviceUnavailable = failedStages.some((s) => s.error?.code === 'SERVICE_UNAVAILABLE')
    const failureRecord = {
      status: 'failed',
      reason: serviceUnavailable ? 'service_unavailable' : 'stage_error',
      attemptedAt: new Date().toISOString(),
      baseUrl,
      stages
    }
    atomicWrite(failedFile, failureRecord)

    console.error('Snapshot build failed; previous good snapshot (if any) was kept.')
    for (const stage of failedStages) {
      console.error(`  ✗ ${stage.label} (${stage.name}): ${stage.error?.code} ${stage.error?.message}`)
    }
    console.error(`\nFailure stage recorded: ${failedFile}`)
    process.exitCode = 1
    return
  }

  const summary = {
    schemaVersion: SCHEMA_VERSION,
    baseUrl,
    tags: { count: tags.length, names: tags },
    stages
  }
  summary.digest = sha256({
    schemaVersion: summary.schemaVersion,
    baseUrl: summary.baseUrl,
    tags: summary.tags,
    stages: summary.stages
  })

  const fullSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    baseUrl,
    tags,
    stages: {
      collection: { request: requests.collection, response: collectionResult.body },
      position: { request: requests.position, response: positionResult.body },
      empty: { request: requests.empty, response: emptyResult.body }
    }
  }

  // Success: overwrite old snapshots and clear any stale failure marker.
  atomicWrite(latestFile, fullSnapshot)
  atomicWrite(summaryFile, summary)
  if (fs.existsSync(failedFile)) fs.rmSync(failedFile)

  for (const [name, stage] of Object.entries(stages)) {
    console.log(
      `  ✓ ${stage.label} (${name}) page=${stage.pagination.page}/${stage.pagination.totalPages} ` +
      `count=${stage.articleCount} total=${stage.pagination.total}`
    )
  }
  console.log(`\nTags: ${tags.length}`)
  console.log(`Digest: ${summary.digest}`)
  console.log(`\nWrote:\n  ${latestFile}\n  ${summaryFile}`)

  const comparison = compareWithBaseline(summary)
  if (comparison) {
    if (comparison.compared === false) {
      console.warn(`\nBaseline comparison skipped: ${comparison.error}`)
    } else {
      console.log(`\nCompared with baseline ${comparison.baseline}`)
      if (comparison.match) {
        console.log('  ✓ MATCH: article list snapshot is unchanged.')
      } else {
        console.warn('  ✗ DIFF: article list snapshot changed.')
        for (const diff of comparison.stageDiffs) {
          console.warn(`    - ${diff.label} (${diff.stage}) digest differs`)
        }
        process.exitCode = 2
      }
    }
  }
}

main().catch((err) => {
  // Unexpected builder error: still preserve a failure stage.
  fs.mkdirSync(outDir, { recursive: true })
  atomicWrite(failedFile, {
    status: 'failed',
    reason: 'builder_error',
    attemptedAt: new Date().toISOString(),
    baseUrl,
    error: { message: err?.message || String(err), code: err?.code || 'BUILDER_ERROR' }
  })
  console.error(`Snapshot builder error: ${err?.message || err}`)
  process.exit(1)
})
