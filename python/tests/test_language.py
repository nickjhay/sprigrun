import unittest

from sprigrun import SprigError
from sprigrun.language import HEADER, MAX_INTEGER, evaluate


class LanguageTests(unittest.TestCase):
    def test_expressions(self):
        cases = {
            "1 + 2 * 3": 7,
            "-7 // 3": -3,
            "-7 % 3": 2,
            "-(-2) + +3": 5,
            "'fern' + 's'": "ferns",
            "3 * 'frond '": "frond frond frond ",
            "'fern' * -1": "",
            "'' * 9223372036854775807": "",
            "'fern' if 1 < 2 <= 3 else 'stone'": "fern",
            "None or 'moss'": "moss",
            "'a' and 'b'": "b",
            "False and 1 // 0": False,
            "True or 1 // 0": True,
            "3 if True else 1 // 0": 3,
            "3 < 2 < 1 // 0": False,
            "not None": True,
            "'a' < 'b'": True,
            "True == 1": True,
            "None != False": True,
            HEADER + "\n1 + 2\n": 3,
        }
        for source, result in cases.items():
            with self.subTest(source=source):
                self.assertEqual(evaluate(source), result)

    def test_unsupported_syntax_even_in_unused_branches(self):
        for source in (
            "__import__('os').system('id')", "(1).__class__", "open('file')",
            "False and open('file')", "0 if True else (lambda: 3)()",
            "[x for x in (1, 2)]", "[1, 2]", "{'a': 1}", "(1, 2)",
            "'abc'[0]", "f'{1}'", "(x := 1)", "1; 2", "import os",
            "2 ** 3", "1 << 2", "2 / 1", "1.0", "1j", "b'hi'",
            "...", "'a' in 'abc'", "None is None", "# comment only",
            "#!sprig.run/spec/sprig/999\n1", " \n#!python\n1",
        ):
            with self.subTest(source=source):
                self.assertRaises(SprigError, evaluate, source)

    def test_resource_boundaries(self):
        self.assertEqual(evaluate(str(MAX_INTEGER)), MAX_INTEGER)
        self.assertEqual(evaluate("'é' * 2048"), "é" * 2048)
        self.assertEqual(evaluate("'x' * 4096 + ''"), "x" * 4096)
        for source in (
            str(MAX_INTEGER + 1), f"{MAX_INTEGER} + 1", f"{MAX_INTEGER} * 2",
            f"-{MAX_INTEGER} - 1", "'x' * 9223372036854775807", "'é' * 2049",
            "'x' * 4096 + 'y'", "'\\ud800'", "1" + " " * 8192,
            "-" * 40 + "1", " + ".join(["1"] * 100),
            " and ".join(["True"] * 254), "(" * 400 + "1" + ")" * 400,
        ):
            with self.subTest(source=source[:100]):
                self.assertRaises(SprigError, evaluate, source)

    def test_type_and_zero_errors(self):
        for source in ("1 + 'a'", "True + 1", "'a' * True", "-'a'", "1 < 'a'",
                       "None >= 0", "'x' % 2", "1 // 0", "1 % 0"):
            with self.subTest(source=source):
                self.assertRaises(SprigError, evaluate, source)


if __name__ == "__main__":
    unittest.main()
