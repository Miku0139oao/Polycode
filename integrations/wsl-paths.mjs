// ACP structured path mapping for a Linux TUI driving Windows agents.
// Restrict to mounted Windows drives; do not guess mappings for Linux-only files.
export function toWindowsPath(value) {
  if (typeof value !== 'string') return value;
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(value);
  if (match) return `${match[1].toUpperCase()}:/${match[2] ?? ''}`;
  return value;
}
export function toWslPath(value) {
  if (typeof value !== 'string') return value;
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : value;
}
const paths = new Set(['cwd', 'path', 'filePath', 'oldPath', 'newPath']);
export function mapPaths(value, direction) {
  const convert = direction === 'windows' ? toWindowsPath : toWslPath;
  if (Array.isArray(value)) return value.map(v => mapPaths(v, direction));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (paths.has(key) && typeof v === 'string') result[key] = convert(v);
    else if (key === 'uri' && typeof v === 'string' && v.startsWith('file:///')) {
      const url = new URL(v);
      const path = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:\/)/, '$1');
      const mapped = convert(path);
      url.pathname = mapped.startsWith('/') ? mapped : '/' + mapped;
      result[key] = url.href;
    } else result[key] = mapPaths(v, direction);
  }
  return result;
}
