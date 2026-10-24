import os
import re
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
chromium = os.environ.get("PW_CHROMIUM")
timeout_ms = int(os.environ.get("TEST_TIMEOUT_MS", "240000"))

with sync_playwright() as p:
    options = {"args": ["--no-sandbox"]}
    if chromium:
        options["executable_path"] = chromium
    browser = p.chromium.launch(**options)
    page = browser.new_page()
    lines = []
    outcome = {}

    def on_console(msg):
        text = msg.text
        lines.append(text)
        m = re.match(r"RESULT (\d+) passed, (\d+) failed", text)
        if m:
            outcome["passed"], outcome["failed"] = int(m.group(1)), int(m.group(2))
            outcome["done"] = True
        elif text.startswith("E2E DONE"):
            outcome["passed"], outcome["failed"] = 1, 0
            outcome["done"] = True
        elif text.startswith("E2E FAIL"):
            outcome["passed"], outcome["failed"] = 0, 1
            outcome["done"] = True

    page.on("console", on_console)
    page.on("pageerror", lambda e: lines.append(f"PAGE ERROR {e}"))
    page.goto(url)
    waited = 0
    while not outcome.get("done") and waited < timeout_ms:
        page.wait_for_timeout(500)
        waited += 500
    browser.close()

print("\n".join(l[:300] for l in lines[-60:]))
if not outcome.get("done"):
    print("Tests did not finish within the time limit")
    sys.exit(1)
print(f"{url}: {outcome['passed']} passed, {outcome['failed']} failed")
sys.exit(0 if outcome["failed"] == 0 and outcome["passed"] > 0 else 1)
