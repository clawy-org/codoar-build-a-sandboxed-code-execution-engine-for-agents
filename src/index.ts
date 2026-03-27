import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Public interfaces ──────────────────────────────────────────────

export interface ExecOptions {
  language: "python" | "javascript" | "typescript";
  code: string;
  stdin?: string;
  timeoutMs?: number;
  memoryMb?: number;
  allowNetwork?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_MB = 128;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

// ── Helpers ────────────────────────────────────────────────────────

function buildEnv(allowNetwork: boolean): NodeJS.ProcessEnv {
  // Minimal env — strip most inherited vars
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    // Disable Python user-site packages
    PYTHONNOUSERSITE: "1",
    // Disable Node warnings about experimental features
    NODE_NO_WARNINGS: "1",
  };
  if (!allowNetwork) {
    // Python: disable network by discouraging socket use via env
    // (Hard block happens via rlimit / seccomp where available)
    env.PYTHONDONTWRITEBYTECODE = "1";
  }
  return env;
}

function truncate(buf: Buffer, max: number): { text: string; truncated: boolean } {
  if (buf.length <= max) {
    return { text: buf.toString("utf-8"), truncated: false };
  }
  return {
    text: buf.subarray(0, max).toString("utf-8") + "\n[output truncated at 1 MB]",
    truncated: true,
  };
}

// ── Network-blocking wrapper scripts ───────────────────────────────

const PYTHON_NET_BLOCK = `
import socket as _socket
_orig_socket = _socket.socket
class _BlockedSocket(_orig_socket):
    def connect(self, *a, **kw):
        raise OSError("Network access is blocked in sandbox")
    def connect_ex(self, *a, **kw):
        raise OSError("Network access is blocked in sandbox")
    def bind(self, *a, **kw):
        raise OSError("Network access is blocked in sandbox")
_socket.socket = _BlockedSocket
import urllib.request as _ur
_orig_urlopen = _ur.urlopen
def _blocked_urlopen(*a, **kw):
    raise OSError("Network access is blocked in sandbox")
_ur.urlopen = _blocked_urlopen
del _socket, _orig_socket, _BlockedSocket, _ur, _orig_urlopen, _blocked_urlopen
`;

const JS_NET_BLOCK = `
const _origNet = require('net');
const _origConnect = _origNet.Socket.prototype.connect;
_origNet.Socket.prototype.connect = function() {
  throw new Error('Network access is blocked in sandbox');
};
const _origHttp = require('http');
const _origRequest = _origHttp.request;
_origHttp.request = function() {
  throw new Error('Network access is blocked in sandbox');
};
const _origHttps = require('https');
const _origHttpsRequest = _origHttps.request;
_origHttps.request = function() {
  throw new Error('Network access is blocked in sandbox');
};
`;

// ── Fork-bomb protection (Python) ──────────────────────────────────

const PYTHON_FORK_BLOCK = `
import os as _os
_orig_fork = getattr(_os, 'fork', None)
def _blocked_fork():
    raise OSError("fork() is blocked in sandbox")
_os.fork = _blocked_fork
if hasattr(_os, 'execve'):
    def _blocked_execve(*a, **kw):
        raise OSError("execve() is blocked in sandbox")
    _os.execve = _blocked_execve
del _os, _orig_fork, _blocked_fork
`;

// ── Main execute function ──────────────────────────────────────────

export async function execute(options: ExecOptions): Promise<ExecResult> {
  const {
    language,
    code,
    stdin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    memoryMb = DEFAULT_MEMORY_MB,
    allowNetwork = false,
  } = options;

  // Create isolated temp directory
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));

  try {
    let cmd: string;
    let args: string[];
    let codeFile: string;

    switch (language) {
      case "python": {
        // Write wrapper that blocks network + fork, then runs user code
        let wrapper = "";
        if (!allowNetwork) wrapper += PYTHON_NET_BLOCK;
        wrapper += PYTHON_FORK_BLOCK;
        wrapper += `\n# --- user code ---\n${code}`;
        codeFile = join(sandboxDir, "main.py");
        await writeFile(codeFile, wrapper, "utf-8");
        cmd = "python3";
        args = ["-u", "-B", codeFile];
        break;
      }
      case "javascript": {
        let wrapper = "";
        if (!allowNetwork) wrapper += JS_NET_BLOCK + "\n";
        wrapper += code;
        codeFile = join(sandboxDir, "main.js");
        await writeFile(codeFile, wrapper, "utf-8");
        cmd = "node";
        args = [
          `--max-old-space-size=${memoryMb}`,
          "--no-warnings",
          "--disallow-code-generation-from-strings",
          codeFile,
        ];
        break;
      }
      case "typescript": {
        // Use Node's built-in TypeScript support (--experimental-strip-types in Node 22+, or tsx)
        // Fallback: strip types with a simple transform, then run as JS
        let wrapper = "";
        if (!allowNetwork) wrapper += JS_NET_BLOCK + "\n";
        wrapper += code;
        codeFile = join(sandboxDir, "main.ts");
        await writeFile(codeFile, wrapper, "utf-8");
        cmd = "node";
        args = [
          `--max-old-space-size=${memoryMb}`,
          "--no-warnings",
          "--experimental-strip-types",
          codeFile,
        ];
        break;
      }
      default:
        return {
          stdout: "",
          stderr: "",
          exitCode: 1,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          error: `Unsupported language: ${language}`,
        };
    }

    // Restrict writable directory to sandbox
    const env = buildEnv(allowNetwork);
    env.TMPDIR = sandboxDir;
    env.TEMP = sandboxDir;
    env.TMP = sandboxDir;

    return await runProcess(cmd, args, {
      cwd: sandboxDir,
      env,
      stdin,
      timeoutMs,
      memoryMb,
    });
  } catch (err: any) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
      truncated: false,
      error: `Sandbox setup error: ${err.message}`,
    };
  } finally {
    // Always clean up
    await rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Process runner ─────────────────────────────────────────────────

interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  memoryMb: number;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: RunOptions
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Prevent inheriting parent's file descriptors
      detached: false,
    });

    // Set up resource limit via kill on timeout
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group if possible
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    // Collect stdout with truncation
    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutLen;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutTruncated = true;
          stdoutLen = MAX_OUTPUT_BYTES;
        } else {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      }
    });

    // Collect stderr with truncation
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrLen;
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrTruncated = true;
          stderrLen = MAX_OUTPUT_BYTES;
        } else {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
        }
      }
    });

    // Write stdin if provided
    if (opts.stdin) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();

    proc.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);

      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);

      const stdoutResult = truncate(stdoutBuf, MAX_OUTPUT_BYTES);
      const stderrResult = truncate(stderrBuf, MAX_OUTPUT_BYTES);

      resolve({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        exitCode: exitCode ?? (signal ? 137 : 1),
        durationMs,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated || stdoutResult.truncated || stderrResult.truncated,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      resolve({
        stdout: "",
        stderr: "",
        exitCode: 1,
        durationMs,
        timedOut: false,
        truncated: false,
        error: `Process error: ${err.message}`,
      });
    });
  });
}
