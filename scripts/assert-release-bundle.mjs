#!/usr/bin/env node
// Release bundle gate: asserts the production output is honestly branded,
// free of QA simulation hooks, and keeps the model runtime out of the
// app-shell precache and the critical (eager) load graph. Read-only.
//
// FAIL-CLOSED contract: this gate never silently passes on parser
// uncertainty. A missing/unreadable index.html or sw.js, a Workbox precache
// that parses to zero entries/bytes, a precache entry whose file cannot be
// sized, an unreadable entry-graph chunk, or a raster whose dimensions cannot
// be verified are all hard failures, as is any budget or content breach.
//
// Usage: node scripts/assert-release-bundle.mjs [distRoot]   (default dist/client)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KIB = 1024

/** Warn-only band (KiB, gzipped) for the critical entry graph. */
export const CRITICAL_JS_WARN_MIN_KIB = 100
export const CRITICAL_JS_FAIL_KIB = 120
export const PRECACHE_LIMIT_KIB = 1024
export const RASTER_MAX_WIDTH = 1024
export const RASTER_MAX_HEIGHT = 600

/** The lazy model/runtime path: excluded from the critical calculation and forbidden in the precache. */
export const MODEL_PATH_PATTERN = /webllm|@mlc-ai|mlc-llm|smollm|\.wasm(?:[?#]|$)/i
/** The intended social-share exception (og image): never fetched by the app itself. */
export const SOCIAL_OG_PATTERN = /(^|\/)og\.(png|jpe?g|gif|webp)$/i
const RASTER_PATTERN = /\.(png|jpe?g|gif|webp)$/i
const FORMER_PRODUCT_BRAND = ['In', 'tent'].join('')
const FORMER_PRODUCT_NAMESPACE = ['in', 'tent-aac'].join('')
const FORMER_PROTOTYPE_BRAND = ['Ki', 'th'].join('')

function gzipSize(bytes) {
  return gzipSync(bytes).length
}

/** Minimal PNG IHDR dimension probe. */
function pngDimensions(bytes) {
  if (bytes.length < 24) return null
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** GIF logical-screen dimensions (little-endian, bytes 6–9). */
function gifDimensions(bytes) {
  if (bytes.length < 10) return null
  if (bytes.toString('ascii', 0, 3) !== 'GIF') return null
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

/** JPEG dimensions via SOF marker scan. */
function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    // Standalone markers (no payload): D8, D9, 01, D0–D7.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

/** WebP dimensions from VP8X / VP8 (lossy) / VP8L (lossless) chunk headers. */
function webpDimensions(bytes) {
  if (bytes.length < 30) return null
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null
  const fourCc = bytes.toString('ascii', 12, 16)
  if (fourCc === 'VP8X') {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    }
  }
  if (fourCc === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (fourCc === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const width = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21])
    const height = 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))
    return { width, height }
  }
  return null
}

/** Dimensions for any supported raster; null means "cannot verify" (caller must fail closed). */
export function rasterDimensions(relativePath, bytes) {
  const lower = relativePath.toLowerCase()
  if (lower.endsWith('.png')) return pngDimensions(bytes)
  if (lower.endsWith('.gif')) return gifDimensions(bytes)
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return jpegDimensions(bytes)
  if (lower.endsWith('.webp')) return webpDimensions(bytes)
  return null
}

/**
 * Static module specifiers referenced by a built chunk, in source order.
 * Two shapes cover real bundler output (minified or not, any quote style):
 *   - `from"./x.js"`   (static import … from / export … from)
 *   - `import"./x.js"` (side-effect import)
 * `import.meta` never matches: no quote follows `import`. Dynamic
 * `import("./x.js")` is deliberately absent here (lazy by definition).
 */
