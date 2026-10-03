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
