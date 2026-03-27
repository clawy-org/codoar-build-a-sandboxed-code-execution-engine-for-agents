# Sandbox Executor

A self-contained TypeScript module for safely executing untrusted code snippets in Python, JavaScript, and TypeScript.

## Features

- **Multi-language support**: Python 3, JavaScript, and TypeScript (via Node's `--experimental-strip-types`)
- **Resource limits**: Configurable memory cap (default 128MB) and CPU timeout (default 10s)
- **Output capture**: Structured results with stdout, stderr, exit code, duration, and truncation status
- **Network blocking**: Blocks socket, HTTP, and HTTPS access by default (opt-in with `allowNetwork`)
- **Fork bomb protection**: Blocks `os.fork()` and `os.execve()` in Python
- **Output truncation**: Caps output at 1MB to prevent memory exhaustion
- **Automatic cleanup**: All temp files removed after execution
- **Zero external dependencies**: Uses only Node.js built-ins

## Requirements

- Node.js >= 20 (Node 22+ for TypeScript support)
- Python 3.10+ (for Python execution)
- Linux

## Interface

```typescript
interface ExecOptions {
  language: "python" | "javascript" | "typescript";
  code: string;
  stdin?: string;
  timeoutMs?: number;      // default: 10000
  memoryMb?: number;       // default: 128
  allowNetwork?: boolean;  // default: false
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

function execute(options: ExecOptions): Promise<ExecResult>
```

## Usage

```typescript
import { execute } from "./src/index.ts";

// Run Python code
const result = await execute({
  language: "python",
  code: 'print("Hello from sandbox!")',
});
console.log(result.stdout); // "Hello from sandbox!\n"

// Run JavaScript with timeout
const result2 = await execute({
  language: "javascript",
  code: 'console.log(2 + 2)',
  timeoutMs: 5000,
});

// Run with stdin
const result3 = await execute({
  language: "python",
  code: 'name = input(); print(f"Hi {name}")',
  stdin: "World\n",
});
```

## Security Model

1. **Network isolation**: Python sockets and urllib are monkey-patched to raise errors. Node's `net`, `http`, and `https` modules are blocked.
2. **Fork protection**: Python's `os.fork()` and `os.execve()` are blocked.
3. **Memory limits**: JavaScript/TypeScript use `--max-old-space-size` flag.
4. **Timeout enforcement**: Processes are killed with SIGKILL after timeout.
5. **Filesystem isolation**: Temp directory is isolated per execution and cleaned up.
6. **Minimal environment**: Only essential PATH and locale variables are passed.

## Running Tests

```bash
node --experimental-strip-types --no-warnings --test tests/executor.test.ts
```

All 25 tests cover: basic execution, stderr capture, syntax errors, stdin, timeouts, memory limits, output truncation, network blocking, fork bomb protection, filesystem restrictions, and edge cases.

## Test Results

```
✔ Sandboxed Code Executor
  ✔ Python execution (5 tests)
  ✔ JavaScript execution (3 tests)
  ✔ TypeScript execution (1 test)
  ✔ Timeout (3 tests)
  ✔ Memory limits (1 test)
  ✔ Output truncation (1 test)
  ✔ Network blocking (3 tests)
  ✔ Fork bomb protection (1 test)
  ✔ Filesystem restrictions (2 tests)
  ✔ Edge cases (5 tests)
25/25 passing
```
