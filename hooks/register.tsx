import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, Timer } from 'claude-code'

import type { CargoProgress, CargoResult } from '../types'
import {
  cargoLabel,
  describeResult,
  drawBar,
  isCargoCommand,
  parseFrame,
  parseResults,
  wrapCommand,
} from './progress'

const runs = atom({ plugin: 'cargo-progress', key: 'runs' } as const, {})
const results = atom({ plugin: 'cargo-progress', key: 'results' } as const, {})
const background = atom(
  { plugin: 'cargo-progress', key: 'background' } as const,
  {},
)

const POLL_MS = 50
const KEPT_RESULTS = 50
// A background command that has finished compiling may be about to exit and
// leave its results; past this wait, what it started is taken to be running.
const SETTLE_MS = 2000
// A progress file this long unchanged belongs to a cargo that was killed
// before it could clean up.
const STALE_MS = 10 * 60 * 1000

const TONE_COLOR = { ok: 'green', warning: 'yellow', error: 'red' } as const

const originals = new Map<string, string>()
const lastFrames = new Map<string, string>()

type Watch = {
  timer: Timer
  hasStarted: boolean
  changedAt: number
  compiledAt: number | null
}
const watches = new Map<string, Watch>()

async function poll($: EngineInterface, id: string, file: string) {
  let frame: string
  try {
    frame = await $.fs.read(file)
  } catch {
    return
  }

  // Only a new frame is worth a redraw.
  if (frame === lastFrames.get(id)) {
    return
  }
  lastFrames.set(id, frame)

  if (!originals.has(id)) {
    return
  }

  // An empty frame is cargo done compiling while what it started still runs.
  const progress = parseFrame(frame)
  await update($, runs, ({ [id]: _, ...rest }) =>
    progress ? { ...rest, [id]: progress } : rest,
  )
}

async function keepResults(
  $: EngineInterface,
  id: string,
  found: CargoResult[],
) {
  if (found.length) {
    await update($, results, all =>
      Object.fromEntries(
        [...Object.entries(all), [id, found] as const].slice(-KEPT_RESULTS),
      ),
    )
  }
}

async function collectResults($: EngineInterface, id: string, file: string) {
  let found: CargoResult[]
  try {
    found = parseResults(await $.fs.read(file))
  } catch {
    return
  }

  await $.process.run(['rm', '-f', file])
  await keepResults($, id, found)
}

async function stopWatching(
  $: EngineInterface,
  id: string,
  file: string,
  found: CargoResult[],
) {
  const watch = watches.get(id)
  if (!watch) {
    return
  }

  watch.timer.cancel()
  watches.delete(id)
  lastFrames.delete(id)
  await update($, runs, ({ [id]: _, ...rest }) => rest)
  await update($, background, ({ [id]: _, ...rest }) => rest)
  // A file with results is complete; one without may still be the script's,
  // which removes it when cargo exits.
  if (found.length) {
    await $.process.run(['rm', '-f', file])
    await keepResults($, id, found)
  }
}

// A background call returns as soon as it has started, so its file is
// watched on until cargo is done compiling, or done altogether.
async function pollBackground($: EngineInterface, id: string, file: string) {
  const watch = watches.get(id)
  if (!watch) {
    return
  }

  const now = await $.clock.now()
  let frame: string | null
  try {
    frame = await $.fs.read(file)
  } catch {
    frame = null
  }

  if (frame === null) {
    if (watch.hasStarted || now - watch.changedAt > STALE_MS) {
      await stopWatching($, id, file, [])
    }
    return
  }

  const found = parseResults(frame)
  if (found.length) {
    await stopWatching($, id, file, found)
    return
  }

  if (frame !== lastFrames.get(id)) {
    lastFrames.set(id, frame)
    watch.hasStarted = true
    watch.changedAt = now
    const progress = parseFrame(frame)
    await update($, runs, ({ [id]: _, ...rest }) =>
      progress ? { ...rest, [id]: progress } : rest,
    )
  }

  if (frame.trim() === '') {
    watch.compiledAt ??= now
    if (now - watch.compiledAt > SETTLE_MS) {
      await stopWatching($, id, file, [])
    }
  } else if (now - watch.changedAt > STALE_MS) {
    await stopWatching($, id, file, [])
  }
}

const isBackground = (input: unknown) =>
  (input as { run_in_background?: unknown } | null)?.run_in_background === true

type Ui = Pick<ElementTable, 'Box' | 'Text'>

function ProgressLine(
  { Text }: Ui,
  progress: CargoProgress,
  columns: number,
  prefix?: string,
) {
  const width = Math.max(10, Math.min(40, columns - 40))
  const count =
    progress.done != null ? ` ${progress.done}/${progress.total}` : ''
  const detail = progress.detail
    ? `${count ? ':' : ''} ${progress.detail}`
    : ''

  return (
    <Text wrap="truncate">
      {prefix && <Text dimColor>{prefix}</Text>}
      {progress.label && (
        <Text color="cyan" bold>
          {`${progress.label} `}
        </Text>
      )}
      {`[${drawBar(progress.ratio, width)}]${count}`}
      <Text dimColor>{detail}</Text>
    </Text>
  )
}

