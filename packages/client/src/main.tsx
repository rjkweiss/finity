import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// @ts-ignore: Allow importing CSS without type declarations
import './styles/App.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
