#!/usr/bin/env node
// Self-contained checks for the two release tools (fire-perf.mjs and
// assert-release-bundle.mjs). Builds synthetic dist trees in a temp dir and
// runs the real gate logic against them — no shared build, no browser, no
// network. Exits non-zero if any expectation fails.
//
// Usage: node scripts/release-tools.selftest.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import {
  CDP_NETWORK_CONDITIONS,
  NETWORK_PROFILE,
  isCrossOriginUrl,
  isModelRequestUrl,
  kbpsToBytesPerSecond,
  percentile95,
} from './fire-perf.mjs'
import {
  extractStaticImportSpecifiers,
  parsePrecacheEntries,
  rasterDimensions,
  runReleaseGate,
} from './assert-release-bundle.mjs'

const failures = []
let checks = 0
function check(name, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`ok ${checks} - ${name}`)
  } else {
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`)
    console.error(`not ok ${checks} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// fire-perf pure helpers
// ---------------------------------------------------------------------------
check('kbps→B/s download', kbpsToBytesPerSecond(1600) === 200_000)
check('kbps→B/s upload', kbpsToBytesPerSecond(750) === 93_750)
check(
  'CDP network payload carries real latency+throughput',
  CDP_NETWORK_CONDITIONS.offline === false &&
    CDP_NETWORK_CONDITIONS.latency === NETWORK_PROFILE.latencyMs &&
    CDP_NETWORK_CONDITIONS.downloadThroughput === 200_000 &&
    CDP_NETWORK_CONDITIONS.uploadThroughput === 93_750,
)
check('model url: webllm chunk', isModelRequestUrl('http://127.0.0.1/assets/webllm-lib-X.js'))
check('model url: huggingface', isModelRequestUrl('https://huggingface.co/mlc-ai/model/resolve/main/x.bin'))
check('model url: wasm', isModelRequestUrl('https://x.test/a.wasm?v=1'))
check('model url: ordinary chunk is not model', !isModelRequestUrl('http://127.0.0.1/assets/index-A.js'))
check(
  'cross-origin: other origin',
  isCrossOriginUrl('https://cdn.example.com/x.js', 'http://127.0.0.1:4173'),
)
check(
  'cross-origin: same origin',
  !isCrossOriginUrl('http://127.0.0.1:4173/assets/index-A.js', 'http://127.0.0.1:4173'),
)
check('cross-origin: data url inert', !isCrossOriginUrl('data:image/png;base64,xx', 'http://127.0.0.1:4173'))
check('p95 of 1..100', percentile95(Array.from({ length: 100 }, (_, i) => i + 1)) === 95)
check('p95 empty', percentile95([]) === null)

// ---------------------------------------------------------------------------
// assert-release-bundle pure helpers
// ---------------------------------------------------------------------------
check(
  'static specifier scan excludes dynamic import() and import.meta',
  JSON.stringify(
    extractStaticImportSpecifiers(
      'import{a}from"./a.js";import"./b.js";const u=import.meta.url;const p=import("./c.js");export{q}from`./d.js`;',
    ),
  ) === JSON.stringify(['./a.js', './b.js', './d.js']),
)
check(
  'precache parser: minified workbox object entries',
  (() => {
    const parsed = parsePrecacheEntries(
      'define(["./workbox-x"],function(e){e.precacheAndRoute([{url:"index.html",revision:"abc"},{url:"assets/index-A.js",revision:null}],{})})',
    )
    return parsed !== null && JSON.stringify(parsed.entries) === JSON.stringify(['index.html', 'assets/index-A.js'])
  })(),
)
check(
  'precache parser: quoted keys and bare strings',
  (() => {
    const parsed = parsePrecacheEntries('precacheAndRoute([{"url":"a.js","revision":"r1"},"b.js"],{})')
    return parsed !== null && JSON.stringify(parsed.entries) === JSON.stringify(['a.js', 'b.js'])
  })(),
)
check('precache parser: no precache call returns null', parsePrecacheEntries('self.skipWaiting()') === null)

// Fabricated raster headers (only the dimension fields the probe reads).
function fakePng(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}
function fakeGif(width, height) {
  const bytes = Buffer.alloc(10)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}
function fakeJpeg(width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}
check('png dims', JSON.stringify(rasterDimensions('x.png', fakePng(192, 192))) === JSON.stringify({ width: 192, height: 192 }))
check('gif dims', JSON.stringify(rasterDimensions('x.gif', fakeGif(640, 480))) === JSON.stringify({ width: 640, height: 480 }))
check('jpeg dims', JSON.stringify(rasterDimensions('x.jpg', fakeJpeg(1024, 600))) === JSON.stringify({ width: 1024, height: 600 }))
check('truncated png → null (fail closed)', rasterDimensions('x.png', Buffer.from([0x89, 0x50, 0x4e])) === null)

// ---------------------------------------------------------------------------
// Fixture dist trees through the real gate
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'ownsay-release-gate-'))

