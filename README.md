# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
review(path)
```

`review(path)` lets the user inspect or edit a copy of a text file:

1. The source file is copied to `original` under a temporary review directory.
2. The extension copies that snapshot to `reviewed`.
3. It opens `reviewed` in `$VISUAL`, falling back to `$EDITOR`, in a focused Herdr tab.
4. When the editor exits, the extension compares the two copies and returns the result to the agent.

Paths may be absolute or relative to Pi's working directory. The source file is never modified. To review generated output, first use Bash to save it to a file, then call `review` with that path. Command execution, timeouts, and exit handling belong to Bash.

The original snapshot and reviewed copy remain under the operating system's temporary directory, whether or not the user changed anything, and the result always includes both paths. A unified diff is included when the files differ, truncated to 50 KiB or 2,000 lines when necessary. There is no file-size cap or time limit on human review. When the diff cannot be generated (missing, killed, or timed out), the result reports `unavailable` and still includes both paths. The agent can inspect the retained files or regenerate the complete diff. These files remain subject to normal operating-system temp cleanup.

Once the editor has launched, a failure or cancellation keeps both copies and reports their paths; if the tab is still open, the error also names its ID so the user can finish or recover. Failures before the editor launches clean up their temporary copies.

`$VISUAL` or `$EDITOR` must be a blocking editor command that does not return until the user finishes (for example, `nvim` or `code --wait`). `review` fails outside interactive Pi sessions running in Herdr. Only the model can call it; Pi's codemode scripts cannot.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
