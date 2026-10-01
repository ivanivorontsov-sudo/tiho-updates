#!/usr/bin/env python3
"""Verifies an `incoming` push before it is published: minisign signature of update-v2.json by the pinned CI key
(or the offline primary/backup keys), trusted comment, package, versions, and SHA-256/size of every APK."""
import base64, hashlib, json, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def pub(path):
    line = [l for l in open(path).read().splitlines() if l and not l.startswith("untrusted")][0]
    raw = base64.b64decode(line)
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:42])

keys = [pub(os.path.join("keys", k)) for k in ("tiho-content-ci.pub", "tiho-content-primary.pub", "tiho-content-backup.pub")]
src = sys.argv[1]
data = open(os.path.join(src, "update-v2.json"), "rb").read()
s = open(os.path.join(src, "update-v2.json.minisig")).read().splitlines()
sraw = base64.b64decode(s[1]); alg, kid, sig = sraw[:2], sraw[2:10], sraw[10:]
k = next((pk for i, pk in keys if i == kid), None)
assert k is not None, "unknown signing key"
k.verify(sig, hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data)
tc = s[2][len("trusted comment: "):]
k.verify(base64.b64decode(s[3]), sig + tc.encode())
u = json.loads(data)
assert u["package"] == "org.ivanivorontsov.tiho"
assert tc.startswith(f"tiho-app {u['version_code']} "), "trusted comment mismatch"
meta = json.load(open(os.path.join(src, "meta.json")))
assert meta["version"] == u["version_name"]
if not meta.get("refresh"):
    base = f"https://github.com/ivanivorontsov-sudo/tiho-updates/releases/download/app-v{u['version_name']}/"
    for abi, a in list(u.get("apks", {}).items()) + [("legacy", {"url": u["apk_url"], "sha256": u["sha256"], "size": u["size"]})]:
        assert a["url"].startswith(base), a["url"]
        f = os.path.join(src, "apks", a["url"][len(base):])
        b = open(f, "rb").read()
        assert len(b) == a["size"] and hashlib.sha256(b).hexdigest() == a["sha256"], f"hash/size mismatch: {f}"
print("OK:", tc)
