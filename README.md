# pi-show-herdr

A Herdr-only Pi extension with one tool:

```text
show(file)
```

`show` opens the file in a focused, zoomed Herdr pane and selects a viewer from the commands available on the user's machine:

- text and code: `bat`, `batcat`, or `less`
- images: `chafa` or `img2txt`
- PDFs: first-page image via `pdftoppm`, or text via `pdftotext`
- video: poster frame via `ffmpeg`
- audio: metadata via `mediainfo` or `ffprobe`
- other files: type information and a short hex dump

Press `q` to close the viewer and restore the original layout. The tool fails outside interactive Pi sessions running in Herdr.

The system must provide `file` and `less`. Other viewers are optional; preview quality improves as more are available, and `chafa` is recommended for images.

## Image previews

The default image path uses terminal character graphics, which works without graphics-protocol passthrough. Herdr also has experimental Kitty graphics support for tools that emit that protocol:

```toml
[experimental]
kitty_graphics = true
```

After changing this setting, reload the Herdr config, detach, and reattach.

## Install

```bash
pi install /absolute/path/to/pi-show-herdr
```

For a one-off run:

```bash
pi -e /absolute/path/to/pi-show-herdr
```