function annotate(
  ui: Ui,
  drawn: JSX.Element,
  columns: number,
  progress: CargoProgress | undefined,
  finished: readonly CargoResult[],
) {
  const { Box, Text } = ui
  const labelWidth =
    Math.max(0, ...finished.map(result => `cargo ${result.command}`.length)) + 2

  return (
    <Box flexDirection="column">
      {drawn}
      {progress && (
        <Box paddingLeft={2}>{ProgressLine(ui, progress, columns)}</Box>
      )}
      {finished.map(result => {
        const { tone, text } = describeResult(result)

        return (
          <Box paddingLeft={2}>
            <Text wrap="truncate">
              <Text dimColor>{`cargo ${result.command}`.padEnd(labelWidth)}</Text>
              <Text color={TONE_COLOR[tone]}>{text}</Text>
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    if (!id || !isCargoCommand(e.command)) {
      return next(e)
    }

    const isBackground = e.run_in_background === true
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const file = `${tmp}/cargo-progress-${id.replace(/[^\w-]/g, '')}`
    originals.set(id, e.command)
    const timer = $.clock.every(POLL_MS, () =>
      void (isBackground ? pollBackground($, id, file) : poll($, id, file)),
    )
    if (isBackground) {
      const now = await $.clock.now()
      watches.set(id, { timer, hasStarted: false, changedAt: now, compiledAt: null })
      await update($, background, all => ({ ...all, [id]: cargoLabel(e.command) }))
    }

    try {
      const script = `${$.plugin.root}/bin/cargo-progress`

      return await next({ ...e, command: wrapCommand(e.command, file, script) })
    } finally {
      originals.delete(id)
      if (isBackground && !next.signal.aborted) {
        // The command keeps running; pollBackground takes it from here.
      } else if (isBackground) {
        await stopWatching($, id, file, []).catch(() => undefined)
      } else {
        timer.cancel()
        lastFrames.delete(id)
        await update($, runs, ({ [id]: _, ...rest }) => rest)
        // An interrupted call refuses further calls on `$`, and what cargo got
        // through before it stopped is no result to report.
        if (!next.signal.aborted) {
          await collectResults($, id, file).catch(() => undefined)
        }
      }
    }
  }).catch(($, e, next) => next(e))

  // The check's input is pinned to the wrapped command, which a rule written
  // for the command Claude wrote may not match. A deny for that command still
  // stands; anything else goes on to the usual check of the wrapped command, so
  // the mod never grants a call itself.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const original = e.tool_use_id && originals.get(e.tool_use_id)
    if (!original) {
      return next(e)
    }

    const verdict = await $.tool.check({
      tool: 'Bash',
      input: { ...(e.input as object), command: original },
    })
    if (verdict.decision === 'deny') {
      return {
        decision: 'deny',
        reason: 'A permission rule denies this cargo command.',
      }
    }

    return next(e)
  })

  // Shell commands usually fold into a group line (`Ran 2 shell commands`);
  // its own row only shows when the group is expanded.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) {
      return next(e)
    }

    const live = await read($, runs)
    const done = await read($, results)
    const elsewhere = await read($, background)
    const calls = e.props.calls.flatMap(call =>
      call.tool === 'Bash' && call.tool_use_id
        ? [{ id: call.tool_use_id, isBackground: isBackground(call.input) }]
        : [],
    )
    const progress = calls
      .map(call => (elsewhere[call.id] ? undefined : live[call.id]))
      .find(Boolean)
    const finished = calls.flatMap(call =>
      call.isBackground ? [] : (done[call.id] ?? []),
    )
    const drawn = await next(e)
    if (!progress && finished.length === 0) {
      return drawn
    }

    const columns = e.viewport?.columns ?? 80

    return annotate($.ui.resolve(e), drawn, columns, progress, finished)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash') {
      return next(e)
    }

    const id = e.props.tool_use_id
    const progress = e.props.isRunning ? (await read($, runs))[id] : undefined
    const finished = isBackground(e.props.input)
      ? []
      : ((await read($, results))[id] ?? [])
    const drawn = await next(e)
    if (!progress && finished.length === 0) {
      return drawn
    }

    const columns = e.viewport?.columns ?? 80

    return annotate($.ui.resolve(e), drawn, columns, progress, finished)
  })

  // A background call's results go under the notification that says it has
  // finished, which names the call that started it, not under the call's row.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const id = e.props.task?.toolUseId
    if (!id) {
      return next(e)
    }

    const finished = (await read($, results))[id] ?? []
    const drawn = await next(e)
    if (finished.length === 0) {
      return drawn
    }

    const columns = e.viewport?.columns ?? 80

    return annotate($.ui.resolve(e), drawn, columns, undefined, finished)
  })

  // A background call has no running row to draw under, so its bar goes in the
  // band above the prompt until cargo is done compiling.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const live = await read($, runs)
    const shown = Object.entries(await read($, background)).flatMap(
      ([id, label]) => {
        const progress = live[id]

        return progress ? [{ id, label, progress }] : []
      },
    )
    if (shown.length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    const labelWidth = Math.max(...shown.map(run => run.label.length)) + 2

    return (
      <Box flexDirection="column">
        {shown.map(run => (
          <Box key={run.id}>
            {ProgressLine(
              ui,
              run.progress,
              e.props.bodyColumns,
              `${run.label} (background)`.padEnd(labelWidth + 13),
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
