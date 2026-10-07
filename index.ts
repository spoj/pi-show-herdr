import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ReviewDetails {
  path: string;
  changed: boolean;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const editor = `eval "$VISUAL" '"$1"'; printf '%s\\n' "$?" > "$2"`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "review",
    label: "Review",
    description: "Open an editable copy of a text file in a Herdr tab and wait for the user to finish. Returns the user's changes as a unified diff.",
    promptSnippet: "Let the user review or edit a copy of a text file in Herdr",
    parameters: Type.Object({
      path: Type.String({ description: "Text file to review (relative to the workspace or absolute)" }),
    }),
    executionMode: "sequential",
    // It waits for the user, so codemode scripts must not call it.
    exposure: "model-only",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error(`review requires interactive TUI mode; current mode is ${ctx.mode}`);
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (!workspace) throw new Error("review requires Herdr");
      const editorCommand = process.env.VISUAL || process.env.EDITOR;
      if (!editorCommand) throw new Error("review requires VISUAL or EDITOR");

      const sourcePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const tempDir = await mkdtemp(join(tmpdir(), "pi-review-"));
      const originalCopy = join(tempDir, "original");
      const reviewedCopy = join(tempDir, "reviewed");
      const editorStatusFile = join(tempDir, "editor-status");
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
        const command = `/bin/sh -c ${quote(editor)} review ${quote(reviewedCopy)} ${quote(editorStatusFile)}; exit`;
        const run = await pi.exec(herdr, ["pane", "run", result.result.root_pane.pane_id, command], { signal, timeout: 5000 });
        if (run.killed || run.code !== 0) throw new Error("Herdr could not launch the editor");
        editorLaunched = true;

        // Herdr closes the tab when the editor's shell exits.
        do await delay(500, undefined, { signal });
        while ((await pi.exec(herdr, ["tab", "get", tabId], { signal, timeout: 5000 })).code === 0);
        tabId = undefined;

        const editorCode = await readFile(editorStatusFile, "utf8").then((status) => status.trim(), () => undefined);
        if (editorCode === undefined) throw new Error("Review editor did not complete");
        if (editorCode !== "0") throw new Error(`Review editor exited with code ${editorCode}`);

        const [before, after] = await Promise.all([readFile(originalCopy), readFile(reviewedCopy)]);
        const changed = !before.equals(after);
        let text = `The user made no changes.\n\n${files}`;
        if (changed) {
          const diff = await pi.exec("diff", ["-u", "--label", "original file", "--label", "reviewed file", "--", originalCopy, reviewedCopy], { signal, timeout: 30_000 });
          const truncation = truncateHead(diff.stdout);
          const notice = truncation.truncated ? `\n\n[Diff truncated after ${truncation.outputBytes.toLocaleString()} bytes.]` : "";
          text = diff.stdout && !diff.killed
            ? `The user changed the reviewed copy. The source file was not modified.\n\nUnified diff:\n${truncation.content}${notice}\n\n${files}`
            : `The user changed the reviewed copy, but the diff could not be generated.\n\n${files}\n\n${diff.killed ? "The diff timed out." : diff.stderr.trim()}`;
        }
        return {
          content: [{ type: "text", text }],
          details: { path: sourcePath, changed } satisfies ReviewDetails,
        };
      } catch (error) {
        if (!editorLaunched) {
          if (tabId) await pi.exec(herdr, ["tab", "close", tabId], { timeout: 5000 });
          throw error;
        }
        const tabNote = tabId ? `\nThe review tab (${tabId}) is still open.` : "";
        throw new Error(`${(error as Error).message}\n\nThe review files were kept:${tabNote}\n${files}`);
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
      return new Text(theme.fg("success", details.changed ? "Review complete — changes returned" : "Review complete — no changes"), 0, 0);
    },
  });
}
