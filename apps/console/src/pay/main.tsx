import React from 'react';
import { createRoot } from 'react-dom/client';
import { PayApp } from './PayApp';
// The identity's typefaces, bundled: the page loads nothing from a third-party host, as its CSP requires.
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
// The console's stylesheet for its tokens only; pay.css sets every rule the page relies on.
import '../styles.css';
import './pay.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PayApp />
  </React.StrictMode>,
);
