import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ReviewDetails {
  command: string;
  exitCode: number;
  outcome: "unchanged" | "changed" | "unavailable";
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function readStatus(path: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const editor = `
file=$1
statusFile=$2
editor=\${VISUAL:-$EDITOR}
eval "$editor" '"$file"'
status=$?
printf '%s\\n' "$status" > "$statusFile"
exit "$status"
`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "review",
    label: "Review",
    description: "Run a Bash script, open an editable copy of its output in a focused Herdr tab, and wait for the user to finish. Returns the paths to the original and reviewed output plus a unified diff. Requires a blocking VISUAL or EDITOR command and an interactive Pi session running in Herdr.",
    promptSnippet: "Let the user review or edit generated command output in Herdr",
    promptGuidelines: [
      "Use review when the user should personally inspect or edit generated output.",
    ],
    parameters: Type.Object({
      cmd: Type.String({ description: "Bash script whose combined output the user will review" }),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error(`review requires interactive TUI mode; current mode is ${ctx.mode}`);
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (process.env.HERDR_ENV !== "1" || !workspace) throw new Error("review requires Herdr");
      const editorCommand = process.env.VISUAL || process.env.EDITOR;
      if (!editorCommand) throw new Error("review requires VISUAL or EDITOR");

      const tempDir = await mkdtemp(join(tmpdir(), "pi-review-"));
      const originalCopy = join(tempDir, "original");
      const reviewedCopy = join(tempDir, "reviewed");
      const editorStatusFile = join(tempDir, "editor-status");
      const captureStatusFile = join(tempDir, "capture-status");
      const diffStatusFile = join(tempDir, "diff-status");
      let tabId: string | undefined;
      let editable = false;
      let retain = false;

      try {
        const captureScript = `
exec > "$1" 2>&1
trap 'trap "" TERM INT HUP; kill -TERM -- -$$; sleep 1; kill -KILL -- -$$' TERM INT HUP
trap 'status=$?; trap - EXIT; set +e; wait; printf "%s\\n" "$status" > "$2"; exit "$status"' EXIT
(
  trap 'status=$?; trap - EXIT; set +e; wait; exit "$status"' EXIT
  eval "$3"
) & commandPid=$!
while kill -0 "$commandPid" 2>/dev/null; do sleep 0.1; done
wait "$commandPid"
`;
        const capture = await pi.exec(
          "setsid",
          ["bash", "-c", captureScript, "pi-review", originalCopy, captureStatusFile, params.cmd],
          { signal, cwd: ctx.cwd },
        );
        const captureCode = await readStatus(captureStatusFile);
        if (signal?.aborted) throw new Error("Review command was cancelled");
        if (captureCode === undefined) {
          const detail = capture.stderr.trim();
          throw new Error(`Review capture did not complete (setsid or bash may be unavailable, or the capture was killed)${detail ? `: ${detail}` : ""}`);
        }
        await copyFile(originalCopy, reviewedCopy);

        const herdr = process.env.HERDR_BIN_PATH || "herdr";
        const created = await pi.exec(
          herdr,
          ["tab", "create", "--workspace", workspace, "--cwd", tempDir, "--label", "Review", "--env", `VISUAL=${editorCommand}`, ...(process.env.PATH ? ["--env", `PATH=${process.env.PATH}`] : []), "--focus"],
          { signal, timeout: 5000 },
        );
        if (created.killed || created.code !== 0) throw new Error("Herdr could not create a review tab");

        const result = JSON.parse(created.stdout) as {
          result: { tab: { tab_id: string }; root_pane: { pane_id: string } };
        };
        tabId = result.result.tab.tab_id;
        const paneId = result.result.root_pane.pane_id;
        const command = `/bin/sh -c ${quote(editor)} review ${quote(reviewedCopy)} ${quote(editorStatusFile)}; exit`;
        const run = await pi.exec(herdr, ["pane", "run", paneId, command], { signal, timeout: 5000 });
        if (run.killed || run.code !== 0) throw new Error("Herdr could not launch the editor");
        editable = true;

        while (true) {
          await delay(500, undefined, { signal });
          const tab = await pi.exec(herdr, ["tab", "get", tabId], { signal, timeout: 5000 });
          if (tab.killed) throw new Error("Herdr could not read the review tab");
          if (tab.code === 0) continue;

          let errorCode: string | undefined;
          try {
            errorCode = (JSON.parse(tab.stderr) as { error?: { code?: string } }).error?.code;
          } catch {}
          if (errorCode !== "tab_not_found") {
            throw new Error(`Herdr could not read the review tab: ${tab.stderr.trim() || tab.stdout.trim()}`);
          }
          break;
        }
        tabId = undefined;

        const editorCode = await readStatus(editorStatusFile);
        if (editorCode === undefined) throw new Error("Review editor did not complete");
        if (editorCode !== 0) throw new Error(`Review editor exited with code ${editorCode}`);

        const diffScript = `diff -u --label 'original output' --label 'reviewed output' -- ${quote(originalCopy)} ${quote(reviewedCopy)}
printf '%s\\n' "$?" > ${quote(diffStatusFile)}`;
        const diff = await pi.exec("bash", ["-c", diffScript], { signal, timeout: 30_000 });
        const diffCode = await readStatus(diffStatusFile);

        const files = `Original: ${originalCopy}\nUser-reviewed: ${reviewedCopy}`;

        if (!diff.killed && diffCode === 0) {
          retain = true;
          return {
            content: [{
              type: "text",
              text: `The user finished reviewing the command output. No changes were made. The command exited with code ${captureCode}.\n\n${files}`,
            }],
            details: {
              command: params.cmd,
              exitCode: captureCode,
              outcome: "unchanged",
            } satisfies ReviewDetails,
          };
        }

        if (!diff.killed && diffCode === 1 && diff.stdout.length > 0) {
          retain = true;
          const truncation = truncateHead(diff.stdout);
          const notice = truncation.truncated
            ? `\n\n[Diff too long and truncated after ${truncation.outputBytes.toLocaleString()} bytes.]`
            : "";
          return {
            content: [{
              type: "text",
              text: `The user changed the generated output. The command exited with code ${captureCode}.\n\nUnified diff:\n${truncation.content}${notice}\n\n${files}`,
            }],
            details: {
              command: params.cmd,
              exitCode: captureCode,
              outcome: "changed",
            } satisfies ReviewDetails,
          };
        }

        retain = true;
        const diffDetail = diff.stderr.trim()
          || (diff.killed
            ? "The diff timed out."
            : diffCode === undefined
              ? "The diff did not complete."
              : `The diff exited with code ${diffCode}.`);
        return {
          content: [{
            type: "text",
            text: `The user finished reviewing the generated output, but the diff could not be generated. Inspect the review files directly. The command exited with code ${captureCode}.\n\n${files}\n\n${diffDetail}`,
          }],
          details: {
            command: params.cmd,
            exitCode: captureCode,
            outcome: "unavailable",
          } satisfies ReviewDetails,
        };
      } catch (error) {
        if (editable) {
          retain = true;
          const message = error instanceof Error ? error.message : String(error);
          const tabNote = tabId ? `\nThe review tab (${tabId}) is still open.` : "";
          throw new Error(`${message}\n\nThe review files were kept:${tabNote}\nOriginal: ${originalCopy}\nUser-reviewed: ${reviewedCopy}`);
        }
        if (tabId) {
          const herdr = process.env.HERDR_BIN_PATH || "herdr";
          await pi.exec(herdr, ["tab", "close", tabId], { timeout: 5000 });
        }
        throw error;
      } finally {
        if (!retain) await rm(tempDir, { recursive: true, force: true });
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("review ")) + theme.fg("muted", args.cmd),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ReviewDetails | undefined;
      if (!details || expanded) {
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        return new Text(theme.fg(details ? "toolOutput" : "error", text), 0, 0);
      }
      const text = details.outcome === "unchanged"
        ? "Review complete — no changes"
        : details.outcome === "changed"
          ? "Review complete — changes returned"
          : "Review complete — diff unavailable";
      return new Text(theme.fg(details.outcome === "unavailable" ? "warning" : "success", text), 0, 0);
    },
  });
}
