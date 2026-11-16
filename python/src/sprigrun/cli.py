import argparse
import sys

from . import SprigError, __version__
from .language import evaluate
from .source import DEFAULT_ORIGIN, address, fetch, read_local, source_text, verify


def parser():
    root = argparse.ArgumentParser(description="Sprig 0.1: the smallest sprig. Bounded expressions, verified sources.")
    root.add_argument("--version", action="version", version="sprigrun " + __version__)
    commands = root.add_subparsers(dest="command", required=True)
    expr = commands.add_parser("eval", help="evaluate one Sprig 0.1 expression")
    expr.add_argument("expression")
    run = commands.add_parser("run", help="run a local source file")
    run.add_argument("file")
    for name, help_text in (("fetch", "fetch and verify remote source"), ("run-ref", "fetch, verify, and run a remote source")):
        remote = commands.add_parser(name, help=help_text)
        remote.add_argument("reference", help="hash_length, fixed publication path, or full URL")
        remote.add_argument("--origin", default=DEFAULT_ORIGIN, help="server origin (default: %(default)s)")
        if name == "fetch":
            remote.add_argument("-o", "--output", required=True, help="new file to create; never overwrites")
    digest = commands.add_parser("hash", help="print the exact UTF-8 source's hash_length")
    digest.add_argument("file")
    check = commands.add_parser("verify", help="verify a file's exact hash and byte length")
    check.add_argument("address")
    check.add_argument("file")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "eval":
            print(repr(evaluate(args.expression)))
        elif args.command == "run":
            print(repr(evaluate(source_text(read_local(args.file)))))
        elif args.command == "hash":
            print(address(read_local(args.file)))
        elif args.command == "verify":
            verify(args.address, read_local(args.file))
            print(args.address)
        else:
            source = fetch(args.reference, args.origin)
            print("verified " + source.address, file=sys.stderr)
            if args.command == "run-ref":
                print(repr(evaluate(source_text(source.data))))
            else:
                with open(args.output, "xb") as target:
                    target.write(source.data)
        return 0
    except SprigError as error:
        print("sprigrun: " + str(error), file=sys.stderr)
    except OSError:
        print("sprigrun: file or connection operation failed (output files must be new)", file=sys.stderr)
    return 1
