import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const STUBS: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `
export function truncateHead(text, options = {}) {
  const maxBytes = options.maxBytes ?? 50 * 1024;
  const maxLines = options.maxLines ?? 2000;
  const lines = text.split("\\n");
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const size = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  const content = kept.join("\\n");
  return { content, truncated: kept.length < lines.length, outputBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(text), outputLines: kept.length, totalLines: lines.length };
}
`,
  "@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }`,
  typebox: `export const Type = {
  Object: (properties) => ({ type: "object", properties }),
  String: (options = {}) => ({ type: "string", ...options }),
};`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stub)}` };
    return nextResolve(specifier, context);
  },
});

const { default: extension } = await import("../index.ts");

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
  execute(cmd: string, signal?: AbortSignal): Promise<{ content: { text: string }[]; details: { outcome: string; exitCode: number } }>;
  cleanup(): Promise<void>;
}

async function createHarness(options: { missing?: string[]; tabGetError?: string; diffKilled?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-show-test-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir);
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
      return options.diffKilled && args[0] === "bash" ? { ...result, killed: true } : result;
    },
    registerTool: (registered: ToolDefinition) => {
      tool = registered;
    },
  } as ExtensionAPI);

  const ctx = { mode: "tui", cwd: root, hasUI: false } as ExtensionContext;
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
    execute: (cmd, signal) => tool.execute("tool-call", { cmd }, signal, undefined, ctx) as ReturnType<Harness["execute"]>,
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
    details: { command: "echo hi", exitCode: 0, outcome: "changed" },
  };
  const expanded = render(result, { expanded: true, isPartial: false }, theme, context) as unknown as { text: string };
  assert.equal(expanded.text, result.content[0].text);
  const collapsed = render(result, { expanded: false, isPartial: false }, theme, context) as unknown as { text: string };
  assert.equal(collapsed.text, "Review complete — changes returned");
});

test("nonzero command exit is reviewed and reported", async () => {
  const h = await createHarness();
  try {
    const result = await h.execute("printf 'hello\\n'; exit 3");
    assert.equal(result.details.outcome, "unchanged");
    assert.equal(result.details.exitCode, 3);
    assert.match(result.content[0].text, /exited with code 3/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a script syntax error is captured and reviewed", async () => {
  const h = await createHarness();
  try {
    const result = await h.execute('printf "unterminated');
    assert.equal(result.details.exitCode, 2);
    const paths = reviewPaths(result.content[0].text);
    assert.match(readFileSync(paths.original, "utf8"), /unexpected EOF/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("an EOF-terminated heredoc cannot consume the capture wrapper", async () => {
  const h = await createHarness();
  try {
    const result = await h.execute("cat <<EOF\nhello");
    assert.equal(result.details.exitCode, 0);
    const paths = reviewPaths(result.content[0].text);
    const output = readFileSync(paths.original, "utf8");
    assert.match(output, /hello\n$/);
    assert.doesNotMatch(output, /commandPid/);
  } finally {
    await h.cleanup();
  }
});

test("capture waits for background output and preserves the script exit code", async () => {
  const h = await createHarness();
  try {
    const result = await h.execute("printf 'early\\n'; (sleep 0.2; printf 'late\\n') & exit 4");
    assert.equal(result.details.exitCode, 4);
    const paths = reviewPaths(result.content[0].text);
    assert.equal(readFileSync(paths.original, "utf8"), "early\nlate\n");
  } finally {
    await h.cleanup();
  }
});

test("edited output returns a unified diff", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const result = await h.execute("printf 'hello\\n'");
    assert.equal(result.details.outcome, "changed");
    assert.match(result.content[0].text, /\+user edit/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("capture killed before completing reports a diagnostic and cleans up", async () => {
  const before = await countReviewDirs();
  const h = await createHarness();
  try {
    await assert.rejects(h.execute("kill -9 -- -$$"), /Review capture did not complete/);
  } finally {
    await h.cleanup();
  }
  assert.equal(await countReviewDirs(), before);
});

test("missing setsid fails with a capture diagnostic, not an ENOENT", async () => {
  const h = await createHarness({ missing: ["setsid"] });
  try {
    await assert.rejects(h.execute("echo hi"), (error: Error) => {
      assert.match(error.message, /Review capture did not complete/);
      assert.doesNotMatch(error.message, /copyfile/);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test("editor failure keeps reviewed files and reports paths", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("fail");
    await assert.rejects(h.execute("echo hi"), (error: Error) => {
      assert.match(error.message, /exited with code 7/);
      assertKept(error.message);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test("aborting during capture does not open a review tab", async () => {
  const h = await createHarness();
  const controller = new AbortController();
  try {
    const pending = h.execute("sleep 5", controller.signal);
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(pending, /Review command was cancelled/);
    assert.equal(existsSync(join(h.stateDir, "tab-created")), false);
  } finally {
    await h.cleanup();
  }
});

test("aborting while the editor is open keeps files, paths, and the tab", async () => {
  const h = await createHarness();
  const controller = new AbortController();
  try {
    h.setEditorMode("hang");
    const pending = h.execute("echo hi", controller.signal);
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

test("tab poll failure keeps files and reports paths", async () => {
  const h = await createHarness({ tabGetError: "server_busy" });
  try {
    await assert.rejects(h.execute("echo hi"), (error: Error) => {
      assert.match(error.message, /Herdr could not read the review tab/);
      assertKept(error.message);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test("a signal-killed diff is unavailable, not 'no changes'", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const binDir = join(h.root, "bin");
    await mkdir(binDir);
    const diffPath = join(binDir, "diff");
    await writeFile(diffPath, "#!/bin/sh\nkill -9 $$\n");
    await chmod(diffPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const result = await h.execute("printf 'hello\\n'");
    assert.equal(result.details.outcome, "unavailable");
    assert.match(result.content[0].text, /Killed/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a diff that exits 1 with no output is unavailable, not a change", async () => {
  const h = await createHarness();
  try {
    h.setEditorMode("edit");
    const binDir = join(h.root, "bin");
    await mkdir(binDir);
    const diffPath = join(binDir, "diff");
    await writeFile(diffPath, "#!/bin/sh\nexit 1\n");
    await chmod(diffPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const result = await h.execute("printf 'hello\\n'");
    assert.equal(result.details.outcome, "unavailable");
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a timed-out diff is unavailable even if it wrote a success status", async () => {
  const h = await createHarness({ diffKilled: true });
  try {
    const result = await h.execute("echo hi");
    assert.equal(result.details.outcome, "unavailable");
    assert.match(result.content[0].text, /The diff timed out/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});

test("a diff that cannot start is unavailable", async () => {
  const h = await createHarness({ missing: ["bash"] });
  try {
    h.setEditorMode("edit");
    const result = await h.execute("printf 'hello\\n'");
    assert.equal(result.details.outcome, "unavailable");
    assert.match(result.content[0].text, /The diff did not complete/);
    assertKept(result.content[0].text);
  } finally {
    await h.cleanup();
  }
});
