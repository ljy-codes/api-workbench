import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializePreferences } from './lib/preferences';
import './styles.css';
import './themes.css';

initializePreferences();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
