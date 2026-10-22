import { expect, test } from 'claude-code/testing'

import { describeResult, drawBar, parseFrame, parseResults } from '../hooks/progress'

test('a cargo command runs wrapped, and is checked as written too', async ($, on) => {
  let ran = ''
  const checked: string[] = []
  on('env.get', () => ({ value: '/tmp/x' }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', (_, e) => {
    ran = e.tool === 'Bash' ? e.command : ''

    return { result: {} }
  })
  on('tool.check', (_, e) => {
    checked.push((e.input as { command: string }).command)

    return { decision: 'allow' }
  })

  await $.tool.call({ tool: 'Bash', command: 'cargo build --release' })

  expect(ran).toMatch(/^cargo\(\) \{/)
  expect(ran).toMatch(/CARGO_TERM_PROGRESS_WHEN=always/)
  expect(ran.endsWith('\ncargo build --release')).toBe(true)
  expect(checked).toContain('cargo build --release')
})

test('a rule denying the command as written denies the wrapped call', async ($, on) => {
  let ran = false
  on('env.get', () => ({ value: '/tmp/x' }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => {
    ran = true

    return { result: {} }
  })
  on('tool.check', (_, e) => ({
    decision: (e.input as { command: string }).command === 'cargo publish' ? 'deny' : 'allow',
  }))

  const result = await $.tool.call({ tool: 'Bash', command: 'cargo publish' })

  expect(ran).toBe(false)
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/denied by plugin cargo-progress/)
})

test('other commands run untouched', async ($, on) => {
  let ran = ''
  on('tool.call', (_, e) => {
    ran = e.tool === 'Bash' ? e.command : ''

    return { result: {} }
  })

  await $.tool.call({ tool: 'Bash', command: 'ls cargo-lock' })

  expect(ran).toBe('ls cargo-lock')
})

test('a finished run leaves its build and test notes under its row', async ($, on) => {
  let id = ''
  on('env.get', () => ({ value: '/tmp/x' }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.read', () => ({
    value: 'Build\tclippy\t0\t2\t1\t3.25\nTests\ttest\t9\t1\t1\ttests::t6\n',
  }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_, e) => {
    id = e.tool_use_id ?? ''

    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.tool.call({ tool: 'Bash', command: 'cargo test 2>&1 | tail -60' })

  const ui = await $.ui.mount({
    plugin: 'cargo-progress',
    component: 'ToolUse',
    surface: 'terminal',
    props: {
      tool_use_id: id,
      tool: 'Bash',
      input: { command: 'cargo test 2>&1 | tail -60' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  const build = await ui.find({ type: 'Text', text: /^cargo clippy/ })
  expect(build?.text).toBe('cargo clippy  ✗ 2 lint errors, 1 warning · 3.3s')
  const tests = await ui.find({ type: 'Text', text: /^cargo test/ })
  expect(tests?.text).toBe('cargo test    ✗ 9 passed · 1 failed: tests::t6 · 1 ignored')
  await ui.unmount()
})

test('a cargo frame parses into a bar', () => {
  const frame = parseFrame('    Building [=====>      ] 3/5: a, e      ')

  expect(frame).toEqual({ label: 'Building', ratio: 0.6, done: 3, total: 5, detail: 'a, e' })
  expect(drawBar(0.5, 10)).toBe('====>     ')
  expect(drawBar(1, 4)).toBe('====')
  expect(parseFrame('[=====>      ]  50.00%')?.ratio).toBe(0.5)
  expect(parseFrame('   Compiling serde v1.0.0')).toBe(null)
})

test('build results tell compile errors, lint errors and warnings apart', () => {
  const build = { errors: 2, lintErrors: 1, warnings: 1, seconds: null }
  expect(describeResult({ command: 'check', build }).text).toBe('✗ 2 errors, 1 lint error, 1 warning')
  expect(describeResult({ command: 'check', build: { ...build, errors: 0, lintErrors: 0, warnings: 0, seconds: 8.21 } }).text).toBe('✓ clean · 8.2s')
  expect(parseResults('Build\tcheck\t0\t0\t3\t\nBuild\tclippy\t0\t3\t0\t')).toEqual([
    { command: 'check', build: { errors: 0, lintErrors: 0, warnings: 3, seconds: null } },
    { command: 'clippy', build: { errors: 0, lintErrors: 3, warnings: 0, seconds: null } },
  ])
})
