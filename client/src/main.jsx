import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import ErrorBoundary from './components/common/ErrorBoundary';
// Side-effect import: initialises i18next (and applies <html lang>) before the
// first render, so nothing ever paints an untranslated frame.
import './i18n';
import './styles/index.css';

/**
 * Applies the webfont.
 *
 * index.html requests it as `rel="preload" as="style"`, which fetches it at high
 * priority but blocks nothing — the paint no longer waits on a third-party round trip
 * the way it did when this was an ordinary stylesheet link. Flipping the `rel` here is
 * what turns the preloaded file into styles that apply.
 *
 * It is done from this module rather than an `onload` attribute on the tag because
 * production serves the page under a CSP with `script-src 'self'`, which blocks inline
 * handlers; done here it is ordinary bundle code. By the time this line runs the font
 * CSS has been downloading alongside the bundle and is normally already in cache.
 */
document.getElementById('app-font')?.setAttribute('rel', 'stylesheet');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Outside the boundary so a non-English shell bundle can suspend on the very
        first paint; the boundary still catches every render error below it. */}
    <Suspense fallback={null}>
      <ErrorBoundary>
        <Provider store={store}>
          <App />
        </Provider>
      </ErrorBoundary>
    </Suspense>
  </React.StrictMode>
);
