import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
const App = lazy(() => import('./App'));
const ClipboardPopup = lazy(() => import('./ClipboardPopup').then(module => ({ default: module.ClipboardPopup })));
const CommandPalette = lazy(() => import('./CommandPalette').then(module => ({ default: module.CommandPalette })));
const TrayPopup = lazy(() => import('./TrayPopup').then(module => ({ default: module.TrayPopup })));
import './styles.css';

const isTray = window.location.hash === '#tray';
const isClipboardPopup = window.location.hash === '#clipboard-popup';
const isCommandPalette = window.location.hash === '#command-palette';

if (isTray) {
  document.body.classList.add('tray-mode');
} else if (isClipboardPopup) {
  document.body.classList.add('clipboard-popup-mode');
} else if (isCommandPalette) {
  document.body.classList.add('command-palette-mode');
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={<div className="empty-state" role="status">Loading WinUtils…</div>}>
    {isTray ? <TrayPopup /> : isClipboardPopup ? <ClipboardPopup /> : isCommandPalette ? <CommandPalette /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
