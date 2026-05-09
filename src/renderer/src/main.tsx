import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TrayPopup } from './TrayPopup';
import './styles.css';

const isTray = window.location.hash === '#tray';

if (isTray) {
  document.body.classList.add('tray-mode');
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isTray ? <TrayPopup /> : <App />}
  </React.StrictMode>,
);
