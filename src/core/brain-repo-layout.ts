/**
 * Physical layout for projecting multiple logical sources into one Git repo.
 *
 * Database identity remains `(source_id, slug)`. The reserved `.sources/`
 * directory is only a Git projection detail and must be removed before a path
 * is used as a logical slug or persisted as `pages.source_path`.
 *
 * Keep every write, sync, restore, and discovery caller on this module. A
 * future layout migration should change this file and its invariant tests, not
 * duplicate prefix arithmetic across command handlers.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { assertValidSourceId } from './source-id.ts';

export const BRAIN_REPO_SOURCES_DIR = '.sources';
export const BRAIN_REPO_SOURCE_MARKER = '.gbrain-source';

function normalizeRepoRelativePath(path: string): string {
  if (path.includes('\\')) {
    throw new Error(
      `Expected a canonical POSIX path relative to the brain repo, got ${JSON.stringify(path)}.`,
    );
  }
  const normalized = posix.normalize(path);
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Expected a path relative to the brain repo, got ${JSON.stringify(path)}.`);
  }
  if (normalized !== path) {
    throw new Error(
      `Expected a canonical POSIX path relative to the brain repo, got ${JSON.stringify(path)}.`,
    );
  }
  return normalized;
}

function hasHiddenFirstSegment(path: string): boolean {
  return path.split('/')[0]?.startsWith('.') === true;
}

/** Relative directory owned by one source (`''` means the repo root). */
export function sourceProjectionPrefix(sourceId: string): string {
  assertValidSourceId(sourceId);
  return sourceId === 'default'
    ? ''
    : posix.join(BRAIN_REPO_SOURCES_DIR, sourceId);
}

/** Absolute checkout directory walked for one logical source. */
export function resolveSourceProjectionRoot(repoRoot: string, sourceId: string): string {
  const prefix = sourceProjectionPrefix(sourceId);
  return prefix === '' ? repoRoot : join(repoRoot, ...prefix.split('/'));
}

function assertDirectoryInsideRepo(repoRoot: string, dirPath: string, label: string): void {
  const stats = lstatSync(dirPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a file or symlink: ${dirPath}`);
  }
  const realRepoRoot = realpathSync(repoRoot);
  const realDirPath = realpathSync(dirPath);
  const rel = relative(realRepoRoot, realDirPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realRepoRoot, rel) !== realDirPath) {
    throw new Error(`${label} escapes the shared brain-repo checkout: ${dirPath}`);
  }
}

/** Validate an existing marker without creating or rewriting it. */
export function assertSourceProjectionMarker(
  repoRoot: string,
  sourceId: string,
): string | null {
  assertValidSourceId(sourceId);
  const sourceRoot = resolveSourceProjectionRoot(repoRoot, sourceId);
  const markerPath = join(sourceRoot, BRAIN_REPO_SOURCE_MARKER);
  if (!existsSync(markerPath)) return null;

  const stats = lstatSync(markerPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Projection marker must be a regular file: ${markerPath}`);
  }
  const actual = readFileSync(markerPath, 'utf8');
  const lf = `${sourceId}\n`;
  const crlf = `${sourceId}\r\n`;
  if (actual !== lf && actual !== crlf) {
    throw new Error(
      `Projection marker ${markerPath} must contain exactly ${JSON.stringify(sourceId)} ` +
      'followed by one LF or CRLF line ending.',
    );
  }
  return markerPath;
}

/**
 * Keep a non-default source representable even when it currently has no pages.
 * Git does not track empty directories, so the marker is part of the projection
 * format and must be committed before an empty source can survive fresh clone.
 */
