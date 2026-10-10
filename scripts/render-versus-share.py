#!/usr/bin/env python3
"""Render the generated, offline HTML share card to a 1200×630 PNG.

Run after `node scripts/generate-versus-share.js` with Python Playwright and
its Chromium browser installed. No public site, fonts, or backend is contacted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def add_png_metadata(png, metadata):
    """Embed source hashes and generated alt text without altering image pixels."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "Chromium did not return a PNG"
    chunks = []
    values = {
        "Description": metadata["imageAlt"],
        "SourceDataSHA256": metadata["hashes"]["data.json"],
        "VersusDataSHA256": metadata["hashes"]["versus.json"],
        "Counters": json.dumps(metadata["counters"], separators=(",", ":")),
    }
    for key, value in values.items():
        # Uncompressed international-text chunks support source names in UTF-8.
        body = key.encode("ascii") + b"\x00\x00\x00\x00\x00" + value.encode("utf-8")
        kind = b"iTXt"
        chunks.append(struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body)))
    # The final 12 bytes are the zero-length IEND chunk.
    assert png[-8:-4] == b"IEND", "PNG lacks its end chunk"
    return png[:-12] + b"".join(chunks) + png[-12:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, default=ROOT / "output/playwright/versus-share.html")
    parser.add_argument("--metadata", type=Path, default=ROOT / "assets/versus-share-metadata.json")
    parser.add_argument("--output", type=Path, default=ROOT / "assets/versus-share.png")
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text())
    before = hashlib.sha256((ROOT / "data.json").read_bytes()).hexdigest()
    assert before == metadata["hashes"]["data.json"], "Regenerate share HTML: data.json changed"
    assert hashlib.sha256((ROOT / "versus.json").read_bytes()).hexdigest() == metadata["hashes"]["versus.json"], \
        "Regenerate share HTML: versus.json changed"
    network = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1,
                                    reduced_motion="reduce")
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: network.append(request.url)
                    if request.url.startswith(("http://", "https://")) else None)
            page.route("http://**/*", lambda route: route.abort())
            page.route("https://**/*", lambda route: route.abort())
            page.goto(args.html.resolve().as_uri(), wait_until="load")
            page.evaluate("() => document.fonts.ready")
            page.wait_for_function("Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)")
            assert page.locator("img").count() == 2, "Share card must show both actual portraits"
            embedded = json.loads(page.locator("#share-metadata").text_content())
            assert embedded == metadata, "Share HTML metadata and manifest differ"
            geometry = page.evaluate("({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})")
            assert geometry == {"width": 1200, "height": 630}, geometry
            assert not network, f"Share card attempted external requests: {network}"
            assert not errors, errors
            image = page.screenshot(type="png", animations="disabled")
        finally:
            browser.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(add_png_metadata(image, metadata))
    assert hashlib.sha256((ROOT / "data.json").read_bytes()).hexdigest() == before, "Share generation changed data.json"
    print(json.dumps({"image": str(args.output), "width": 1200, "height": 630,
                      "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                      "dataHash": before, "imageAlt": metadata["imageAlt"]}, indent=2))


if __name__ == "__main__":
    main()
