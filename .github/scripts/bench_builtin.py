import json
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
out = sys.argv[2]
timeout_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 1500000

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    done = []
    page.on("console", lambda m: done.append(True) if m.text == "BENCH DONE" else print(m.text, flush=True) if m.text.startswith("BENCH") else None)
    page.goto(url)
    waited = 0
    while not done and waited < timeout_ms:
        page.wait_for_timeout(1000)
        waited += 1000
    if not done:
        print("built-in benchmark did not finish", file=sys.stderr)
        sys.exit(1)
    report = page.evaluate("() => self.BENCH")
    with open(out, "w") as f:
        json.dump(report, f)
    browser.close()
