#!/usr/bin/env python3
"""Import Chrome cookies into PI-Desktop work-browser cookie DB (macOS).

Decryption uses the off-the-shelf Chromium/browser_cookie3 scheme:
  key = PBKDF2(keychain_password_raw_string, b'saltysalt', 1003 iters, 16 bytes)
  iv  = 16 spaces (0x20)
  plaintext = unpad(AES-128-CBC-decrypt(key, iv, encrypted_value[3:]))  # strip b'v10'

Chrome cookie values are then upserted into PI-Desktop's work-browser Cookies
DB as PLAINTEXT (encrypted_value cleared), matching the format PI-Desktop's own
browser already uses for its cookies.
"""
import base64
import os
import sqlite3
import subprocess
import sys
import time

from Cryptodome.Cipher import AES
from Cryptodome.Protocol.KDF import PBKDF2
from Cryptodome.Util.Padding import unpad

CHROME_DB = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/Default/Cookies"
)
PI_DB = os.path.expanduser(
    "~/Library/Application Support/PI-Desktop/Partitions/work-browser/Cookies"
)


def get_keychain_key() -> bytes:
    """Return the raw Chrome Safe Storage keychain password string."""
    return subprocess.check_output(
        ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"],
        stderr=subprocess.DEVNULL,
    ).strip()


def derive_aes_key(keychain_password: bytes) -> bytes:
    return PBKDF2(keychain_password, b"saltysalt", 16, count=1003)


def decrypt_chrome_value(enc: bytes, key: bytes) -> bytes:
    """Decrypt a Chrome cookie's encrypted_value (v10 format) on macOS."""
    if enc.startswith(b"v10"):
        cipher = AES.new(key, AES.MODE_CBC, b" " * 16)
        return unpad(cipher.decrypt(enc[3:]), AES.block_size)
    if enc.startswith(b"v11"):
        raise RuntimeError("v11 encryption found — not supported on macOS")
    return enc  # no prefix: plaintext

def get_meta_version(db_path: str) -> int:
    """Read the cookie DB's meta 'version' (0 if no meta table)."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        row = con.execute('SELECT value FROM meta WHERE key="version"').fetchone()
        return int(row[0]) if row else 0
    except sqlite3.OperationalError:
        return 0
    finally:
        con.close()


COLS = [
    "creation_utc", "host_key", "top_frame_site_key", "name", "value",
    "encrypted_value", "path", "expires_utc", "is_secure", "is_httponly",
    "last_access_utc", "has_expires", "is_persistent", "priority", "samesite",
    "source_scheme", "source_port", "last_update_utc", "source_type",
    "has_cross_site_ancestor",
]
COL_PLACEHOLDERS = ", ".join("?" for _ in COLS)


def main():
    pw = get_keychain_key()
    key = derive_aes_key(pw)
    print(f"Keychain password obtained ({len(pw)} bytes), AES key derived")

    # ---- Detect integrity-prefix scheme (v24+ DBs prepend 32-byte domain hash) ----
    chrome_version = get_meta_version(CHROME_DB)
    strip_prefix = chrome_version >= 24
    print(f"Chrome cookie DB meta version: {chrome_version} (strip 32-byte prefix: {strip_prefix})")

    # ---- Read + decrypt Chrome cookies ----
    chrome = sqlite3.connect(f"file:{CHROME_DB}?mode=ro", uri=True)
    chrome.row_factory = sqlite3.Row
    rows = chrome.execute("SELECT * FROM cookies").fetchall()
    chrome.close()
    print(f"Chrome cookies read: {len(rows)}")

    now_utc = int(time.time() * 1000000)
    imported, skipped = [], 0
    for r in rows:
        enc = r["encrypted_value"]
        if not enc:  # skip non-encrypted Chrome cookies (rare)
            skipped += 1
            continue
        try:
            plain = decrypt_chrome_value(bytes(enc), key)
            if strip_prefix and len(plain) >= 32:
                plain = plain[32:]
        except Exception as e:
            print(f"  !! decrypt failed for {r['host_key']}/{r['name']}: {e}")
            skipped += 1
            continue
        vals = [
            r["creation_utc"] or now_utc, r["host_key"], r["top_frame_site_key"] or "",
            r["name"], plain.decode("utf-8", "replace"), b"", r["path"],
            r["expires_utc"] or 0, r["is_secure"], r["is_httponly"],
            r["last_access_utc"] or now_utc, r["has_expires"], r["is_persistent"],
            r["priority"], r["samesite"], r["source_scheme"], r["source_port"],
            r["last_update_utc"] or now_utc, r["source_type"],
            r["has_cross_site_ancestor"],
        ]
        imported.append(vals)
    print(f"Decrypted and queued: {len(imported)} (skipped {skipped})")

    # ---- Clear existing PI-Desktop cookies, then upsert clean data ----
    pi = sqlite3.connect(PI_DB, timeout=15)
    pi.execute("PRAGMA busy_timeout=15000")
    pi.execute("BEGIN IMMEDIATE")
    cleared = pi.execute("DELETE FROM cookies").rowcount
    print(f"Cleared {cleared} existing PI-Desktop cookies")
    upsert_sql = (
        f"INSERT INTO cookies ({', '.join(COLS)}) VALUES ({COL_PLACEHOLDERS}) "
        "ON CONFLICT(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port) DO UPDATE SET "
        "value=excluded.value, encrypted_value=excluded.encrypted_value, "
        "expires_utc=excluded.expires_utc, is_secure=excluded.is_secure, "
        "is_httponly=excluded.is_httponly, has_expires=excluded.has_expires, "
        "is_persistent=excluded.is_persistent, priority=excluded.priority, "
        "samesite=excluded.samesite, last_update_utc=excluded.last_update_utc"
    )
    pi.executemany(upsert_sql, imported)
    pi.commit()
    pi.close()
    print(f"Upsert done. Total rows touched: {len(imported)}")

    # ---- Verify ----
    pi = sqlite3.connect(PI_DB)
    total = pi.execute("SELECT COUNT(*) FROM cookies").fetchone()[0]
    print(f"PI-Desktop cookie DB now has {total} rows")
    for host in (".google.com", ".google.com.tw", "accounts.google.com"):
        n = pi.execute(
            "SELECT COUNT(*) FROM cookies WHERE host_key=?", (host,)
        ).fetchone()[0]
        if n:
            print(f"  sample domain {host}: {n} cookies")
    # spot-check a stripped value looks clean
    row = pi.execute(
        "SELECT value FROM cookies WHERE name='__Secure-next-auth.session-token.0' LIMIT 1"
    ).fetchone()
    if row:
        v = row[0]
        print(f"  session-token value check: {v[:40]!r} (len {len(v)})")
    pi.close()


if __name__ == "__main__":
    sys.exit(main())