/** Random hex comment filler: lands near a target gzip size within ±2 KiB. */
function jsFillerNearGzip(targetBytes) {
  let length = Math.round(targetBytes * 1.7)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const source = `/*${randomBytes(Math.ceil(length / 2)).toString('hex')}*/\nexport const x=1\n`
    const gz = gzipSync(Buffer.from(source)).length
    if (Math.abs(gz - targetBytes) <= 2 * 1024) return source
    length = Math.max(1024, Math.round(length * (targetBytes / gz)))
  }
  throw new Error(`could not synthesise filler near ${targetBytes} gzip bytes`)
}

function writeBaseTree(overrides = {}) {
  const root = mkdtempSync(join(tmp, 'dist-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'icons'), { recursive: true })
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html lang="en-GB"><head><title>OwnSay</title>' +
      '<script type="module" crossorigin src="/assets/index-AAA.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-BBB.css">' +
      '<link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>',
  )
  writeFileSync(
    join(root, 'assets', 'index-AAA.js'),
    overrides.entrySource ??
      'import{g}from"./shared-CCC.js";console.log(g);const lazy=()=>import("./webllm-lib-DDD.js");export{lazy};',
  )
  writeFileSync(join(root, 'assets', 'shared-CCC.js'), 'export const g="hi";\n')
  writeFileSync(join(root, 'assets', 'webllm-lib-DDD.js'), '// lazy model runtime stub\n')
  writeFileSync(join(root, 'assets', 'index-BBB.css'), 'body{margin:0}\n')
  writeFileSync(
    join(root, 'manifest.webmanifest'),
    JSON.stringify({ id: '/', name: 'OwnSay', short_name: 'OwnSay' }),
  )
  writeFileSync(
    join(root, 'sw.js'),
    overrides.sw ??
      'define(["./workbox-W"],function(e){"use strict";e.precacheAndRoute([' +
        '{url:"index.html",revision:"abc"},' +
        '{url:"assets/index-AAA.js",revision:null},' +
        '{url:"assets/index-BBB.css",revision:null},' +
        '{url:"assets/shared-CCC.js",revision:null},' +
        '{url:"manifest.webmanifest",revision:"def"},' +
        '{url:"icons/icon-192.png",revision:"ghi"}],{}),e.cleanupOutdatedCaches()})',
  )
  writeFileSync(join(root, 'icons', 'icon-192.png'), overrides.icon ?? fakePng(192, 192))
  writeFileSync(join(root, 'og.png'), fakePng(1731, 909)) // intended social exception
  return root
}

const has = (list, fragment) => list.some((item) => item.includes(fragment))

{
  const gate = runReleaseGate(writeBaseTree())
  check('base fixture passes clean', gate.problems.length === 0 && gate.failHard.length === 0, JSON.stringify([...gate.problems, ...gate.failHard]))
  check('base fixture: no warnings under 100 KiB', gate.warnings.length === 0, JSON.stringify(gate.warnings))
  check('base fixture: precache counted', gate.stats.precacheEntries === 6 && gate.stats.precacheKib > 0)
  check('base fixture: entry graph follows static imports', gate.stats.criticalGraphFiles === 2, `got ${gate.stats.criticalGraphFiles}`)
}
{
  const root = writeBaseTree()
  const big = 'assets/big-EEE.js'
  writeFileSync(join(root, 'assets', 'big-EEE.js'), randomBytes(Math.ceil((1100 * 1024) / 2)).toString('hex'))
  const gate = runReleaseGate(root) // baseline: big file NOT precached → no precache failure
  check('unprecached big asset does not trip the precache ceiling', !has(gate.failHard, 'precache'), JSON.stringify(gate.failHard))
  const swWithBig =
    'e.precacheAndRoute([{url:"index.html",revision:"abc"},{url:"assets/big-EEE.js",revision:null}],{})'
  const root2 = writeBaseTree({ sw: swWithBig })
  writeFileSync(join(root2, 'assets', 'big-EEE.js'), randomBytes(Math.ceil((1100 * 1024) / 2)).toString('hex'))
  const gate2 = runReleaseGate(root2)
  check('precache over 1 MiB fails', has(gate2.failHard, '1024 KiB'), JSON.stringify(gate2.failHard))
}
{
  const gate = runReleaseGate(
    writeBaseTree({ sw: 'e.precacheAndRoute([{url:"index.html",revision:"a"},{url:"og.png",revision:"b"}],{})' }),
  )
  check('precache containing the social asset fails', has(gate.problems, 'social'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(
    writeBaseTree({
      sw: 'e.precacheAndRoute([{url:"index.html",revision:"a"},{url:"assets/webllm-lib-DDD.js",revision:null}],{})',
    }),
  )
  check('precache containing a model asset fails', has(gate.problems, 'model/runtime'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ sw: 'e.precacheAndRoute([],{})' }))
  check('zero-entry precache fails closed', has(gate.problems, 'zero entries'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ sw: 'self.skipWaiting()' }))
  check('precache call missing fails closed', has(gate.problems, 'no parseable Workbox precache'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ sw: 'precacheAndRoute(self.__WB_MANIFEST)' }))
  check('indirect __WB_MANIFEST reference fails closed', has(gate.problems, 'zero entries'), JSON.stringify(gate.problems))
}
{
  const root = writeBaseTree()
  rmSync(join(root, 'sw.js'))
  const gate = runReleaseGate(root)
  check('missing sw.js fails closed', has(gate.problems, 'sw.js missing'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(
    writeBaseTree({ sw: 'e.precacheAndRoute([{url:"index.html",revision:"a"},{url:"ghost.js",revision:null}],{})' }),
  )
  check('precache entry missing on disk fails closed', has(gate.problems, 'cannot be sized'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ icon: fakePng(1200, 700) }))
  check('non-social raster over 1024x600 fails', has(gate.problems, 'raster too large'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ icon: Buffer.from('not a real png at all') }))
  check('unverifiable raster fails closed', has(gate.problems, 'dimensions unverifiable'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ entrySource: jsFillerNearGzip(130 * 1024) }))
  check('critical JS over 120 KiB hard-fails', has(gate.failHard, '120 KiB'), JSON.stringify(gate.failHard))
}
{
  const gate = runReleaseGate(writeBaseTree({ entrySource: jsFillerNearGzip(110 * 1024) }))
  check('critical JS in 100–120 KiB band warns without failing', gate.problems.length === 0 && gate.failHard.length === 0 && has(gate.warnings, 'warning band'), JSON.stringify({ p: gate.problems, f: gate.failHard, w: gate.warnings }))
}
{
  const gate = runReleaseGate(
    writeBaseTree({ entrySource: 'import"./webllm-lib-DDD.js";export const x=1;\n' }),
  )
  check('static (eager) import of the model path fails', has(gate.problems, 'eager static import'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(
    writeBaseTree({ entrySource: 'export const x=1;const p=import("./assets/nope-ZZZ.js");\n' }),
  )
  check('dynamic import target missing fails', has(gate.problems, 'dynamic import target missing'), JSON.stringify(gate.problems))
}
{
  const gate = runReleaseGate(writeBaseTree({ entrySource: 'import{q}from"react";export const x=q;\n' }))
  check('non-relative specifier in a chunk fails', has(gate.problems, 'non-relative'), JSON.stringify(gate.problems))
}

// Parser-level proof against the REAL current build output (informational;
// the shared build is owned by other agents and may be mid-integration).
const realSw = 'dist/client/sw.js'
if (existsSync(realSw)) {
  const { readFileSync } = await import('node:fs')
  const parsed = parsePrecacheEntries(readFileSync(realSw, 'utf8'))
  check('real sw.js parses to a non-empty precache', parsed !== null && parsed.entries.length > 0, `entries=${parsed?.entries.length}`)
  const gate = runReleaseGate('dist/client')
  console.log(
    `info - real dist/client gate outcome (informational): problems=${JSON.stringify(gate.problems)} warnings=${JSON.stringify(gate.warnings)} failHard=${JSON.stringify(gate.failHard)} stats=${JSON.stringify(gate.stats)}`,
  )
} else {
  console.log('skip - dist/client/sw.js not present; real-output parse check not applicable')
}

rmSync(tmp, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nSELFTEST FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log(`\nAll ${checks} release-tool selftest checks passed.`)
