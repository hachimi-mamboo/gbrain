import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSync } from '../src/commands/sync.ts';
import {
  _resetCliExitVerdictForTests,
  currentExitCode,
} from '../src/core/cli-force-exit.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

function page(title: string, body: string): string {
  return `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function syncDbSnapshot(engine: PGLiteEngine): Promise<Record<string, unknown>> {
  return {
    sources: await engine.executeRaw(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, archived
         FROM sources ORDER BY id`,
    ),
    pages: await engine.executeRaw(
      `SELECT source_id, slug, title, compiled_truth, source_path, deleted_at
         FROM pages ORDER BY source_id, slug`,
    ),
    config: await engine.executeRaw(
      `SELECT key, value FROM config ORDER BY key`,
    ),
    jobs: await engine.executeRaw(
      `SELECT id, name, status, data, error_text FROM minion_jobs ORDER BY id`,
    ),
  };
}

function checkoutSnapshot(repo: string): { head: string; status: string } {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--porcelain']),
  };
}

async function captureRun(fn: () => Promise<void>): Promise<{
  error: unknown;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalStderrWrite = process.stderr.write;
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitSentinel = new Error('__captured_process_exit__');
  let error: unknown = null;
  let exitCode: number | null = null;

  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw exitSentinel;
  }) as never;
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } catch (caught) {
    if (caught !== exitSentinel) error = caught;
  } finally {
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    process.stderr.write = originalStderrWrite;
  }

  return { error, exitCode, stderr: stderr.join('\n'), stdout: stdout.join('\n') };
}

function capturedFailureText(result: Awaited<ReturnType<typeof captureRun>>): string {
  const errorText = result.error instanceof Error ? result.error.message : String(result.error ?? '');
  return `${result.stderr}\n${errorText}`;
}

