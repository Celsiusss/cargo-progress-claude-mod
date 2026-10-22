import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { CargoProgress, CargoResult } from '../types'
import {
  describeResult,
  drawBar,
  isCargoCommand,
  parseFrame,
  parseResults,
  wrapCommand,
} from './progress'

const runs = atom({ plugin: 'cargo-progress', key: 'runs' } as const, {})
const results = atom({ plugin: 'cargo-progress', key: 'results' } as const, {})

const POLL_MS = 50
const KEPT_RESULTS = 50

const TONE_COLOR = { ok: 'green', warning: 'yellow', error: 'red' } as const

const originals = new Map<string, string>()
const lastFrames = new Map<string, string>()

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

  const progress = parseFrame(frame)
  if (progress && originals.has(id)) {
    await update($, runs, all => ({ ...all, [id]: progress }))
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
  if (found.length) {
    await update($, results, all =>
      Object.fromEntries(
        [...Object.entries(all), [id, found] as const].slice(-KEPT_RESULTS),
      ),
    )
  }
}

type Ui = Pick<ElementTable, 'Box' | 'Text'>

function annotate(
  { Box, Text }: Ui,
  drawn: JSX.Element,
  columns: number,
  progress: CargoProgress | undefined,
  finished: readonly CargoResult[],
) {
  const width = Math.max(10, Math.min(40, columns - 40))
  const count =
    progress?.done != null ? ` ${progress.done}/${progress.total}` : ''
  const detail = progress?.detail
    ? `${count ? ':' : ''} ${progress.detail}`
    : ''
  const labelWidth =
    Math.max(0, ...finished.map(result => `cargo ${result.command}`.length)) + 2

  return (
    <Box flexDirection="column">
      {drawn}
      {progress && (
        <Box paddingLeft={2}>
          <Text wrap="truncate">
            {progress.label && (
              <Text color="cyan" bold>
                {`${progress.label} `}
              </Text>
            )}
            {`[${drawBar(progress.ratio, width)}]${count}`}
            <Text dimColor>{detail}</Text>
          </Text>
        </Box>
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
    if (!id || e.run_in_background || !isCargoCommand(e.command)) {
      return next(e)
    }

    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const file = `${tmp}/claude-cargo-progress-${id.replace(/[^\w-]/g, '')}`
    originals.set(id, e.command)
    const timer = $.clock.every(POLL_MS, () => void poll($, id, file))

    try {
      const script = `${$.plugin.root}/bin/cargo-progress.pl`

      return await next({ ...e, command: wrapCommand(e.command, file, script) })
    } finally {
      timer.cancel()
      originals.delete(id)
      lastFrames.delete(id)
      await update($, runs, ({ [id]: _, ...rest }) => rest)
      // An interrupted call refuses further calls on `$`, and what cargo got
      // through before it stopped is no result to report.
      if (!next.signal.aborted) {
        await collectResults($, id, file).catch(() => undefined)
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
    const ids = e.props.calls.flatMap(call =>
      call.tool === 'Bash' && call.tool_use_id ? [call.tool_use_id] : [],
    )
    const progress = ids.map(id => live[id]).find(Boolean)
    const finished = ids.flatMap(id => done[id] ?? [])
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
    const finished = (await read($, results))[id] ?? []
    const drawn = await next(e)
    if (!progress && finished.length === 0) {
      return drawn
    }

    const columns = e.viewport?.columns ?? 80

    return annotate($.ui.resolve(e), drawn, columns, progress, finished)
  })
}
