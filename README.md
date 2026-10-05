# WinUtils

WinUtils is a Windows desktop utility app built with Electron, React, TypeScript, and Vite. It brings startup management, centralized hotkeys, process-aware macros, focus-based audio muting, beta always-active app focus rules, clipboard history, safe file sync, and tray/window behavior controls into one desktop app.

## Desktop App
- WinUtils runs as an Electron desktop window on Windows.
- In development, Vite serves renderer assets internally, but the app is still opened by Electron as a desktop application.
- For distribution, use the generated `.exe` files in the `release` folder.

## Current Features

- Modern blue-gradient desktop UI with a Power Tools style layout and compact tray popup
- Startup Apps reads entries from:
  - `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
  - `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
  - `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run`
  - User Startup folder
  - Common Startup folder
- Disable autostart entries, keep them visible from cache, and restore them later
- Macros with folders, profiles, recorded input, reusable WinUtils actions, nested If/Else and bounded Repeat groups, early Stop actions, process-aware profile switching, Helldivers 2 presets, and an optional bound-key preview
- Central Hotkey Manager for editing feature/macro shortcuts, binding parameterless reusable actions, detecting conflicts, and reporting Windows registration failures
- Shared Action Engine for application, process, audio-session, window, clipboard, file, URL, notification, PowerShell, Explorer, and active-profile macro actions
- Compact Ctrl+Space Command Palette with searchable actions, typed parameter forms, dangerous-action warnings, and direct commands such as `mute discord`, `volume spotify 40`, and `window discord left monitor 2`
- Window Manager with live top-level window controls, exact positioning, multi-monitor presets, and persistent monitor-relative layouts that are also exposed as reusable actions
- Automation Triggers for application lifecycle, focused windows, clipboard changes, file changes, monitor/network connections, Windows unlock, schedules, and WinUtils startup, with cooldown, concurrency, and run diagnostics
- Configurable Windows Explorer submenu for copying paths, copying SHA-256 hashes, and opening PowerShell in a folder, registered reversibly under the current user only
- Focus Audio with whitelist/blacklist modes for muting unfocused apps by audio session/process
- Always Active (Beta) rules for preventing window deactivation, throttled game keepalive signals, active-window signals, or focus-locking selected running apps
- Batch Renamer with drag-and-drop loading, ordered rename rules, live validation, conflict preview, reversible apply, and undo history
- Regex Lab with colored token suggestions, live match checks, capture previews, and direct export into Batch Renamer regex rules
- Clipboard Manager with local searchable history, pins, smart categories, image capture, Windows OCR, Windows history delete sync, and a compact Win+V-style quick-access popup
- File Sync with local folder jobs, GoodSync-style integrated left/right folder selectors, auto-analyzing tree previews, direct include/exclude filter actions, one-way and two-way sync, empty-folder handling, guarded automation triggers, verified copies, conflict handling, metadata-preserving copies, and quarantine for replaced/deleted files
- Settings for launch at login, start minimized, minimize to tray, and close to tray
- Secure IPC bridge between renderer and Electron main process

## How Disable and Restore Works

- Registry entries are cached to a JSON file under the app user data directory and removed from the relevant `Run` key.
- Startup folder items are moved into a WinUtils-managed cache directory under the app user data directory.
- Re-enabling restores the original registry value or moves the startup file back to its original location.

## Development

Install dependencies:

```bash
npm install
```

Start the app in development mode:

```bash
npm run dev
```

Start as a built desktop app (without packaging):

```bash
npm run start:desktop
```

Run type checks:

```bash
npm run typecheck
```

Build the app:

```bash
npm run build
```

Package Windows binaries (installer + portable):

```bash
npm run package
```

Or package each target separately:

```bash
npm run package:installer
npm run package:portable
```

## Notes

- Directional sync requires its source folder to exist and be readable; a missing source is never interpreted as an empty tree. Two-way sync requires both folders to exist. Endpoint files, root junctions/symbolic links, and canonical same/nested locations are rejected.
- Startup changes persist restore records before disabling entries and retain them until restoration succeeds. Cache mutations are serialized and published atomically; invalid cache files are preserved rather than replaced with empty data.
- Batch Renamer journals each batch before moving files and recovers interrupted batches on startup. Undo uses staged renames for swaps and case-only changes, and new transactions track filesystem IDs to reject replacement files. If recovery cannot restore an original path safely, the journal and affected files are retained and the error identifies the recovery paths. Filesystems without stable file IDs are rejected for safety.

- Editing system startup entries may request permission for a restricted helper; the WinUtils application continues at normal permissions.
- Startup folder entries are restored from WinUtils cache storage, so deleting the cache files manually will prevent restore for those disabled items.
- The cache is stored in Electron's `app.getPath('userData')` location for the installed app.
- Always Active is best-effort because Windows only has one true foreground window. Prevent Deactivation uses a native window hook and may be blocked by protected, elevated, fullscreen, or anti-cheat apps.
- Clipboard Manager stores history locally under the app user data directory. Deleting matching entries also removes them from Windows clipboard history when available. Image OCR uses Windows built-in OCR and does not upload clipboard contents.
- Automation trigger and saved-window-layout definitions are stored locally under the app user data directory. Clipboard trigger checks remain local.
- Explorer integration writes only WinUtils-owned keys below `HKCU\Software\Classes`; the Context Menu module can remove them again without administrator access.
- File Sync starts with local folder-to-folder jobs only. Always review Analyze results first; Sync rejects nested endpoints, uses temporary verified copies, preserves copied file timestamps, syncs true empty folders, and moves replaced/deleted files into the WinUtils quarantine folder instead of hard-deleting them. Automation triggers require one successful manual sync before they can apply changes.
- Clipboard Privacy and storage controls offer app exclusions and a saved-history limit. New profiles use 30-day retention; existing retention choices and pinned items are preserved.
- File recovery restores recorded copies from new runs and deliberately purges completed copies. Existing destinations and incomplete recovery copies are protected.
- Settings exports theme, startup and tray preferences, previews imports before applying, and can save a diagnostic summary.
- Packaging generates installer and portable EXE artifacts in `release/`.
- Packaging rebuilds the native hook and application before creating artifacts; `npm run native:build` and `npm run typecheck` are available for build validation. Windows CI validates and creates unsigned artifacts without publishing them.
- Emergency stop pauses automation, cancels cooperating actions, stops macros/file sync between operations, and attempts owned audio/window restoration. Resume enables actions/file sync; audio and Always Active require explicit re-enabling.
- Hidden-window recovery persists window identities before hiding and retries restoration on startup. The Windows module also provides Restore all hidden windows; failed restorations retain recovery records.
- Current review status and remaining work are tracked in [PROJECT_REVIEW.md](PROJECT_REVIEW.md). Clipboard encryption is optional and tied to the Windows account and saved key. Focus Audio records recovery baselines before changing sessions and retries pending restoration on startup.
- Update checks use the public GitHub release feed. Installed builds download verified updates in-app and offer Install and Restart; portable builds link to the new portable EXE. Installer bytes must match the exact published GitHub asset, and signed installations additionally require the same verified publisher. Publish `latest.yml`, the installer EXE, and its blockmap with each installer release; portable users are shown a download link for the new portable EXE.
- Release EXEs are published as GitHub release assets and are not tracked in Git.
