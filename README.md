# WinUtils

WinUtils is a Windows desktop utility app built with Electron, React, TypeScript, and Vite. It brings startup management, process-aware macros, focus-based audio muting, beta always-active app focus rules, clipboard history, safe file sync, and tray/window behavior controls into one desktop app.

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
- Macros with folders, profiles, recorded keyboard/mouse actions, process-aware automatic profile switching, a Helldivers 2 stratagem preset library (including full-pack import with configurable modifier key behavior), and an optional in-app keyboard preview for bound hotkeys
- Focus Audio with whitelist/blacklist modes for muting unfocused apps by audio session/process
- Always Active (Beta) rules for preventing window deactivation, throttled game keepalive signals, active-window signals, or focus-locking selected running apps
- Batch Renamer with drag-and-drop loading, ordered rename rules, live validation, conflict preview, reversible apply, and undo history
- Regex Lab with colored token suggestions, live match checks, capture previews, and direct export into Batch Renamer regex rules
- Clipboard Manager with local searchable history, pins, smart categories, image capture, Windows OCR, Windows history delete sync, and quick-access hotkeys
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

- Editing `HKLM` startup entries may require elevated privileges depending on the target machine and how the app is launched.
- Startup folder entries are restored from WinUtils cache storage, so deleting the cache files manually will prevent restore for those disabled items.
- The cache is stored in Electron's `app.getPath('userData')` location for the installed app.
- Always Active is best-effort because Windows only has one true foreground window. Prevent Deactivation uses a native window hook and may be blocked by protected, elevated, fullscreen, or anti-cheat apps.
- Clipboard Manager stores history locally under the app user data directory. Deleting matching entries also removes them from Windows clipboard history when available. Image OCR uses Windows built-in OCR and does not upload clipboard contents.
- File Sync starts with local folder-to-folder jobs only. Always review Analyze results first; Sync rejects nested endpoints, uses temporary verified copies, preserves copied file timestamps, syncs true empty folders, and moves replaced/deleted files into the WinUtils quarantine folder instead of hard-deleting them. Automation triggers require one successful manual sync before they can apply changes.
- Packaging generates installer and portable EXE artifacts in `release/`.
- Auto-update support uses the public GitHub release feed. Publish `latest.yml`, the installer EXE, and its blockmap with each installer release; portable users are shown a download link for the new portable EXE.
- Release EXEs are published as GitHub release assets and are not tracked in Git.
