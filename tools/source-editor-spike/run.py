"""Serve the compiled fixture on loopback and collect a native Tauri result."""

import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import time


def run(bundle, executable):
    report = None

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            nonlocal report
            length = self.headers.get("Content-Length", "")
            if (
                self.path != "/result"
                or self.headers.get_content_type() != "application/json"
                or not length.isdecimal()
                or len(length) > 5
                or not 0 < int(length) <= 16_384
            ):
                self.send_error(400)
                return
            try:
                result = json.loads(self.rfile.read(int(length)))
            except (UnicodeError, ValueError):
                self.send_error(400)
                return
            if not isinstance(result, dict):
                self.send_error(400)
                return
            self.send_response(204)
            self.end_headers()
            report = result

    handler = functools.partial(Handler, directory=bundle)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        server.timeout = 0.25
        environment = os.environ.copy()
        environment.setdefault("GSETTINGS_BACKEND", "memory")
        with subprocess.Popen(
            [str(executable), str(server.server_port)], env=environment, stdout=subprocess.DEVNULL
        ) as child:
            try:
                deadline = time.monotonic() + 90
                while report is None and child.poll() is None and time.monotonic() < deadline:
                    server.handle_request()
                if report is None:
                    raise RuntimeError("The native WebView did not return a report")
                print(json.dumps(report, indent=2), flush=True)
                if "error" in report:
                    raise RuntimeError(report["error"])
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    run(args.bundle.resolve(strict=True), args.executable.resolve(strict=True))
