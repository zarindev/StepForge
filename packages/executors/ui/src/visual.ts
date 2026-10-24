// Baselines and the pixel comparison are shared with phone and desktop apps (@stepforge/image-match).
export { baselineKey, compareWithBaseline } from '@stepforge/image-match/visual';

/**
 * Turns a URL pattern into a test: a glob with `*` (within a path segment) / `**` (anything; `**` then a slash also
 * matches no segment at all), else a substring. A glob starting with `/` is a path (any host), and a query string after the
 * matched part is fine unless the glob itself has a `?`.
 */
export function urlMatcher(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (p.includes('*')) {
    const glob = p.startsWith('/') ? `**${p}` : p;
    let re = '';
    for (let i = 0; i < glob.length;) {
      if (glob.startsWith('**/', i)) [re, i] = [re + '(?:.*/)?', i + 3];
      else if (glob.startsWith('**', i)) [re, i] = [re + '.*', i + 2];
      else if (glob[i] === '*') [re, i] = [re + '[^/]*', i + 1];
      else [re, i] = [re + glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&'), i + 1];
    }
    const query = glob.includes('?') ? '' : '(?:[?#].*)?';
    const rx = new RegExp(`^${re}${query}$`);
    return (u) => rx.test(u);
  }
  return (u) => u.includes(p);
}
