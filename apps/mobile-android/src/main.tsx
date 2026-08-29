import React from 'react';

import ReactDOM from 'react-dom/client';

import '@azurity/pure-nerd-font/pure-nerd-font.css';
import '@fontsource-variable/inter';
import '@fontsource/fira-code';
import '@fontsource/jetbrains-mono';
import 'highlight.js/styles/atom-one-dark.css';
import 'katex/dist/katex.min.css';

import { MobileApp } from './MobileApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