describe('shared brain-repo native restore', () => {
  let engine: PGLiteEngine;
  let repo: string;
  let isolatedHome: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    _resetCliExitVerdictForTests();
    await resetPgliteState(engine);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-shared-projection-'));
    isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-shared-home-'));
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);

    mkdirSync(join(repo, 'decisions'), { recursive: true });
    mkdirSync(join(repo, '.sources', 'project-p', 'decisions'), { recursive: true });
    writeFileSync(
      join(repo, 'decisions', 'retention.md'),
      page('Default retention', 'default-source-body'),
    );
    writeFileSync(
      join(repo, '.sources', 'project-p', 'decisions', 'retention.md'),
      page('Project retention', 'project-source-body'),
    );
    mkdirSync(join(repo, '.sources', 'project-p', 'notes'), { recursive: true });
    writeFileSync(
      join(repo, '.sources', 'project-p', 'notes', 'delete-me.md'),
      page('Delete me', 'project-delete-body'),
    );
    writeFileSync(
      join(repo, '.sources', 'project-p', '.gbrain-source'),
      'project-p\n',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'projection']);
  });

  test('fresh Postgres restores same-slug sources and keeps client paths local', async () => {
    const legacyProjectPath = join(tmpdir(), 'legacy-project-checkout');
    const legacyRepoPath = join(tmpdir(), 'legacy-brain-checkout');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('project-p', 'Project P', $1, '{}'::jsonb)`,
      [legacyProjectPath],
    );
    await engine.setConfig('sync.repo_path', legacyRepoPath);
    await engine.logIngest({
      source_id: 'project-p',
      source_type: 'git',
      source_ref: `${legacyProjectPath}/decisions/retention.md`,
      pages_updated: ['decisions/retention'],
      summary: `imported from ${legacyProjectPath}`,
    });
    try {
      await withEnv(
        {
          GBRAIN_HOME: isolatedHome,
          GBRAIN_BRAIN_REPO_PATH: repo,
          GBRAIN_SOURCE: undefined,
          GBRAIN_SOURCE_PATH: undefined,
          GBRAIN_DATABASE_URL: undefined,
          DATABASE_URL: undefined,
        },
        () => runSync(engine, ['--all', '--no-pull', '--no-embed']),
      );

      const defaultPage = await engine.getPage('decisions/retention', { sourceId: 'default' });
      const projectPage = await engine.getPage('decisions/retention', { sourceId: 'project-p' });
      expect(defaultPage?.compiled_truth).toContain('default-source-body');
      expect(projectPage?.compiled_truth).toContain('project-source-body');

      const rows = await engine.executeRaw<{
        id: string;
        local_path: string | null;
        slug: string | null;
        source_path: string | null;
      }>(
        `SELECT s.id, s.local_path, p.slug, p.source_path
           FROM sources s
          LEFT JOIN pages p ON p.source_id = s.id
          WHERE s.id IN ('default', 'project-p')
            AND p.slug = 'decisions/retention'
          ORDER BY s.id`,
      );
      expect(rows).toEqual([
        {
          id: 'default',
          local_path: null,
          slug: 'decisions/retention',
          source_path: 'decisions/retention.md',
        },
        {
          id: 'project-p',
          local_path: null,
          slug: 'decisions/retention',
          source_path: 'decisions/retention.md',
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain(repo);
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
      const ingest = await engine.getIngestLog({ limit: 10 });
      expect(JSON.stringify(ingest)).not.toContain(legacyProjectPath);
      expect(JSON.stringify(ingest)).not.toContain(legacyRepoPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('first shared full sync re-exports a legacy DB-only page through the hardened shared root', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'gbrain-shared-remote-'));
    const freshClone = mkdtempSync(join(tmpdir(), 'gbrain-shared-fresh-'));
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('project-p', 'Project P', NULL, '{}'::jsonb)`,
      );
      await importFromContent(
        engine,
        'legacy/db-only',
        page('Legacy DB only', 'must-survive-adoption'),
        {
          noEmbed: true,
          sourceId: 'project-p',
          sourcePath: 'legacy/db-only.md',
        },
      );
      expect(existsSync(join(repo, '.sources', 'project-p', 'legacy', 'db-only.md'))).toBe(false);

      execFileSync('git', ['init', '--quiet', '--bare', bare]);
      git(repo, ['remote', 'add', 'origin', bare]);
      const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      git(repo, ['push', '--quiet', '--set-upstream', 'origin', branch]);

      await withEnv({
        GBRAIN_HOME: isolatedHome,
        GBRAIN_BRAIN_REPO_PATH: repo,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
        GBRAIN_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
      }, async () => {
        const hardened = await hardenBrainRepo({
          repoPath: repo,
          sourceId: 'brain-repo',
          installCron: false,
        });
        expect(hardened.needs_attention).toEqual([]);

        await runSync(engine, ['--all', '--no-pull', '--no-embed', '--no-extract']);
      });

      const rel = '.sources/project-p/legacy/db-only.md';
      expect(git(repo, ['ls-files', rel])).toBe(rel);
      const localHead = git(repo, ['rev-parse', 'HEAD']);
      for (let i = 0; i < 100; i++) {
        const remoteHead = execFileSync(
          'git', ['--git-dir', bare, 'rev-parse', branch],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
        if (remoteHead === localHead) break;
        await Bun.sleep(25);
      }
      expect(execFileSync(
        'git', ['--git-dir', bare, 'rev-parse', branch],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim()).toBe(localHead);

      rmSync(freshClone, { recursive: true, force: true });
      execFileSync('git', ['clone', '--quiet', '--branch', branch, bare, freshClone]);
      await expect(Bun.file(join(freshClone, rel)).text()).resolves.toContain('must-survive-adoption');
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(freshClone, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('dry-run discovers projection sources without mutating shared state', async () => {
    const legacyDefaultPath = join(tmpdir(), 'legacy-default-dry-run');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [legacyDefaultPath],
    );
    await engine.setConfig('sync.repo_path', legacyDefaultPath);
    const before = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources ORDER BY id`,
    );
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(
        env,
        () => runSync(engine, ['--all', '--dry-run', '--no-pull', '--no-embed']),
      );

      expect(await engine.executeRaw(
        `SELECT id, local_path FROM sources ORDER BY id`,
      )).toEqual(before);
      expect(await engine.getConfig('sync.repo_path')).toBe(legacyDefaultPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('incremental diff maps add, modify, delete, and rename through source-relative paths', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));

      writeFileSync(
        join(repo, 'decisions', 'retention.md'),
        page('Default retention', 'default-source-body-updated'),
      );
      mkdirSync(join(repo, 'notes'), { recursive: true });
      writeFileSync(join(repo, 'notes', 'added.md'), page('Added', 'default-added-body'));
      renameSync(
        join(repo, '.sources', 'project-p', 'decisions', 'retention.md'),
        join(repo, '.sources', 'project-p', 'decisions', 'archive.md'),
      );
      unlinkSync(join(repo, '.sources', 'project-p', 'notes', 'delete-me.md'));
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'incremental projection changes']);
      const head = git(repo, ['rev-parse', 'HEAD']);

      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));

      expect(
        (await engine.getPage('decisions/retention', { sourceId: 'default' }))?.compiled_truth,
      ).toContain('default-source-body-updated');
      expect((await engine.getPage('notes/added', { sourceId: 'default' }))?.compiled_truth).toContain(
        'default-added-body',
      );
      expect(await engine.getPage('decisions/retention', { sourceId: 'project-p' })).toBeNull();
      expect(
        (await engine.getPage('decisions/archive', { sourceId: 'project-p' }))?.compiled_truth,
      ).toContain('project-source-body');
      expect(await engine.getPage('notes/delete-me', { sourceId: 'project-p' })).toBeNull();

      const rows = await engine.executeRaw<{
        id: string;
        local_path: string | null;
        last_commit: string | null;
        source_path: string | null;
      }>(
        `SELECT s.id, s.local_path, s.last_commit, p.source_path
           FROM sources s
           JOIN pages p ON p.source_id = s.id
          WHERE s.id = 'project-p' AND p.slug = 'decisions/archive'`,
      );
      expect(rows).toEqual([{
        id: 'project-p',
        local_path: null,
        last_commit: head,
        source_path: 'decisions/archive.md',
      }]);
      expect(JSON.stringify(rows)).not.toContain('.sources');
      expect(JSON.stringify(rows)).not.toContain(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('cross-source rename deletes the old identity and imports the new source identity', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));

      mkdirSync(join(repo, '.sources', 'project-p', 'moved'), { recursive: true });
      renameSync(
        join(repo, 'decisions', 'retention.md'),
        join(repo, '.sources', 'project-p', 'moved', 'retention.md'),
      );
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'move page into project source']);

      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));

      expect(await engine.getPage('decisions/retention', { sourceId: 'default' })).toBeNull();
      expect(
        (await engine.getPage('moved/retention', { sourceId: 'project-p' }))?.compiled_truth,
      ).toContain('default-source-body');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('incremental extraction reads the selected projection instead of a default same-path file', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      mkdirSync(join(repo, 'links'), { recursive: true });
      mkdirSync(join(repo, '.sources', 'project-p', 'links'), { recursive: true });
      writeFileSync(join(repo, 'links', 'origin.md'), page('Default origin', 'no links yet'));
      writeFileSync(join(repo, 'links', 'default-target.md'), page('Default target', 'default'));
      writeFileSync(join(repo, '.sources', 'project-p', 'links', 'origin.md'), page('Project origin', 'no links yet'));
      writeFileSync(join(repo, '.sources', 'project-p', 'links', 'project-target.md'), page('Project target', 'project'));
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'add same-path extraction fixtures']);

      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));
      await engine.executeRaw(`DELETE FROM links`);

      writeFileSync(
        join(repo, 'links', 'origin.md'),
        page('Default origin', 'Links to [[links/default-target]].'),
      );
      writeFileSync(
        join(repo, '.sources', 'project-p', 'links', 'origin.md'),
        page('Project origin', 'Links to [[links/project-target]].'),
      );
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'add source-specific links']);

      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));

      const projectLinks = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT from_page.slug AS from_slug, to_page.slug AS to_slug
           FROM links l
           JOIN pages from_page ON from_page.id = l.from_page_id
           JOIN pages to_page ON to_page.id = l.to_page_id
          WHERE from_page.source_id = 'project-p'`,
      );
      expect(projectLinks).toContainEqual({
        from_slug: 'links/origin',
        to_slug: 'links/project-target',
      });
      expect(projectLinks).not.toContainEqual({
        from_slug: 'links/origin',
        to_slug: 'links/default-target',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('an emptied source is deleted from the current DB and remains discoverable after fresh restore', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));
      expect(await engine.getPage('decisions/retention', { sourceId: 'project-p' })).not.toBeNull();

      rmSync(join(repo, '.sources', 'project-p', 'decisions'), { recursive: true, force: true });
      rmSync(join(repo, '.sources', 'project-p', 'notes'), { recursive: true, force: true });
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'empty project source']);

      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));
      expect(await engine.getPage('decisions/retention', { sourceId: 'project-p' })).toBeNull();
      expect(await engine.getPage('notes/delete-me', { sourceId: 'project-p' })).toBeNull();

      const marker = join(repo, '.sources', 'project-p', '.gbrain-source');
      expect(Bun.file(marker).size).toBeGreaterThan(0);
      expect(git(repo, ['ls-files', '.sources/project-p/.gbrain-source']))
        .toBe('.sources/project-p/.gbrain-source');

      await resetPgliteState(engine);
      await withEnv(env, () => runSync(engine, ['--all', '--no-pull', '--no-embed']));
      const restored = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE id = 'project-p'`,
      );
      expect(restored).toEqual([{ id: 'project-p', local_path: null }]);
      expect(await engine.getPage('decisions/retention', { sourceId: 'project-p' })).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('shared projection uses its exported repo-level sync lock identity', async () => {
    try {
      const syncModule = await import('../src/commands/sync.ts');
      const sharedLockId = (
        syncModule as unknown as { SHARED_BRAIN_REPO_SYNC_LOCK_ID?: string }
      ).SHARED_BRAIN_REPO_SYNC_LOCK_ID;
      expect(sharedLockId).toBe('gbrain-sync:brain-repo');
      if (!sharedLockId) throw new Error('shared brain-repo sync lock id is not exported');

      const heldLock = await tryAcquireDbLock(engine, sharedLockId);
      if (!heldLock) throw new Error('could not acquire shared brain-repo sync lock for test');
      try {
        const dbBefore = await syncDbSnapshot(engine);
        const checkoutBefore = checkoutSnapshot(repo);
        const result = await withEnv(
          {
            GBRAIN_HOME: isolatedHome,
            GBRAIN_BRAIN_REPO_PATH: repo,
            GBRAIN_SOURCE: undefined,
            GBRAIN_SOURCE_PATH: undefined,
            GBRAIN_DATABASE_URL: undefined,
            DATABASE_URL: undefined,
          },
          () => captureRun(() => runSync(
            engine,
            ['--all', '--no-pull', '--no-embed', '--no-extract', '--json'],
          )),
        );

        expect(checkoutSnapshot(repo)).toEqual(checkoutBefore);
        expect(await syncDbSnapshot(engine)).toEqual(dbBefore);
        expect(result.error).toBeNull();
        expect(result.exitCode).toBeNull();
        expect(currentExitCode()).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          schema_version: 1,
          sources: [],
          parallel: 0,
          ok_count: 0,
          error_count: 1,
          error: { stage: 'shared_brain_repo_lock' },
        });
      } finally {
        await heldLock.release();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('incremental dry-run keeps an indexed page whose modified file became unsyncable', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(
        env,
        () => runSync(engine, ['--all', '--no-pull', '--no-embed', '--no-extract']),
      );
      await engine.executeRaw(
        `UPDATE sources SET config = '{"strategy":"code"}'::jsonb WHERE id = 'project-p'`,
      );
      writeFileSync(
        join(repo, '.sources', 'project-p', 'decisions', 'retention.md'),
        page('Project retention', 'project-source-body-now-unsyncable'),
      );
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'make indexed project page unsyncable']);

      const before = await engine.executeRaw<{
        source_id: string;
        slug: string;
        compiled_truth: string;
        source_path: string | null;
        deleted_at: string | null;
      }>(
        `SELECT source_id, slug, compiled_truth, source_path, deleted_at
           FROM pages
          WHERE source_id = 'project-p' AND slug = 'decisions/retention'`,
      );
      expect(before).toHaveLength(1);

      await withEnv(
        env,
        () => runSync(engine, [
          '--all', '--dry-run', '--no-pull', '--no-embed', '--no-extract',
        ]),
      );

      expect(await engine.executeRaw(
        `SELECT source_id, slug, compiled_truth, source_path, deleted_at
           FROM pages
          WHERE source_id = 'project-p' AND slug = 'decisions/retention'`,
      )).toEqual(before);
      expect(
        (await engine.getPage('decisions/retention', { sourceId: 'project-p' }))?.compiled_truth,
      ).toContain('project-source-body');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('shared --all ignores archived DB sources and does not create their marker', async () => {
    const archivedRoot = join(repo, '.sources', 'archived-x');
    const archivedMarker = join(archivedRoot, '.gbrain-source');
    const legacyArchivedPath = join(tmpdir(), 'legacy-archived-checkout');
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      mkdirSync(join(archivedRoot, 'notes'), { recursive: true });
      writeFileSync(
        join(archivedRoot, 'notes', 'private.md'),
        page('Archived note', 'archived-source-body'),
      );
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'add archived projection fixture']);
      await engine.executeRaw(
        `INSERT INTO sources (
           id, name, local_path, config, archived, archived_at, archive_expires_at
         )
         VALUES (
           'archived-x', 'Archived X', $1, '{}'::jsonb, TRUE, now(), now() - interval '1 hour'
         )`,
        [legacyArchivedPath],
      );
      expect(existsSync(archivedMarker)).toBe(false);

      await withEnv(
        env,
        () => runSync(engine, ['--all', '--no-pull', '--no-embed', '--no-extract']),
      );

      expect(await engine.getPage('notes/private', { sourceId: 'archived-x' })).toBeNull();
      expect(existsSync(archivedMarker)).toBe(false);
      expect(await engine.executeRaw(
        `SELECT last_commit, last_sync_at, archive_expires_at
           FROM sources WHERE id = 'archived-x'`,
      )).toEqual([{
        last_commit: null,
        last_sync_at: null,
        archive_expires_at: null,
      }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('shared sync refuses a dirty checkout without --no-pull and leaves state unchanged', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      writeFileSync(
        join(repo, 'decisions', 'retention.md'),
        page('Default retention', 'dirty-local-body'),
      );
      const dbBefore = await syncDbSnapshot(engine);
      const checkoutBefore = checkoutSnapshot(repo);

      const result = await withEnv(
        env,
        () => captureRun(() => runSync(engine, ['--all', '--no-embed', '--no-extract'])),
      );

      expect(checkoutSnapshot(repo)).toEqual(checkoutBefore);
      expect(await syncDbSnapshot(engine)).toEqual(dbBefore);
      expect(result.error !== null || (result.exitCode !== null && result.exitCode !== 0)).toBe(true);
      expect(capturedFailureText(result)).toMatch(/uncommitted changes[\s\S]*--no-pull/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('shared JSON sync envelopes post-pull layout failures without mutating DB', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      writeFileSync(join(repo, '.sources', 'project-p', '.gbrain-source'), 'wrong-source\n');
      const dbBefore = await syncDbSnapshot(engine);
      const checkoutBefore = checkoutSnapshot(repo);

      const result = await withEnv(
        env,
        () => captureRun(() => runSync(engine, [
          '--all', '--no-pull', '--no-embed', '--no-extract', '--json',
        ])),
      );

      expect(result.error).toBeNull();
      expect(result.exitCode).toBeNull();
      expect(currentExitCode()).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema_version: 1,
        sources: [],
        parallel: 0,
        ok_count: 0,
        error_count: 1,
        error: { stage: 'shared_brain_repo_layout' },
      });
      expect(await syncDbSnapshot(engine)).toEqual(dbBefore);
      expect(checkoutSnapshot(repo)).toEqual(checkoutBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('shared dry-run with --skip-failed leaves the failure ledger unchanged', async () => {
    const env = {
      GBRAIN_HOME: isolatedHome,
      GBRAIN_BRAIN_REPO_PATH: repo,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
    };
    try {
      await withEnv(env, async () => {
        const { loadSyncFailures, recordFailures } = await import(
          '../src/core/sync-failure-ledger.ts'
        );
        recordFailures('project-p', [{ path: 'broken.md', error: 'bad yaml' }], 'deadbeef');
        const before = loadSyncFailures();

        await runSync(engine, [
          '--all', '--dry-run', '--skip-failed', '--no-pull', '--no-embed', '--no-extract',
        ]);

        expect(loadSyncFailures()).toEqual(before);
        expect(loadSyncFailures()[0]?.state).toBe('open');
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 60_000);

  const invalidSharedInvocations: Array<{
    name: string;
    args: (repoPath: string) => string[];
    message: RegExp;
  }> = [
    {
      name: 'missing --all',
      args: () => ['--no-pull', '--no-embed', '--no-extract'],
      message: /--all/i,
    },
    {
      name: '--watch',
      args: () => ['--all', '--watch', '--no-pull', '--no-embed', '--no-extract'],
      message: /--watch/i,
    },
    {
      name: '--timeout',
      args: () => [
        '--all', '--timeout', '60', '--no-pull', '--no-embed', '--no-extract',
      ],
      message: /--timeout/i,
    },
    {
      name: '--src-subpath',
      args: () => [
        '--all', '--src-subpath', 'decisions', '--no-pull', '--no-embed', '--no-extract',
      ],
      message: /--src-subpath/i,
    },
    {
      name: '--repo',
      args: repoPath => [
        '--all', '--repo', repoPath, '--no-pull', '--no-embed', '--no-extract',
      ],
      message: /--repo[\s\S]*--all|--all[\s\S]*--repo/i,
    },
  ];

  for (const invocation of invalidSharedInvocations) {
    test(`shared projection rejects ${invocation.name} without changing checkout or DB`, async () => {
      const env = {
        GBRAIN_HOME: isolatedHome,
        GBRAIN_BRAIN_REPO_PATH: repo,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
      };
      try {
        const dbBefore = await syncDbSnapshot(engine);
        const checkoutBefore = checkoutSnapshot(repo);

        const result = await withEnv(
          env,
          () => captureRun(() => runSync(engine, invocation.args(repo))),
        );

        expect(checkoutSnapshot(repo)).toEqual(checkoutBefore);
        expect(await syncDbSnapshot(engine)).toEqual(dbBefore);
        expect(result.error !== null || (result.exitCode !== null && result.exitCode !== 0)).toBe(true);
        expect(capturedFailureText(result)).toMatch(invocation.message);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(isolatedHome, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
