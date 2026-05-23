import type { ReactElement } from 'react';

export function TrayPopup(): ReactElement {
  const handleOpen = (): void => {
    void window.winUtils.tray.showMain();
  };

  const handleQuit = (): void => {
    void window.winUtils.tray.quit();
  };

  return (
    <div className="tray-popup">
      <div className="tray-popup-header">
        <span className="tray-popup-mark" aria-hidden="true" />
        <div className="tray-popup-copy">
          <strong className="tray-popup-title">WinUtils</strong>
          <p className="tray-popup-eyebrow">Power Tools</p>
        </div>
      </div>
      <div className="tray-popup-actions">
        <button className="tray-popup-btn tray-popup-btn--primary" type="button" onClick={handleOpen} title="Show the main WinUtils window.">
          Open
        </button>
        <button className="tray-popup-btn tray-popup-btn--danger" type="button" onClick={handleQuit} title="Fully quit WinUtils instead of leaving it in the tray.">
          Quit
        </button>
      </div>
    </div>
  );
}
