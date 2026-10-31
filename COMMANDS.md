# Velora Commands Reference

Velora provides two primary sets of commands:

1. **[Developer & CLI Commands](#developer--cli-commands)** — Commands and scripts used from the terminal for building, testing, linting, formatting, running, and releasing Velora.
2. **[Tauri IPC Commands](#tauri-ipc-commands-reference)** — The complete catalog of Tauri backend commands (`generate_handler!`) invoked by the React webviews (`main`, `dock`, `overlay`, `settings`) to interact with the Rust backend and native Win32 APIs.

---

## Developer & CLI Commands

All commands are run from the repository root unless otherwise noted. Requires **Bun 1.4+** and **Rust stable** on Windows.

### Quick Reference

| Command                                   | Working Directory | Description                                                                                                                                      |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun install`                             | Repo root         | Installs frontend dependencies. (CI uses `bun install --frozen-lockfile`; never commit a root `package-lock.json`).                              |
| `bun run tauri dev`                       | Repo root         | Starts the full development loop: spins up Vite dev server on port `1420` and compiles/launches the Tauri Rust app.                              |
| `bun run build`                           | Repo root         | Runs the frontend TypeScript typecheck and builds production bundles (`tsc && vite build`).                                                      |
| `bun run preview`                         | Repo root         | Serves the Vite production build locally for inspection.                                                                                         |
| `bun test`                                | Repo root         | Executes the Bun unit test suite in `scripts/*.test.ts` (dock lifecycle, battery formatting, window regions, extras).                            |
| `bun run format`                          | Repo root         | Automatically formats the frontend with `oxfmt` and the Rust backend with `cargo fmt`.                                                           |
| `bun run bump <x.y.z>`                    | Repo root         | Atomically synchronizes the version bump across `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`. |
| `bun run release <x.y.z>`                 | Repo root         | Complete release command: validates branch (`main`), bumps versions, commits, creates git tag `v<x.y.z>`, and pushes to remote.                  |
| `bun scripts/verify-updater.mjs v<x.y.z>` | Repo root         | Validates updater manifest, cryptographic signatures, and network downloads against GitHub Releases.                                             |
| `bun scripts/ai-issues.mjs`               | Repo root         | Utility script for analyzing and organizing GitHub issue triage data.                                                                            |
| `cargo check --locked`                    | `src-tauri/`      | Quick syntax, typing, and dependency verification for the Rust backend (runs in CI).                                                             |
| `cargo clippy --locked --all-targets`     | `src-tauri/`      | Rust static analysis and lint gates (runs in CI). Must pass with zero warnings.                                                                  |
| `cargo test --locked`                     | `src-tauri/`      | Fast pure-function Rust unit tests (dock deduplication, battery math, settings parser, updater age gates).                                       |
| `cargo fmt --check`                       | `src-tauri/`      | Verifies Rust formatting without making file modifications.                                                                                      |
| `cd website && npm install`               | `website/`        | Installs static documentation and marketing website dependencies.                                                                                |
| `cd website && npm run dev`               | `website/`        | Runs the static documentation website dev server locally.                                                                                        |
| `cd website && npm run build`             | `website/`        | Generates the production static export for the documentation website.                                                                            |

---

### Development Workflows

#### 1. Daily Development Loop

```bash
# Install dependencies
bun install

# Launch Vite + Tauri backend
bun run tauri dev
```

> [!NOTE]
> Vite runs on strict port `1420`. Do not run `bun run dev` separately; `bun run tauri dev` manages both the Vite frontend server and the native Tauri process together.

#### 2. Code Quality & Pre-Commit Gates

Before committing or opening a PR, ensure all gates pass:

```bash
# 1. Frontend TypeScript typecheck and bundle build
bun run build

# 2. Frontend unit tests
bun test

# 3. Rust compiler checks and linter
cd src-tauri
cargo check --locked
cargo clippy --locked --all-targets
cargo test --locked
cd ..

# 4. Code formatting
bun run format
```

#### 3. Version Bumping & Releasing

Velora maintains version parity across four files (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`).

```bash
# Bump version files together without committing
bun run bump 3.15.0

# Or run the complete release pipeline on 'main'
bun run release 3.15.0
```

After triggering a release workflow, verify release updater integrity:

```bash
bun scripts/verify-updater.mjs v3.15.0
```

#### 4. Microsoft Defender Definition Diagnostics

If Microsoft Defender falsely flags a clean local dev build, purge the cached signature definitions from an elevated Command Prompt or PowerShell:

```cmd
cd "C:\Program Files\Windows Defender"
MpCmdRun.exe -removedefinitions -dynamicsignatures
MpCmdRun.exe -SignatureUpdate
```

---

## Tauri IPC Commands Reference

Velora webviews communicate with the Rust backend using Tauri v2's IPC bridge.

### Invocation Pattern

Import `invoke` from `@tauri-apps/api/core`:

```typescript
import { invoke } from "@tauri-apps/api/core";

// Calling a command without arguments
await invoke("media_play_pause");

// Calling a command with arguments (Rust snake_case -> JS/TS camelCase keys)
await invoke("focus_window", { hwnd: 123456 });

// Calling a command that returns data
const volumeState = await invoke<{ volume: number; is_muted: boolean }>("get_volume_state");
```

> [!IMPORTANT]
>
> - **Argument Naming**: Rust argument names in `snake_case` (e.g. `app_name: String`) must be passed as `camelCase` keys in the JavaScript payload object (e.g. `{ appName: "chrome.exe" }`).
> - **Injected Handles**: Parameters typed as `app: AppHandle` or `window: Window` in Rust functions are injected by the Tauri runtime and **omitted** from frontend payloads.
> - **Error Handling**: Commands returning `Result<T, String>` resolve to `T` on success or reject with a descriptive error `string` on failure.

---

### Command Categories

- [Window & Display Management](#1-window--display-management)
- [Dock Controls & AppBar Integration](#2-dock-controls--appbar-integration)
- [Notch (Island) Controls](#3-notch-island-controls)
- [App Launching, Pinned Apps & Icons](#4-app-launching-pinned-apps--icons)
- [Shelf (Drag & Drop Stash)](#5-shelf-drag--drop-stash)
- [Dock Extras (Drives, Folders, Stacks & Recycle Bin)](#6-dock-extras-drives-folders-stacks--recycle-bin)
- [Audio, Media Sessions & Volume Mixer](#7-audio-media-sessions--volume-mixer)
- [Quick Settings & System Toggles](#8-quick-settings--system-toggles)
- [Wi-Fi Network Manager](#9-wi-fi-network-manager)
- [Bluetooth Device Manager](#10-bluetooth-device-manager)
- [System Tray & Shell Actions](#11-system-tray--shell-actions)
- [Hardware, Power & Battery Metrics](#12-hardware-power--battery-metrics)
- [Settings Persistence & Lifecycle](#13-settings-persistence--lifecycle)
- [Application Updater](#14-application-updater)

---

### 1. Window & Display Management

Controls webview sizing, click-through regions, window focus, and thumbnail generation.

| Command                    | Frontend Payload (TS)                                   | Return Type (TS)           | Description                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open_settings_window`     | `{}`                                                    | `void`                     | Opens and focuses the Velora Settings window, creating it if not already instantiated.                                                                             |
| `close_settings_window`    | `{}`                                                    | `void`                     | Hides the Settings window without terminating the application.                                                                                                     |
| `resize_settings_window`   | `{ width: number, height: number }`                     | `void`                     | Adjusts the logical width and height of the Settings window.                                                                                                       |
| `set_window_height`        | `{ height: number }`                                    | `void`                     | Resizes the calling window's height while respecting the current display DPI scale factor.                                                                         |
| `hide_overlay`             | `{}`                                                    | `void`                     | Hides the fullscreen transparent overlay window.                                                                                                                   |
| `sync_overlay_position`    | `{}`                                                    | `void`                     | Re-aligns the overlay window bounds to match the current monitor's desktop dimensions.                                                                             |
| `set_splash_fullscreen`    | `{ fullscreen: boolean }`                               | `void`                     | Adjusts splash window sizing between standard windowed and fullscreen display.                                                                                     |
| `set_ignore_cursor_events` | `{ ignore: boolean }`                                   | `void`                     | Enables or disables mouse event pass-through (`WS_EX_TRANSPARENT`) on the calling window.                                                                          |
| `set_window_region`        | `{ rects: IntRect[] }`                                  | `void`                     | Uses Win32 `SetWindowRgn` to clip hit-testing and drawing to the union of specified CSS-pixel rectangles. Prevents transparent empty areas from swallowing clicks. |
| `set_menu_open`            | `{ open: boolean, rect?: IntRect }`                     | `void`                     | Notifies the backend that a dropdown or context menu is open, preventing auto-hide triggers while open.                                                            |
| `focus_window`             | `{ hwnd: number }`                                      | `boolean`                  | Restores, unminimizes, and brings the specified window handle to the foreground.                                                                                   |
| `focus_app_windows`        | `{ hwnds: number[] }`                                   | `void`                     | Cycles or brings forward windows belonging to a multi-window dock item.                                                                                            |
| `close_window`             | `{ hwnd: number }`                                      | `void`                     | Sends a standard `WM_CLOSE` message to gracefully terminate the target window.                                                                                     |
| `get_active_windows`       | `{}`                                                    | `AppInfo[]`                | Enumerates all visible top-level application windows currently present on the desktop.                                                                             |
| `capture_window_thumbnail` | `{ hwnd: number, maxWidth: number, maxHeight: number }` | `[string, number] \| null` | Captures a live thumbnail of the given window as a base64 PNG data URL with millisecond timestamp.                                                                 |

---

### 2. Dock Controls & AppBar Integration

Manages the Velora dock taskbar replacement, monitor reservations, and hover states.

| Command            | Frontend Payload (TS)                    | Return Type (TS) | Description                                                                                                             |
| ------------------ | ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `init_dock`        | `{ mode: string }`                       | `void`           | Positions the dock, registers AppBar in `fixed` mode, or initializes edge-hover detection in `smart`/`peek` modes.      |
| `toggle_dock`      | `{ enable: boolean }`                    | `void`           | Shows or hides the dock entirely according to user settings.                                                            |
| `change_dock_mode` | `{ mode: "fixed" \| "smart" \| "peek" }` | `void`           | Switches dock visibility between `fixed` (AppBar reservation), `smart` (auto-hide on overlap), and `peek` (edge hover). |
| `set_dock_hovered` | `{ hovered: boolean }`                   | `void`           | Updates the backend state tracking whether the mouse cursor is hovering over the dock.                                  |
| `update_dock_rect` | `{ rect: IntRect }`                      | `void`           | Synchronizes the current on-screen dock rectangle for overlap checking with other windows.                              |
| `sync_appbar`      | `{}`                                     | `void`           | Re-evaluates and syncs the Windows AppBar reservation when screen resolution or display topology changes.               |

---

### 3. Notch (Island) Controls

Controls the top notch / dynamic island interface modes and bounds.

| Command             | Frontend Payload (TS)                    | Return Type (TS) | Description                                                                                                                |
| ------------------- | ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `change_notch_mode` | `{ mode: "fixed" \| "smart" \| "peek" }` | `void`           | Transitions notch behavior between `fixed` (always visible), `smart` (auto-hide), and `peek` (reveal on edge hover/event). |
| `set_notch_hovered` | `{ hovered: boolean }`                   | `void`           | Updates hover state and triggers immediate refresh of notch expanded/collapsed states.                                     |
| `set_notch_visible` | `{ visible: boolean }`                   | `void`           | Toggles notch visibility flag in runtime state.                                                                            |
| `update_notch_rect` | `{ rect: IntRect }`                      | `void`           | Updates the notch bounding box used for cursor proximity and overlap detection.                                            |

---

### 4. App Launching, Pinned Apps & Icons

Handles installed app discovery, launching, pinned dock items, and icon caching.

| Command               | Frontend Payload (TS)                            | Return Type (TS)         | Description                                                                                       |
| --------------------- | ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `open_app`            | `{ appName: string }`                            | `void`                   | Focuses an already open application window, or launches it from Start Menu / path if not running. |
| `launch_new_instance` | `{ appPath: string, appName?: string }`          | `void`                   | Spawns a brand new process instance of the application regardless of existing windows.            |
| `get_installed_apps`  | `{}`                                             | `AppInfo[]`              | Scans Windows Start Menu shortcuts and UWP package manifests to build the installed apps list.    |
| `get_app_icon`        | `{ path: string, name?: string, hwnd?: number }` | `string \| null`         | Extracts a high-resolution icon from an executable, shortcut, or window as a base64 PNG data URL. |
| `load_pinned_apps`    | `{}`                                             | `AppInfo[]`              | Reads the user's pinned dock apps list from `%APPDATA%/velora/pinned_apps.json`.                  |
| `save_pinned_apps`    | `{ apps: AppInfo[] }`                            | `void`                   | Saves the ordered list of pinned dock applications to disk.                                       |
| `clear_icon_cache`    | `{}`                                             | `void`                   | Clears all cached icon data from memory and the local disk cache directory.                       |
| `set_custom_icon`     | `{ cacheKey: string, iconData: string }`         | `string`                 | Associates a user-provided image data URL as a custom icon for a dock app.                        |
| `remove_custom_icon`  | `{ path: string, name?: string }`                | `void`                   | Removes a custom icon override, reverting the app to its native executable icon.                  |
| `get_custom_icons`    | `{}`                                             | `Record<string, string>` | Retrieves all registered custom icon mappings from the user profile.                              |

---

### 5. Shelf (Drag & Drop Stash)

Supports the temporary drag-and-drop file shelf on the desktop.

| Command            | Frontend Payload (TS) | Return Type (TS) | Description                                                                                                |
| ------------------ | --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `setup_shelf_drop` | `{}`                  | `void`           | Registers the shelf window as an OLE drag-and-drop target to intercept dragged files from Explorer.        |
| `shelf_thumbnail`  | `{ path: string }`    | `ShelfPreview`   | Generates a quick preview for a stashed file (thumbnail image, opening text snippet, or folder indicator). |
| `shelf_drag_icon`  | `{}`                  | `string \| null` | Returns a base64 PNG data URL of a generic document icon for dragging items out of the shelf.              |
| `shelf_prune`      | `{ paths: string[] }` | `string[]`       | Filters a list of file paths, dropping items that have been moved, deleted, or unmounted.                  |
| `shelf_open`       | `{ path: string }`    | `void`           | Launches a stashed file in its system default application.                                                 |

---

### 6. Dock Extras (Drives, Folders, Stacks & Recycle Bin)

Manages additional dock elements: connected drives, folder stacks, and the Recycle Bin.

| Command            | Frontend Payload (TS)                 | Return Type (TS)    | Description                                                                                        |
| ------------------ | ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `get_dock_extras`  | `{}`                                  | `DockExtra[]`       | Lists all active dock extras (drives, known/custom folders, and Recycle Bin) based on settings.    |
| `get_dock_drives`  | `{}`                                  | `DockExtra[]`       | Enumerates all connected logical drives (fixed, removable, network) for the Settings drive picker. |
| `open_dock_extra`  | `{ kind: string, path: string }`      | `void`              | Opens a dock extra item (e.g. folder, drive root, or Recycle Bin) in Windows Explorer.             |
| `eject_dock_extra` | `{ path: string }`                    | `void`              | Safely unmounts and ejects a removable USB drive using Windows Shell COM interfaces.               |
| `get_folder_stack` | `{ path: string, maxItems?: number }` | `FolderFileEntry[]` | Lists recent files and folders inside a directory for macOS-style fan or grid stack previews.      |

---

### 7. Audio, Media Sessions & Volume Mixer

Controls system audio endpoints, media playback sessions (GSMTC), and per-app volume mixer.

| Command                   | Frontend Payload (TS)                                     | Return Type (TS)     | Description                                                                                        |
| ------------------------- | --------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `media_play_pause`        | `{}`                                                      | `void`               | Toggles play/pause on the active Windows media playback session.                                   |
| `media_next`              | `{}`                                                      | `void`               | Skips to the next track in the active media session.                                               |
| `media_previous`          | `{}`                                                      | `void`               | Rewinds or returns to the previous track in the active media session.                              |
| `media_seek`              | `{ positionMs: number }`                                  | `void`               | Seeks playback to the specified millisecond offset in the currently playing media item.            |
| `open_media_source_app`   | `{}`                                                      | `void`               | Focuses or launches the application currently responsible for audio playback.                      |
| `get_volume`              | `{}`                                                      | `number`             | Retrieves the master audio endpoint volume as a float between `0.0` and `1.0`.                     |
| `set_volume`              | `{ volume: number }`                                      | `void`               | Adjusts the master audio endpoint volume (`0.0` to `1.0`).                                         |
| `get_volume_state`        | `{}`                                                      | `VolumeChangeEvent`  | Retrieves current master volume level and mute status (`{ volume: number, is_muted: boolean }`).   |
| `get_audio_sessions`      | `{}`                                                      | `AudioSessionInfo[]` | Enumerates active per-process audio sessions connected to the default render endpoint.             |
| `set_app_volume`          | `{ pid: number, volume: number }`                         | `void`               | Sets the individual volume level (`0.0` to `1.0`) for a specific application by process ID.        |
| `set_app_mute`            | `{ pid: number, muted: boolean }`                         | `void`               | Mutes or unmutes a specific application's audio session by process ID.                             |
| `set_volume_mixer_rect`   | `{ x: number, y: number, width: number, height: number }` | `void`               | Registers the screen bounding box of the volume mixer flyout to guard against premature dismissal. |
| `clear_volume_mixer_rect` | `{}`                                                      | `void`               | Clears the volume mixer flyout bounding box when the mixer is closed.                              |

---

### 8. Quick Settings & System Toggles

Provides quick toggles and shortcuts mirroring the Windows Action Center and Command Center.

| Command                        | Frontend Payload (TS)    | Return Type (TS) | Description                                                                            |
| ------------------------------ | ------------------------ | ---------------- | -------------------------------------------------------------------------------------- |
| `get_brightness`               | `{}`                     | `number`         | Reads current display brightness (`0`–`100`) via WMI.                                  |
| `set_brightness`               | `{ brightness: number }` | `void`           | Sets display brightness (`0`–`100`) via WMI / DDC/CI monitor controls.                 |
| `hide_native_osd`              | `{}`                     | `void`           | Suppresses native Windows volume/brightness on-screen display flyouts.                 |
| `get_wifi_status`              | `{}`                     | `WifiStatus`     | Queries Wi-Fi radio status, connection state, and current SSID.                        |
| `set_wifi_state`               | `{ enabled: boolean }`   | `void`           | Powers the Wi-Fi adapter radio on or off.                                              |
| `open_wifi_settings`           | `{}`                     | `void`           | Launches the Windows Settings Wi-Fi subpage (`ms-settings:network-wifi`).              |
| `get_bluetooth_state`          | `{}`                     | `boolean`        | Queries whether the Bluetooth radio adapter is enabled.                                |
| `set_bluetooth_state`          | `{ enabled: boolean }`   | `void`           | Turns the system Bluetooth radio on or off.                                            |
| `open_bluetooth_settings`      | `{}`                     | `void`           | Launches the Windows Settings Bluetooth page (`ms-settings:bluetooth`).                |
| `get_airplane_mode_state`      | `{}`                     | `boolean`        | Checks whether Windows Airplane Mode is currently enabled.                             |
| `toggle_airplane_mode`         | `{}`                     | `boolean`        | Toggles Airplane Mode on or off, returning the new state.                              |
| `open_airplane_mode_settings`  | `{}`                     | `void`           | Launches Windows Airplane Mode settings (`ms-settings:network-airplanemode`).          |
| `get_battery_saver_state`      | `{}`                     | `boolean`        | Checks if Windows Battery Saver energy-saving mode is active.                          |
| `toggle_battery_saver`         | `{}`                     | `boolean`        | Toggles Windows Battery Saver mode on or off.                                          |
| `open_battery_saver_settings`  | `{}`                     | `void`           | Launches Windows Battery Saver settings (`ms-settings:batterysaver`).                  |
| `get_night_light_state`        | `{}`                     | `boolean`        | Checks if Windows Night Light display color temperature filter is active.              |
| `toggle_night_light`           | `{}`                     | `boolean`        | Toggles Night Light mode on or off.                                                    |
| `open_night_light_settings`    | `{}`                     | `void`           | Launches Windows Night Light settings (`ms-settings:nightlight`).                      |
| `get_dnd_state`                | `{}`                     | `boolean`        | Checks if Do Not Disturb (Focus Assist) is active.                                     |
| `toggle_dnd`                   | `{}`                     | `boolean`        | Toggles Do Not Disturb mode on or off.                                                 |
| `open_focus_assist_settings`   | `{}`                     | `void`           | Launches Windows Focus Assist settings (`ms-settings:quiethours`).                     |
| `get_dark_mode_state`          | `{}`                     | `boolean`        | Queries whether the Windows system theme is currently dark mode.                       |
| `toggle_dark_mode`             | `{}`                     | `boolean`        | Toggles the Windows system apps dark/light theme registry flag.                        |
| `get_mobile_hotspot_state`     | `{}`                     | `boolean`        | Checks if Windows Mobile Hotspot Wi-Fi tethering is active.                            |
| `toggle_mobile_hotspot`        | `{}`                     | `boolean`        | Toggles Mobile Hotspot tethering on or off.                                            |
| `open_mobile_hotspot_settings` | `{}`                     | `void`           | Launches Windows Mobile Hotspot settings (`ms-settings:network-mobilehotspot`).        |
| `get_nearby_sharing_state`     | `{}`                     | `number`         | Reads Nearby Sharing mode (`0` = Off, `1` = My Devices, `2` = Everyone).               |
| `toggle_nearby_sharing`        | `{}`                     | `number`         | Cycles Nearby Sharing mode through its three states.                                   |
| `open_nearby_sharing_settings` | `{}`                     | `void`           | Launches Windows Nearby Sharing settings (`ms-settings:crossdevice`).                  |
| `toggle_live_captions`         | `{}`                     | `void`           | Toggles or launches the Windows Live Captions accessibility feature.                   |
| `toggle_accessibility`         | `{}`                     | `boolean`        | Toggles system high-contrast or accessibility settings.                                |
| `open_accessibility_menu`      | `{}`                     | `void`           | Launches Windows Accessibility settings (`ms-settings:easeofaccess-display`).          |
| `trigger_screen_snip`          | `{}`                     | `void`           | Launches the Windows Snipping Tool screen capture overlay (equivalent to Win+Shift+S). |
| `toggle_touch_keyboard`        | `{}`                     | `void`           | Shows or hides the Windows touch keyboard (`TabTip.exe`).                              |
| `open_project_menu`            | `{}`                     | `void`           | Opens the Windows Display Projection sidebar (equivalent to Win+P).                    |
| `open_cast_menu`               | `{}`                     | `void`           | Opens the Windows Connect / Cast wireless display flyout (equivalent to Win+K).        |
| `open_sound_settings`          | `{}`                     | `void`           | Launches Windows Sound settings (`ms-settings:sound`).                                 |
| `open_notification_center`     | `{}`                     | `void`           | Opens Windows Notification Center and Calendar flyout (equivalent to Win+N).           |
| `open_system_tray`             | `{}`                     | `void`           | Toggles the native system tray overflow chevron flyout.                                |

---

### 9. Wi-Fi Network Manager

Full Wi-Fi management supporting scans, connections with passwords, and profile management.

| Command              | Frontend Payload (TS)                 | Return Type (TS)  | Description                                                                                           |
| -------------------- | ------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `wifi_list_networks` | `{}`                                  | `WifiNetworkList` | Returns all Wi-Fi networks visible to Windows from its most recent scan.                              |
| `wifi_scan`          | `{}`                                  | `void`            | Triggers a fresh active Wi-Fi scan. Results arrive via `wifi-changed` event.                          |
| `wifi_connect`       | `{ ssid: string, password?: string }` | `void`            | Connects to a network. Saved/open networks require no password; new personal networks require one.    |
| `wifi_disconnect`    | `{}`                                  | `void`            | Disconnects the active Wi-Fi connection.                                                              |
| `wifi_forget`        | `{ ssid: string }`                    | `void`            | Deletes the saved Windows profile for the specified network SSID.                                     |
| `wifi_open_settings` | `{ page: "wifi" \| "location" }`      | `void`            | Opens Windows Wi-Fi settings or Location privacy settings (required for Wi-Fi scans on Win 11 24H2+). |

---

### 10. Bluetooth Device Manager

Discovers nearby devices, manages paired accessories, and handles in-app PIN pairing prompts.

| Command                     | Frontend Payload (TS)                | Return Type (TS) | Description                                                                                 |
| --------------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- |
| `bluetooth_list_devices`    | `{}`                                 | `BtDevice[]`     | Lists paired Bluetooth devices with connection state, device kind, and battery level.       |
| `bluetooth_set_connected`   | `{ id: string, connected: boolean }` | `void`           | Connects or disconnects a paired Bluetooth audio device (headphones, speakers).             |
| `bluetooth_discovery`       | `{ active: boolean }`                | `void`           | Starts or stops scanning for nearby pairable Bluetooth devices (emits `bluetooth-nearby`).  |
| `bluetooth_pair`            | `{ id: string }`                     | `void`           | Initiates pairing with a discovered device. Prompts arrive via `bluetooth-pairing-request`. |
| `bluetooth_pairing_respond` | `{ accept: boolean, pin?: string }`  | `void`           | Submits the user's response or entered PIN for an active pairing prompt.                    |
| `bluetooth_unpair`          | `{ id: string }`                     | `void`           | Unpairs and removes a Bluetooth device from Windows.                                        |

---

### 11. System Tray & Shell Actions

Inspects notification area icons and launches native administrative shell actions.

| Command                  | Frontend Payload (TS)      | Return Type (TS) | Description                                                                                                                                                                                              |
| ------------------------ | -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_tray_apps`          | `{}`                       | `TrayApp[]`      | Discovers active notification icons registered in the Windows system notification area.                                                                                                                  |
| `show_tray_context_menu` | `{ trayId: string }`       | `void`           | Simulates a right-click message on a tray icon to open its native Win32 context menu.                                                                                                                    |
| `activate_tray_icon`     | `{ trayId: string }`       | `void`           | Simulates a primary left-click or double-click to restore or activate a tray app.                                                                                                                        |
| `open_system_action`     | `{ action: SystemAction }` | `void`           | Launches administrative tools: `TaskManager`, `DiskManagement`, `DeviceManager`, `ComputerManagement`, `Settings`, `TaskbarSettings`, `InstalledApps`, `PowerOptions`, `NetworkConnections`, `TaskView`. |

---

### 12. Hardware, Power & Battery Metrics

Monitors real-time resource utilization, battery health, and system telemetry.

| Command                   | Frontend Payload (TS) | Return Type (TS)   | Description                                                                                         |
| ------------------------- | --------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `get_battery_details`     | `{}`                  | `BatteryDetails`   | Fetches charge %, charging state, time remaining, time to full, battery health %, and power scheme. |
| `get_cpu_usage`           | `{}`                  | `number`           | Returns overall system CPU utilization percentage (`0`–`100`).                                      |
| `get_ram_usage`           | `{}`                  | `number`           | Returns overall system RAM utilization percentage (`0.0`–`100.0`).                                  |
| `get_disk_space`          | `{}`                  | `number`           | Returns total available free disk bytes on the system drive.                                        |
| `get_network_speed`       | `{}`                  | `[number, number]` | Measures real-time network throughput as `[downloadBytesPerSec, uploadBytesPerSec]`.                |
| `get_system_accent_color` | `{}`                  | `string`           | Retrieves the active Windows user accent color as a hex string (e.g. `#0078D7`).                    |

---

### 13. Settings Persistence & Lifecycle

Handles reading/writing app preferences to disk, import/export, and app shutdown/restart.

| Command                     | Frontend Payload (TS)         | Return Type (TS)      | Description                                                                             |
| --------------------------- | ----------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `load_settings`             | `{}`                          | `Record<string, any>` | Loads all `velora-*` key-value pairs from `%APPDATA%/velora/settings.json`.             |
| `save_setting`              | `{ key: string, value: any }` | `void`                | Updates a setting in memory, saves to disk, and broadcasts `settings-changed`.          |
| `settings_file_readable`    | `{}`                          | `boolean`             | Verifies whether `settings.json` exists and parses cleanly without errors.              |
| `export_settings_to_file`   | `{}`                          | `string \| null`      | Opens a native Save File dialog to safely export settings to a user-selected JSON file. |
| `import_settings_from_file` | `{}`                          | `string \| null`      | Opens a native Open File dialog to safely restore settings from a JSON file.            |
| `reset_settings`            | `{}`                          | `void`                | Clears all settings back to factory defaults and updates runtime services.              |
| `quit_velora`               | `{}`                          | `void`                | Restores the native Windows taskbar, unregisters AppBars, removes hooks, and exits.     |
| `restart_velora`            | `{}`                          | `void`                | Restores the native taskbar, cleans up resources, and relaunches the Velora executable. |

---

### 14. Application Updater

Integrates with GitHub Releases to check for, download, and install version updates.

| Command             | Frontend Payload (TS) | Return Type (TS)    | Description                                                                                 |
| ------------------- | --------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `check_for_updates` | `{ force: boolean }`  | `UpdateCheckResult` | Checks the remote manifest for new versions, bypassing the interval cache if `force: true`. |
| `install_update`    | `{}`                  | `void`              | Downloads the update binary, verifies signature, launches installer, and exits the process. |
| `get_update_state`  | `{}`                  | `UpdateCheckResult` | Returns cached update check information from disk/memory without making network requests.   |

---

## Backend-to-Frontend Events

The Rust backend communicates state changes asynchronously to the frontends using `app.emit()`. Listen to these events using `@tauri-apps/api/event`:

```typescript
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<MediaInfo>("media-update", (event) => {
	console.log("Now playing:", event.payload.title);
});
```

### Event Catalog

| Event Name                  | Payload Type (TS)                       | Description                                                                                          |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `settings-changed`          | `Record<string, string>`                | Fired when any setting is updated through `save_setting` or UI interaction.                          |
| `settings-external-changed` | `Record<string, string>`                | Fired when `settings.json` is modified externally on disk by a text editor or script.                |
| `media-update`              | `MediaInfo`                             | Emitted when active media playback track, artist, play/pause, position, or album art changes.        |
| `volume-change`             | `VolumeChangeEvent`                     | Emitted when master endpoint volume or mute state changes (`{ volume: number, is_muted: boolean }`). |
| `brightness-change`         | `BrightnessChangeEvent`                 | Emitted when display brightness changes via WMI or hardware buttons (`{ brightness: number }`).      |
| `dock-overlap`              | `boolean`                               | Emitted when an active window overlaps the dock area, triggering auto-hide in smart mode.            |
| `notch-overlap`             | `boolean`                               | Emitted when an active window overlaps the notch area in smart mode.                                 |
| `windows-changed`           | `()`                                    | Emitted when desktop windows are opened, closed, focused, or rearranged.                             |
| `wifi-changed`              | `()`                                    | Emitted when a background Wi-Fi network scan completes or connection state changes.                  |
| `bluetooth-changed`         | `()`                                    | Emitted when paired Bluetooth devices connect, disconnect, or update battery levels.                 |
| `bluetooth-nearby`          | `BtNearbyDevice[]`                      | Broadcasts discovered pairable Bluetooth devices during active discovery.                            |
| `bluetooth-pairing-request` | `BtPairingRequest`                      | Emitted when a Bluetooth device initiates a PIN confirmation or entry prompt.                        |
| `update-available`          | `UpdateCheckResult`                     | Emitted when a new version is detected during startup or manual check.                               |
| `auto-update-status`        | `{ status: string, progress?: number }` | Emitted during update lifecycle: `"checking"`, `"downloading"`, or `"done"`.                         |

---

## See Also

- [SETTINGS.md](SETTINGS.md) — Comprehensive reference of all `velora-*` configuration keys and types.
- [AGENTS.md](AGENTS.md) — Architecture summary, design guidelines, and developer environment constraints.
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) — Pre-flight checklist and verification steps for publishing new releases.
