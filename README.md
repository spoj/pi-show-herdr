# pi-show

A Pi extension with one tool:

```text
show(file)
```

When Pi runs in Herdr, `show` opens the file in a new pane, focuses and zooms that pane, and starts `less`. Press `q` to close the viewer and return to the original layout.

Outside Herdr, the tool falls back to reporting the file's absolute path.

## Install

```bash
pi install /absolute/path/to/pi-show
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show
```
