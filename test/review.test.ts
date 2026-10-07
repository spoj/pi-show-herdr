import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

// Same observable contract as the SDK's execCommand: spawn failures resolve as
// code 1 with empty stderr, and signal deaths resolve as code 0 (code ?? 0).
function makeExec(missing: string[]): Exec {
  const missingSet = new Set(missing);
  return (command, args, options = {}) =>
    new Promise<ExecResult>((resolve) => {
      if (missingSet.has(command)) {
        resolve({ stdout: "", stderr: "", code: 1, killed: false });
        return;
      }
      const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (killed) return;
        killed = true;
        child.kill("SIGTERM");
      };
      const finish = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options.timeout) timer = setTimeout(onAbort, options.timeout);
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", () => finish({ stdout, stderr, code: 1, killed }));
      child.on("close", (code) => finish({ stdout, stderr, code: code ?? 0, killed }));
    });
}

const HERDR_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const state = process.env.FAKE_HERDR_STATE;
const [group, sub, ...rest] = process.argv.slice(2);

if (group === "tab" && sub === "create") {
  writeFileSync(join(state, "tab-created"), "1");
  console.log(JSON.stringify({ result: { tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } } }));
  process.exit(0);
}

if (group === "pane" && sub === "run") {
  const command = rest[1];
  const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  writeFileSync(join(state, "editor-status-path"), quoted[quoted.length - 1] ?? "");
  const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(state, "pane.pid"), String(child.pid));
  process.exit(0);
}

if (group === "tab" && sub === "get") {
  appendFileSync(join(state, "tab-gets"), "x");
  const error = process.env.FAKE_HERDR_TAB_GET_ERROR;
  if (error) {
    process.stderr.write(JSON.stringify({ error: { code: error } }));
    process.exit(1);
  }
  const statusPathFile = join(state, "editor-status-path");
  const statusPath = existsSync(statusPathFile) ? readFileSync(statusPathFile, "utf8").trim() : "";
  if (statusPath && existsSync(statusPath)) {
    process.stderr.write(JSON.stringify({ error: { code: "tab_not_found" } }));
    process.exit(1);
  }
  process.exit(0);
}

if (group === "tab" && sub === "close") {
  writeFileSync(join(state, "tab-closed"), "1");
  const pidFile = join(state, "pane.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  process.exit(0);
}

process.exit(0);
`;

const EDITOR_SOURCE = `#!/bin/sh
case "$FAKE_EDITOR_MODE" in
  edit) printf '\\nuser edit\\n' >> "$1" ;;
  fail) exit 7 ;;
  hang) sleep 300 ;;
