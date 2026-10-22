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

The mod puts a `cargo` shell function in front of the command. The function runs `bin/cargo-progress.pl`, which starts cargo with its bar forced on, passes its output through and records the latest frame and the results in a temporary file. The mod reads that file and draws the bar and the notes. Commands run in the background, and cargo called by path, are left alone.

## What the mod does on your machine

- **Changes Bash commands that call `cargo`.** Before such a command runs, the mod puts a `cargo` shell function in front of it, so `cargo` runs through `bin/cargo-progress.pl`. Claude's own command follows unchanged. Other Bash commands, and cargo commands run in the background, are passed on untouched.
- **Starts these programs:** `perl`, running the mod's own `bin/cargo-progress.pl`, which in turn runs the `cargo` command Claude asked for; and `rm -f` on the mod's temporary file once the command has finished.
- **Reads** only that temporary file, `$TMPDIR/claude-cargo-progress-<call id>` (or under `/tmp`), which holds the latest progress frame and the result counts. It reads `TMPDIR` to find it.
- **Sends nothing anywhere.** The mod makes no network calls; the bar and the notes are drawn locally in your terminal.
- **Permission checks.** Because the command that runs is the wrapped one, the mod also asks Claude Code's permission check about the command Claude wrote. If your rules deny that command, the mod denies the call; otherwise the usual permission check decides on the wrapped command. The mod never allows a call itself.

## License

CC0 1.0, see [LICENSE](LICENSE).
