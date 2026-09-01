import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ReviewDetails {
  file: string;
  outcome: "unchanged" | "changed" | "unavailable";
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const maxInlineDiffChars = 10_000;

const viewer = `
file=$1

if command -v bat >/dev/null 2>&1; then
  LESSOPEN='|bat --style=plain --color=always -- %s' less -R -- "$file"
elif command -v batcat >/dev/null 2>&1; then
  LESSOPEN='|batcat --style=plain --color=always -- %s' less -R -- "$file"
else
  less -R -- "$file"
fi
`;

export default function (pi: ExtensionAPI) {
  const pendingCleanup = new Set<string>();

  const cleanup = async () => {
    const directories = [...pendingCleanup];
    pendingCleanup.clear();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  };

  pi.on("agent_settled", cleanup);
  pi.on("session_shutdown", cleanup);

  pi.registerTool({
    name: "review",
    label: "Review",
    description: "Open an isolated copy of an existing file in a focused, zoomed Herdr pane and wait for the user to finish. Returns any edits as a unified diff without modifying the original. Requires less and an interactive Pi session running in Herdr.",
    promptSnippet: "Let the user review or edit a file in Herdr",
    promptGuidelines: [
      "Use review when the user should personally inspect or edit a file; use read for the agent's own inspection.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File to review, relative to the working directory or absolute" }),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error(`review requires interactive TUI mode; current mode is ${ctx.mode}`);
      const parentPane = process.env.HERDR_PANE_ID;
      if (process.env.HERDR_ENV !== "1" || !parentPane) throw new Error("review requires Herdr");

      const input = params.file.startsWith("@") ? params.file.slice(1) : params.file;
      const file = resolve(ctx.cwd, input);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`Not a file: ${file}`);

      const less = await pi.exec("less", ["--version"], { signal, timeout: 5000 });
      if (less.code !== 0) throw new Error("review requires less");

      const tempDir = await mkdtemp(join(tmpdir(), "pi-review-"));
      const originalCopy = join(tempDir, `original-${basename(file)}`);
      const workingCopy = join(tempDir, `working-${basename(file)}`);
      const diffFile = join(tempDir, "diff.patch");
      let paneId: string | undefined;
      let retain = false;

      try {
        await copyFile(file, originalCopy);
        await copyFile(originalCopy, workingCopy);

        const herdr = process.env.HERDR_BIN_PATH || "herdr";
        const split = await pi.exec(
          herdr,
          ["pane", "split", "--pane", parentPane, "--direction", "right", "--cwd", tempDir, "--focus"],
          { signal, timeout: 5000 },
        );
        if (split.code !== 0) throw new Error("Herdr could not create a review pane");

        paneId = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
        const zoom = await pi.exec(herdr, ["pane", "zoom", "--pane", paneId, "--on"], {
          signal,
          timeout: 5000,
        });
        const command = `/bin/sh -c ${quote(viewer)} review ${quote(workingCopy)}; ${quote(herdr)} pane zoom --current --off; exit`;
        const run = zoom.code === 0
          ? await pi.exec(herdr, ["pane", "run", paneId, command], { signal, timeout: 5000 })
          : zoom;
        if (run.code !== 0) throw new Error("Herdr could not launch the reviewer");

        while (true) {
          await delay(500, undefined, { signal });
          const pane = await pi.exec(herdr, ["pane", "get", paneId], { signal, timeout: 5000 });
          if (pane.code !== 0) break;
        }
        paneId = undefined;

        const diff = await pi.exec(
          "diff",
          ["-u", "--label", `original ${file}`, "--label", `edited copy ${file}`, originalCopy, workingCopy],
          { signal, timeout: 30_000 },
        );

        if (diff.code === 0) {
          return {
            content: [{ type: "text", text: `The user finished reviewing ${file}. No changes were made.` }],
            details: { file, outcome: "unchanged" } satisfies ReviewDetails,
          };
        }

        retain = true;
        pendingCleanup.add(tempDir);

        if (diff.code === 1) {
          await writeFile(diffFile, diff.stdout);
          const files = `Original snapshot: ${originalCopy}\nEdited copy: ${workingCopy}\nUnified diff: ${diffFile}`;
          const text = diff.stdout.length <= maxInlineDiffChars
            ? `The user edited an isolated copy of ${file}; the original was not modified. Apply this diff against the current file, accounting for any concurrent changes. The review files remain available during this agent run and will be removed when the agent settles:\n\n${files}\n\n${diff.stdout}`
            : `The user edited an isolated copy of ${file}, but the diff is too large to include inline. The original was not modified. Inspect or apply these files during this agent run; they will be removed when the agent settles:\n\n${files}`;
          return {
            content: [{ type: "text", text }],
            details: { file, outcome: "changed" } satisfies ReviewDetails,
          };
        }

        return {
          content: [{
            type: "text",
            text: `The user finished reviewing ${file}, but the diff could not be generated. The original was not modified. Inspect these files during this agent run; they will be removed when the agent settles:\n\nOriginal snapshot: ${originalCopy}\nEdited copy: ${workingCopy}\n\n${diff.stderr.trim()}`,
          }],
          details: { file, outcome: "unavailable" } satisfies ReviewDetails,
        };
      } catch (error) {
        if (paneId) {
          const herdr = process.env.HERDR_BIN_PATH || "herdr";
          await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5000 });
        }
        throw error;
      } finally {
        if (!retain) await rm(tempDir, { recursive: true, force: true });
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("review ")) + theme.fg("muted", basename(args.file)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as ReviewDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const text = details.outcome === "unchanged"
        ? "Review complete — no changes"
        : details.outcome === "changed"
          ? "Review complete — changes returned"
          : "Review complete — diff unavailable";
      return new Text(theme.fg(details.outcome === "unavailable" ? "warning" : "success", text), 0, 0);
    },
  });
}
