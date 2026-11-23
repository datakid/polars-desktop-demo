import json
import os
import sys

root, target = sys.argv[1], sys.argv[2]
rows = []
for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
    parts = name.split("-")
    if len(parts) != 4 or parts[0] != "smoke":
        continue
    _, ubuntu, display, variant = parts
    folder = os.path.join(root, name)
    try:
        result = json.load(open(os.path.join(folder, "result.json")))
    except (OSError, ValueError):
        result = {"status": "fail", "reason": "no result was written"}
    failed = []
    try:
        checks = json.load(open(os.path.join(folder, "checks.json")))["checks"]
        failed = [c["name"] for c in checks if not c["ok"]]
        passed = sum(1 for c in checks if c["ok"])
        total = len(checks)
    except (OSError, ValueError, KeyError):
        passed, total = 0, 0
    rows.append((ubuntu, display, variant, result.get("status", "fail"), result.get("reason", ""), failed, passed, total))

order = {"22.04": 0, "24.04": 1, "26.04": 2, "26.10": 3}
rows.sort(key=lambda r: (order.get(r[0], 9), r[1], r[2]))
label = {"pass": "passed", "fail": "FAILED", "not-tested": "not tested"}

lines = ["## Linux packages: what was run", ""]
lines.append("Each package was installed from the `.deb` into a clean Ubuntu container, started under WebDriver and driven through the same Tauri commands the app uses.")
lines.append("")
lines.append("| Ubuntu | Display | Package | Result | Checks | Detail |")
lines.append("|---|---|---|---|---|---|")
for ubuntu, display, variant, status, reason, failed, passed, total in rows:
    detail = reason if status != "pass" else ""
    if failed:
        detail = (detail + " Failed: " + "; ".join(failed)).strip()
    lines.append("| %s | %s | %s | %s | %s | %s |" % (ubuntu, "X11 (Xvfb)" if display == "x11" else "Wayland (weston, headless)", variant, label.get(status, status), ("%d of %d" % (passed, total)) if total else "", detail.replace("|", "/")))
if not rows:
    lines.append("| | | | no test results were produced | | |")

lines += [
    "",
    "### What this does not show",
    "",
    "- The packages are built on Ubuntu 22.04 (glibc 2.35). Releases older than that are not covered, and nothing was built for arm64, Fedora, Arch or as an AppImage or RPM.",
    "- Containers have no GPU, so WebKitGTK runs with software rendering and its web process sandbox switched off. Hardware acceleration, NVIDIA drivers, HiDPI and fractional scaling were not exercised.",
    "- Wayland is a headless weston compositor, not GNOME. Nothing was tested inside a real GNOME, KDE or other desktop session, with its file chooser portal, drag and drop from a file manager, double-clicking a `.floe` file, input methods, themes or printing.",
    "- Only the checks listed in the Detail column and in `checks.json` ran. A pass means the app starts, its Tauri bridge answers, the Polars package runs one CSV plan end to end and the built-in engine runs the sample project; it says nothing about the rest of the interface.",
    "- Ubuntu 26.10 appears as not tested whenever Docker Hub has no `ubuntu:26.10` image or its WebKitGTK packages could not be installed.",
    "",
]
open(target, "w").write("\n".join(lines))
print("\n".join(lines))
