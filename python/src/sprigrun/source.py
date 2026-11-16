"""Exact-byte content addresses and the native core's fixed publication paths."""

from dataclasses import dataclass
import hashlib
from http.client import HTTPException
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import SprigError, __version__

MAX_SOURCE_BYTES = 256 * 1024
ADDRESS = re.compile(r"[0-9a-f]{64}_(0|[1-9][0-9]{0,19})")
WORD = r"[a-z_][a-z0-9_]{0,31}"
NUMBER = r"(?:0|[1-9][0-9]{0,19})"
TOPIC = rf"{WORD}(?:/{WORD}){{0,7}}"
PUBLICATION = re.compile(rf"/(?:grove/{TOPIC}|plot/{WORD}\.{NUMBER}/{TOPIC})\.{NUMBER}")
DEFAULT_ORIGIN = "https://sprig.run"


def source_text(data: bytes) -> str:
    if len(data) > MAX_SOURCE_BYTES:
        raise SprigError("source exceeds 256 KiB")
    try:
        return data.decode("utf-8")
    except UnicodeError:
        raise SprigError("source must be UTF-8") from None


def address(data: bytes) -> str:
    source_text(data)
    return hashlib.sha256(data).hexdigest() + "_" + str(len(data))


def address_length(value: str) -> int:
    if not ADDRESS.fullmatch(value):
        raise SprigError("expected lowercase SHA-256 hex followed by _byte_length")
    size = int(value.split("_")[1])
    if size > MAX_SOURCE_BYTES:
        raise SprigError("source exceeds 256 KiB")
    return size


def verify(value: str, data: bytes) -> None:
    if len(data) != address_length(value) or address(data) != value:
        raise SprigError("source hash or byte length does not match its address")


def read_local(path: str) -> bytes:
    with Path(path).open("rb") as file:
        data = file.read(MAX_SOURCE_BYTES + 1)
    source_text(data)
    return data


def origin_url(value: str) -> str:
    try:
        url = urlsplit(value)
        _ = url.port  # Validate even when the default is used.
    except ValueError:
        raise SprigError("invalid server origin") from None
    if (
        not value.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in value)
        or url.username is not None or url.password is not None
        or url.query or url.fragment or url.path not in ("", "/")
        or not url.hostname or "\\" in value or "%" in value
        or (url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
        ))
    ):
        raise SprigError("use an HTTPS origin, or HTTP on literal loopback for development")
    return url.scheme + "://" + url.netloc


def reference_path(value: str) -> str:
    if ADDRESS.fullmatch(value):
        address_length(value)
        return "/sea/" + value
    path = value if value.startswith("/") else "/" + value
    if len(path) <= 512 and path.startswith("/sea/"):
        address_length(path[5:])
        return path
    if len(path) <= 512 and PUBLICATION.fullmatch(path):
        if all(int(n) <= 2**64 - 1 for n in re.findall(r"\.([0-9]+)", path)):
            return path
    raise SprigError("expected a hash_length or fixed /grove/topic.0 or /plot/handle.0/topic.0 reference")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _get(url: str, limit: int) -> bytes:
    # No redirect can silently change the server, path or pinned publication.
    request = Request(url, headers={"Accept": "text/plain", "Accept-Encoding": "identity",
                                    "User-Agent": "sprigrun/" + __version__})
    try:
        with build_opener(_NoRedirect()).open(request, timeout=10) as response:
            if response.status != 200:
                raise SprigError("source server must return HTTP 200")
            if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                raise SprigError("compressed responses are not supported")
            data = response.read(limit + 1)
    except HTTPError as error:
        error.close()
        raise SprigError(f"source server returned HTTP {error.code}; use a fixed, available reference") from None
    except (URLError, OSError, ValueError, HTTPException):
        raise SprigError("could not fetch source (check origin, TLS and connection)") from None
    if len(data) > limit:
        raise SprigError("response exceeds its byte limit")
    return data


@dataclass(frozen=True)
class Source:
    data: bytes
    address: str
    url: str


def fetch(reference: str, origin: str = DEFAULT_ORIGIN) -> Source:
    if "://" in reference:
        # Validate the unmodified input before urlsplit can discard controls.
        if not reference.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in reference):
            raise SprigError("invalid source URL")
        try:
            url = urlsplit(reference)
        except ValueError:
            raise SprigError("invalid source URL") from None
        if "?" in reference or "#" in reference:
            raise SprigError("use a fixed reference without a query or fragment")
        origin, reference = origin_url(url.scheme + "://" + url.netloc), url.path
    else:
        origin = origin_url(origin)
    path = reference_path(reference)
    if not path.startswith("/sea/"):
        # Phase-0 publication bodies are exactly '/sea/<hash_length>\n'.
        binding = _get(origin + path, 96)
        try:
            text = binding.decode("ascii")
        except UnicodeError:
            raise SprigError("publication must contain a /sea/hash_length reference") from None
        if not text.startswith("/sea/") or not text.endswith("\n"):
            raise SprigError("publication must contain a /sea/hash_length reference and newline")
        path = reference_path(text[:-1])
    value = path[5:]
    data = _get(origin + path, address_length(value))
    verify(value, data)
    return Source(data, value, origin + path)
