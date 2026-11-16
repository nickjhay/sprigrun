from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
from pathlib import Path
import tempfile
import threading
import unittest

from sprigrun import SprigError
from sprigrun.cli import main
from sprigrun.source import address, address_length, fetch, origin_url, reference_path, verify

SOURCE = b"#!sprig.run/spec/sprig/0.1\n1 + 2\n"
ADDRESS = address(SOURCE)


class Sources(unittest.TestCase):
    def test_exact_bytes(self):
        self.assertEqual(address(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855_0")
        self.assertNotEqual(address(b"1\n"), address(b"1\r\n"))
        self.assertNotEqual(address(b"1"), address(b"\xef\xbb\xbf1"))
        self.assertTrue(address("🌿".encode()).endswith("_4"))
        verify(ADDRESS, SOURCE)
        for data in (SOURCE[:-1], SOURCE + b"\n", SOURCE.replace(b"2", b"3")):
            self.assertRaises(SprigError, verify, ADDRESS, data)
        self.assertRaises(SprigError, address, b"\xff")
        self.assertRaises(SprigError, address, b"x" * (256 * 1024 + 1))

    def test_references(self):
        for ref in ("/grove/fern.0", "/grove/a/b.12", "/plot/nick.0/fern.12"):
            self.assertEqual(reference_path(ref), ref)
        self.assertEqual(reference_path(ADDRESS), "/sea/" + ADDRESS)
        self.assertEqual(reference_path("grove/fern.0"), "/grove/fern.0")
        for ref in ("/plot/nick.0", "/grove/fern.01", "/grove/fern.18446744073709551616",
                    "/grove/../fern.0", "/grove/Fern.0", "/grove/a%2fb.0",
                    "/chat/grove/fern.0/0", "/grove/fern.0/step/1", "/grove/fern?select=latest",
                    "/grove/" + "a/" * 8 + "b.0", "/grove/" + "a" * 33 + ".0"):
            self.assertRaises(SprigError, reference_path, ref)
        for value in (ADDRESS.upper(), "f" * 64 + "_01", "f" * 64 + "_262145", ADDRESS + "\n"):
            self.assertRaises(SprigError, address_length, value)

    def test_origins(self):
        for value in ("https://sprig.run", "https://example.org:443", "http://127.0.0.1:8789",
                      "http://localhost:8789", "http://[::1]:8789"):
            self.assertEqual(origin_url(value), value)
        for value in ("http://example.org", "file:///tmp", "https://user:pw@sprig.run",
                      "https://sprig.run/a", "https://sprig.run/?x=1", "https://sprig.run/#x",
                      "https://sprig.run:abc", "https://sprig.run\n", "https://sprig.run\\evil",
                      "http://127.1", "https://sprig.run%2f.evil"):
            self.assertRaises(SprigError, origin_url, value)


class RemoteSources(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routes = {}
        cls.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.requests.append(self.path)
                status, data, headers = cls.routes.get(self.path, (404, b"missing", {}))
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.routes.clear()
        self.requests.clear()
        self.routes["/sea/" + ADDRESS] = (200, SOURCE, {})
        self.routes["/grove/fern.0"] = (200, ("/sea/" + ADDRESS + "\n").encode(), {})

    def test_hash_and_named_source(self):
        for ref in (ADDRESS, "/sea/" + ADDRESS, "/grove/fern.0", self.origin + "/grove/fern.0"):
            with self.subTest(ref=ref):
                result = fetch(ref, self.origin)
                self.assertEqual(result.data, SOURCE)
                self.assertEqual(result.address, ADDRESS)
        self.assertEqual(self.requests[-2:], ["/grove/fern.0", "/sea/" + ADDRESS])

    def test_corruption_and_limits(self):
        for data in (SOURCE[:-1], SOURCE + b"x", SOURCE.replace(b"2", b"3")):
            self.routes["/sea/" + ADDRESS] = (200, data, {})
            self.assertRaises(SprigError, fetch, ADDRESS, self.origin)
        self.routes["/sea/" + ADDRESS] = (200, SOURCE, {"Content-Encoding": "gzip"})
        self.assertRaises(SprigError, fetch, ADDRESS, self.origin)
        self.routes["/sea/" + ADDRESS] = (206, SOURCE, {})
        self.assertRaises(SprigError, fetch, ADDRESS, self.origin)

    def test_publication_cannot_redirect_or_chain(self):
        for data in (b"/grove/fern.0\n", b"https://example.org/source\n", b"x" * 97,
                     ("/sea/" + ADDRESS).encode(), b"\xff\n", ("/sea/" + ADDRESS + "\n\n").encode()):
            self.routes["/grove/fern.0"] = (200, data, {})
            self.assertRaises(SprigError, fetch, "/grove/fern.0", self.origin)
        for location in ("/sea/" + ADDRESS, "https://example.org/private"):
            self.requests.clear()
            self.routes["/grove/fern.0"] = (303, b"", {"Location": location})
            self.assertRaises(SprigError, fetch, "/grove/fern.0", self.origin)
            self.assertEqual(self.requests, ["/grove/fern.0"])

    def test_cli_and_no_unverified_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fern.sprig"
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(main(["run-ref", "/grove/fern.0", "--origin", self.origin]), 0)
                self.assertEqual(out.getvalue(), "3\n")
                self.assertIn(ADDRESS, err.getvalue())
                self.assertEqual(main(["fetch", ADDRESS, "--origin", self.origin, "-o", str(path)]), 0)
                self.assertEqual(path.read_bytes(), SOURCE)
                self.assertEqual(main(["run", str(path)]), 0)
                self.assertEqual(main(["verify", ADDRESS, str(path)]), 0)
                self.assertEqual(main(["fetch", ADDRESS, "--origin", self.origin, "-o", str(path)]), 1)
                self.assertEqual(path.read_bytes(), SOURCE)
                self.routes["/sea/" + ADDRESS] = (200, SOURCE.replace(b"2", b"3"), {})
                other = Path(folder) / "bad.sprig"
                self.assertEqual(main(["fetch", ADDRESS, "--origin", self.origin, "-o", str(other)]), 1)
                self.assertFalse(other.exists())


if __name__ == "__main__":
    unittest.main()
