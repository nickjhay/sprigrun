from pathlib import Path
from queue import Queue
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from sprigrun import SprigError
from sprigrun.source import fetch
from sprigrun.testserver import FERN, TestServer


class TestServerTests(unittest.TestCase):
    def test_blob_names_listing_and_read_only_http(self):
        with TestServer() as server:
            value = server.add_source(FERN, "/grove/fern.0")
            self.assertEqual(server.add_source(FERN, "/grove/fern.0"), value)
            self.assertEqual(server.add_source(FERN, "/plot/moss.0/fern.1"), value)
            for path in (value, "/grove/fern.0", "/plot/moss.0/fern.1"):
                self.assertEqual(fetch(path, server.origin).data, FERN)
            with urlopen(server.origin, timeout=5) as response:
                self.assertEqual(response.read().decode().splitlines(), [
                    "/grove/fern.0", "/plot/moss.0/fern.1", "/sea/" + value])
            with urlopen(Request(server.origin + "/sea/" + value, method="HEAD"), timeout=5) as response:
                self.assertEqual(response.read(), b"")
                self.assertEqual(int(response.headers["Content-Length"]), len(FERN))
                self.assertEqual(response.headers["Content-Type"], "text/plain; charset=utf-8")
            for path in ("/missing", "/grove/fern.0?select=latest", "/grove/fern.1", "/grove/../fern.0"):
                with self.assertRaises(HTTPError) as error:
                    urlopen(server.origin + path, timeout=5)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(server.origin + "/grove/fern.0", data=b"changed", method=method), timeout=5)
                self.assertEqual(error.exception.code, 405)
                self.assertEqual(error.exception.headers["Allow"], "GET, HEAD")
                error.exception.close()
            self.assertEqual(fetch("/grove/fern.0", server.origin).data, FERN)

    def test_seed_validation_and_name_immutability(self):
        with TestServer() as server:
            server.add_source(FERN, "/grove/fern.0")
            before = dict(server.routes)
            for data, name in ((b"1", "/grove/fern.0"), (FERN, "../escape"),
                               (FERN, "/sea/" + "0" * 64 + "_1"), (b"\xff", None),
                               (b"x" * 262145, None)):
                self.assertRaises(SprigError, server.add_source, data, name)
                self.assertEqual(server.routes, before)

    def test_module_entry_point_serves_a_file(self):
        # This also runs against the installed wheel in CI, outside the checkout.
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "answer.sprig"
            source.write_bytes(b"6 * 7\n")
            process = subprocess.Popen(
                [sys.executable, "-m", "sprigrun.testserver", str(source),
                 "--name", "/grove/answer.0", "--port", "0"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            line = Queue()
            reader = threading.Thread(target=lambda: line.put(process.stdout.readline()), daemon=True)
            reader.start()
            try:
                origin = line.get(timeout=10).strip()
                self.assertTrue(origin.startswith("http://127.0.0.1:"), origin)
                self.assertEqual(fetch("/grove/answer.0", origin).data, b"6 * 7\n")
                run = subprocess.run(
                    [sys.executable, "-m", "sprigrun", "run-ref", "/grove/answer.0", "--origin", origin],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout, "42\n")
            finally:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
                reader.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
