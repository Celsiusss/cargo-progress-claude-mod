export type CargoProgress = {
  label: string
  ratio: number
  done: number | null
  total: number | null
  detail: string
}

export type TestSummary = {
  passed: number
  failed: number
  ignored: number
  failures: string[]
}

export type BuildSummary = {
  errors: number
  lintErrors: number
  warnings: number
  seconds: number | null
}

/** One line of what a cargo invocation reported, led by its subcommand. */
export type CargoResult =
  | { command: string; build: BuildSummary }
  | { command: string; tests: TestSummary }

declare module 'claude-code' {
  interface PluginState {
    'cargo-progress': {
      runs: Record<string, CargoProgress>
      results: Record<string, CargoResult[]>
    }
  }
}
