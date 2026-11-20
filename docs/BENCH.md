# Benchmarks

Open `bench.html` (web build only) and choose an input size; it prints the table and a copyable JSON report. The pipelines are fixed so runs stay comparable:

| Id | Pipeline |
|---|---|
| A | CSV → ChangeType (date, int, 2× number) → Filter `[quantity] > 5 and [status] = "shipped"` |
| B | A → GroupBy (2 keys; sum, mean, count) |
| C | A → Merge with 5,000 customers → Sort 2 keys |
| D | ChangeType → Select → Unpivot → Pivot (sum) |
| E | Excel sheet → PromoteHeaders → ChangeType |
| F | ChangeType → custom column `[quantity] * [unit_price] * (1 - Coalesce([discount], 0))` → Filter |

## Built-in engine, 100,000 rows (headless Chromium, editor sandbox)
Times are full-data runs. In the step columns, Source is CSV parse and Pivot is the pivot step on its own.

| | 1.1 before | 1.1 after | Change |
|---|---|---|---|
| Pipeline D, Pivot step | 161 ms | 65 ms | −60% (streaming accumulators instead of per-cell arrays) |
| Pipeline D, full | 287 ms | 176–264 ms | about −25% |
| Source step (CSV parse into columns) | 64–129 ms | 43–88 ms | about −30% (parse straight into column arrays, no transpose) |
| Preview of a CSV over 8 MB | decodes the whole file | decodes the first 4 MB only | O(preview) instead of O(file) |

Sandbox timings vary by ±30% between runs, so compare medians from your own machine. Record your runs below.

## Your machine
| Date | Machine / browser | Rows | A | B | C | D | E | F |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Polars build (desktop)
Run the same pipelines in the desktop `polars` build with "Prefer Polars" on and off (Engine panel → switch), and record the chip timings here. Target: at least 5× faster on full-data A–C at 1M rows.

## Polars engine: streaming full runs and exports
Peak memory and wall time for the Polars engine's full runs and exports, with and without
streaming. The benchmark is `desktop/src-tauri/engine/tests/bench_stream.rs`. It writes a Parquet
file (id, region, qty, price, note), filters `qty >= 3`, rounds `price`, and either evaluates or exports
the result. Each measurement is a fresh process; peak memory is the process's maximum resident set.

```
BENCH_ROWS=12000000 BENCH_MODE=buffered BENCH_FORMAT=csv \
  /usr/bin/time -v cargo test --release --test bench_stream -- --ignored --exact bench_export --nocapture
```

`BENCH_MODE=buffered` collects the whole result and writes it with the previous writers.
`BENCH_MODE=streamed` (the default) runs the production `export` and `evaluate`.
`BENCH_FORMAT` is `csv`, `parquet` or `arrow`. The dataset is created on first use in `BENCH_DIR`
(default `/tmp/floe_bench`) and reused.

### Results

Measured on one CPU, 4 GB of memory, a debug build (opt-level 0). Memory is meaningful; absolute times are
not, and the two modes are compared on the same machine. 12 million input rows, 8.4 million output rows.

| Run | Buffered peak | Streamed peak | Buffered time | Streamed time |
|---|---|---|---|---|
| Export CSV | 1142 MB | 292 MB | 22.4 s | 23.2 s |
| Export Arrow | 1736 MB | 277 MB | 8.5 s | 9.0 s |
| Export Parquet | 1142 MB | 293 MB | 26.2 s | 24.7 s |
| Full evaluate | 1141 MB | 848 MB | 8.7 s | 9.0 s |

Run-to-run noise on this machine is up to about 10%, so the times are equal within noise; streaming is not
consistently faster or slower. The streamed CSV file is byte for byte the file the buffered writer produces
(504,429,576 bytes), and the row count it reports (8,400,000) is exact.

On 4 million input rows (2.8 million output) a streamed export peaked at 231 to 251 MB for every format, against
426 to 666 MB buffered, so the streamed peak does not grow with the data. A full evaluate keeps its result in memory,
so streaming only removes the intermediate copies.

### Notes

- The streamed CSV count of exported rows reads the written file once and counts newlines outside quotes in
  constant memory. Counting by re-reading it with the CSV reader added about 270 MB and 2 s.
- Excel exports and preview runs still collect in memory.
- Release timings against the built-in engine have not been recorded here.
