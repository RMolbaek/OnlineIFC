// Version shown in the About dialog: what was built (from git at build time, see vite.config.js)
// and the latest release on GitHub (fetched when the dialog opens).
import { t } from './i18n.js';

/* global __BUILD_INFO__ */
const REPO = 'vispecta-app/vispecta';
export const BUILD = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : { release: '', ahead: 0, commit: '', date: '', version: '' };

const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(document.documentElement.lang || undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return iso; } };

/** "0.0.1" or "0.0.1 + 12 changes" (or the package version when there are no release tags). */
export function versionLabel() {
  if (!BUILD.release) return BUILD.version || '?';
  return BUILD.ahead ? t('about.versionAhead', { release: BUILD.release, n: BUILD.ahead }) : BUILD.release;
}

let latest = null; // cached for the session
async function fetchLatest() {
  if (latest) return latest;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(String(res.status));
  const r = await res.json();
  latest = { tag: r.tag_name, name: r.name, url: r.html_url, date: r.published_at };
  // is the running build older than that release? (only asked when the tags differ)
  if (BUILD.commit && r.tag_name !== BUILD.release) {
    try {
      const c = await fetch(`https://api.github.com/repos/${REPO}/compare/${encodeURIComponent(r.tag_name)}...${BUILD.commit}`);
      if (c.ok) { const j = await c.json(); latest.behind = j.status === 'behind' || j.status === 'diverged'; }
    } catch { /* unknown */ }
  }
  return latest;
}

/** Fills the version block of the About dialog. */
export async function renderVersion(el, h) {
  const commitLink = BUILD.commit
    ? h('a', { href: `https://github.com/${REPO}/commit/${BUILD.commit}`, target: '_blank', rel: 'noopener', text: BUILD.commit })
    : null;
  const line1 = h('div', {}, h('b', { text: `${t('about.version')}: ` }), versionLabel(),
    commitLink ? h('span', { class: 'muted' }, ' · ', commitLink) : null,
    BUILD.date ? h('span', { class: 'muted', text: ` · ${fmtDate(BUILD.date)}` }) : null);
  const line2 = h('div', { class: 'muted small', text: t('about.checking') });
  el.replaceChildren(line1, line2);
  try {
    const r = await fetchLatest();
    const link = h('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.name && r.name.trim() && r.name.trim() !== r.tag ? `${r.tag} – ${r.name.trim()}` : r.tag });
    line2.replaceChildren(`${t('about.latestRelease')}: `, link, ` (${fmtDate(r.date)})`);
    if (r.behind) line2.append(h('div', { class: 'about-update', text: t('about.updateAvailable') }));
    line2.className = 'small';
  } catch {
    line2.replaceChildren(t('about.releasesOffline'), ' ', h('a', { href: `https://github.com/${REPO}/releases`, target: '_blank', rel: 'noopener', text: t('about.releasesLink') }));
  }
}
