import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.vercel(?:\/|$)/i,
  /(^|\/)\.openai\/hosting\.json$/i,
  /(^|\/)(?:artifacts|coverage|playwright-report|test-results)(?:\/|$)/i,
  /(^|\/)ownsay-backup-\d{4}-\d{2}-\d{2}\.json$/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.|$)/i,
  /\.(?:p8|p12|pfx|pem|key)$/i,
]

const textExtensions = new Set([
  '', '.cjs', '.css', '.cff', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.svg', '.toml', '.ts', '.tsx', '.txt', '.webmanifest', '.xml', '.yaml', '.yml',
])

const formerProductBrand = ['In', 'tent'].join('')
const formerPrototypeBrand = ['Ki', 'th'].join('')
const formerPublicSlug = ['in', 'tent-aac-open-source'].join('')

const lockedBinaryHashes = new Map([
  ['public/og.png', '78121de9a4167c98f55b51d40a803a5363a94a0b3470370af566d0d4c57dd8d7'],
])

const forbiddenContent = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access-key identifier', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['OpenAI-style secret key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI Sites project binding', /\bappgprj_[A-Za-z0-9_-]+\b/],
  ['personal Vercel deployment URL', /https?:\/\/[A-Za-z0-9-]+\.vercel\.app\b/i],
  ['local user filesystem path', /(?:^|[\s"'=(])\/(?:Users|home)\/[A-Za-z0-9._-]+\//m],
  ['former private product brand', new RegExp(`\\b${formerProductBrand}\\b`, 'i')],
  ['former prototype product brand', new RegExp(`\\b${formerPrototypeBrand}\\b`, 'i')],
  ['former public repository slug', new RegExp(formerPublicSlug, 'i')],
]

const problems = []

for (const required of lockedBinaryHashes.keys()) {
  if (!tracked.includes(required)) problems.push(`${required}: required reviewed asset is not tracked`)
}

for (const file of tracked) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    problems.push(`${file}: forbidden public-repository path`)
    continue
  }

  const absolute = resolve(root, file)
  const normalizedRelative = relative(root, absolute)
  if (normalizedRelative.startsWith(`..${sep}`) || normalizedRelative === '..') {
    problems.push(`${file}: resolves outside the repository`)
    continue
  }

  const stat = statSync(absolute)
  const expectedHash = lockedBinaryHashes.get(file)
  if (expectedHash) {
    const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    if (digest !== expectedHash) problems.push(`${file}: reviewed binary asset hash changed`)
    continue
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || !textExtensions.has(extname(file).toLowerCase())) {
    continue
  }

  const content = readFileSync(absolute, 'utf8')
  for (const [label, pattern] of forbiddenContent) {
    if (pattern.test(content)) problems.push(`${file}: contains ${label}`)
  }
}

if (problems.length > 0) {
  console.error('Public-source gate failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log(`Public-source gate passed for ${tracked.length} tracked files.`)
}
