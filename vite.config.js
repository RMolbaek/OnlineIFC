import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Version shown in the About dialog: the latest GitHub release (git tag) plus the number of
// changes since it, and the commit. Falls back to package.json when git is not available.
function buildInfo() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const git = (cmd) => { try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const describe = git('describe --tags --long --always'); // e.g. 0.0.1-12-g7d35a5a
  const m = /^(.*)-(\d+)-g([0-9a-f]+)$/.exec(describe);
  return {
    release: m ? m[1] : '',
    ahead: m ? Number(m[2]) : 0,
    commit: m ? m[3] : describe || '',
    date: git('log -1 --format=%cI') || new Date().toISOString(),
    version: pkg.version,
  };
}

// base: './' makes the built site work from any sub folder (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    // The big libraries get files of their own: they rarely change, so after an update of the app
    // the browser (and the offline cache) only fetches the small application file again.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'web-ifc', test: /node_modules[\\/]web-ifc/ },
            { name: 'three', test: /node_modules[\\/](three|three-mesh-bvh)[\\/]/ },
            { name: 'editor', test: /node_modules[\\/](codemirror|@codemirror|@lezer|crelt|style-mod|w3c-keyname|@marijn)/ },
          ],
        },
      },
    },
  },
  optimizeDeps: { exclude: ['web-ifc'] },
  worker: { format: 'es' },
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
    // the site serves the Python runtime itself when scripts/fetch-python.mjs has collected it
    __PY_SELF_HOSTED__: JSON.stringify(existsSync(new URL('./public/py/pyodide/pyodide.mjs', import.meta.url))),
  },
});
