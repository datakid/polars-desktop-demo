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

## Polars engine against the built-in engine (release build, CI)

Run from the Actions tab: Engine benchmark, Run workflow (`.github/workflows/bench.yml`). The job builds the
engine in release mode on a GitHub-hosted Ubuntu runner, runs the same five pipelines as above on both engines
(the built-in engine in headless Chromium on the same machine), and checks that both return the same number of rows.
The six numbers below are one run; runner speed varies, so compare the columns of one run with each other.

#### Pipelines, 1,000,000 input rows

Full-data run, cold then warm. Speed-up is built-in warm over Polars warm.

| Pipeline | Built-in cold | Built-in warm | Polars cold | Polars warm | Speed-up | Rows out |
|---|---|---|---|---|---|---|
| A · types + filter | 750 ms | 670 ms | 258 ms | 235 ms | 2.8x | 374,674 (same) |
| B · A + group by | 1.02 s | 711 ms | 231 ms | 227 ms | 3.1x | 168,270 (same) |
| C · A + merge + sort | 1.16 s | 1.03 s | 328 ms | 305 ms | 3.4x | 374,674 (same) |
| D · unpivot + pivot | 1.34 s | 1.49 s | 815 ms | 782 ms | 1.9x | 1,000,000 (same) |
| F · formula column + filter | 922 ms | 882 ms | 260 ms | 265 ms | 3.3x | 409,974 (same) |

#### Preview (first 1,000 rows)

| Pipeline | Built-in cold | Built-in warm | Polars cold | Polars warm |
|---|---|---|---|---|
| A · types + filter | 12 ms | 8 ms | 8 ms | 3 ms |
| B · A + group by | 2 ms | 2 ms | 3 ms | 2 ms |
| C · A + merge + sort | 4 ms | 2 ms | 4 ms | 4 ms |
| D · unpivot + pivot | 2 ms | 2 ms | 6 ms | 4 ms |
| F · formula column + filter | 4 ms | 2 ms | 4 ms | 3 ms |

#### Exports and full evaluate, 4,000,000 input rows

| Run | Buffered peak | Streamed peak | Buffered time | Streamed time |
|---|---|---|---|---|
| Export csv | 385 MB | 298 MB | 0.4 s | 0.4 s |
| Export parquet | 402 MB | 257 MB | 0.5 s | 0.3 s |
| Export arrow | 604 MB | 298 MB | 0.4 s | 0.2 s |
| Full evaluate | 389 MB | 291 MB | 0.2 s | 0.1 s |

What changed between the first and the second run: pipeline F (formula column and filter) ran at 1.53 s warm
against 0.75 s for the built-in engine, because type conversion chained seven string passes per number and two regex
passes plus up to seventeen date parses per date. Converting numbers and dates in one native pass brought F to 265 ms and
the other pipelines down by 30 to 70 percent (B 384 to 227 ms, C 869 to 305 ms, D 1.10 s to 0.78 s). The old
expressions stay in `src/expr.rs` tests as the reference for a differential test.

Preview runs (the first 1,000 rows) are on par: 2 to 8 ms on both engines.

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
