#!/usr/bin/env node
/**
 * Documentation gate for the CCT entry points (`@chainlink/ccip-sdk/cct/evm`, `…/cct/solana`).
 *
 * TypeDoc's `validation.notDocumented` cannot be scoped by path, and the docs-site build is not part
 * of `npm run check`, so this runs a separate TypeDoc pass over the CCT entry points only, with no
 * output, and fails when a public symbol has no documentation. Its options and entry points come
 * from `ccip-api-ref/typedoc.shared.mjs`, which the docs site uses too, so both document the same
 * symbols. `cct/canton` is not gated yet.
 *
 * Symbols that were undocumented when the gate was introduced are listed in
 * `lint-docs-cct.baseline.txt`. The baseline only shrinks: a new undocumented symbol fails, and so
 * does a baseline entry that is now documented. `--prune` removes documented entries from the
 * baseline; it never adds one, and still fails while new undocumented symbols exist.
 *
 * Usage: `npm run lint:docs:cct [-- --prune]`
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'ccip-api-ref')
const baselinePath = join(root, 'scripts', 'lint-docs-cct.baseline.txt')
const { SDK_TYPEDOC_ENTRY_POINTS, SDK_TYPEDOC_OPTIONS } = await import(
  pathToFileURL(join(docs, 'typedoc.shared.mjs')).href
)
const ENTRY_POINTS = SDK_TYPEDOC_ENTRY_POINTS.filter(
  (e) => e.includes('/cct/') && !e.includes('/canton/'),
)
const REQUIRED_KINDS = [
  'Class',
  'Function',
  'Method',
  'Interface',
  'TypeAlias',
  'Variable',
  'Enum',
  'Property',
]

// the site's options (shared module), plus validation only
const args = [
  ...Object.entries(SDK_TYPEDOC_OPTIONS).flatMap(([k, v]) =>
    v === true ? [`--${k}`] : [`--${k}`, String(v)],
  ),
  ...ENTRY_POINTS.flatMap((e) => ['--entryPoints', e]),
  '--emit',
  'none',
  '--validation.notDocumented',
  '--validation.invalidLink',
  'false',
  '--validation.notExported',
  'false',
  ...REQUIRED_KINDS.flatMap((k) => ['--requiredToBeDocumented', k]),
  '--logLevel',
  'Warn',
]

// TypeDoc is a dependency of the docs workspace; resolve it from there and run its entry with node,
// which also works where `.bin` shims are `.cmd` files
const requireFromDocs = createRequire(join(root, 'ccip-api-ref', 'package.json'))
const typedocPkg = requireFromDocs.resolve('typedoc/package.json')
const typedocBin = join(dirname(typedocPkg), 'bin', 'typedoc')

process.stderr.write('lint:docs:cct: running TypeDoc over cct/evm and cct/solana (up to ~2 min)…\n')
const run = spawnSync(process.execPath, [typedocBin, ...args], {
  cwd: docs,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (run.error) {
  process.stderr.write(`lint:docs:cct: could not run typedoc: ${run.error.message}\n`)
  process.exit(2)
}
const output = `${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
if (/\[error\]/.test(output) || run.status !== 0) {
  process.stderr.write(output)
  process.stderr.write(`lint:docs:cct: typedoc failed (exit ${run.status})\n`)
  process.exit(2)
}

const current = new Set(
  output
    .split('\n')
    .filter((line) => line.includes('does not have any documentation'))
    .map((line) => line.replace(/^\[warning\]\s*/, '').trim()),
)
const baseline = readFileSync(baselinePath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
const baselined = new Set(baseline)
const added = [...current].filter((l) => !baselined.has(l)).sort()
const fixed = baseline.filter((l) => !current.has(l))

if (added.length) {
  process.stderr.write(
    `lint:docs:cct: ${added.length} public CCT symbol(s) without documentation. Add a /** … */ comment, or mark the symbol @internal if it is not public API (\`__type.x\` is property x of an inline object type):\n`,
  )
  for (const l of added) process.stderr.write(`  ${l}\n`)
}

if (process.argv.includes('--prune')) {
  const kept = baseline.filter((l) => current.has(l))
  writeFileSync(baselinePath, kept.length ? kept.join('\n') + '\n' : '')
  process.stdout.write(
    `lint:docs:cct: baseline pruned (${fixed.length} removed, ${kept.length} left)\n`,
  )
  process.exit(added.length ? 1 : 0)
}

if (fixed.length) {
  process.stderr.write(
    `lint:docs:cct: ${fixed.length} baseline ${fixed.length === 1 ? 'entry is' : 'entries are'} now documented; remove ${fixed.length === 1 ? 'it' : 'them'} from scripts/lint-docs-cct.baseline.txt, or run \`npm run lint:docs:cct -- --prune\`:\n`,
  )
  for (const l of fixed) process.stderr.write(`  ${l}\n`)
}
if (added.length || fixed.length) process.exit(1)
process.stdout.write(`lint:docs:cct: ok (${baseline.length} baselined)\n`)
