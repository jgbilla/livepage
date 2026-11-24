import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PwaPrompts } from './PwaPrompts';
import { preloadForLocation } from './preload';
import { startPwa } from './pwa';
import { captureHandoff, nameThisWindow } from './workspaceLinks';
import './styles.css';

captureHandoff(); // before anything reads the address
nameThisWindow();
preloadForLocation();
startPwa();
createRoot(document.getElementById('root')!).render(<><App /><PwaPrompts /></>);
