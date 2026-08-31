# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
show(file)
```

`show` opens the file in a focused, zoomed Herdr pane and chooses a preview from available command-line programs:

- text: `bat`, `batcat`, or `less`
- images: `chafa` or `img2txt`
- PDFs: `pdftoppm` plus an image renderer, or `pdftotext`
- video: `ffmpeg` poster frame, or metadata
- audio: `mediainfo` or `ffprobe`
- other files: type information and a short hex dump

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
