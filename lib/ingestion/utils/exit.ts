/**
 * Ends a CLI process without tripping libuv on Windows.
 *
 * Calling `process.exit()` while sockets are mid-close makes Node abort with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... src\win\async.c`.
 * `fetch` keeps connections alive after the last response, so any script that made
 * HTTP requests hits this on exit.
 *
 * Setting `exitCode` and letting the loop drain avoids it. The unref'd fallback timer
 * covers the opposite failure — a keep-alive socket that never closes would otherwise
 * hang the script forever — and being unref'd it never delays a clean exit.
 */
export function finishProcess(exitCode: number, graceMs = 3_000): void {
  process.exitCode = exitCode;

  const fallback = setTimeout(() => {
    process.exit(exitCode);
  }, graceMs);
  fallback.unref();
}
