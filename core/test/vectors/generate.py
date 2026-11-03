"""Reproduce public test vectors independently of the TypeScript implementation.

Optional developer tool: requires Python cryptography. The fixed private seed is
PUBLIC TEST DATA, never a production identity. CI reads the frozen JSON instead.
"""
import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def address(text):
    data = text.encode("utf-8")
    return hashlib.sha256(data).hexdigest() + "_" + str(len(data))


seed = bytes(range(32))
key = Ed25519PrivateKey.from_private_bytes(seed)
public = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
record = "#!sprig.run/spec/key/1\nalgorithm: ed25519\npublic-key: " + b64(public) + "\n"
key_ref = "/sea/" + address(record)
origin = "https://sprig.run"
binding = "#!sprig.run/spec/plot/1\norigin: " + origin + "\nplot: /plot/vector.0\nkey: " + key_ref + "\n"
cases = []
for author in [key_ref, "/plot/vector.0"]:
    action = "#!sprig.run/spec/action/1\nauthor: " + author + "\n\nPOST " + origin + "/chat/grove/fern.7/12\n\nHello from the fern. 🌿\n"
    cases.append({"action": action, "id": address(action), "signature": b64(key.sign(action.encode("utf-8")))})
fixture = {"warning": "PUBLIC TEST KEY. Never use for a seed identity or production authority.",
           "generator": "Python cryptography Ed25519, independent of core/src",
           "private_seed_hex": seed.hex(), "public_key": b64(public),
           "key_record": record, "key_reference": key_ref,
           "plot_binding": binding, "plot_binding_id": address(binding), "cases": cases}
Path(__file__).with_name("ed25519.json").write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
