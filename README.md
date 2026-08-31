# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
show(file)
```

When `show(file)` starts, it creates an isolated snapshot and working copy under `/tmp`, then opens the working copy in a focused, zoomed Herdr pane with `less`:

1. The original file is copied to an `original-*` snapshot.
2. The snapshot is copied to a `working-*` file for the user to view.
3. In `less`, `v` opens the working copy in `$VISUAL` or `$EDITOR`; `show` never modifies the original file.
4. When the user presses `q`, the extension creates a unified diff between the snapshot and the final working copy and sends it to the agent. This is a diff against the startup snapshot, not against any concurrent changes made to the original.

If the diff is short, it is included in the message and also saved as `diff.patch`. If it is long, the message gives the agent paths to the retained original snapshot, final working copy, and complete diff. The agent can inspect and apply the changes or ask the user questions; `show` never applies them automatically. These temporary files are intentionally not cleaned up when the user is done.

If available, `bat` or `batcat` adds syntax highlighting through `less`; `cat` is the last-resort display fallback. The `bat` and `cat` fallbacks only display the file and do not provide editing. The tool fails outside interactive Pi sessions running in Herdr.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
