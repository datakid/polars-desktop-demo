import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

APP, CSV, VARIANT, DISPLAY, OUT, PROJECT = sys.argv[1:7]
EXPECTED_VERSION = os.environ.get("EXPECTED_VERSION", "")
BASE = "http://127.0.0.1:4444"

checks = []
session = {"id": None}
driver = {"proc": None}


def record(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + name + ((": " + str(detail)[:300]) if detail else ""), flush=True)


def call(method, path, body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode())
        except ValueError:
            return {"value": {"error": "http " + str(error.code), "message": ""}}
    except (urllib.error.URLError, socket.timeout, ConnectionError) as error:
        return {"value": {"error": "connection", "message": str(error)}}


def run_script(js, args=None, asynchronous=False, timeout=120):
    kind = "async" if asynchronous else "sync"
    reply = call("POST", "/session/%s/execute/%s" % (session["id"], kind), {"script": js, "args": args or []}, timeout)
    value = reply.get("value")
    if isinstance(value, dict) and "error" in value:
        raise RuntimeError("%s %s" % (value.get("error"), (value.get("message") or "")[:300]))
    return value


def wait_for_ui(seconds):
    probe = "return JSON.stringify({ui: !!(window.PQ && PQ.UI && PQ.UI.App && PQ.UI.Store && PQ.UI.Store.project), tauri: !!(window.__TAURI__ && window.__TAURI__.core), native: !!(window.PQ && PQ.Platform && PQ.Platform.native), href: location.href, agent: navigator.userAgent});"
    last = ""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            value = json.loads(run_script(probe, timeout=30))
            last = value
            if value.get("ui"):
                return value
        except (RuntimeError, ValueError, TypeError) as error:
            last = str(error)
        time.sleep(1)
    return last


ASYNC_PRELUDE = "const done = arguments[arguments.length - 1]; const input = arguments[0];"
ASYNC_TAIL = ".catch((e) => done(JSON.stringify({error: String((e && e.message) || e)})));"

INFO_JS = ASYNC_PRELUDE + """
(async () => {
  const inv = window.__TAURI__.core.invoke;
  const out = {};
  out.app = await inv('app_info');
  out.engine = await inv('engine_status');
  done(JSON.stringify(out));
})()""" + ASYNC_TAIL

POLARS_JS = ASYNC_PRELUDE + """
(async () => {
  const inv = window.__TAURI__.core.invoke;
  const plan = {v: 1, locale: 'en-US', source: {kind: 'csv', path: input, delimiter: ',', header: true, skipRows: 0}, ops: [
    {op: 'cast', onError: 'error', changes: [{col: 'id', type: 'int', locale: 'en-US'}, {col: 'qty', type: 'int', locale: 'en-US'}, {col: 'price', type: 'number', locale: 'en-US'}]},
    {op: 'filter', expr: {k: 'bin', op: '>=', a: {k: 'col', name: 'qty'}, b: {k: 'lit', v: 3}}}
  ]};
  const r = await inv('engine_call', {op: 'evaluate', args: {plan: plan, mode: 'full', previewRows: 1000}});
  const page = await inv('engine_page', {resultId: r.resultId, offset: 0, count: 10});
  const bytes = page && (page.byteLength !== undefined ? page.byteLength : page.length);
  done(JSON.stringify({n: r.n, schema: r.schema, bytes: bytes}));
})()""" + ASYNC_TAIL

PROJECT_JS = "return JSON.stringify({name: PQ.UI.Store.project.name, queries: PQ.UI.Store.project.queries.map(function (q) { return q.name; }), files: (PQ.UI.App.files || []).map(function (f) { return f.name || f.fileName || f.id; })});"

SETTINGS_JS = "const m = document.querySelector('.modal'); return JSON.stringify({open: !!m, title: m ? (((m.querySelector('.modal-h') || m).textContent) || '').trim().slice(0, 80) : ''});"

FOCUS_JS = "window.focus(); return document.hasFocus();"

CONTROL = "\ue009"

DEMO_JS = "location.replace('demo.html'); return true;"

DEMO_PROBE = "return JSON.stringify({ready: !!(window.PQ && PQ.UI && PQ.UI.App && PQ.UI.App.result && PQ.UI.App.result.fp), queries: (window.PQ && PQ.UI && PQ.UI.Store && PQ.UI.Store.project) ? PQ.UI.Store.project.queries.length : 0});"


