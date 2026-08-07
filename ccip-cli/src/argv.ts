import { Format } from './commands/index.ts'

/**
 * Yargs parses a repeated option into an array: `--format json --format json` yields
 * `['json','json']`. Commands compare `argv.format` with strict equality against a {@link Format}
 * member, so an array matches nothing and the run silently falls back to the human-readable branch
 * — or, where a switch has no `default`, writes nothing to stdout at all while still exiting 0.
 * Keep the last occurrence, so a repeated flag behaves like the single flag it was meant to be.
 *
 * @param arg - Parsed option value, an array if the option was given more than once.
 * @returns The effective (last) value, never an array.
 */
export function lastIfRepeated<T>(arg: T | T[] | undefined): T | undefined {
  return Array.isArray(arg) ? arg.at(-1) : arg
}

/** Valid `--format` values; also feeds yargs' `choices`, so the two cannot drift. */
export const FORMATS: readonly string[] = Object.values(Format)

/**
 * Collapses a repeated `--format` to its last occurrence, rejecting any invalid occurrence first.
 *
 * Yargs runs `coerce` *before* `choices` validation, so collapsing unconditionally would let
 * `--format bogus --format json` succeed while `--format json --format bogus` still failed. Every
 * occurrence is validated here so both orderings are rejected alike.
 *
 * The return type is deliberately the bare {@link Format}: yargs derives the option's type from
 * this signature, and a `Format | undefined` here would silently weaken every `argv.format`
 * comparison site and defeat any future exhaustiveness check.
 *
 * @param arg - Parsed `--format` value, an array if the flag was given more than once.
 * @returns The effective (last) format.
 */
export function coerceFormat(arg: Format | Format[]): Format {
  if (!Array.isArray(arg)) return arg
  return arg.find((value) => !FORMATS.includes(value)) ?? lastIfRepeated(arg) ?? Format.pretty
}

/**
 * Shorthand flags rewritten by {@link preprocessArgv} into the canonical `--opt=value` form.
 * A Map, not an object literal: argv holds arbitrary user input, and a plain-object lookup would
 * resolve inherited keys (`toString`, `constructor`, …) to `Object.prototype` members.
 */
const FLAG_REWRITES = new Map<string, string>([
  ['--no-api', '--api=false'],
  ['--json', '--format=json'],
  ['--no-estimate-gas-limit', '--estimate-gas-limit=-100'],
])

/**
 * Expands the shorthand flags in {@link FLAG_REWRITES} into the canonical `--opt=value` form that
 * yargs parses, and appends `--no-interactive` when stdin is not a TTY.
 *
 * @param argv - Raw argv, without the node/script prefix.
 * @param isTty - Whether stdin is a TTY; defaults to the current process's stdin.
 * @returns The rewritten argv, with each shorthand emitted at most once.
 */
export function preprocessArgv(argv: string[], isTty = Boolean(process.stdin.isTTY)): string[] {
  // Everything after a `--` separator is the caller's positional payload, not our flags; rewriting
  // there would mangle their argument.
  const sep = argv.indexOf('--')
  const [head, tail] = sep === -1 ? [argv, []] : [argv.slice(0, sep), argv.slice(sep)]
  // Repeats are not dropped here: every option these expand to declares a collapsing `coerce`
  // (`--format` and `--api` in index.ts, `--estimate-gas-limit` in send.ts/manual-exec.ts), and
  // that layer also catches `--format json --format json`, which never reaches this function.
  const result = head.map((arg) => FLAG_REWRITES.get(arg) ?? arg)
  if (!isTty && !result.includes('--no-interactive')) result.push('--no-interactive')
  return [...result, ...tail]
}
