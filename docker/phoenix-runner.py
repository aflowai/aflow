#!/usr/bin/env python3
"""
phoenix-runner: Persistent Python session for warm compute containers.

Maintains a shared globals dict across exec calls. The executor sends JSON
requests via stdin (one per line), each containing a 'code' field. The runner
executes the code in the persistent globals namespace, captures stdout/stderr,
and writes a JSON response followed by a newline.

Protocol:
  Request (stdin, one JSON line):
    {"code": "import pandas as pd; df = pd.read_csv('/tmp/input/data.csv')"}

  Response (stdout, one JSON line):
    {"exitCode": 0, "stdout": "...", "stderr": ""}

  Sentinel (stdout, after response):
    __PHOENIX_DONE__

The sentinel line allows the executor to detect the end of a response even
when user code writes to stdout (since we restore sys.stdout before writing
the response JSON, but user code could have spawned threads that write later).

This script is baked into the Docker image at /opt/phoenix/runner.py.
It is invoked once per session and stays alive for the container's lifetime.
"""

import sys
import json
import traceback
import io
import os
import signal

# Sentinel that marks end of a response — chosen to be unlikely in user output
SENTINEL = "__PHOENIX_DONE__"

# The persistent namespace shared across all exec calls in this session
_globals = {"__builtins__": __builtins__, "__name__": "__main__"}


def handle_request(request):
    """Execute code in the persistent namespace and return a result dict."""
    code = request.get("code", "")

    # Capture stdout
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    capture_out = io.StringIO()
    capture_err = io.StringIO()
    sys.stdout = capture_out
    sys.stderr = capture_err

    exit_code = 0
    try:
        compiled = compile(code, "<agent>", "exec")
        exec(compiled, _globals)
    except SystemExit as e:
        # Allow sys.exit() but capture the exit code
        exit_code = e.code if isinstance(e.code, int) else 1
    except Exception:
        exit_code = 1
        capture_err.write(traceback.format_exc())
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    return {
        "exitCode": exit_code,
        "stdout": capture_out.getvalue(),
        "stderr": capture_err.getvalue(),
    }


def main():
    # Ignore SIGTERM during code execution — let the executor handle timeouts
    # by killing the docker exec process, not this long-lived runner.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    # Ensure /tmp/output exists for file output
    os.makedirs("/tmp/output", exist_ok=True)

    # Write ready signal so the executor knows we're alive
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.write(SENTINEL + "\n")
    sys.stdout.flush()

    while True:
        line = sys.stdin.readline()
        if not line:
            # stdin closed — container shutting down
            break

        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            result = {
                "exitCode": 1,
                "stdout": "",
                "stderr": f"Invalid JSON request: {e}",
            }
            sys.stdout.write(json.dumps(result) + "\n")
            sys.stdout.write(SENTINEL + "\n")
            sys.stdout.flush()
            continue

        result = handle_request(request)

        # Write response as a single JSON line followed by sentinel
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.write(SENTINEL + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