export function extractStaticImportSpecifiers(source) {
  const found = []
  const seen = new Set()
  for (const pattern of [/\bfrom\s*["'`]([^"'`]+)["'`]/g, /\bimport\s*["'`]([^"'`]+)["'`]/g]) {
    for (const match of source.matchAll(pattern)) {
      if (!seen.has(match[1])) {
        seen.add(match[1])
        found.push({ index: match.index, specifier: match[1] })
      }
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.specifier)
}

/** Dynamic `import("./x.js")` specifiers, in source order. */
export function extractDynamicImportSpecifiers(source) {
  const found = []
  const seen = new Set()
  for (const match of source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if (!seen.has(match[1])) {
      seen.add(match[1])
      found.push(match[1])
    }
  }
  return found
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

/**
 * Parse the real Workbox precache call out of a generated service worker.
 * Handles the generateSW shape `precacheAndRoute([...],{})` with entries such
 * as `{url:"index.html",revision:"abc"}`, `{url:"assets/x.js",revision:null}`,
 * quoted-key variants, and bare string entries. Returns null when no precache
 * call can be located at all (caller must fail closed).
 */
export function parsePrecacheEntries(swText) {
  const callMatch = /precacheAndRoute\s*\(/.exec(swText)
  let arrayText = null
  if (callMatch) {
    const start = swText.indexOf('[', callMatch.index)
    if (start !== -1) {
      // Bracket-match the array literal, skipping over string contents.
      let depth = 0
      let inString = null
      for (let index = start; index < swText.length; index += 1) {
        const char = swText[index]
        if (inString) {
          if (char === '\\') index += 1
          else if (char === inString) inString = null
          continue
        }
        if (char === '"' || char === "'" || char === '`') inString = char
        else if (char === '[') depth += 1
        else if (char === ']') {
          depth -= 1
          if (depth === 0) {
            arrayText = swText.slice(start, index + 1)
            break
          }
        }
      }
    }
  }
  if (arrayText === null) {
    // Fallback shape some builds emit: the bare manifest array on its own.
    if (/__WB_MANIFEST/.test(swText)) {
      return { entries: [], shape: 'unparseable __WB_MANIFEST reference' }
    }
    return null
  }

  const entries = []
  const objectEntry = /\{[^{}]*\burl"?\s*:\s*["'`]([^"'`]+)["'`][^{}]*\}/g
  let consumed = arrayText
  for (const match of arrayText.matchAll(objectEntry)) {
    entries.push(match[1])
    consumed = consumed.replace(match[0], '')
  }
  // Bare string entries (legacy/loose form): what remains inside the array.
  for (const match of consumed.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    entries.push(match[1])
  }
  return { entries, shape: callMatch ? 'precacheAndRoute' : 'unknown' }
}

/**
 * Run the full release gate against a built client root. Returns a result
 * object; the CLI wrapper owns printing and the process exit code.
 */
export function runReleaseGate(rootInput) {
  const root = normalize(rootInput ?? 'dist/client')
  const problems = []
  const warnings = []
  const failHard = []
  const stats = {}

  let files
  try {
    files = [...walk(root)]
  } catch {
    problems.push(`build root unreadable: ${root}`)
    return { root, problems, warnings, failHard, stats }
  }
  const text = (file) => readFileSync(file, 'utf8')
  const readAsset = (relative) => {
    try {
      return readFileSync(join(root, relative.replace(/^\//, '')))
    } catch {
      return null
    }
  }

  // -- Honest branding / metadata -------------------------------------------
  let html = ''
  try {
    html = text(join(root, 'index.html'))
  } catch {
    problems.push('index.html unreadable or missing — cannot verify the entry document')
  }
  if (html) {
    if (new RegExp(`\\b${FORMER_PRODUCT_BRAND}\\b`, 'i').test(html)) problems.push('index.html contains a former private brand')
    if (new RegExp(`\\b${FORMER_PROTOTYPE_BRAND}\\b`, 'i').test(html)) problems.push('index.html contains a former prototype brand')
    if (/webllm/i.test(html)) problems.push('index.html references the lazy WebLLM chunks')
    if (!/<title>OwnSay<\/title>/.test(html)) problems.push('document title must be OwnSay')
  }

  for (const file of files) {
    const relative = file.slice(root.length + 1)
    if (!/\.(js|css|html|webmanifest|json)$/.test(relative)) continue

    let content = ''
    try {
      content = text(file)
    } catch {
      problems.push(`${relative}: unreadable text asset — cannot verify content`)
      continue
    }

    const isWebllmChunk = /webllm/i.test(relative)

    if (new RegExp(`\\b${FORMER_PRODUCT_BRAND}\\b`).test(content) || new RegExp(FORMER_PRODUCT_NAMESPACE, 'i').test(content)) {
      problems.push(`${relative}: contains a former private product identifier`)
    }
    if (new RegExp(`\\b${FORMER_PROTOTYPE_BRAND}\\b`, 'i').test(content)) {
      problems.push(`${relative}: contains a former prototype product identifier`)
    }

    if (!isWebllmChunk) {
      if (/applySimulationFromQuery|simulate-ready|simulate-unavailable|simulate-fail/.test(content)) {
        problems.push(`${relative}: contains a QA simulation hook`)
      }
      if (relative === 'sw.js' || relative.endsWith('manifest.webmanifest')) {
        if (/webllm/i.test(content)) problems.push(`${relative}: references the lazy model runtime`)
      }
    }

    if (relative === 'manifest.webmanifest') {
      try {
        const manifest = JSON.parse(content)
        if (manifest.name !== 'OwnSay' || manifest.short_name !== 'OwnSay') {
          problems.push('manifest.webmanifest: product name must be OwnSay')
        }
        if (manifest.id !== '/') problems.push('manifest.webmanifest: stable app id must be /')
      } catch {
        problems.push('manifest.webmanifest: unparseable JSON')
      }
    }
  }

  // The lazy chunks must exist and stay unreferenced by the entry document.
  const hasWebllmChunks = files.some((file) => /assets\/webllm-.*\.js$/.test(file))
  if (!hasWebllmChunks) problems.push('lazy WebLLM runtime chunks missing from the build')

  // ---------------------------------------------------------------------------
  // Performance/artifact budget ceilings (final Fire 7 release audit)
  // ---------------------------------------------------------------------------

  const htmlBytes = html ? readFileSync(join(root, 'index.html')) : null
  const htmlText = htmlBytes ? htmlBytes.toString() : ''
  const scripts = [...htmlText.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
  const stylesheets = [
    ...htmlText.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1])

  if (html && scripts.length === 0) problems.push('index.html contains no entry script tag')

  // Critical entry graph: entry scripts + recursive STATIC relative imports.
  // The lazy model path is excluded from the size total; a STATIC edge into it
  // is an eager-load regression and fails the gate.
  const criticalFiles = new Map()
  {
    const seen = new Set()
    const queue = scripts.map((src) => normalize(src.replace(/^\//, '')))
    for (const rel of queue) seen.add(rel)
    while (queue.length > 0) {
      const rel = queue.shift()
      if (criticalFiles.has(rel)) continue
      const bytes = readAsset(rel)
      if (!bytes) {
        problems.push(`entry script missing from build output: ${rel}`)
        continue
      }
      criticalFiles.set(rel, bytes)
      const source = bytes.toString('utf8')
      for (const specifier of extractStaticImportSpecifiers(source)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          problems.push(`non-relative static module specifier left in built chunk ${rel}: ${specifier}`)
          continue
        }
        const resolved = normalize(join(dirname(rel), specifier))
        if (MODEL_PATH_PATTERN.test(resolved)) {
          problems.push(`eager static import of the lazy model path from ${rel}: ${specifier}`)
          continue
        }
        if (!/\.m?js$/i.test(resolved)) continue
        if (!seen.has(resolved)) {
          seen.add(resolved)
          queue.push(resolved)
        }
      }
      // Dynamic references are lazy by definition: verify integrity only.
      for (const specifier of extractDynamicImportSpecifiers(source)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
        const resolved = normalize(join(dirname(rel), specifier))
        if (MODEL_PATH_PATTERN.test(resolved)) continue
        if (readAsset(resolved) === null) {
          problems.push(`dynamic import target missing from build output: ${resolved} (referenced by ${rel})`)
        }
      }
    }
  }

  let initialJsGzip = 0
  let initialJsRaw = 0
  for (const bytes of criticalFiles.values()) {
    initialJsGzip += gzipSize(bytes)
    initialJsRaw += bytes.length
  }
  let cssGzip = 0
  for (const href of stylesheets) {
    const bytes = readAsset(href)
    if (!bytes) {
      problems.push(`entry stylesheet missing from build output: ${href}`)
      continue
    }
    cssGzip += gzipSize(bytes)
  }
  const htmlGzip = htmlBytes ? gzipSize(htmlBytes) : 0
  const criticalGzip = htmlGzip + initialJsGzip + cssGzip

  // Initial request count: document + scripts + stylesheets + manifest/icon head requests.
  const manifestLink = /<link[^>]+rel="manifest"[^>]*href="([^"]+)"/.exec(htmlText)
  const iconLinks = [
    ...htmlText.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g),
  ]
  const initialRequests =
    1 + scripts.length + stylesheets.length + (manifestLink ? 1 : 0) + iconLinks.length

  // Web fonts must never appear in the entry graph or precache.
  const fontFiles = files.filter((file) => /\.(woff2?|ttf|otf|eot)$/i.test(file))
  if (fontFiles.length > 0) problems.push(`web fonts present in bundle: ${fontFiles.join(', ')}`)

  // Every ORDINARY raster must fit a Fire-class screen without huge decode
  // cost. The og.* social-share preview is the single intended exception: it
  // is never fetched or decoded by the app itself and stays out of the shell.
  for (const file of files) {
    const relative = file.slice(root.length + 1)
    if (!RASTER_PATTERN.test(relative)) continue
    if (SOCIAL_OG_PATTERN.test(relative)) continue
    const dims = rasterDimensions(relative, readFileSync(file))
    if (!dims) {
      problems.push(`${relative}: raster dimensions unverifiable (unsupported or truncated file)`)
      continue
    }
    if (dims.width > RASTER_MAX_WIDTH || dims.height > RASTER_MAX_HEIGHT) {
      problems.push(
        `raster too large for the ${RASTER_MAX_WIDTH}x${RASTER_MAX_HEIGHT} Fire decode budget: ${relative} ${dims.width}x${dims.height} (only the social og image may exceed it)`,
      )
    }
  }

  // Service worker precache: real Workbox shape, fail-closed, model/social
  // assets forbidden, 1 MiB ceiling.
  let precacheEntries = []
  let precacheBytes = 0
  const swPath = join(root, 'sw.js')
  let swText = null
  try {
    swText = readFileSync(swPath, 'utf8')
  } catch {
    problems.push('sw.js missing or unreadable — the offline shell cannot be verified')
  }
  if (swText !== null) {
    const parsed = parsePrecacheEntries(swText)
    if (parsed === null) {
      problems.push('sw.js contains no parseable Workbox precache call — refusing to guess')
    } else {
      precacheEntries = [...new Set(parsed.entries)]
      if (precacheEntries.length === 0) {
        problems.push(
          `service-worker precache parsed to zero entries (${parsed.shape}) — refusing to pass an unverifiable shell`,
        )
      }
      for (const entryUrl of precacheEntries) {
        if (MODEL_PATH_PATTERN.test(entryUrl)) {
          problems.push(`service-worker precache includes a model/runtime asset: ${entryUrl}`)
          continue
        }
        if (SOCIAL_OG_PATTERN.test(entryUrl)) {
          problems.push(`service-worker precache includes the social asset: ${entryUrl}`)
          continue
        }
        const bytes = readAsset(entryUrl)
        if (!bytes) {
          problems.push(`precache entry cannot be sized on disk: ${entryUrl}`)
          continue
        }
        precacheBytes += bytes.length
      }
      if (precacheEntries.length > 0 && precacheBytes === 0) {
        problems.push('service-worker precache sizes to zero bytes — refusing to pass an unverifiable shell')
      }
      if (precacheBytes > PRECACHE_LIMIT_KIB * KIB) {
        failHard.push(
          `service-worker shell precache ${(precacheBytes / KIB).toFixed(0)} KiB exceeds the ${PRECACHE_LIMIT_KIB} KiB ceiling`,
        )
      }
    }
  }

  if (initialJsGzip > CRITICAL_JS_FAIL_KIB * KIB) {
    failHard.push(
      `critical entry-graph JS gzip ${(initialJsGzip / KIB).toFixed(1)} KiB > ${CRITICAL_JS_FAIL_KIB} KiB hard ceiling`,
    )
  } else if (initialJsGzip > CRITICAL_JS_WARN_MIN_KIB * KIB) {
    warnings.push(
      `critical entry-graph JS gzip ${(initialJsGzip / KIB).toFixed(1)} KiB is inside the ${CRITICAL_JS_WARN_MIN_KIB}–${CRITICAL_JS_FAIL_KIB} KiB warning band (target ≤${CRITICAL_JS_WARN_MIN_KIB} KiB)`,
    )
  }
  if (initialJsRaw > 450 * KIB) failHard.push(`critical entry-graph JS raw ${(initialJsRaw / KIB).toFixed(1)} KiB > 450 KiB`)
  if (cssGzip > 20 * KIB) failHard.push(`initial CSS gzip ${(cssGzip / KIB).toFixed(1)} KiB > 20 KiB`)
  else if (cssGzip > 15 * KIB)
    problems.push(`initial CSS gzip target missed: ${(cssGzip / KIB).toFixed(1)} KiB (target ≤15 KiB)`)
  if (htmlBytes && gzipSize(htmlBytes) > 25 * KIB) failHard.push('critical HTML gzip > 25 KiB')
  if (htmlBytes && criticalGzip > 200 * KIB)
    failHard.push(`ordinary critical-path gzip ${(criticalGzip / KIB).toFixed(1)} KiB > 200 KiB`)
  if (initialRequests > 12) failHard.push(`ordinary initial requests ${initialRequests} > 12`)

  stats.criticalGraphFiles = criticalFiles.size
  stats.criticalJsGzipKib = +(initialJsGzip / KIB).toFixed(1)
  stats.criticalJsRawKib = +(initialJsRaw / KIB).toFixed(1)
  stats.cssGzipKib = +(cssGzip / KIB).toFixed(1)
  stats.htmlGzipKib = +(htmlGzip / KIB).toFixed(1)
  stats.criticalGzipKib = +(criticalGzip / KIB).toFixed(1)
  stats.initialRequests = initialRequests
  stats.fonts = fontFiles.length
  stats.precacheEntries = precacheEntries.length
  stats.precacheKib = +(precacheBytes / KIB).toFixed(1)
  stats.totalFiles = files.length

  return { root, problems, warnings, failHard, stats }
}

async function main() {
  const root = process.argv[2] ?? 'dist/client'
  const { problems, warnings, failHard, stats } = runReleaseGate(root)

  console.log(
    [
      `Budgets: critical entry graph ${stats.criticalGraphFiles ?? 0} JS file(s) ${stats.criticalJsGzipKib ?? '?'} KiB gzip / ${stats.criticalJsRawKib ?? '?'} KiB raw`,
      `CSS ${stats.cssGzipKib ?? '?'} KiB gzip`,
      `HTML ${stats.htmlGzipKib ?? '?'} KiB gzip`,
      `critical gzip total ${stats.criticalGzipKib ?? '?'} KiB`,
      `initial requests ${stats.initialRequests ?? '?'}`,
      `precache ${stats.precacheEntries ?? 0} entr(ies) ${stats.precacheKib ?? '?'} KiB`,
      `fonts ${stats.fonts ?? 0}`,
    ].join(' · '),
  )

  if (warnings.length > 0) {
    console.warn('Release bundle warnings (non-blocking):')
    for (const warning of warnings) console.warn(` - ${warning}`)
  }

  const failures = [...problems, ...failHard]
  if (failures.length > 0) {
    console.error('Release bundle gate FAILED:')
    for (const failure of failures) console.error(` - ${failure}`)
    return 1
  }

  console.log(`Release bundle gate passed for ${stats.totalFiles ?? 0} files in ${root}.`)
  return 0
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  process.exitCode = await main()
}
