import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute, type ExecResult } from "../src/index.ts";

describe("Sandboxed Code Executor", () => {
  // ── Basic execution ────────────────────────────────────────────

  describe("Python execution", () => {
    it("should run simple Python code", async () => {
      const result = await execute({
        language: "python",
        code: 'print("hello sandbox")',
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /hello sandbox/);
      assert.equal(result.timedOut, false);
      assert.equal(result.truncated, false);
    });

    it("should capture stderr", async () => {
      const result = await execute({
        language: "python",
        code: 'import sys; sys.stderr.write("error output\\n")',
      });
      assert.match(result.stderr, /error output/);
    });

    it("should handle syntax errors", async () => {
      const result = await execute({
        language: "python",
        code: "def broken(",
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /SyntaxError/);
    });

    it("should handle stdin", async () => {
      const result = await execute({
        language: "python",
        code: 'x = input(); print(f"got: {x}")',
        stdin: "hello\n",
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /got: hello/);
    });

    it("should handle multi-line output", async () => {
      const result = await execute({
        language: "python",
        code: "for i in range(5): print(i)",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "0\n1\n2\n3\n4");
    });
  });

  describe("JavaScript execution", () => {
    it("should run simple JavaScript code", async () => {
      const result = await execute({
        language: "javascript",
        code: 'console.log("hello from js")',
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /hello from js/);
    });

    it("should handle runtime errors", async () => {
      const result = await execute({
        language: "javascript",
        code: "throw new Error('boom')",
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /boom/);
    });

    it("should support modern JS features", async () => {
      const result = await execute({
        language: "javascript",
        code: `
          const arr = [1, 2, 3, 4, 5];
          const sum = arr.reduce((a, b) => a + b, 0);
          console.log(sum);
          const obj = { a: 1, b: 2, ...{ c: 3 } };
          console.log(JSON.stringify(obj));
        `,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /15/);
      assert.match(result.stdout, /{"a":1,"b":2,"c":3}/);
    });
  });

  describe("TypeScript execution", () => {
    it("should run simple TypeScript code", async () => {
      const result = await execute({
        language: "typescript",
        code: `
          const greet = (name: string): string => \`hello \${name}\`;
          console.log(greet("typescript"));
        `,
      });
      // May fail if Node doesn't support --experimental-strip-types
      // That's expected on Node < 22
      if (result.exitCode === 0) {
        assert.match(result.stdout, /hello typescript/);
      } else {
        // On older Node, we expect a graceful error
        assert.ok(result.stderr.length > 0 || result.error);
      }
    });
  });

  // ── Timeout handling ───────────────────────────────────────────

  describe("Timeout", () => {
    it("should kill Python infinite loop", async () => {
      const result = await execute({
        language: "python",
        code: "while True: pass",
        timeoutMs: 1000,
      });
      assert.equal(result.timedOut, true);
      assert.ok(result.durationMs >= 900, `Duration was ${result.durationMs}ms`);
      assert.ok(result.durationMs < 5000, `Duration was ${result.durationMs}ms, expected < 5000`);
    });

    it("should kill JavaScript infinite loop", async () => {
      const result = await execute({
        language: "javascript",
        code: "while(true) {}",
        timeoutMs: 1000,
      });
      assert.equal(result.timedOut, true);
    });

    it("should not timeout fast code", async () => {
      const result = await execute({
        language: "python",
        code: 'print("fast")',
        timeoutMs: 5000,
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0);
    });
  });

  // ── Memory limits ─────────────────────────────────────────────

  describe("Memory limits", () => {
    it("should enforce memory limit on JavaScript", async () => {
      const result = await execute({
        language: "javascript",
        code: `
          const arrays = [];
          while (true) {
            arrays.push(new Array(1000000).fill('x'));
          }
        `,
        memoryMb: 32,
        timeoutMs: 10000,
      });
      // Should die from OOM or timeout
      assert.notEqual(result.exitCode, 0);
    });
  });

  // ── Output truncation ─────────────────────────────────────────

  describe("Output truncation", () => {
    it("should truncate excessive stdout", async () => {
      const result = await execute({
        language: "python",
        code: `
import sys
# Generate > 1MB of output
for i in range(200000):
    sys.stdout.write("x" * 10 + "\\n")
`,
        timeoutMs: 15000,
      });
      assert.equal(result.truncated, true);
      // Output should be roughly 1MB, not 2MB+
      assert.ok(result.stdout.length <= 1_100_000, `stdout length: ${result.stdout.length}`);
    });
  });

  // ── Network blocking ──────────────────────────────────────────

  describe("Network blocking", () => {
    it("should block Python network access by default", async () => {
      const result = await execute({
        language: "python",
        code: `
import urllib.request
try:
    urllib.request.urlopen("http://example.com")
    print("NETWORK_ALLOWED")
except Exception as e:
    print(f"BLOCKED: {e}")
`,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /BLOCKED/);
      assert.doesNotMatch(result.stdout, /NETWORK_ALLOWED/);
    });

    it("should block JavaScript network access by default", async () => {
      const result = await execute({
        language: "javascript",
        code: `
const http = require('http');
try {
  http.request('http://example.com');
  console.log('NETWORK_ALLOWED');
} catch (e) {
  console.log('BLOCKED: ' + e.message);
}
`,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /BLOCKED/);
    });

    it("should block Python socket access", async () => {
      const result = await execute({
        language: "python",
        code: `
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect(("example.com", 80))
    print("NETWORK_ALLOWED")
except Exception as e:
    print(f"BLOCKED: {e}")
`,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /BLOCKED/);
    });
  });

  // ── Fork bomb protection ──────────────────────────────────────

  describe("Fork bomb protection", () => {
    it("should block Python fork", async () => {
      const result = await execute({
        language: "python",
        code: `
import os
try:
    os.fork()
    print("FORK_ALLOWED")
except Exception as e:
    print(f"BLOCKED: {e}")
`,
        timeoutMs: 5000,
      });
      assert.match(result.stdout, /BLOCKED/);
      assert.doesNotMatch(result.stdout, /FORK_ALLOWED/);
    });
  });

  // ── Filesystem restrictions ───────────────────────────────────

  describe("Filesystem restrictions", () => {
    it("should allow writing to temp directory", async () => {
      const result = await execute({
        language: "python",
        code: `
import os, tempfile
tmpdir = os.environ.get("TMPDIR", "/tmp")
path = os.path.join(tmpdir, "test_file.txt")
with open(path, "w") as f:
    f.write("hello")
with open(path, "r") as f:
    print(f.read())
`,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /hello/);
    });

    it("should clean up temp files after execution", async () => {
      // Run some code that creates files
      const result1 = await execute({
        language: "python",
        code: `
import os, tempfile
tmpdir = os.environ.get("TMPDIR", "/tmp")
path = os.path.join(tmpdir, "persistent_test.txt")
with open(path, "w") as f:
    f.write("should be cleaned up")
print(path)
`,
      });
      assert.equal(result1.exitCode, 0);
      const createdPath = result1.stdout.trim();

      // Verify the file no longer exists (sandbox cleaned up)
      const result2 = await execute({
        language: "python",
        code: `
import os
print(os.path.exists("${createdPath}"))
`,
      });
      assert.match(result2.stdout, /False/);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle empty code", async () => {
      const result = await execute({
        language: "python",
        code: "",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
    });

    it("should handle unsupported language gracefully", async () => {
      const result = await execute({
        language: "ruby" as any,
        code: 'puts "hello"',
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.error!, /Unsupported language/);
    });

    it("should report accurate duration", async () => {
      const result = await execute({
        language: "python",
        code: "import time; time.sleep(0.5); print('done')",
        timeoutMs: 5000,
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.durationMs >= 400, `Duration ${result.durationMs}ms too short`);
      assert.ok(result.durationMs < 3000, `Duration ${result.durationMs}ms too long`);
    });

    it("should handle non-zero exit code", async () => {
      const result = await execute({
        language: "python",
        code: "import sys; sys.exit(42)",
      });
      assert.equal(result.exitCode, 42);
    });

    it("should handle code that writes to both stdout and stderr", async () => {
      const result = await execute({
        language: "python",
        code: `
import sys
sys.stdout.write("out1\\n")
sys.stderr.write("err1\\n")
sys.stdout.write("out2\\n")
sys.stderr.write("err2\\n")
`,
      });
      assert.match(result.stdout, /out1/);
      assert.match(result.stdout, /out2/);
      assert.match(result.stderr, /err1/);
      assert.match(result.stderr, /err2/);
    });
  });
});
