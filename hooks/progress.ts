import type {
  BuildSummary,
  CargoProgress,
  CargoResult,
  TestSummary,
} from '../types'

const INVOKES_CARGO = /(^|[\s;&|(`])cargo(\s|$)/m

export const isCargoCommand = (command: string) => INVOKES_CARGO.test(command)

/** `cargo run` for a command that runs `cargo +nightly run --release`. */
export const cargoLabel = (command: string) => {
  const match = /(?:^|[\s;&|(`])cargo\s+(?:\+\S+\s+)?([a-z][\w-]*)/m.exec(command)

  return match ? `cargo ${match[1]}` : 'cargo'
}

// Quotes only what needs it: the permission prompt shows this line, and plain
// paths read more easily there.
const quote = (text: string) =>
  /^[\w./+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`

// Cargo only draws its bar on a TTY; `script` forces it on and runs cargo
// through a filter that strips the bar's frames from its output and keeps the
// latest one in `file`. The function's body is a subshell, not a `{ }` group,
// which the permission check reads as possible obfuscation once it holds
// quotes.
export const wrapCommand = (command: string, file: string, script: string) =>
  `cargo() (exec sh ${quote(script)} ${quote(file)} "$@")\n${command}`

export const parseResults = (text: string): CargoResult[] =>
  text.split('\n').flatMap((line): CargoResult[] => {
    const [tag, command = '', ...fields] = line.trimEnd().split('\t')
    if (tag === 'Tests') {
      const [passed, failed, ignored, ...failures] = fields
      const tests = {
        passed: Number(passed),
        failed: Number(failed),
        ignored: Number(ignored),
        failures,
      }

      return [{ command, tests }]
    }
    if (tag === 'Build') {
      const [errors, lintErrors, warnings, seconds] = fields
      const build = {
        errors: Number(errors),
        lintErrors: Number(lintErrors),
        warnings: Number(warnings),
        seconds: seconds ? Number(seconds) : null,
      }

      return [{ command, build }]
    }

    return []
  })

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`

const describeBuild = (build: BuildSummary) => {
  const time = build.seconds === null ? '' : ` · ${build.seconds.toFixed(1)}s`
  const counts = [
    build.errors ? plural(build.errors, 'error') : '',
    build.lintErrors ? plural(build.lintErrors, 'lint error') : '',
    build.warnings ? plural(build.warnings, 'warning') : '',
  ].filter(Boolean)

  if (build.errors || build.lintErrors) {
    return { tone: 'error', text: `✗ ${counts.join(', ')}${time}` } as const
  }
  if (build.warnings) {
    return { tone: 'warning', text: `⚠ ${counts.join(', ')}${time}` } as const
  }

  return { tone: 'ok', text: `✓ clean${time}` } as const
}

const describeTests = (summary: TestSummary) => {
  const shown = summary.failures.slice(0, 3).join(', ')
  const more = summary.failures.length > 3 ? ', …' : ''
  const parts = [`${summary.passed} passed`]
  if (summary.failed) {
    parts.push(`${summary.failed} failed${shown ? `: ${shown}${more}` : ''}`)
  }
  if (summary.ignored) {
    parts.push(`${summary.ignored} ignored`)
  }

  const tone = summary.failed ? 'error' : 'ok'

  return { tone, text: `${summary.failed ? '✗' : '✓'} ${parts.join(' · ')}` } as const
}

export const describeResult = (result: CargoResult) =>
  'build' in result ? describeBuild(result.build) : describeTests(result.tests)

export const parseFrame = (frame: string): CargoProgress | null => {
  // `cargo clean` draws its bar with no label in front.
  const match = /^(?:(\w+) )?\[([=> ]*)\] *(.*)$/.exec(frame.trim())
  if (!match) {
    return null
  }

  const [, label = '', bar = '', rest = ''] = match
  const counted = /^(\d+)\/(\d+)(?::\s*(.*))?$/.exec(rest)
  const filled = bar.replace(/ /g, '').length
  const done = counted ? Number(counted[1]) : null
  const total = counted ? Number(counted[2]) : null
  const ratio =
    done !== null && total ? done / total : bar.length ? filled / bar.length : 0

  return {
    label,
    ratio: Math.min(1, Math.max(0, ratio)),
    done,
    total,
    detail: counted ? (counted[3] ?? '') : rest,
  }
}

export const drawBar = (ratio: number, width: number) => {
  const filled = Math.round(ratio * width)

  if (filled >= width) {
    return '='.repeat(width)
  }

  return `${'='.repeat(Math.max(0, filled - 1))}${filled > 0 ? '>' : ''}${' '.repeat(width - Math.max(filled, 0))}`
}
