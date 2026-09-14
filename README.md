# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
review(cmd)
```

`review(cmd)` runs a Bash script and lets the user inspect or edit its generated output while the agent waits:

1. The script's combined output is captured as `original` under a temporary review directory.
2. The extension copies it to `reviewed`.
3. It opens `reviewed` directly in `$VISUAL`, falling back to `$EDITOR`, in a focused Herdr tab.
4. When the editor exits, the extension compares the two files and returns the result to the agent.

Like Pi's built-in Bash tool, capture has no automatic runtime or total-output limit; cancellation stops the command. Unlike Bash, `review` writes output to disk immediately so the editor can open the complete file. The 50 KiB / 2,000-line limit applies only to the returned diff, not the files on disk.

For successfully completed reviews, the original and reviewed outputs remain under `/tmp` whether or not the user changed anything, and the result always includes both paths. A unified diff is included when the files differ and truncated to 50 KiB or 2,000 lines when necessary; the result reports the exact number of bytes included. When the diff cannot be generated (missing, killed, or timed out), the result reports `unavailable` and still includes both paths. The agent can inspect the retained files or regenerate the complete diff. The extension does not clean up artifacts from successfully completed reviews; they remain subject to the operating system's normal `/tmp` cleanup.

Once the review tab has opened the editor, a failure or cancellation keeps the original and reviewed files and reports their paths; if the tab is still open, the error also names the tab ID so the user can finish or recover. Failures before the editor launches clean up their temporary files.

The script's exit code is reported with the review result. A non-zero exit does not prevent the review; a command killed by a signal is reported as its shell status, and a capture that never completes is reported as an error instead of a successful run. `$VISUAL` or `$EDITOR` must be a blocking editor command that does not return until the user finishes (for example, `code --wait`). `review` requires `$VISUAL` or `$EDITOR` and fails outside interactive Pi sessions running in Herdr.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
