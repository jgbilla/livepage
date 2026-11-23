// Applies the saved light/dark choice before first paint, so there is no flash (see src/design/theme.tsx).
try { var t = localStorage.getItem('livepage:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
