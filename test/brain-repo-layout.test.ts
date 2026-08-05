import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  discoverProjectedSourceIds,
  ensureSourceProjectionMarker,
  resolveSourceProjectionRoot,
  toLogicalSourcePath,
  toRepoRelativeSourcePath,
} from '../src/core/brain-repo-layout.ts';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared brain-repo layout', () => {
  test('maps logical paths bidirectionally without losing source identity', () => {
    expect(resolveSourceProjectionRoot('/brain', 'default')).toBe('/brain');
    expect(resolveSourceProjectionRoot('/brain', 'project-p')).toBe(
      join('/brain', '.sources', 'project-p'),
    );

    expect(toRepoRelativeSourcePath('decisions/retention.md', 'default')).toBe(
      'decisions/retention.md',
    );
    expect(toRepoRelativeSourcePath('decisions/retention.md', 'project-p')).toBe(
      '.sources/project-p/decisions/retention.md',
    );

    expect(toLogicalSourcePath('decisions/retention.md', 'default')).toBe(
      'decisions/retention.md',
    );
    expect(toLogicalSourcePath('.sources/project-p/decisions/retention.md', 'project-p')).toBe(
      'decisions/retention.md',
    );
  });

  test('rejects the reserved .sources tree as default-source content', () => {
    expect(() =>
      toRepoRelativeSourcePath('.sources/project-p/decisions/retention.md', 'default'),
    ).toThrow('reserved hidden segment');
    expect(toLogicalSourcePath('.sources/project-p/decisions/retention.md', 'default')).toBeNull();
  });

  test('rejects hidden first segments inside a non-default source projection', () => {
    expect(() => toRepoRelativeSourcePath('.private/secret.md', 'project-p')).toThrow(
      'reserved hidden segment',
    );
    expect(toLogicalSourcePath('.sources/project-p/.private/secret.md', 'project-p')).toBeNull();
  });

  test('rejects logical paths containing backslashes', () => {
    expect(() => toRepoRelativeSourcePath('decisions\\retention.md', 'default')).toThrow();
  });

  test('rejects logical paths containing duplicate slashes', () => {
    expect(() => toRepoRelativeSourcePath('decisions//retention.md', 'default')).toThrow();
  });

  test('rejects logical paths containing dot segments', () => {
    expect(() => toRepoRelativeSourcePath('decisions/./retention.md', 'default')).toThrow();
  });

  test('discovers path-free logical sources from the reserved projection directory', () => {
    const repo = join(tmpdir(), `gbrain-layout-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(join(repo, '.sources', 'personal-u'), { recursive: true });
    mkdirSync(join(repo, '.sources', 'project-p'), { recursive: true });

    expect(discoverProjectedSourceIds(repo)).toEqual(['default', 'personal-u', 'project-p']);
  });

  test('fails closed on an invalid projected source directory', () => {
    const repo = join(tmpdir(), `gbrain-layout-invalid-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(join(repo, '.sources', 'Project P'), { recursive: true });

    expect(() => discoverProjectedSourceIds(repo)).toThrow('Invalid source_id');
  });

  test('fails closed when the default source is projected under .sources', () => {
    const repo = join(tmpdir(), `gbrain-layout-default-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(join(repo, '.sources', 'default'), { recursive: true });

    expect(() => discoverProjectedSourceIds(repo)).toThrow(
      'the default source belongs at the repository root',
    );
  });

  test('accepts the exact default identity marker at the repository root', () => {
    const repo = join(tmpdir(), `gbrain-layout-root-marker-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.gbrain-source'), 'default\n', 'utf8');

    expect(discoverProjectedSourceIds(repo)).toEqual(['default']);
  });

  test('accepts an exact CRLF identity marker checked out by Git on Windows', () => {
    const repo = join(tmpdir(), `gbrain-layout-root-marker-crlf-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.gbrain-source'), 'default\r\n', 'utf8');

    expect(discoverProjectedSourceIds(repo)).toEqual(['default']);
  });

  test('rejects a non-default identity marker at the repository root', () => {
    const repo = join(tmpdir(), `gbrain-layout-root-marker-wrong-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.gbrain-source'), 'project-p\n', 'utf8');

    expect(() => discoverProjectedSourceIds(repo)).toThrow(/default/);
  });

  test('rejects a repository-root identity marker without the exact trailing newline', () => {
    const repo = join(tmpdir(), `gbrain-layout-root-marker-format-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.gbrain-source'), 'default', 'utf8');

    expect(() => discoverProjectedSourceIds(repo)).toThrow(/default/);
  });

  test('rejects marker whitespace or extra lines beyond the single terminator', () => {
    for (const [suffix, content] of [
      ['space', 'default \n'],
      ['extra-line', 'default\r\nextra\r\n'],
      ['extra-terminator', 'default\n\n'],
    ] as const) {
      const repo = join(
        tmpdir(),
        `gbrain-layout-root-marker-${suffix}-${process.pid}-${Date.now()}`,
      );
      scratch.push(repo);
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, '.gbrain-source'), content, 'utf8');

      expect(() => discoverProjectedSourceIds(repo)).toThrow(/one LF or CRLF/);
    }
  });

  test('rejects a .sources symlink that escapes the repository', () => {
    const repo = join(tmpdir(), `gbrain-layout-symlink-repo-${process.pid}-${Date.now()}`);
    const outside = join(tmpdir(), `gbrain-layout-symlink-outside-${process.pid}-${Date.now()}`);
    scratch.push(repo, outside);
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(outside, 'project-p'), { recursive: true });
    symlinkSync(outside, join(repo, '.sources'), 'dir');

    expect(() => discoverProjectedSourceIds(repo)).toThrow();
  });

  test('rejects a discovered source whose marker disagrees with its directory id', () => {
    const repo = join(tmpdir(), `gbrain-layout-discovery-marker-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    const sourceRoot = join(repo, '.sources', 'project-p');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, '.gbrain-source'), 'project-q\n', 'utf8');

    expect(() => discoverProjectedSourceIds(repo)).toThrow(/project-p/);
  });

  test('creates the projection identity marker and remains idempotent', () => {
    const repo = join(tmpdir(), `gbrain-layout-marker-${process.pid}-${Date.now()}`);
    scratch.push(repo);

    const expectedPath = join(repo, '.sources', 'project-p', '.gbrain-source');
    expect(ensureSourceProjectionMarker(repo, 'project-p')).toBe(expectedPath);
    expect(readFileSync(expectedPath, 'utf8')).toBe('project-p\n');

    expect(ensureSourceProjectionMarker(repo, 'project-p')).toBe(expectedPath);
    expect(readFileSync(expectedPath, 'utf8')).toBe('project-p\n');
  });

  test('rejects an existing projection marker with a different source identity', () => {
    const repo = join(tmpdir(), `gbrain-layout-marker-mismatch-${process.pid}-${Date.now()}`);
    scratch.push(repo);
    const markerPath = join(repo, '.sources', 'project-p', '.gbrain-source');
    mkdirSync(join(repo, '.sources', 'project-p'), { recursive: true });
    writeFileSync(markerPath, 'project-q\n', 'utf8');

    expect(() => ensureSourceProjectionMarker(repo, 'project-p')).toThrow(
      'must contain exactly "project-p"',
    );
    expect(readFileSync(markerPath, 'utf8')).toBe('project-q\n');
  });
});