esac
exit 0
`;

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "HERDR_BIN_PATH",
  "FAKE_HERDR_STATE",
  "FAKE_HERDR_TAB_GET_ERROR",
  "FAKE_EDITOR_MODE",
  "VISUAL",
  "PATH",
  "TMPDIR",
] as const;

interface Harness {
  root: string;
  stateDir: string;
  setEditorMode(mode: string): void;
  execute(path: string, signal?: AbortSignal): Promise<{ content: { text: string }[]; details: { changed: boolean; path: string } }>;
  cleanup(): Promise<void>;
}

async function createHarness(options: { missing?: string[]; tabGetError?: string; diffKilled?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-show-test-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir);
  await writeFile(join(root, "source.txt"), "hello\n");
  const herdrPath = join(root, "herdr.mjs");
  await writeFile(herdrPath, HERDR_SOURCE);
  await chmod(herdrPath, 0o755);
  const editorPath = join(root, "editor.sh");
  await writeFile(editorPath, EDITOR_SOURCE);
  await chmod(editorPath, 0o755);

  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "test-workspace";
  process.env.HERDR_BIN_PATH = herdrPath;
  process.env.FAKE_HERDR_STATE = stateDir;
  process.env.TMPDIR = root;
  process.env.FAKE_EDITOR_MODE = "noop";
  process.env.VISUAL = editorPath;
  delete process.env.FAKE_HERDR_TAB_GET_ERROR;
  if (options.tabGetError) process.env.FAKE_HERDR_TAB_GET_ERROR = options.tabGetError;

  let tool: ToolDefinition;
  const exec = makeExec(options.missing ?? []);
  extension({
    exec: async (...args: Parameters<Exec>) => {
      const result = await exec(...args);
      return options.diffKilled && args[0] === "diff" ? { ...result, killed: true } : result;
    },
    registerTool: (registered: ToolDefinition) => {
      tool = registered;
    },
  } as ExtensionAPI);

  const ctx = { mode: "tui", cwd: root, hasUI: false } as ExtensionToolContext;
  const killPane = () => {
    const pidFile = join(stateDir, "pane.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  };

  return {
    root,
    stateDir,
    setEditorMode(mode) {
      process.env.FAKE_EDITOR_MODE = mode;
    },
    execute: (path, signal) => tool.execute("tool-call", { path }, signal, undefined, ctx) as ReturnType<Harness["execute"]>,
    async cleanup() {
      killPane();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function reviewPaths(text: string): { original: string; reviewed: string } {
  const original = /Original: (\S+)/.exec(text)?.[1];
  const reviewed = /User-reviewed: (\S+)/.exec(text)?.[1];
  assert.ok(original && reviewed, `expected review paths in: ${text}`);
  return { original, reviewed };
}

function assertKept(text: string) {
  const paths = reviewPaths(text);
  assert.ok(existsSync(paths.original), `original not kept: ${paths.original}`);
  assert.ok(existsSync(paths.reviewed), `reviewed not kept: ${paths.reviewed}`);
}

async function countReviewDirs(): Promise<number> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("pi-review-")).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the renderer shows errors and expanded review details", () => {
  let tool!: ToolDefinition;
  extension({ registerTool: (registered: ToolDefinition) => { tool = registered; } } as ExtensionAPI);
  const render = tool.renderResult!;
  const theme = { fg: (_color: string, text: string) => text } as Parameters<typeof render>[2];
  const context = {} as Parameters<typeof render>[3];
  const error = { content: [{ type: "text" as const, text: "Review editor exited with code 7\nOriginal: /tmp/original" }], details: undefined };
  const renderedError = render(error, { expanded: false, isPartial: false }, theme, context) as unknown as { text: string };
  assert.equal(renderedError.text, error.content[0].text);

  const result = {
    content: [{ type: "text" as const, text: "Unified diff:\n+user edit\nOriginal: /tmp/original" }],
    details: { path: "source.txt", changed: true },
  };
  const expanded = render(result, { expanded: true, isPartial: false }, theme, context) as unknown as { text: string };
  assert.equal(expanded.text, result.content[0].text);
  const collapsed = render(result, { expanded: false, isPartial: false }, theme, context) as unknown as { text: string };
  assert.equal(collapsed.text, "Review complete — changes returned");
});

for (const kind of ["relative", "absolute", "@-prefixed"]) {
  test(`reviews a ${kind} file path`, async () => {
    const h = await createHarness();
    try {
      const source = join(h.root, "source.txt");
      const path = kind === "absolute" ? source : kind === "@-prefixed" ? "@source.txt" : "source.txt";
      const result = await h.execute(path);
      assert.deepEqual(result.details, { path: source, changed: false });
      const paths = reviewPaths(result.content[0].text);
      assert.equal(readFileSync(paths.original, "utf8"), "hello\n");
      assert.equal(readFileSync(paths.reviewed, "utf8"), "hello\n");
    } finally {
      await h.cleanup();
    }
  });
}

test("file paths with shell metacharacters are treated literally", async () => {
  const h = await createHarness();
  try {
    const name = "file 'quoted'; $(touch sentinel).txt";
    await writeFile(join(h.root, name), "literal contents");
    const result = await h.execute(name);
    assert.equal(result.details.changed, false);
    assert.equal(existsSync(join(h.root, "sentinel")), false);
    assert.equal(readFileSync(reviewPaths(result.content[0].text).original, "utf8"), "literal contents");
  } finally {
    await h.cleanup();
  }
});

test("edits return a unified diff without modifying the source file", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /\+user edit/);
    assert.match(result.content[0].text, /--- original file\n\+\+\+ reviewed file/);
    assertKept(result.content[0].text);
    assert.equal(readFileSync(join(h.root, "source.txt"), "utf8"), "hello\n");
    const paths = reviewPaths(result.content[0].text);
    assert.equal(readFileSync(paths.reviewed, "utf8"), "hello\n\nuser edit\n");
    await writeFile(join(h.root, "source.txt"), "later source change");
    assert.equal(readFileSync(paths.original, "utf8"), "hello\n");
  } finally {
    await h.cleanup();
  }
});

test("a read-only source produces an editable copy", async () => {
  const h = await createHarness();
  try {
    await chmod(join(h.root, "source.txt"), 0o444);
    h.setEditorMode("edit");
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.equal(readFileSync(join(h.root, "source.txt"), "utf8"), "hello\n");
  } finally {
    await h.cleanup();
  }
});

for (const size of [0, 100_000]) {
  test(`copies all ${size} bytes without truncating the file`, async () => {
    const h = await createHarness();
    try {
      const content = "x".repeat(size);
      await writeFile(join(h.root, "source.txt"), content);
      const result = await h.execute("source.txt");
      assert.equal(result.details.changed, false);
      const paths = reviewPaths(result.content[0].text);
      assert.equal(readFileSync(paths.original, "utf8"), content);
      assert.equal(readFileSync(paths.reviewed, "utf8"), content);
    } finally {
      await h.cleanup();
    }
  });
}

test("a missing source file cleans up without opening a tab", async () => {
  const h = await createHarness();
  try {
    await assert.rejects(h.execute("missing.txt"), /ENOENT/);
    assert.equal(existsSync(join(h.stateDir, "tab-created")), false);
    assert.equal(await countReviewDirs(), 0);
  } finally {
    await h.cleanup();
  }
});

test("editor failure keeps reviewed files and reports paths", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("fail");
    await assert.rejects(h.execute("source.txt"), (error: Error) => {
      assert.match(error.message, /exited with code 7/);
      assertKept(error.message);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test("a pre-aborted review does not open a tab or create copies", async () => {
  const h = await createHarness();
  const controller = new AbortController();
  try {
    controller.abort();
    await assert.rejects(h.execute("source.txt", controller.signal), /abort/i);
    assert.equal(existsSync(join(h.stateDir, "tab-created")), false);
    assert.equal(await countReviewDirs(), 0);
  } finally {
    await h.cleanup();
  }
});

test("aborting while the editor is open keeps files, paths, and the tab", async () => {
  const h = await createHarness();
  const controller = new AbortController();
  try {
    h.setEditorMode("hang");
    const pending = h.execute("source.txt", controller.signal);
    pending.catch(() => {});
    await waitFor(() => existsSync(join(h.stateDir, "tab-gets")));
    controller.abort();
    await assert.rejects(pending, (error: Error) => {
      assert.match(error.message, /The review files were kept/);
      assert.match(error.message, /The review tab \(tab-1\) is still open/);
      assertKept(error.message);
      return true;
    });
    assert.equal(existsSync(join(h.stateDir, "tab-closed")), false);
  } finally {
    await h.cleanup();
  }
});

test("a failing tab poll ends the wait and keeps the files", async () => {
  const h = await createHarness({ tabGetError: "server_busy" });
  try {
    h.setEditorMode("hang");
    await assert.rejects(h.execute("source.txt"), (error: Error) => {
      assert.match(error.message, /Review editor did not complete/);
      assertKept(error.message);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test("a signal-killed diff is reported", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const binDir = join(h.root, "bin");
    await mkdir(binDir);
    const diffPath = join(binDir, "diff");
    await writeFile(diffPath, "#!/bin/sh\nkill -9 $$\n");
    await chmod(diffPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /diff could not be generated/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a diff without output is reported", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const binDir = join(h.root, "bin");
    await mkdir(binDir);
    const diffPath = join(binDir, "diff");
    await writeFile(diffPath, "#!/bin/sh\nexit 1\n");
    await chmod(diffPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /diff could not be generated/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a timed-out diff is reported", async () => {
  const h = await createHarness({ diffKilled: true });
  try {
    h.setEditorMode("edit");
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /diff could not be generated/);
    assert.match(result.content[0].text, /The diff timed out/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a diff that cannot start is reported", async () => {
  const h = await createHarness({ missing: ["diff"] });
  try {
    h.setEditorMode("edit");
    const result = await h.execute("source.txt");
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /diff could not be generated/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});
