import { resolve as resolvePath } from 'path';
import type { BrainEngine } from './engine.ts';
import {
  ClientLocalStructuredPathError,
  structuredValueContainsClientPath,
} from './client-local-path.ts';
import { resolveClientSourcePath } from './source-resolver.ts';

function normalizedPath(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? value.replaceAll('\\', '/').toLowerCase()
    : resolvePath(value);
}

function pathBelongsToAnyRoot(
  candidate: string,
  roots: readonly string[],
): boolean {
  const value = normalizedPath(candidate);
  return roots.some((root) => {
    const normalizedRoot = normalizedPath(root);
    return value === normalizedRoot || value.startsWith(`${normalizedRoot}/`);
  });
}

function uniqueRoots(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/**
 * Engine-level backstop for direct/native structured writes. Product-facing
 * entrypoints still own the cleanup transaction; this pure guard prevents an
 * engine caller from bypassing the same client-local path boundary.
 */
export async function assertClientBoundStructuredWrite(
  engine: BrainEngine,
  value: unknown,
  fieldLabel: string,
): Promise<void> {
  const sourceId = process.env.GBRAIN_SOURCE;
  if (!sourceId || !process.env.GBRAIN_SOURCE_PATH) return;
  const clientPath = resolveClientSourcePath(sourceId);
  if (!clientPath) return;

  const sourceRows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  const sourceLocalPath = sourceRows[0]?.local_path ?? null;
  const sourceRoots = uniqueRoots([sourceLocalPath, clientPath]);
  const legacyRepoPath = await engine.getConfig('sync.repo_path');
  const roots = uniqueRoots([
    ...sourceRoots,
    legacyRepoPath !== null &&
      (
        sourceId === 'default' ||
        pathBelongsToAnyRoot(legacyRepoPath, sourceRoots)
      )
      ? legacyRepoPath
      : null,
  ]);

  if (structuredValueContainsClientPath(value, roots)) {
    throw new ClientLocalStructuredPathError(
      `Client-local source "${sourceId}" must not persist client-local paths in ${fieldLabel}.`,
    );
  }
}
