// The two small cards for the installed app: "a new version is ready" and, on the home and
// sign-in screens, how to install Livepage (Share > Add to Home Screen on iPhone and iPad, or the
// browser's own Install dialog on Chrome, Edge and Android).
import { useState } from 'react';
import { Icon } from './design/Icon';
import { useLocation } from './router';
import { applyUpdate, dismissInstallHint, dismissUpdate, installHintDismissed, isIos, isStandalone, promptInstall, usePwa } from './pwa';

export function PwaPrompts() {
  const { updateReady, install } = usePwa();
  const { path } = useLocation();
  const [hintClosed, setHintClosed] = useState(() => installHintDismissed() || isStandalone());

  if (updateReady) {
    return (
      <div className="pwa-card" role="status">
        <Icon name="refresh" className="pwa-card-icon" />
        <p className="pwa-card-text">A new version of Livepage is ready.</p>
        <button type="button" className="primary" onClick={() => void applyUpdate()}>Reload</button>
        <button type="button" className="ghost pwa-card-close" aria-label="Later" title="Later" onClick={dismissUpdate}><Icon name="x" /></button>
      </div>
    );
  }

  const ios = isIos();
  if (hintClosed || (path !== '/' && path !== '/login') || !(ios || install)) return null;
  const close = () => { dismissInstallHint(); setHintClosed(true); };
  const device = /iPad/.test(navigator.userAgent) || (ios && !/iPhone|iPod/.test(navigator.userAgent)) ? 'iPad' : 'iPhone';
  return (
    <div className="pwa-card pwa-install" role="complementary" aria-label="Install Livepage">
      <img src="/icons/apple-touch-icon.png" alt="" width={36} height={36} className="pwa-card-app" />
      {ios ? (
        <div className="pwa-card-text">
          <strong>Add Livepage to your {device}</strong>
          <span>Tap <Icon name="ios-share" label="Share" /> <b>Share</b>, then <Icon name="square-plus" /> <b>Add to Home Screen</b>. You sign in once more inside the app.</span>
        </div>
      ) : (
        <>
          <div className="pwa-card-text">
            <strong>Install Livepage</strong>
            <span>Open it from your dock or home screen, in its own window.</span>
          </div>
          <button type="button" className="primary" onClick={() => { void promptInstall(); close(); }}>Install</button>
        </>
      )}
      <button type="button" className="ghost pwa-card-close" aria-label="Not now" title="Not now" onClick={close}><Icon name="x" /></button>
    </div>
  );
}
