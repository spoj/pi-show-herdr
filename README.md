# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
review(file)
```

`review(file)` lets the user inspect or edit an isolated copy of a file while the agent waits:

1. The extension creates an original snapshot and a working copy under `/tmp`.
2. It opens the working copy with `less` in a focused, zoomed Herdr pane.
3. In `less`, `v` opens the working copy in `$VISUAL` or `$EDITOR`.
4. When the user presses `q`, the extension compares the working copy with the snapshot and returns the result to the agent. The original file is never modified.

If nothing changed, the temporary files are removed immediately. If the user made changes, the original snapshot and edited copy remain available while the agent reconciles them with any concurrent changes to the real file. A short diff is also returned inline; a large diff is available by path. Changed review files are removed when the agent settles. Session shutdown provides a second cleanup path; files left by an abrupt process termination remain subject to the operating system's normal `/tmp` cleanup.

The diff is against the startup snapshot, not against concurrent changes to the original. The agent must apply it against the current file accordingly.

`less` is required. If available, `bat` or `batcat` provides syntax highlighting through `less`. The tool fails outside interactive Pi sessions running in Herdr.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
