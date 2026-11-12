import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
  build: { target: 'es2022', chunkSizeWarningLimit: 5000 },
  optimizeDeps: { exclude: ['web-ifc'] },
  worker: { format: 'es' },
  define: { __BUILD_INFO__: JSON.stringify(buildInfo()) },
});
