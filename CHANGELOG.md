# Changelog

## v0.3.0 - 2026-10-05

This release strengthens recovery and privacy, adds safer settings controls, and simplifies everyday use.

### Added

- Added crash recovery for Focus Audio, a file recovery browser, and reviewed app-preference import/export.
- Added optional clipboard encryption, app exclusions, storage limits, and a diagnostic summary export.
- Added recent automation results with readable action names, failure details and elapsed time.
- Added automation activity and emergency stop/resume controls, durable hidden-window recovery, and a restore-all control.
- Added Windows build validation and native DLL rebuilds before packaging.
- Added centralized action hotkeys and compact Clipboard/Command Palette popups.
- Added reusable system, application, process, audio-session, window, clipboard, file, notification, PowerShell, and Explorer actions.
- Added direct Command Palette commands, advanced macro control flow, a multi-monitor Window Manager with saved layouts, persisted Automation Triggers, and configurable Explorer context-menu actions.

### Changed

- Simplified clipboard controls and settings previews; advanced privacy options are expandable.
- New clipboard profiles keep unpinned items for 30 days and use a 256 MB storage limit. Existing retention choices and pinned items are preserved.
- File recovery lists copies from new sync runs; older quarantine folders remain on disk.
- Installed builds keep in-app update downloads and restart installation; portable builds keep direct downloads.

### Security

- Startup permission requests now elevate only a restricted helper; automation stays at normal permissions.
- Windows file moves and final deletion use pinned handles and refuse collisions, replaced identities and reparse points.
- Encrypted clipboard backups require the original Windows account and the saved encryption key; back up the whole history folder.

### Fixed

- Fixed failed saves leaving unsaved settings in memory, damaged files replacing valid backups, and moving a macro to a missing folder losing it.
- Added update download cancellation, verified GitHub installer digests, and fail-stop cleanup after unexpected main-process errors.
- OCR reads encrypted images through stdin without writing plaintext temporary images.
- Clipboard retention now saves explicitly, keeps drafts during background updates, and rejects invalid limits before pruning history.
- Bulk clipboard clearing now asks for confirmation; quick access handles empty-list navigation and repeated Enter presses safely.
- Fixed native hook ownership and acknowledged teardown, including cleanup after the worker exits.
- Fixed cross-volume moves retaining verified recovery copies and preserving file timestamps.
- Fixed queued automation skipping cooldown, overlapping file polls, and malformed optional-module data preventing core tools from opening.
- Restricted privileged IPC to trusted application documents and moved regex evaluation into bounded workers.
- Fixed Focus Audio restoration losing saved volume after failures or output-device changes, and unmuting apps muted by the user.
- Focus Audio now retries failed restoration, waits for worker cleanup on exit, preserves manual mixer changes, and displays audio errors.
- Fixed native window and reusable PowerShell actions passing arguments as source text instead of securely separated values.
- Added bounded macro control flow and cancellation-aware waits so repeating or toggle macros can stop safely.

## v0.2.0 - 2026-08-23

This release adds Focus Audio volume ducking and selectable app themes, and rebuilds the interface on a consistent layout system.

### Added

- Added Focus Audio volume ducking so chosen apps are lowered while other apps are playing and restored automatically afterwards.
- Added per-rule ducking controls for trigger apps, target apps, and how much volume to remove.
- Added theme selection in Settings with WinUtils Ocean, Sable Tactical, and Sable Ember.
- Added macro hotkey conflict detection with one-click suggested replacements.
- Added a macro runtime panel showing the active hotkey backend and focus-monitor activity.
- Added macro profile export and import so profiles can be moved between machines.
- Added File Sync run history with the trigger, outcome, and applied or failed operation counts for each job.
- Added a File Sync control for deleting the selected job.
- Added File Sync options to keep replaced file versions and to exclude empty folders.

### Changed

- Redesigned the interface with consistent spacing, control sizing, panel hierarchy, and module navigation.
- Focus Audio now detects playback from audio output levels, so paused browser media releases ducking in seconds instead of waiting for the browser to close its audio session.
- File Sync quarantine for deleted and replaced files is now an option instead of always being applied.
- Clipboard Manager now polls sequentially so slow clipboard reads cannot overlap.
- Renderer windows now run with an explicit Content Security Policy.

### Fixed

- Fixed overlapping and clipped elements across module headers, toolbars, and long file paths.
- Fixed File Sync reporting an analysis error when a job had no folders selected.
- Fixed Clipboard Manager continuing to poll after clipboard monitoring was turned off.

## v0.1.13 - 2026-07-04

This release focuses on macro reliability, editor usability, and clipboard retention controls.

### Added

- Added Clipboard Manager retention controls for maximum unpinned entries and maximum unpinned age.
- Added support for dragging macro action nodes into IF branches and nested action groups.

### Changed

- Improved macro linked-action rails so paired Down/Up actions are easier to follow in nested lists.
- Moved modifier-only macro hotkeys to an isolated worker path to avoid main-process hook freezes.

### Fixed

- Fixed localized macro hotkeys so non-ASCII keys no longer crash Electron accelerator registration.
- Fixed modifier-only hotkeys so held movement keys do not block standalone modifier macros.
- Fixed standalone modifier hotkeys retriggering from their own injected modifier actions.
- Fixed IF key-state conditions so held keys are detected reliably during macro playback.
- Fixed macro arrow-key actions saved as `ArrowUp`, `ArrowDown`, `ArrowLeft`, or `ArrowRight`.
- Fixed Clipboard Manager search refreshing the full page while typing through larger histories.
- Fixed macro action link rail placement and Clipboard retention pruning order.
