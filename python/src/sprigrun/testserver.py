"""A read-only, in-memory protocol fixture. Loopback only; not a public host.

Run ``python -m sprigrun.testserver`` for a fern, or use TestServer in tests.
There are no dependencies on the hosting implementation or its repository.
"""

import argparse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import threading

from . import SprigError
from .source import address, read_local, reference_path

FERN = b'#!sprig.run/spec/sprig/0.1\n"room for " + "another fern"\n'


class TestServer:
    """Context-managed fixture with exact byte responses and fault injection.

    Call add_source before sending requests. Tests may override entries in
    routes with (status, bytes, headers) to exercise hostile server responses.
    Only the last 256 request paths are recorded. No HTTP method changes data.
    """

    def __init__(self, port=0):
        self.routes = {}
        self.requests = deque(maxlen=256)
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                self.request.settimeout(5)
                super().setup()

            def do_GET(self):
                self._read(body=True)

            def do_HEAD(self):
                self._read(body=False)

            def _read(self, body):
                fixture.requests.append(self.path)
                if self.path == "/":
                    result = (200, ("\n".join(sorted(fixture.routes)) + "\n").encode(), {})
                else:
                    result = fixture.routes.get(self.path, (404, b"not found\n", {}))
                status, data, headers = result
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if body:
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # A client may deliberately stop an oversized read.

            def do_POST(self):
                self.send_response(405)
                self.send_header("Allow", "GET, HEAD")
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_PUT = do_PATCH = do_DELETE = do_POST

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.origin = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    def add_source(self, data: bytes, name: str | None = None) -> str:
        """Seed a blob and optionally a fixed publication name; return hash_length."""
        value = address(data)
        path = reference_path(name) if name is not None else None
        if path is not None:
            if path.startswith("/sea/"):
                raise SprigError("a publication name must be a grove or plot reference")
            binding = (200, ("/sea/" + value + "\n").encode(), {})
            if path in self.routes and self.routes[path] != binding:
                raise SprigError("that publication name already points to another source")
            self.routes[path] = binding
        self.routes["/sea/" + value] = (200, data, {})
        return value

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()

    def wait(self):
        self._thread.join()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only Sprig test server on 127.0.0.1; in-memory, local testing only.")
    parser.add_argument("file", nargs="?", help="source file (default: a small fern expression)")
    parser.add_argument("--name", default="/grove/fern.0", help="fixed publication name")
    parser.add_argument("--port", type=int, default=8789, help="loopback port; 0 picks an available port (default: 8789)")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    try:
        data = read_local(args.file) if args.file else FERN
        with TestServer(args.port) as server:
            value = server.add_source(data, args.name)
            print(server.origin, flush=True)
            print("source: /sea/" + value, flush=True)
            print("name:   " + reference_path(args.name), flush=True)
            print("Read-only test server; Ctrl+C stops it.", flush=True)
            server.wait()
    except KeyboardInterrupt:
        pass
    except SprigError as error:
        print("sprigrun test server: " + str(error), file=sys.stderr)
        return 1
    except OSError:
        print("sprigrun test server: could not read the file or bind the loopback port", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
