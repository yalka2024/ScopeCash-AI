import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { transformSync } from 'esbuild';

// Vite config for ScopeCash AI.
//
// The dashboard was authored CRA-style: JSX lives inside `.js` files and the
// code reads `process.env.REACT_APP_*`. Vite/Rollup does NOT run esbuild on
// plain `.js`, so we add a `pre` plugin that transforms JSX-in-`.js` for every
// file under src/ (no need to rename ~30 files), and statically `define` the
// handful of env keys the app reads so the existing code builds unchanged.
const jsxInJs = {
  name: 'jsx-in-js',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]src[\\/].*\.js$/.test(id)) return null;
    const r = transformSync(code, { loader: 'jsx', jsx: 'automatic', sourcemap: true, sourcefile: id });
    return { code: r.code, map: r.map };
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [jsxInJs, react()],
  server: { port: 3000, proxy: { '/api': process.env.VITE_API_PROXY || 'http://localhost:4000' } },
  build: { outDir: 'build', sourcemap: false },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    'process.env.REACT_APP_API_URL': JSON.stringify(process.env.REACT_APP_API_URL || ''),
    'process.env.REACT_APP_SENTRY_DSN': JSON.stringify(process.env.REACT_APP_SENTRY_DSN || ''),
    'process.env.REACT_APP_SENTRY_ENV': JSON.stringify(process.env.REACT_APP_SENTRY_ENV || ''),
    'process.env.REACT_APP_SENTRY_RELEASE': JSON.stringify(process.env.REACT_APP_SENTRY_RELEASE || ''),
    'process.env.REACT_APP_SENTRY_TRACES': JSON.stringify(process.env.REACT_APP_SENTRY_TRACES || ''),
    'process.env.REACT_APP_SENTRY_REPLAY_ON_ERROR': JSON.stringify(process.env.REACT_APP_SENTRY_REPLAY_ON_ERROR || ''),
  },
}));

