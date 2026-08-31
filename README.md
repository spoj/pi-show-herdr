# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
show(file)
```

`show` opens the file in a focused, zoomed Herdr pane. It uses Yazi when available, giving images, PDFs, audio, video, archives, and text the preview behavior configured on the user's machine. Without Yazi it falls back to `bat`, `batcat`, or `less`.

Press `q` to close the viewer and restore the original layout. The tool fails outside interactive Pi sessions running in Herdr.

## Image previews

Herdr's Kitty graphics support is experimental and must be enabled when the outer terminal supports it:

```toml
[experimental]
kitty_graphics = true
```

Reload the Herdr config, detach, and reattach before reopening Yazi. Yazi can fall back to character-art previews when `chafa` is installed.

Check Yazi's selected image adapter with:

```bash
yazi --debug
```

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
