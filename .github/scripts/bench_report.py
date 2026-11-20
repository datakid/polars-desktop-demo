import json
import sys

polars = json.load(open(sys.argv[1]))
builtin = json.load(open(sys.argv[2]))
meta = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}


def ms(v):
    return f"{v:.0f} ms" if v < 1000 else f"{v / 1000:.2f} s"


by = {r["pipeline"]: r for r in builtin["results"]}
lines = [f"### Pipelines, {builtin['rows']:,} input rows", "", "Full-data run, cold then warm. Speed-up is built-in warm over Polars warm.", "",
         "| Pipeline | Built-in cold | Built-in warm | Polars cold | Polars warm | Speed-up | Rows out |", "|---|---|---|---|---|---|---|"]
for r in polars["pipelines"]:
    b = by.get(r["pipeline"])
    if not b:
        continue
    same = "same" if b["rowsOut"] == r["rowsOut"] else f"built-in {b['rowsOut']:,} vs Polars {r['rowsOut']:,}"
    lines.append(f"| {r['pipeline']} | {ms(b['fullCold'])} | {ms(b['fullWarm'])} | {ms(r['fullCold'])} | {ms(r['fullWarm'])} | {b['fullWarm'] / max(r['fullWarm'], 0.001):.1f}x | {r['rowsOut']:,} ({same}) |")
lines += ["", "### Preview (first 1,000 rows)", "", "| Pipeline | Built-in cold | Built-in warm | Polars cold | Polars warm |", "|---|---|---|---|---|"]
for r in polars["pipelines"]:
    b = by.get(r["pipeline"])
    if b:
        lines.append(f"| {r['pipeline']} | {ms(b['previewCold'])} | {ms(b['previewWarm'])} | {ms(r['previewCold'])} | {ms(r['previewWarm'])} |")
lines += ["", f"### Exports and full evaluate, {polars['exportRows']:,} input rows", "", "| Run | Buffered peak | Streamed peak | Buffered time | Streamed time |", "|---|---|---|---|---|"]
ex = {(e["format"], e["mode"]): e for e in polars["exports"]}
for fmt in ("csv", "parquet", "arrow"):
    b, s = ex[(fmt, "buffered")], ex[(fmt, "streamed")]
    lines.append(f"| Export {fmt} | {b['peakMb']} MB | {s['peakMb']} MB | {b['wallS']} s | {s['wallS']} s |")
ev = {e["mode"]: e for e in polars["evaluate"]}
lines.append(f"| Full evaluate | {ev['buffered']['peakMb']} MB | {ev['streamed']['peakMb']} MB | {ev['buffered']['wallS']} s | {ev['streamed']['wallS']} s |")
if meta:
    lines += ["", f"Runner: {meta.get('runner', '')}, release build, built-in engine in headless {builtin.get('ua', '')}."]
print("\n".join(lines))
