import { copyFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ShowDetails {
  file: string;
  paneId: string;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const maxInlineDiffChars = 10_000;

const viewer = `
file=$1

if command -v less >/dev/null 2>&1; then
  if command -v bat >/dev/null 2>&1; then
    LESSOPEN='|bat --style=plain --color=always -- %s' less -R -- "$file"
  elif command -v batcat >/dev/null 2>&1; then
    LESSOPEN='|batcat --style=plain --color=always -- %s' less -R -- "$file"
  else
    less -R -- "$file"
  fi
elif command -v bat >/dev/null 2>&1; then
  bat --paging=never --style=plain --color=always -- "$file"
elif command -v batcat >/dev/null 2>&1; then
  batcat --paging=never --style=plain --color=always -- "$file"
else
  cat -- "$file"
fi
`;

export default function (pi: ExtensionAPI) {
  const watchers = new Set<AbortController>();

  pi.on("session_shutdown", () => {
    for (const watcher of watchers) watcher.abort();
    watchers.clear();
  });

  pi.registerTool({
    name: "show",
    label: "Show",
    description: "Present an existing file in a focused, zoomed Herdr pane for viewing or editing with less. Fails outside interactive Pi sessions running in Herdr.",
    promptSnippet: "Present a file in Herdr for viewing or editing",
    promptGuidelines: [
      "Use show when you want the user to view or edit a file in Herdr; do not tell the user to open it manually.",
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

      const tempDir = await mkdtemp(join(tmpdir(), "pi-show-"));
      const originalCopy = join(tempDir, `original-${basename(file)}`);
      const workingCopy = join(tempDir, `working-${basename(file)}`);
      const diffFile = join(tempDir, "diff.patch");
      await copyFile(file, originalCopy);
      await copyFile(originalCopy, workingCopy);

      const herdr = process.env.HERDR_BIN_PATH || "herdr";
      const split = await pi.exec(
        herdr,
        ["pane", "split", "--pane", pane, "--direction", "right", "--cwd", dirname(workingCopy), "--focus"],
        { signal, timeout: 5000 },
      );
      if (split.code !== 0) throw new Error("Herdr could not create a viewer pane");

      const paneId = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
      const zoom = await pi.exec(herdr, ["pane", "zoom", "--pane", paneId, "--on"], {
        signal,
        timeout: 5000,
      });
      const command = `/bin/sh -c ${quote(viewer)} show ${quote(workingCopy)}; ${quote(herdr)} pane zoom --current --off; exit`;
      const run = zoom.code === 0
        ? await pi.exec(herdr, ["pane", "run", paneId, command], { signal, timeout: 5000 })
        : zoom;

      if (run.code !== 0) {
        await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5000 });
        throw new Error("Herdr could not launch the viewer");
      }
      const watcher = new AbortController();
      watchers.add(watcher);
      void (async () => {
        try {
          while (!watcher.signal.aborted) {
            await delay(500, undefined, { signal: watcher.signal });
            const pane = await pi.exec(herdr, ["pane", "get", paneId], {
              signal: watcher.signal,
              timeout: 5000,
            });
            if (pane.code !== 0) break;
          }
          if (watcher.signal.aborted) return;

          const diff = await pi.exec(
            "diff",
            [
              "-u",
              "--label",
              `original ${file}`,
              "--label",
              `edited copy ${file}`,
              originalCopy,
              workingCopy,
            ],
            { signal: watcher.signal, timeout: 30_000 },
          );
          await writeFile(diffFile, diff.stdout);

          let content: string;
          if (diff.code > 1) {
            content = `The user finished reviewing ${file} in Herdr, but the diff could not be generated. The show tool did not modify the original file.\n\nOriginal snapshot: ${originalCopy}\nFinal edited copy: ${workingCopy}\nDiff output: ${diffFile}\n\n${diff.stderr.trim()}`;
          } else if (diff.code === 0) {
            content = `The user finished reviewing ${file} in Herdr. No edits were made, and the show tool did not modify the original file.\n\nOriginal snapshot: ${originalCopy}\nFinal edited copy: ${workingCopy}\nDiff: ${diffFile}`;
          } else if (diff.stdout.length <= maxInlineDiffChars) {
            content = `The user finished reviewing ${file} in Herdr. The show tool did not modify the original file; the user edited an isolated copy.\n\nOriginal snapshot: ${originalCopy}\nFinal edited copy: ${workingCopy}\nDiff: ${diffFile}\n\nUnified diff:\n${diff.stdout}\n\nThe agent may apply the changes or ask the user questions.`;
          } else {
            content = `The user finished reviewing ${file} in Herdr. The diff is too long to include inline. The show tool did not modify the original file. The isolated review files were retained for inspection.\n\nOriginal snapshot: ${originalCopy}\nFinal edited copy: ${workingCopy}\nUnified diff: ${diffFile}\n\nRead those three files to inspect the changes. The agent may apply the changes or ask the user questions.`;
          }

          pi.sendMessage(
            { customType: "pi-show-herdr", content, display: true },
            { deliverAs: "steer", triggerTurn: true },
          );
        } catch {
          return;
        } finally {
          watchers.delete(watcher);
        }
      })();

      return {
        content: [{ type: "text", text: `Showing an isolated copy of ${file} in Herdr. The user can press v to edit the copy and q to return; the show tool will not modify the original.` }],
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
      return new Text(theme.fg("success", "Isolated copy opened — press q to return"), 0, 0);
    },
  });
}