def main():
    log = open(os.path.join(OUT, "tauri-driver.log"), "w")
    driver["proc"] = subprocess.Popen(["tauri-driver"], stdout=log, stderr=subprocess.STDOUT)
    started = False
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", 4444), 1).close()
            started = True
            break
        except OSError:
            time.sleep(0.3)
    record("tauri-driver starts", started)
    if not started:
        return

    capabilities = {"capabilities": {"alwaysMatch": {"browserName": "wry", "tauri:options": {"application": APP, "args": [CSV, PROJECT]}}}}
    value = {}
    for attempt in range(1, 4):
        reply = call("POST", "/session", capabilities, 240)
        value = reply.get("value") or {}
        session["id"] = value.get("sessionId")
        if session["id"] or value.get("error") != "connection":
            break
        print("session attempt %d failed: %s" % (attempt, json.dumps(value)[:200]), flush=True)
        time.sleep(4)
    record("the app starts under WebDriver", bool(session["id"]), json.dumps(value)[:400] if not session["id"] else APP)
    if not session["id"]:
        return
    call("POST", "/session/%s/timeouts" % session["id"], {"script": 90000, "pageLoad": 90000})

    state = wait_for_ui(120)
    booted = isinstance(state, dict) and state.get("ui")
    record("the interface boots", booted, state if not booted else state.get("agent"))
    if not booted:
        return
    record("it runs inside the Tauri shell with the native bridge", state.get("tauri") and state.get("native"), "tauri=%s native=%s" % (state.get("tauri"), state.get("native")))

    opened = None
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            opened = json.loads(run_script(PROJECT_JS, timeout=30))
            if opened.get("name") == "Smoke project" and any("sample.csv" in str(f) for f in opened.get("files", [])):
                break
        except (RuntimeError, ValueError):
            pass
        time.sleep(1.5)
    record("a .floe file given on the command line opens as a project", bool(opened) and opened.get("name") == "Smoke project" and "Smoke query" in opened.get("queries", []), json.dumps(opened))
    record("a data file given on the command line is added to the project", bool(opened) and any("sample.csv" in str(f) for f in opened.get("files", [])), json.dumps(opened))

    try:
        run_script(FOCUS_JS)
        keys = [{"type": "keyDown", "value": CONTROL}, {"type": "keyDown", "value": ","}, {"type": "keyUp", "value": ","}, {"type": "keyUp", "value": CONTROL}]
        call("POST", "/session/%s/actions" % session["id"], {"actions": [{"type": "key", "id": "keyboard", "actions": keys}]}, 30)
    except RuntimeError as error:
        print("key press failed: %s" % error, flush=True)
    dialog = {}
    for _ in range(12):
        time.sleep(1)
        try:
            dialog = json.loads(run_script(SETTINGS_JS, timeout=30))
            if dialog.get("open"):
                break
        except (RuntimeError, ValueError):
            continue
    record("Ctrl+, opens the settings dialog", bool(dialog.get("open")) and "settings" in dialog.get("title", "").lower(), json.dumps(dialog))
    call("POST", "/session/%s/actions" % session["id"], {"actions": [{"type": "key", "id": "keyboard", "actions": [{"type": "keyDown", "value": "\ue00c"}, {"type": "keyUp", "value": "\ue00c"}]}]}, 30)

    info = {}
    attempts = 0
    for attempts in range(1, 4):
        try:
            info = json.loads(run_script(INFO_JS, asynchronous=True))
        except (RuntimeError, ValueError) as error:
            info = {"error": str(error)}
        if info.get("app"):
            break
        print("app_info attempt %d failed: %s" % (attempts, json.dumps(info)[:300]), flush=True)
        time.sleep(3)
    app_info = info.get("app") or {}
    engine = info.get("engine") or {}
    record("app_info reports Linux", app_info.get("os") == "linux", (json.dumps(app_info) if app_info else json.dumps(info)) + ("" if attempts == 1 else " after %d attempts" % attempts))
    if EXPECTED_VERSION:
        record("the version matches the release", app_info.get("version") == EXPECTED_VERSION, "%s against %s" % (app_info.get("version"), EXPECTED_VERSION))
    record("the engine variant is what the package says", bool(app_info.get("nativeEngine")) == (VARIANT == "polars"), "nativeEngine=%s variant=%s" % (app_info.get("nativeEngine"), VARIANT))

    if VARIANT == "polars":
        record("the Polars engine reports itself", bool(engine.get("available")) and bool((engine.get("info") or {}).get("polars")), json.dumps(engine))
        try:
            result = json.loads(run_script(POLARS_JS, args=[CSV], asynchronous=True))
        except (RuntimeError, ValueError) as error:
            result = {"error": str(error)}
        names = [c.get("name") for c in (result.get("schema") or [])]
        types = dict((c.get("name"), c.get("type")) for c in (result.get("schema") or []))
        good = result.get("n") == 3 and names == ["id", "name", "qty", "price"] and types.get("id") == "int" and types.get("price") == "number"
        record("Polars reads a CSV, casts, filters and returns 3 rows", good, json.dumps(result))
        record("Polars returns an Arrow page", (result.get("bytes") or 0) > 0, "bytes=%s" % result.get("bytes"))
    else:
        record("the built-in package reports no Polars engine", engine.get("available") is False, json.dumps(engine))

    try:
        run_script(DEMO_JS)
    except RuntimeError:
        pass
    demo = None
    deadline = time.time() + 90
    while time.time() < deadline:
        time.sleep(1.5)
        try:
            demo = json.loads(run_script(DEMO_PROBE, timeout=30))
            if demo.get("ready"):
                break
        except (RuntimeError, ValueError):
            continue
    record("the built-in engine runs the sample project in a worker", bool(demo and demo.get("ready") and demo.get("queries", 0) >= 4), json.dumps(demo))

    shot = call("GET", "/session/%s/screenshot" % session["id"], None, 60).get("value")
    size = 0
    if isinstance(shot, str):
        raw = base64.b64decode(shot)
        size = len(raw)
        with open(os.path.join(OUT, "screenshot.png"), "wb") as handle:
            handle.write(raw)
    record("a screenshot of the window is not blank", size > 20000, "%d bytes" % size)


try:
    main()
except Exception as error:
    record("the test script itself ran to the end", False, repr(error))
finally:
    if session["id"]:
        call("DELETE", "/session/%s" % session["id"], None, 30)
    if driver["proc"]:
        driver["proc"].terminate()
    if not (checks and all(c["ok"] for c in checks)):
        try:
            print("--- tauri-driver.log", flush=True)
            print("\n".join(open(os.path.join(OUT, "tauri-driver.log"), errors="replace").read().splitlines()[-25:]), flush=True)
        except OSError:
            pass
    with open(os.path.join(OUT, "checks.json"), "w") as handle:
        json.dump({"variant": VARIANT, "display": DISPLAY, "checks": checks}, handle, indent=1)

sys.exit(0 if checks and all(c["ok"] for c in checks) else 1)
