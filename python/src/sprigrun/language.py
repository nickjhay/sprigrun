"""Parse Python expression syntax, then interpret an explicit, bounded subset.

No source is compiled to bytecode or passed to eval/exec. Every syntax node is
checked before execution, including branches that will not be evaluated.
"""

import ast

from . import SprigError

HEADER = "#!sprig.run/spec/sprig/0.1"
MAX_SOURCE_BYTES = 8192
MAX_STRING_BYTES = 4096
MAX_INTEGER = 2**63 - 1
MAX_NODES = 256
MAX_DEPTH = 32

ALLOWED = (
    ast.Expression, ast.Constant, ast.BinOp, ast.UnaryOp, ast.BoolOp,
    ast.Compare, ast.IfExp, ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod,
    ast.UAdd, ast.USub, ast.Not, ast.And, ast.Or, ast.Eq, ast.NotEq,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE,
)


def bounded(value):
    if type(value) is int:
        if abs(value) > MAX_INTEGER:
            raise SprigError("integer exceeds the 63-bit magnitude limit")
    elif type(value) is str:
        try:
            size = len(value.encode("utf-8"))
        except UnicodeError:
            raise SprigError("strings must contain valid Unicode scalar values") from None
        if size > MAX_STRING_BYTES:
            raise SprigError("string exceeds 4096 UTF-8 bytes")
    elif value is not None and type(value) is not bool:
        raise SprigError("only integers, strings, booleans and None are supported")
    return value


def evaluate(source: str):
    try:
        size = len(source.encode("utf-8"))
    except UnicodeError:
        raise SprigError("source must be UTF-8") from None
    if size > MAX_SOURCE_BYTES:
        raise SprigError("Sprig 0.1 expressions are limited to 8192 UTF-8 bytes")
    source = source.strip()
    if source.startswith("#!") and source.splitlines()[0] != HEADER:
        raise SprigError("unsupported language header; expected " + HEADER)
    try:
        tree = ast.parse(source, mode="eval")
    except (SyntaxError, ValueError, RecursionError):
        raise SprigError("expected one Sprig 0.1 expression") from None
    pending = [(tree, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise SprigError("expression exceeds the node or nesting limit")
        if type(node) not in ALLOWED:
            raise SprigError("unsupported syntax: " + type(node).__name__)
        if type(node) is ast.Constant:
            bounded(node.value)
        pending.extend((child, depth + 1) for child in ast.iter_child_nodes(node))
    return _run(tree.body)


def _run(node):
    if type(node) is ast.Constant:
        return node.value
    if type(node) is ast.IfExp:
        return _run(node.body if _run(node.test) else node.orelse)
    if type(node) is ast.BoolOp:
        for child in node.values:
            result = _run(child)
            if (isinstance(node.op, ast.And) and not result) or (
                isinstance(node.op, ast.Or) and result
            ):
                break
        return result
    if type(node) is ast.UnaryOp:
        value = _run(node.operand)
        if type(node.op) is ast.Not:
            return not value
        if type(value) is not int:
            raise SprigError("unary arithmetic requires an integer")
        return bounded(value if type(node.op) is ast.UAdd else -value)
    if type(node) is ast.Compare:
        left = _run(node.left)
        for op, child in zip(node.ops, node.comparators):
            right = _run(child)
            if type(op) is ast.Eq:
                ok = left == right
            elif type(op) is ast.NotEq:
                ok = left != right
            else:
                if type(left) is not type(right) or type(left) not in (int, str):
                    raise SprigError("ordering requires two integers or two strings")
                if type(op) is ast.Lt:
                    ok = left < right
                elif type(op) is ast.LtE:
                    ok = left <= right
                elif type(op) is ast.Gt:
                    ok = left > right
                else:
                    ok = left >= right
            if not ok:
                return False
            left = right
        return True
    if type(node) is ast.BinOp:
        left, right, op = _run(node.left), _run(node.right), type(node.op)
        if op is ast.Add and type(left) is str and type(right) is str:
            if len(left.encode("utf-8")) + len(right.encode("utf-8")) > MAX_STRING_BYTES:
                raise SprigError("string exceeds 4096 UTF-8 bytes")
            return left + right
        if op is ast.Mult and (type(left), type(right)) in ((str, int), (int, str)):
            value, times = (left, right) if type(left) is str else (right, left)
            times = max(0, times)
            if len(value.encode("utf-8")) * times > MAX_STRING_BYTES:
                raise SprigError("string exceeds 4096 UTF-8 bytes")
            return value * times if value else ""
        if type(left) is not int or type(right) is not int:
            raise SprigError("arithmetic requires integers (or string + / *)")
        if op in (ast.FloorDiv, ast.Mod) and right == 0:
            raise SprigError("division by zero")
        if op is ast.Add:
            result = left + right
        elif op is ast.Sub:
            result = left - right
        elif op is ast.Mult:
            result = left * right
        elif op is ast.FloorDiv:
            result = left // right
        else:
            result = left % right
        return bounded(result)
    raise AssertionError("unvalidated syntax")
