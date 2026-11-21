import json
import os
import subprocess
import sys
import time

binary, plans, out = sys.argv[1], sys.argv[2], sys.argv[3]
export_rows = sys.argv[4] if len(sys.argv) > 4 else "4000000"
work = os.path.dirname(out) or "."


def run(test, env=None):
    merged = dict(os.environ)
    merged.update(env or {})
    started = time.time()
    proc = subprocess.Popen([binary, "--ignored", "--exact", test, "--nocapture", "--test-threads=1"], env=merged, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = proc.stdout.read().decode()
    _, status, usage = os.wait4(proc.pid, 0)
    if status != 0:
        print(text, file=sys.stderr)
        raise SystemExit(f"{test} failed with status {status}")
    return text, usage.ru_maxrss / 1024.0, time.time() - started


result = {"pipelines": [], "exports": [], "evaluate": []}
text, _, _ = run("bench_pipelines", {"BENCH_PLANS": plans})
for line in text.splitlines():
    if "BENCH pipeline" in line:
        _, label, pc, pw, fc, fw, rows = line[line.index("BENCH pipeline"):].split("\t")
        result["pipelines"].append({"pipeline": label, "previewCold": float(pc), "previewWarm": float(pw), "fullCold": float(fc), "fullWarm": float(fw), "rowsOut": int(rows)})
        print(line, flush=True)

env = {"BENCH_ROWS": export_rows, "BENCH_DIR": os.path.join(work, "export-data")}
run("bench_export", dict(env, BENCH_FORMAT="csv"))
for fmt in ("csv", "parquet", "arrow"):
    for mode in ("buffered", "streamed"):
        text, rss, wall = run("bench_export", dict(env, BENCH_FORMAT=fmt, BENCH_MODE=mode))
        result["exports"].append({"format": fmt, "mode": mode, "peakMb": round(rss), "wallS": round(wall, 1)})
        print("export", fmt, mode, round(rss), "MB", round(wall, 1), "s", flush=True)
for mode in ("buffered", "streamed"):
    text, rss, wall = run("bench_evaluate", dict(env, BENCH_MODE=mode))
    result["evaluate"].append({"mode": mode, "peakMb": round(rss), "wallS": round(wall, 1)})
    print("evaluate", mode, round(rss), "MB", round(wall, 1), "s", flush=True)
result["exportRows"] = int(export_rows)
with open(out, "w") as f:
    json.dump(result, f)
