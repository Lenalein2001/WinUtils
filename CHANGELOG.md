# Changelog

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