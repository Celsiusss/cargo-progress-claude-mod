# cargo-progress

A Claude Code mod that shows cargo's progress bar under a running cargo command, instead of a line per crate, and leaves a short result note when the command finishes.

![cargo build, check, clippy and test with the progress bar and result notes](assets/demo.gif)

> [!NOTE]
> The mod wraps cargo commands in a small shell function, so permission prompts for them show the longer wrapped command.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cargo-progress --marketplace Celsiusss/cargo-progress-claude-mod
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install cargo-progress --marketplace Celsiusss/cargo-progress-claude-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Celsiusss/cargo-progress-claude-mod`, then Add plugin.

To run it from a local checkout instead:

```
claude --plugin-dir /path/to/cargo-progress-claude-mod
```

## Usage

It works on any cargo command Claude runs through the Bash tool, including piped ones like `cargo test 2>&1 | tail -60`; the notes still count everything. Claude reads cargo's normal output, minus the progress bar's frames, with the same exit code.

## Requirements

- `perl` on the `PATH` (without it, cargo runs as usual and no bar is shown)
- A POSIX shell (bash or zsh)

## How it works

The mod puts a one-line `cargo` shell function in front of the command. The function runs `bin/cargo-progress`, which starts cargo through `bin/cargo-progress.pl` with its bar forced on; that script passes cargo's output through and records the latest frame and the results in a temporary file. The mod reads that file and draws the bar and the notes. For a command Claude runs in the background, such as `cargo run` starting a server, the bar shows above the prompt until cargo has finished compiling. Cargo called by path is left alone.

## What the mod does on your machine

- **Changes Bash commands that call `cargo`.** Before such a command runs, the mod puts one line in front of it, `cargo() (exec sh <mod>/bin/cargo-progress <temp file> "$@")`, so `cargo` runs through the mod's scripts. Claude's own command follows unchanged. Other Bash commands are passed on untouched.
- **Starts these programs:** `sh`, running the mod's own `bin/cargo-progress`, which runs `perl` with `bin/cargo-progress.pl` (or plain `cargo` where perl is missing), which in turn runs the `cargo` command Claude asked for; and `rm -f` on the mod's temporary file once the command has finished.
- **Reads** only that temporary file, `$TMPDIR/cargo-progress-<call id>` (or under `/tmp`), which holds the latest progress frame and the result counts. It reads `TMPDIR` to find it.
- **Sends nothing anywhere.** The mod makes no network calls; the bar and the notes are drawn locally in your terminal.
- **Permission checks.** Because the command that runs is the wrapped one, the mod also asks Claude Code's permission check about the command Claude wrote. If your rules deny that command, the mod denies the call; otherwise the usual permission check decides on the wrapped command. The mod never allows a call itself.

## License

CC0 1.0, see [LICENSE](LICENSE).
