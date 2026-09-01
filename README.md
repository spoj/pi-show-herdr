# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
review(file)
```

`review(file)` lets the user inspect or edit an isolated copy of a file while the agent waits:

1. The extension creates an original snapshot and a working copy under `/tmp`.
2. It opens the working copy with `less` in a focused, zoomed Herdr pane.
3. In `less`, `v` opens the working copy in `$VISUAL` or `$EDITOR`.
4. When the user presses `q`, the extension checks whether the working copy changed. The original file is never modified.

If nothing changed, the temporary files are removed immediately. If the user made changes, the extension returns paths to the original snapshot and reviewed copy. It deliberately does not generate a diff: the agent compares the two files itself, then reconciles the reviewed copy with any concurrent changes to the real file. The review files are removed when the agent settles. Session shutdown provides a second cleanup path; files left by an abrupt process termination remain subject to the operating system's normal `/tmp` cleanup.

`less` is required. If available, `bat` or `batcat` provides syntax highlighting through `less`. The tool fails outside interactive Pi sessions running in Herdr.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
