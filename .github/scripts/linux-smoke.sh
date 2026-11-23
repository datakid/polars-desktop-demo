#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
OUT=/work/out
KIND="${DISPLAY_KIND:-x11}"
VARIANT="${VARIANT:-builtin}"
mkdir -p "$OUT"
. /etc/os-release
echo "Ubuntu ${VERSION_ID} (${VERSION_CODENAME}), $(uname -m), $(ldd --version | head -1)"

result() {
  local reason
  reason=$(printf '%s' "$2" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)
  printf '{"status":"%s","reason":"%s"}\n' "$1" "$reason" > "$OUT/result.json"
}

apt-get update -qq > "$OUT/apt.log" 2>&1 || { result not-tested "apt-get update failed"; exit 0; }

TOOLS="ca-certificates python3 dbus xauth xvfb libgl1-mesa-dri fonts-dejavu-core"
if [ "$KIND" = wayland ]; then TOOLS="$TOOLS weston"; fi
apt-get install -y -qq --no-install-recommends $TOOLS >> "$OUT/apt.log" 2>&1 || { result not-tested "the test tools could not be installed"; tail -5 "$OUT/apt.log"; exit 0; }
if ! apt-get install -y -qq --no-install-recommends webkit2gtk-driver >> "$OUT/apt.log" 2>&1; then
  apt-get install -y -qq --no-install-recommends webkitgtk-webdriver >> "$OUT/apt.log" 2>&1 || { result not-tested "no WebKitWebDriver package on this release"; exit 0; }
fi
command -v WebKitWebDriver > /dev/null || { result not-tested "WebKitWebDriver is not on the path"; exit 0; }

DEB=$(ls /work/pkg/*.deb | head -1)
PKG=$(dpkg-deb -f "$DEB" Package)
echo "Installing $(basename "$DEB") as package $PKG"
if ! apt-get install -y -qq --no-install-recommends "$DEB" >> "$OUT/apt.log" 2>&1; then
  tail -15 "$OUT/apt.log"
  result fail "the package does not install on this release: $(grep -E 'Depends|Unmet|but it is not|E:' "$OUT/apt.log" | head -3)"
  exit 1
fi
APP=$(dpkg -L "$PKG" | grep -E '^/usr/bin/[^/]+$' | head -1)
[ -x "$APP" ] || { result fail "the package installed no executable in /usr/bin"; exit 1; }
MISSING=$(ldd "$APP" 2>&1 | grep 'not found' || true)
if [ -n "$MISSING" ]; then echo "$MISSING"; result fail "shared libraries are missing: $MISSING"; exit 1; fi
echo "Installed $APP"
dpkg -l | grep -E 'libwebkit2gtk-4.1-0|libgtk-3-0' | awk '{print $2, $3}'

dbus-uuidgen --ensure=/etc/machine-id
id tester > /dev/null 2>&1 || useradd -m -s /bin/bash tester
UID_T=$(id -u tester)
XDG="/run/user/$UID_T"
mkdir -p "$XDG" && chown tester "$XDG" && chmod 700 "$XDG"
chmod 777 "$OUT"
printf 'id,name,qty,price\n1,alpha,2,"1,234.50"\n2,beta,5,10\n3,gamma,7,7.25\n4,delta,3,0.5\n' > /home/tester/sample.csv
chown tester /home/tester/sample.csv
cp /work/driver/tauri-driver /usr/local/bin/tauri-driver
chmod +x /usr/local/bin/tauri-driver

ENVV=(HOME=/home/tester XDG_RUNTIME_DIR="$XDG" WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 EXPECTED_VERSION="${EXPECTED_VERSION:-}")
TEST=(python3 /work/.github/scripts/linux_smoke.py "$APP" /home/tester/sample.csv "$VARIANT" "$KIND" "$OUT")

if [ "$KIND" = wayland ]; then
  for backend in headless headless-backend.so; do
    runuser -u tester -- env "${ENVV[@]}" weston --backend="$backend" --socket=wl-smoke --width=1280 --height=800 --idle-time=0 > "$OUT/weston.log" 2>&1 &
    WESTON=$!
    for _ in $(seq 1 20); do [ -S "$XDG/wl-smoke" ] && break; sleep 0.5; done
    [ -S "$XDG/wl-smoke" ] && break
    kill "$WESTON" 2>/dev/null
  done
  [ -S "$XDG/wl-smoke" ] || { cat "$OUT/weston.log"; result not-tested "the headless Wayland compositor did not start"; exit 0; }
  runuser -u tester -- env "${ENVV[@]}" GDK_BACKEND=wayland WAYLAND_DISPLAY=wl-smoke dbus-run-session -- "${TEST[@]}"
else
  runuser -u tester -- env "${ENVV[@]}" GDK_BACKEND=x11 dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "${TEST[@]}"
fi
CODE=$?

if [ "$CODE" -eq 0 ]; then result pass "all checks passed"; else result fail "see the checks in checks.json"; fi
exit 0
