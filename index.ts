import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ShowDetails {
  file: string;
  paneId?: string;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "show",
    label: "Show",
    description: "Present an existing file to the user. In Herdr, opens it in a focused, zoomed pager pane. Otherwise returns its absolute path.",
    promptSnippet: "Present a file to the user",
    promptGuidelines: [
      "Use show when you want the user to look at a file; do not tell the user to open it manually.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File to present, relative to the working directory or absolute" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params.file.startsWith("@") ? params.file.slice(1) : params.file;
      const file = resolve(ctx.cwd, input);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`Not a file: ${file}`);

      const pane = process.env.HERDR_PANE_ID;
      if (process.env.HERDR_ENV !== "1" || !pane) {
        return {
          content: [{ type: "text", text: `Could not open a viewer outside Herdr. File: ${file}` }],
          details: { file } satisfies ShowDetails,
        };
      }

      const herdr = process.env.HERDR_BIN_PATH || "herdr";
      const split = await pi.exec(
        herdr,
        ["pane", "split", "--pane", pane, "--direction", "right", "--cwd", dirname(file), "--focus"],
        { signal, timeout: 5000 },
      );

      if (split.code !== 0) {
        return {
          content: [{ type: "text", text: `Herdr could not open a viewer. File: ${file}` }],
          details: { file } satisfies ShowDetails,
        };
      }

      const paneId = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
      const zoom = await pi.exec(herdr, ["pane", "zoom", "--pane", paneId, "--on"], {
        signal,
        timeout: 5000,
      });
      const command = `less -R -- ${quote(file)}; ${quote(herdr)} pane zoom --current --off; exit`;
      const run = zoom.code === 0
        ? await pi.exec(herdr, ["pane", "run", paneId, command], { signal, timeout: 5000 })
        : zoom;

      if (run.code !== 0) {
        await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5000 });
        return {
          content: [{ type: "text", text: `Herdr could not open a viewer. File: ${file}` }],
          details: { file } satisfies ShowDetails,
        };
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
      if (details.paneId) {
        return new Text(theme.fg("success", "Viewer opened — press q to return"), 0, 0);
      }
      return new Text(theme.fg("warning", `Viewer unavailable — ${details.file}`), 0, 0);
    },
  });
}
