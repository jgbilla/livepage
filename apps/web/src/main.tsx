import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PwaPrompts } from './PwaPrompts';
import { preloadForLocation } from './preload';
import { startPwa } from './pwa';
import './styles.css';

preloadForLocation();
startPwa();
createRoot(document.getElementById('root')!).render(<><App /><PwaPrompts /></>);
