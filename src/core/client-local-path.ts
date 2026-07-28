/**
 * Shared classifier for process/client-local absolute paths in structured
 * Postgres fields. Stable remote locators are shareable, unless they contain
 * one of the exact client roots being retired.
 */

const STABLE_URL_RE = /\b(?:https?|ssh|git|git\+ssh):\/\/[^\s"'<>]+/gi;
const STABLE_SCP_RE = /\b[^@\s/:]+@[^:\s/]+:[^\s"'<>]+/g;

export class ClientLocalStructuredPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientLocalStructuredPathError';
  }
}

function containsRootAtBoundary(value: string, root: string): boolean {
  if (!root) return false;
  const crossPlatformRoot =
    /^[A-Za-z]:[\\/]/.test(root) ||
    root.startsWith('\\\\') ||
    root.startsWith('//');
  const haystack = crossPlatformRoot
    ? value.replaceAll('\\', '/').toLowerCase()
    : value;
  const needle = crossPlatformRoot
    ? root.replaceAll('\\', '/').toLowerCase()
    : root;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const after = haystack[index + needle.length];
    if (after === undefined || /[\\/?#&=:;,\s"'()[\]{}]/.test(after)) {
      return true;
    }
    from = index + 1;
  }
  return false;
}

export function textContainsClientRoot(
  value: unknown,
  roots: readonly string[],
): boolean {
  return typeof value === 'string' &&
    roots.some((root) => containsRootAtBoundary(value, root));
}

function maskStableRemoteLocators(
  value: string,
  roots: readonly string[],
): string {
  const mask = (locator: string): string =>
    textContainsClientRoot(locator, roots) ? locator : '[stable-remote]';
  return value
    .replace(STABLE_URL_RE, mask)
    .replace(STABLE_SCP_RE, mask);
}

export function isClientPathShapedText(
  value: string,
  roots: readonly string[] = [],
): boolean {
  if (textContainsClientRoot(value, roots)) return true;
  const inspected = maskStableRemoteLocators(value, roots);
  return (
    // Historical locator schemes, including file:/// and directory:/ forms.
    /(?:^|[^A-Za-z0-9+.-])(?:file|directory|git|path):(?:\/\/)?[\\/]/i.test(inspected) ||
    // A POSIX path at the start or after a free-text/key-value boundary.
    /(?:^|[\s="'([{=,])\/(?!\/)/.test(inspected) ||
    // Forward-slash UNC/network paths at a boundary; exclude URL schemes.
    /(?:^|[\s="'([{=,])\/\/[^/\s]+\/[^/\s]+/.test(inspected) ||
    // A prefixed POSIX path such as "checkout:/srv/wiki", but not a URL.
    /:\/(?!\/)/.test(inspected) ||
    // Windows drive paths, raw or embedded in a small provenance phrase.
    /(?:^|[\s="'([{=,:])[A-Za-z]:[\\/]/.test(inspected) ||
    // UNC paths, raw or embedded.
    /(?:^|[\s="'([{=,:])\\\\[^\\/\s]+[\\/]/.test(inspected)
  );
}

export function structuredValueContainsClientPath(
  value: unknown,
  roots: readonly string[] = [],
): boolean {
  if (typeof value === 'string') {
    return isClientPathShapedText(value, roots);
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      structuredValueContainsClientPath(entry, roots));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) =>
        key === 'repoPath' ||
        structuredValueContainsClientPath(key, roots) ||
        structuredValueContainsClientPath(entry, roots),
    );
  }
  return false;
}
