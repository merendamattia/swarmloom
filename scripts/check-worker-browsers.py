#!/usr/bin/env python3
"""Exercise all bundled browsers without network access or GitHub credentials."""

import struct
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright


def main():
    with TemporaryDirectory(prefix="swarmloom-browser-check-") as directory:
        with sync_playwright() as playwright:
            for name in ("chromium", "firefox", "webkit"):
                browser = getattr(playwright, name).launch()
                try:
                    for width, height in ((1280, 800), (390, 844)):
                        page = browser.new_page(
                            viewport={"width": width, "height": height}
                        )
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.set_content(
                            '<meta name="viewport" content="width=device-width">'
                            "<h1>Visual verification</h1><button>Show details</button>"
                            "<p hidden>Browser checks work.</p>"
                            '<script>document.querySelector("button").onclick = () => '
                            'document.querySelector("p").hidden = false;</script>'
                        )
                        page.get_by_role("button", name="Show details").click()
                        expect(page.get_by_text("Browser checks work.")).to_be_visible()
                        assert page.evaluate(
                            "document.documentElement.scrollWidth <= innerWidth"
                        )
                        path = Path(directory) / f"{name}-{width}.png"
                        page.screenshot(path=str(path))
                        image = path.read_bytes()
                        assert image[:8] == b"\x89PNG\r\n\x1a\n"
                        assert struct.unpack(">II", image[16:24]) == (width, height)
                        assert not errors, errors
                        print(
                            f"{name}: {width}x{height}, screenshot and interaction OK"
                        )
                        page.close()
                finally:
                    browser.close()


if __name__ == "__main__":
    main()