export function ensureSourceProjectionMarker(
  repoRoot: string,
  sourceId: string,
): string | null {
  assertValidSourceId(sourceId);
  if (sourceId === 'default') return null;
  const sourceRoot = resolveSourceProjectionRoot(repoRoot, sourceId);
  const markerPath = join(sourceRoot, BRAIN_REPO_SOURCE_MARKER);
  const expected = `${sourceId}\n`;
  if (existsSync(sourceRoot)) {
    assertDirectoryInsideRepo(repoRoot, sourceRoot, `Projection directory for source "${sourceId}"`);
  } else {
    mkdirSync(sourceRoot, { recursive: true });
    assertDirectoryInsideRepo(repoRoot, sourceRoot, `Projection directory for source "${sourceId}"`);
  }
  if (assertSourceProjectionMarker(repoRoot, sourceId)) return markerPath;
  writeFileSync(markerPath, expected, 'utf8');
  return markerPath;
}

/** Map a source-relative logical path to its Git-root-relative projection. */
export function toRepoRelativeSourcePath(logicalPath: string, sourceId: string): string {
  const path = normalizeRepoRelativePath(logicalPath);
  if (hasHiddenFirstSegment(path)) {
    throw new Error(
      `Logical source path ${JSON.stringify(logicalPath)} starts with a reserved hidden segment.`,
    );
  }
  const prefix = sourceProjectionPrefix(sourceId);
  return prefix === '' ? path : posix.join(prefix, path);
}

/** Resolve a logical source-relative path below the physical checkout root. */
export function resolveProjectedSourcePath(
  repoRoot: string,
  logicalPath: string,
  sourceId: string,
): string {
  const repoRelativePath = toRepoRelativeSourcePath(logicalPath, sourceId);
  return join(repoRoot, ...repoRelativePath.split('/'));
}

/**
 * Map a Git-root-relative path into one source's logical path.
 * Returns null when the physical path belongs to another source.
 */
export function toLogicalSourcePath(repoRelativePath: string, sourceId: string): string | null {
  const path = normalizeRepoRelativePath(repoRelativePath);
  const prefix = sourceProjectionPrefix(sourceId);
  if (prefix === '') {
    return hasHiddenFirstSegment(path) ? null : path;
  }
  if (!path.startsWith(`${prefix}/`)) return null;
  const logicalPath = path.slice(prefix.length + 1);
  return hasHiddenFirstSegment(logicalPath) ? null : logicalPath;
}

/**
 * Discover path-free logical sources encoded by a checkout.
 *
 * `default` is always represented by the repo root. Non-default sources are
 * direct directories under `.sources/`. Invalid directory names fail closed:
 * silently skipping one during disaster recovery would lose visible memory.
 */
export function discoverProjectedSourceIds(repoRoot: string): string[] {
  let repoStats: ReturnType<typeof lstatSync>;
  try {
    repoStats = lstatSync(repoRoot);
  } catch {
    throw new Error(`Shared brain-repo checkout does not exist: ${repoRoot}`);
  }
  if (!repoStats.isDirectory()) {
    throw new Error(`Shared brain-repo checkout is not a directory: ${repoRoot}`);
  }
  assertSourceProjectionMarker(repoRoot, 'default');
  const sourceRoot = join(repoRoot, BRAIN_REPO_SOURCES_DIR);
  if (existsSync(sourceRoot)) {
    assertDirectoryInsideRepo(repoRoot, sourceRoot, 'Shared projection root');
  }
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(sourceRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ['default'];
    throw error;
  }

  const sourceIds = ['default'];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Shared projection entries must not be symlinks: ${join(sourceRoot, entry.name)}`,
      );
    }
    if (!entry.isDirectory()) continue;
    assertValidSourceId(entry.name);
    if (entry.name === 'default') {
      throw new Error(
        `Invalid shared projection directory ${join(sourceRoot, entry.name)}: ` +
        'the default source belongs at the repository root.',
      );
    }
    const projectedRoot = join(sourceRoot, entry.name);
    assertDirectoryInsideRepo(repoRoot, projectedRoot, `Projection directory for source "${entry.name}"`);
    assertSourceProjectionMarker(repoRoot, entry.name);
    sourceIds.push(entry.name);
  }
  return sourceIds.sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b));
}
