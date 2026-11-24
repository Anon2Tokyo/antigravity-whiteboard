// Prevent Excalidraw from fetching external fonts/assets from esm.sh under strict MCP App CSP
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string[] }).EXCALIDRAW_ASSET_PATH = [];

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
