# pi-show

A Pi extension with one tool:

```text
show(file)
```

When Pi runs in Herdr, `show` opens the file in a new pane, focuses and zooms that pane, and starts a pager. Press `q` to close the viewer and return to the original layout.

Outside Herdr, `show` temporarily suspends Pi's TUI and opens the pager in the current terminal. It uses `bat` when available and falls back to `less`.

The tool fails in print, JSON, and RPC modes so agents and automations cannot mistake an undisplayed file for a successful presentation.

## Install

```bash
pi install /absolute/path/to/pi-show
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show
```
