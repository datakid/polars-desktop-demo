import sys, datetime
import polars as pl

def load(path, ext):
    if ext == "parquet":
        return pl.read_parquet(path)
    if ext == "arrow":
        return pl.read_ipc(path)
    return pl.read_excel(path, engine="openpyxl")

def norm(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y-%m-%d") if value.time() == datetime.time(0) else value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, datetime.date):
        return value.strftime("%Y-%m-%d")
    return str(value)

def same(a, b):
    if a == b:
        return True
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    return False

base = sys.argv[1]
for item in sys.argv[2:]:
    name, ext = item.split(":")
    try:
        app = load(f"{base}/app/{name}.{ext}", ext)
        out = load(f"{base}/out/{name}.{ext}", ext)
    except Exception as error:
        print(f"FAIL {name}: cannot read the {ext} files: {str(error)[:150]}")
        continue
    if app.columns != out.columns:
        print(f"FAIL {name}: columns {app.columns} against {out.columns}")
        continue
    if app.height != out.height:
        print(f"FAIL {name}: {app.height} rows against {out.height}")
        continue
    why = None
    for row_index, (left, right) in enumerate(zip(app.rows(), out.rows()), 1):
        for column, a, b in zip(app.columns, left, right):
            if not same(norm(a), norm(b)):
                why = f"row {row_index} column {column}: {norm(a)!r} against {norm(b)!r}"
                break
        if why:
            break
    if why:
        print(f"FAIL {name}: {why}")
