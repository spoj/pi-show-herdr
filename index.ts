import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ShowDetails {
  file: string;
  paneId: string;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const viewer = (file: string) =>
  `if command -v yazi >/dev/null 2>&1; then yazi ${quote(file)}; ` +
  `elif command -v bat >/dev/null 2>&1; then bat --paging=always --style=plain --color=always -- ${quote(file)}; ` +
  `elif command -v batcat >/dev/null 2>&1; then batcat --paging=always --style=plain --color=always -- ${quote(file)}; ` +
  `else less -R -- ${quote(file)}; fi`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "show",
    label: "Show",
    description: "Present an existing file to the user in a focused, zoomed Herdr viewer pane. Uses Yazi when available for text and multimedia previews. Fails outside interactive Pi sessions running in Herdr.",
    promptSnippet: "Present a file to the user",
    promptGuidelines: [
      "Use show when you want the user to look at a file; do not tell the user to open it manually.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File to present, relative to the working directory or absolute" }),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error(`show requires interactive TUI mode; current mode is ${ctx.mode}`);
      const pane = process.env.HERDR_PANE_ID;
      if (process.env.HERDR_ENV !== "1" || !pane) throw new Error("show requires Herdr");

      const input = params.file.startsWith("@") ? params.file.slice(1) : params.file;
      const file = resolve(ctx.cwd, input);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`Not a file: ${file}`);

      const herdr = process.env.HERDR_BIN_PATH || "herdr";
      const split = await pi.exec(
        herdr,
        ["pane", "split", "--pane", pane, "--direction", "right", "--cwd", dirname(file), "--focus"],
        { signal, timeout: 5000 },
      );
      if (split.code !== 0) throw new Error("Herdr could not create a viewer pane");

      const paneId = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
      const zoom = await pi.exec(herdr, ["pane", "zoom", "--pane", paneId, "--on"], {
        signal,
        timeout: 5000,
      });
      const command = `${viewer(file)}; ${quote(herdr)} pane zoom --current --off; exit`;
      const run = zoom.code === 0
        ? await pi.exec(herdr, ["pane", "run", paneId, command], { signal, timeout: 5000 })
        : zoom;

      if (run.code !== 0) {
        await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5000 });
        throw new Error("Herdr could not launch the viewer");
      }
      return {
        content: [{ type: "text", text: `Showing ${file} in Herdr. The user can press q to return.` }],
        details: { file, paneId } satisfies ShowDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("show ")) + theme.fg("muted", basename(args.file)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as ShowDetails | undefined;
      if (!details) return new Text("", 0, 0);
      return new Text(theme.fg("success", "Viewer opened — press q to return"), 0, 0);
    },
  });
}
