# Floe on Linux

Linux packages are `.deb` files for 64-bit Debian and Ubuntu, built by `.github/workflows/linux.yml` and attached to every release next to the Windows installers.

| File | Engine |
|---|---|
| `Floe_<version>_amd64.deb` | built-in engine (recommended) |
| `Floe-polars_<version>_amd64.deb` | built-in engine plus the native Polars engine |

Both are the package `floe`, so installing one replaces the other.

```
sudo apt install ./Floe_<version>_amd64.deb
```

`apt` installs WebKitGTK 4.1 and GTK 3 as dependencies. There is no AppImage, RPM, Flatpak, Snap or arm64 build.

## What is tested

`.github/workflows/linux-smoke.yml` installs each package from its `.deb` into a clean `ubuntu` container and drives it with `tauri-driver` and `WebKitWebDriver`:

| Ubuntu | WebKitGTK | X11 (Xvfb), built-in package | X11 (Xvfb), Polars package | Wayland (headless weston), Polars package |
|---|---|---|---|---|
| 22.04 | 2.50 | tested | tested | tested |
| 24.04 | 2.52 | tested | tested | tested |
| 26.04 | 2.52 | tested | tested | tested |
| 26.10 | 2.52 | tested | tested | tested |

Each leg checks that:

- the package installs and no shared library is missing,
- the app starts and the interface boots inside the Tauri shell,
- `app_info` reports Linux and the version of the release, and the package contains the engine it says it contains,
- the Polars package reads a CSV passed on the command line, casts three columns, filters it and returns the rows and an Arrow page through the real `engine_call` and `engine_page` commands,
- the app, started with a CSV and a small `.floe` project on its command line (what a file manager does when a file is opened with it), opens the project and adds the data file,
- a key press sent through WebDriver reaches the page: `Ctrl+,` opens the settings dialog, which only the desktop build binds,
- the built-in engine runs the sample project inside a web worker,
- a screenshot of the window is not blank.

Every release run produces the table above from what actually ran. A release whose container image or packages are unavailable is listed as not tested, and the table is copied into the release notes. The table is generated, so it is the authority; this page only describes the setup.

## What is not tested

- **Real desktops.** Wayland is a headless weston compositor, X11 is Xvfb. Nothing ran inside GNOME, KDE, Xfce or any other session, so the GTK file chooser and portals, drag and drop from a file manager, the registration of `.floe` with the desktop and double-clicking a file in a file manager, input methods, other keyboard layouts, the other shortcuts (F5, Ctrl+E), themes, fractional scaling and printing are untested.
- **Graphics.** Containers have no GPU. WebKitGTK ran with software rendering and with its web process sandbox disabled (`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`), because containers do not allow the sandbox's namespaces. Hardware acceleration and proprietary NVIDIA drivers were not exercised. If a window opens blank on your machine, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is the commonly reported remedy for WebKitGTK; it has not been verified here.
- **Other systems.** Packages are built on Ubuntu 22.04 (glibc 2.35), so older releases are not covered. Debian, Linux Mint, Pop!_OS and others are expected to work where WebKitGTK 4.1 exists but are not tested. Fedora, Arch and openSUSE have no package.
- **Depth.** The checks above prove the app starts and its native bridge and engines answer. They do not exercise the rest of the interface; that is covered on the web build by `tests.html` and `tests-ui.html`.
- **Single instance.** The shell uses a single-instance plugin that talks over D-Bus. The tests run inside a session bus. An environment with no session bus was not tried.
- **Signing.** Packages are not signed and there is no apt repository or auto-update.

## Running the test yourself

The smoke test needs the packages from a Linux workflow run. From the Actions tab, run **Linux** (it builds both packages and then tests them), or run **Linux smoke tests** with the run id of an earlier **Linux** run.

The per-container steps are in `.github/scripts/linux-smoke.sh` and the WebDriver session is in `.github/scripts/linux_smoke.py`; both run as written in any `ubuntu` image when the packages are mounted at `/work/pkg`, the `tauri-driver` binary at `/work/driver`, and the repository at `/work`.
