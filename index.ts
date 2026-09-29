import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ReviewDetails {
  path: string;
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
    description: "Open an editable copy of a text file in a focused Herdr tab and wait for the user to finish. Leaves the source file unchanged. Returns paths to the original snapshot and reviewed copy plus a unified diff, limited to 50 KiB or 2,000 lines. Requires a blocking VISUAL or EDITOR command and an interactive Pi session running in Herdr.",
    promptSnippet: "Let the user review or edit a copy of a text file in Herdr",
    promptGuidelines: [
      "Use review when the user should personally inspect or edit a text file. For generated output, first save it to a file with bash, then pass its path to review.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Text file to review (relative to the workspace or absolute)" }),
    }),
    executionMode: "sequential",
    // It waits for the user, so codemode scripts must not call it.
    exposure: "model-only",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (ctx.mode !== "tui") throw new Error(`review requires interactive TUI mode; current mode is ${ctx.mode}`);
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (process.env.HERDR_ENV !== "1" || !workspace) throw new Error("review requires Herdr");
      const editorCommand = process.env.VISUAL || process.env.EDITOR;
      if (!editorCommand) throw new Error("review requires VISUAL or EDITOR");

      const sourcePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const tempDir = await mkdtemp(join(tmpdir(), "pi-review-"));
      const originalCopy = join(tempDir, "original");
      const reviewedCopy = join(tempDir, "reviewed");
      const editorStatusFile = join(tempDir, "editor-status");
      const diffStatusFile = join(tempDir, "diff-status");
      const files = `Original: ${originalCopy}\nUser-reviewed: ${reviewedCopy}`;
      const herdr = process.env.HERDR_BIN_PATH || "herdr";
      let tabId: string | undefined;
      let editorLaunched = false;

      try {
        await copyFile(sourcePath, originalCopy);
        await chmod(originalCopy, 0o600);
        await copyFile(originalCopy, reviewedCopy);
        signal?.throwIfAborted();

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
        editorLaunched = true;

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

        const diffScript = `diff -u --label 'original file' --label 'reviewed file' -- ${quote(originalCopy)} ${quote(reviewedCopy)}
printf '%s\\n' "$?" > ${quote(diffStatusFile)}`;
        const diff = await pi.exec("bash", ["-c", diffScript], { signal, timeout: 30_000 });
        const diffCode = await readStatus(diffStatusFile);

        let outcome: ReviewDetails["outcome"];
        let text: string;
        if (!diff.killed && diffCode === 0) {
          outcome = "unchanged";
          text = `The user finished reviewing the file. No changes were made.\n\n${files}`;
        } else if (!diff.killed && diffCode === 1 && diff.stdout.length > 0) {
          outcome = "changed";
          const truncation = truncateHead(diff.stdout);
          const notice = truncation.truncated
            ? `\n\n[Diff too long and truncated after ${truncation.outputBytes.toLocaleString()} bytes.]`
            : "";
          text = `The user changed the reviewed copy. The source file was not modified.\n\nUnified diff:\n${truncation.content}${notice}\n\n${files}`;
        } else {
          outcome = "unavailable";
          const diffDetail = diff.stderr.trim()
            || (diff.killed
              ? "The diff timed out."
              : diffCode === undefined
                ? "The diff did not complete."
                : `The diff exited with code ${diffCode}.`);
          text = `The user finished reviewing the file, but the diff could not be generated. Inspect the review files directly.\n\n${files}\n\n${diffDetail}`;
        }
        return {
          content: [{ type: "text", text }],
          details: { path: sourcePath, outcome } satisfies ReviewDetails,
        };
      } catch (error) {
        if (editorLaunched) {
          const message = error instanceof Error ? error.message : String(error);
          const tabNote = tabId ? `\nThe review tab (${tabId}) is still open.` : "";
          throw new Error(`${message}\n\nThe review files were kept:${tabNote}\n${files}`);
        }
        if (tabId) await pi.exec(herdr, ["tab", "close", tabId], { timeout: 5000 });
        throw error;
      } finally {
        if (!editorLaunched) await rm(tempDir, { recursive: true, force: true });
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("review ")) + theme.fg("muted", args.path),
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
