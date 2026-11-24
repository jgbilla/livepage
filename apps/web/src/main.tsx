import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PwaPrompts } from './PwaPrompts';
import { preloadForLocation } from './preload';
import { startPwa } from './pwa';
import { captureHandoff } from './workspaceLinks';
import './styles.css';

captureHandoff(); // before anything reads the address
preloadForLocation();
startPwa();
createRoot(document.getElementById('root')!).render(<><App /><PwaPrompts /></>);
