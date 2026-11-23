// iPhone and iPad screens that get their own launch (splash) image. iOS ignores the web app
// manifest's splash settings and needs one PNG per exact screen size, picked by a media query.
// Used by scripts/make-app-icons.mjs (draws them) and vite.config.ts (links them in index.html).
// Sizes are CSS pixels in portrait, then the device pixel ratio.
export const SPLASH_DEVICES = [
  [440, 956, 3], // iPhone 16/17 Pro Max
  [430, 932, 3], // iPhone 14/15 Pro Max, 15/16 Plus
  [428, 926, 3], // iPhone 12/13 Pro Max, 14 Plus
  [420, 912, 3], // iPhone Air
  [414, 896, 3], // iPhone XS Max, 11 Pro Max
  [414, 896, 2], // iPhone XR, 11
  [402, 874, 3], // iPhone 16 Pro, 17, 17 Pro
  [393, 852, 3], // iPhone 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // iPhone 12, 13, 14, 16e
  [375, 812, 3], // iPhone X, XS, 11 Pro, 12/13 mini
  [375, 667, 2], // iPhone SE (2nd/3rd), 8
  [320, 568, 2], // iPhone SE (1st)
  [744, 1133, 2], // iPad mini (6th+)
  [768, 1024, 2], // iPad (older), iPad mini 5
  [810, 1080, 2], // iPad (9th)
  [820, 1180, 2], // iPad (10th+), iPad Air 4/5
  [834, 1194, 2], // iPad Pro 11, iPad Air 11
  [834, 1210, 2], // iPad Pro 11 (M4)
  [1024, 1366, 2], // iPad Pro 12.9, iPad Air 13
  [1032, 1376, 2], // iPad Pro 13 (M4)
];

export const splashName = ([w, h, r], theme) => `splash/${w * r}x${h * r}-${theme}.png`;

/** <link rel="apple-touch-startup-image"> tags for every device, light and dark. */
export function splashLinks() {
  return SPLASH_DEVICES.flatMap((d) => ['light', 'dark'].map((theme) => {
    const [w, h, r] = d;
    const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`;
    return `<link rel="apple-touch-startup-image" media="${media}" href="/${splashName(d, theme)}" />`;
  })).join('\n    ');
}
