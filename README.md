# WinUtils

WinUtils is a Windows desktop utility app built with Electron, React, TypeScript, and Vite. It brings startup management, process-aware macros, focus-based audio muting, Playit.gg tunnel setup, and tray/window behavior controls into one desktop app.

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
- Macros with folders, profiles, recorded keyboard/mouse actions, and process-aware automatic profile switching
- Focus Audio with whitelist/blacklist modes for muting unfocused apps by audio session/process
- Playit Tunnels detects the local Playit.gg agent, offers Winget or direct signed-agent installer paths, and creates Playit-supported self-managed tunnel types through the Playit API
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
- Playit Tunnels requires a claimed Playit.gg agent. WinUtils can open the Playit claim page, finish the claim after browser approval, write Playit's local config without showing the agent secret, and refresh tunnels created outside the app.
- Packaging generates installer and portable EXE artifacts in `release/`.
- Auto-update support uses the public GitHub release feed. Publish `latest.yml`, the installer EXE, and its blockmap with each installer release; portable users are shown a download link for the new portable EXE.
- Release EXEs are published as GitHub release assets and are not tracked in Git.
