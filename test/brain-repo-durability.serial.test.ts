/**
 * brain-repo-durability core (v0.42.44): hardenBrainRepo / unhardenBrainRepo /
 * acceptPat. Real git against a local bare remote. HOME + GBRAIN_HOME are
 * redirected to a tmp dir; installCron:false so the suite never touches launchd.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  hardenBrainRepo, unhardenBrainRepo, acceptPat, maintainPushLog,
} from '../src/core/brain-repo-durability.ts';
import { runHarden, runPull, runUnharden } from '../src/commands/sources-harden.ts';
import { runSync } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const PAT = 'ghp_TESTSECRETTOKEN0123456789abcdef';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
function commitCount(work: string): number {
  return parseInt(git(work, 'rev-list', '--count', 'HEAD'), 10);
}
/** git config read that returns '' instead of throwing when the key is unset. */
function cfg(work: string, key: string): string {
  try { return git(work, 'config', '--local', '--get', key); } catch { return ''; }
}

let root: string;
let work: string;
let bare: string;
let oldHome: string | undefined;
let oldGbrainHome: string | undefined;

function makePair(): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

async function harden(extra: Record<string, unknown> = {}) {
  return hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: PAT, installCron: false, ...extra });
}

async function sharedBrainEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedSharedSourcePaths(engine);
  return engine;
}

async function seedSharedSourcePaths(engine: PGLiteEngine): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET local_path = $1,
            config = $2::jsonb
      WHERE id = 'default'`,
    [
      join(root, 'stale-default-client'),
      JSON.stringify({ remote_url: 'https://github.com/example/default-memory.git' }),
    ],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('project-p', 'Project P', $1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       local_path = EXCLUDED.local_path,
       config = EXCLUDED.config`,
    [
      join(root, 'stale-project-client'),
      JSON.stringify({ remote_url: 'https://gitlab.com/example/project-memory.git' }),
    ],
  );
  await engine.setConfig('sync.repo_path', join(root, 'stale-default-client'));
}

async function sourceBindingRows(engine: PGLiteEngine): Promise<Array<{
  id: string;
  local_path: string | null;
  config: Record<string, unknown>;
}>> {
  return engine.executeRaw(
    `SELECT id, local_path, config FROM sources ORDER BY id`,
  );
}

async function withExitCapture(fn: () => Promise<void>): Promise<number | null> {
  const originalExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__captured_process_exit__');
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__captured_process_exit__') throw error;
  } finally {
    process.exit = originalExit;
  }
  return exitCode;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brd-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir (config.ts semantics — `.gbrain` is
  // appended by the resolver), so the effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  makePair();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('hardenBrainRepo', () => {
  test('shared brain repo hardens once and ignores per-source remote hosts for the PAT guard', async () => {
    const engine = await sharedBrainEngine();
    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logLines.push(args.map(String).join(' '));
    try {
      const marker = join(work, '.sources', 'project-p', '.gbrain-source');
      const beforeSources = await sourceBindingRows(engine);
      const beforeConfig = await engine.executeRaw<{ key: string; value: unknown }>(
        `SELECT key, value FROM config ORDER BY key`,
      );
      const beforeHead = git(work, 'rev-parse', 'HEAD');
      const beforeStatus = git(work, 'status', '--porcelain');
      expect(existsSync(marker)).toBe(false);

      const exitCode = await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_GITHUB_PAT: PAT,
      }, () => withExitCapture(() => runHarden(engine, [
        '--all', '--dry-run', '--no-cron', '--no-verify', '--json',
      ])));

      expect(exitCode).toBeNull();
      const output = JSON.parse(logLines.at(-1)!);
      expect(output.reports).toHaveLength(1);
      expect(output.reports[0]).toMatchObject({
        source_id: 'brain-repo',
        repo_path: work,
      });

      // A preview may read every source and inspect Git, but must not retire
      // client paths, mutate config, create projection markers, or touch HEAD.
      expect(await sourceBindingRows(engine)).toEqual(beforeSources);
      expect(await engine.executeRaw(
        `SELECT key, value FROM config ORDER BY key`,
      )).toEqual(beforeConfig);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(work, '.sources'))).toBe(false);
      expect(git(work, 'rev-parse', 'HEAD')).toBe(beforeHead);
      expect(git(work, 'status', '--porcelain')).toBe(beforeStatus);
    } finally {
      console.log = originalLog;
      await engine.disconnect();
    }
  }, 60_000);

  test('formal shared harden commits and pushes every source projection marker', async () => {
    const engine = await sharedBrainEngine();
    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logLines.push(args.map(String).join(' '));
    try {
      const markerRel = '.sources/project-p/.gbrain-source';
      const marker = join(work, markerRel);
      const beforeCommits = commitCount(work);

      const exitCode = await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_GITHUB_PAT: undefined,
      }, () => withExitCapture(() => runHarden(engine, [
        '--all', '--no-cron', '--json',
      ])));

      expect(exitCode).toBeNull();
      const output = JSON.parse(logLines.at(-1)!);
      expect(output.reports).toHaveLength(1);
      expect(output.reports[0]).toMatchObject({
        source_id: 'brain-repo',
        repo_path: work,
        clean_against_origin: true,
      });
      expect(output.reports[0].steps).toContainEqual(expect.objectContaining({
        step: 'commit',
        status: 'fixed',
      }));

      expect(readFileSync(marker, 'utf8')).toBe('project-p\n');
      expect(git(work, 'ls-files', markerRel)).toBe(markerRel);
      expect(git(work, 'show', `HEAD:${markerRel}`)).toBe('project-p');
      expect(commitCount(work)).toBe(beforeCommits + 1);

      const remoteMarker = execFileSync(
        'git',
        ['--git-dir', bare, 'show', `main:${markerRel}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const remoteHead = execFileSync(
        'git',
        ['--git-dir', bare, 'rev-parse', 'main'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      expect(remoteMarker).toBe('project-p\n');
      expect(remoteHead).toBe(git(work, 'rev-parse', 'HEAD'));
      expect(git(work, 'status', '--porcelain')).toBe('');
    } finally {
      console.log = originalLog;
      await engine.disconnect();
    }
  }, 60_000);

  test('shared sync upgrades an already-hardened repo by committing and pushing missing markers', async () => {
    const engine = await sharedBrainEngine();
    const markerRel = '.sources/project-p/.gbrain-source';
    const marker = join(work, markerRel);
    try {
      const hardened = await hardenBrainRepo({
        repoPath: work,
        sourceId: 'brain-repo',
        installCron: false,
      });
      expect(hardened.needs_attention).toEqual([]);
      expect(existsSync(marker)).toBe(false);

      await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
      }, () => runSync(engine, [
        '--all', '--no-pull', '--no-embed', '--no-extract',
      ]));

      expect(readFileSync(marker, 'utf8')).toBe('project-p\n');
      expect(git(work, 'show', `HEAD:${markerRel}`)).toBe('project-p');
      const remoteMarker = execFileSync(
        'git',
        ['--git-dir', bare, 'show', `main:${markerRel}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(remoteMarker).toBe('project-p\n');
      expect(git(work, 'status', '--porcelain')).toBe('');
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('shared sources pull applies an upstream marker repair before DB path retirement', async () => {
    const markerRel = '.sources/project-p/.gbrain-source';
    const marker = join(work, markerRel);
    mkdirSync(join(work, '.sources', 'project-p'), { recursive: true });
    writeFileSync(marker, 'wrong-source\n');
    git(work, 'add', markerRel);
    git(work, 'commit', '-qm', 'malformed marker');
    git(work, 'push', '-q', 'origin', 'main');

    const repair = mkdtempSync(join(root, 'repair-'));
    execFileSync('git', [
      '-c', 'protocol.file.allow=always', 'clone', '-q', bare, repair,
    ], { stdio: 'ignore' });
    git(repair, 'config', 'user.email', 'repair@t.t');
    git(repair, 'config', 'user.name', 'repair');
    writeFileSync(join(repair, markerRel), 'project-p\n');
    git(repair, 'add', markerRel);
    git(repair, 'commit', '-qm', 'repair marker');
    git(repair, 'push', '-q', 'origin', 'main');

    const engine = await sharedBrainEngine();
    try {
      await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
      }, () => runPull(engine, ['project-p']));

      expect(readFileSync(marker, 'utf8')).toBe('project-p\n');
      expect((await sourceBindingRows(engine)).map(row => row.local_path))
        .toEqual([null, null]);
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('shared harden and pull by explicit id prepare every logical source without persisting the checkout', async () => {
    const engine = await sharedBrainEngine();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
        GBRAIN_GITHUB_PAT: undefined,
      }, async () => {
        await runHarden(engine, [
          'project-p', '--no-cron', '--no-verify', '--json',
        ]);
        expect((await sourceBindingRows(engine)).every(row => row.local_path === null)).toBe(true);
        expect(readFileSync(
          join(work, '.sources', 'project-p', '.gbrain-source'),
          'utf8',
        )).toBe('project-p\n');

        await seedSharedSourcePaths(engine);
        await runPull(engine, ['project-p']);
        const rows = await sourceBindingRows(engine);
        expect(rows.every(row => row.local_path === null)).toBe(true);
        expect(JSON.stringify(rows)).not.toContain(work);
        expect(await engine.getConfig('sync.repo_path')).toBeNull();
      });
    } finally {
      console.log = originalLog;
      await engine.disconnect();
    }
  }, 60_000);

  test('shared unharden removes the checkout-level durability identity', async () => {
    const engine = await sharedBrainEngine();
    const sharedWrapper = join(process.env.GBRAIN_HOME!, 'brain-pull-brain-repo.sh');
    mkdirSync(process.env.GBRAIN_HOME!, { recursive: true });
    writeFileSync(sharedWrapper, '#!/bin/sh\n', { mode: 0o755 });

    try {
      await withEnv({
        GBRAIN_BRAIN_REPO_PATH: work,
        GBRAIN_SOURCE: undefined,
        GBRAIN_SOURCE_PATH: undefined,
      }, () => runUnharden(engine, ['project-p']));
      expect(existsSync(sharedWrapper)).toBe(false);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('client-local harden and pull never write the checkout path to shared state', async () => {
    const stableRemote = 'https://git.example.invalid/private/wiki.git';
    const clientA = join(root, 'client-a');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, clientA], {
      stdio: 'ignore',
    });
    for (const checkout of [work, clientA]) {
      git(checkout, 'remote', 'set-url', 'origin', stableRemote);
      git(checkout, 'config', `url.file://${bare}.insteadOf`, stableRemote);
    }
    const stableCommit = git(work, 'rev-parse', 'HEAD');
    const dbEngine = new PGLiteEngine();
    await dbEngine.connect({});
    await dbEngine.initSchema();

    const seedStaleState = async (marker: string): Promise<void> => {
      await dbEngine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_commit, config)
         VALUES ('wiki', 'Wiki', $1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           local_path = EXCLUDED.local_path,
           last_commit = EXCLUDED.last_commit,
           config = EXCLUDED.config`,
        [
          clientA,
          stableCommit,
          JSON.stringify({ remote_url: stableRemote, tracked_branch: 'main' }),
        ],
      );
      await dbEngine.setConfig('sync.repo_path', clientA);
      await dbEngine.setConfig('sync.last_commit', 'stable-bookmark');
      await dbEngine.executeRaw(
        `INSERT INTO ingest_log (source_id, source_type, source_ref, summary)
         VALUES ('wiki', 'directory', $1, $2)`,
        [clientA, marker],
      );
      await dbEngine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, error_text)
         VALUES ('sync', 'waiting', $1::jsonb, $2)`,
        [JSON.stringify({
          sourceId: 'wiki',
          repoPath: clientA,
          commit: marker,
        }), `failed at ${clientA}`],
      );
    };

    const assertStaleStateRetired = async (marker: string): Promise<void> => {
      const sourceRows = await dbEngine.executeRaw<{
        id: string;
        local_path: string | null;
        last_commit: string | null;
        config: Record<string, unknown>;
      }>(`SELECT id, local_path, last_commit, config FROM sources WHERE id = 'wiki'`);
      expect(sourceRows[0]).toEqual({
        id: 'wiki',
        local_path: null,
        last_commit: stableCommit,
        config: { remote_url: stableRemote, tracked_branch: 'main' },
      });
      expect(await dbEngine.getConfig('sync.repo_path')).toBeNull();
      expect(await dbEngine.getConfig('sync.last_commit')).toBe('stable-bookmark');

      const logs = await dbEngine.executeRaw<{ source_ref: string }>(
        `SELECT source_ref FROM ingest_log WHERE summary = $1`,
        [marker],
      );
      expect(logs).toEqual([{ source_ref: 'source:wiki' }]);
      const jobs = await dbEngine.executeRaw<{
        status: string;
        data: Record<string, unknown>;
        error_text: string | null;
      }>(
        `SELECT status, data, error_text FROM minion_jobs WHERE data->>'commit' = $1`,
        [marker],
      );
      expect(jobs).toEqual([{
        status: 'cancelled',
        data: { sourceId: 'wiki', commit: marker },
        error_text: 'cancelled: client-local source binding retired queued checkout path',
      }]);

      const sharedState = JSON.stringify({
        source: sourceRows,
        config: await dbEngine.executeRaw(`SELECT key, value FROM config`),
        logs,
        jobs,
      });
      expect(sharedState).not.toContain(clientA);
      expect(sharedState).not.toContain(work);
      expect(sharedState).not.toContain(bare);
      expect(sharedState).not.toContain(root);
    };

    try {
      await withEnv({
        GBRAIN_SOURCE: 'wiki',
        GBRAIN_SOURCE_PATH: work,
        GBRAIN_GITHUB_PAT: undefined,
      }, async () => {
        await seedStaleState('harden-entry');
        await runHarden(dbEngine, [
          'wiki', '--dry-run', '--no-cron', '--no-verify', '--json',
        ]);
        await assertStaleStateRetired('harden-entry');

        await seedStaleState('pull-entry');
        await runPull(dbEngine, ['wiki']);
        await assertStaleStateRetired('pull-entry');
      });
    } finally {
      await dbEngine.disconnect();
    }
  });

  test('source commands reject a client checkout whose origin does not match the shared source', async () => {
    const engine = {
      executeRaw: async () => [{
        id: 'wiki',
        local_path: null,
        config: { remote_url: 'https://git.example.invalid/other.git' },
      }],
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const before = git(work, 'rev-parse', 'HEAD');

    await withEnv({
      GBRAIN_SOURCE: 'wiki',
      GBRAIN_SOURCE_PATH: work,
      GBRAIN_GITHUB_PAT: undefined,
    }, async () => {
      await expect(
        runHarden(engine, ['wiki', '--dry-run', '--no-cron', '--no-verify']),
      ).rejects.toThrow(/url-drift/);
      await expect(runPull(engine, ['wiki'])).rejects.toThrow(/url-drift/);
    });

    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  test('harden --all rejects a process-local checkout binding before reading sources', async () => {
    const engine = {
      executeRaw: async () => {
        throw new Error('source rows must not be read');
      },
    } as unknown as BrainEngine;

    await withEnv({
      GBRAIN_SOURCE: 'wiki',
      GBRAIN_SOURCE_PATH: work,
      GBRAIN_GITHUB_PAT: undefined,
    }, async () => {
      await expect(
        runHarden(engine, ['--all', '--dry-run', '--no-cron', '--no-verify']),
      ).rejects.toThrow(/--all cannot be combined with GBRAIN_SOURCE_PATH/);
    });
  });

  test('installs hook (local, untracked, +x), helper, and AGENTS rules', async () => {
    const r = await harden();
    // hook
    const hookPath = join(work, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('post-commit hook');
    expect(statSync(hookPath).mode & 0o111).toBeTruthy(); // executable
    // helper (committed, +x)
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    expect(existsSync(helperPath)).toBe(true);
    expect(statSync(helperPath).mode & 0o111).toBeTruthy();
    // AGENTS.md with managed block + taxonomy
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('BEGIN gbrain-brain-durability');
    expect(agents).toContain('people/');
    expect(agents).toContain('brain-commit-push.sh');
    // verify pushed scaffolding → clean against origin
    expect(r.clean_against_origin).toBe(true);
    expect(r.needs_attention).toEqual([]);
  });

  test('is idempotent — second run adds NO new commit', async () => {
    await harden();
    const after1 = commitCount(work);
    const r2 = await harden();
    expect(commitCount(work)).toBe(after1); // no churn
    // every step is ok/skipped on the second pass (nothing left to fix)
    expect(r2.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
  });

  test('harden commits only managed artifacts and preserves unrelated staged work', async () => {
    const unrelated = join(work, 'unrelated.md');
    writeFileSync(unrelated, 'user work\n');
    git(work, 'add', 'unrelated.md');

    const r = await harden();

    expect(r.clean_against_origin).toBe(true);
    expect(git(work, 'diff', '--cached', '--name-only')).toBe('unrelated.md');
    expect(() => git(work, 'show', 'HEAD:unrelated.md')).toThrow();
    expect(git(work, 'show', 'HEAD:scripts/brain-commit-push.sh')).toContain('gbrain');
  });

  test('installed commit-push helper leaves unrelated staged work untouched', async () => {
    await harden();
    const helper = join(work, 'scripts', 'brain-commit-push.sh');
    // Keep this test deterministic: exercise the helper's own synchronous push
    // without the separate post-commit background hook racing it.
    rmSync(join(work, '.git', 'hooks', 'post-commit'), { force: true });
    writeFileSync(join(work, 'unrelated.md'), 'user work\n');
    writeFileSync(join(work, 'managed.md'), 'managed\n');
    git(work, 'add', 'unrelated.md');

    execFileSync(helper, ['managed projection', 'managed.md'], {
      cwd: work,
      stdio: 'pipe',
      env: { ...process.env, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' },
    });

    expect(git(work, 'diff', '--cached', '--name-only')).toBe('unrelated.md');
    expect(() => git(work, 'show', 'HEAD:unrelated.md')).toThrow();
    expect(git(work, 'show', 'HEAD:managed.md')).toBe('managed');
    expect(execFileSync(
      'git', ['--git-dir', bare, 'show', 'main:managed.md'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )).toBe('managed\n');
  });

  test('harden retry pushes a previously committed managed change', async () => {
    await harden();
    const markerRel = '.sources/project-p/.gbrain-source';
    const marker = join(work, markerRel);
    mkdirSync(join(work, '.sources', 'project-p'), { recursive: true });
    writeFileSync(marker, 'project-p\n');
    git(work, 'add', markerRel);
    git(work, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'local marker');
    expect(() => execFileSync(
      'git', ['--git-dir', bare, 'show', `main:${markerRel}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )).toThrow();

    const r = await harden({ managedPaths: [marker] });

    expect(r.clean_against_origin).toBe(true);
    expect(r.steps).toContainEqual(expect.objectContaining({
      step: 'commit',
      status: 'fixed',
      detail: 'pushed previously committed durability changes',
    }));
    expect(execFileSync(
      'git', ['--git-dir', bare, 'show', `main:${markerRel}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )).toBe('project-p\n');
  });

  test('the post-commit hook is UNTRACKED (never committed)', async () => {
    await harden();
    const tracked = git(work, 'ls-files');
    expect(tracked.includes('post-commit')).toBe(false);
    expect(tracked).toContain('scripts/brain-commit-push.sh'); // helper IS tracked
  });

  test('D3 — patches RESOLVER.md when it exists, not AGENTS.md', async () => {
    writeFileSync(join(work, 'RESOLVER.md'), '# my resolver\n\nuser content\n');
    git(work, 'add', 'RESOLVER.md'); git(work, 'commit', '-qm', 'resolver');
    await harden();
    expect(readFileSync(join(work, 'RESOLVER.md'), 'utf-8')).toContain('BEGIN gbrain-brain-durability');
    expect(existsSync(join(work, 'AGENTS.md'))).toBe(false);
  });

  test('AGENTS block patch preserves user content above and below', async () => {
    writeFileSync(join(work, 'AGENTS.md'), '# Top\n\nkeep above\n\n## footer\nkeep below\n');
    git(work, 'add', 'AGENTS.md'); git(work, 'commit', '-qm', 'agents');
    await harden();
    const body = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(body).toContain('keep above');
    expect(body).toContain('keep below');
    expect(body).toContain('BEGIN gbrain-brain-durability');
    // patch-in-place: exactly one managed block
    expect(body.split('BEGIN gbrain-brain-durability').length - 1).toBe(1);
  });

  test('D11 — writes a repo-scoped credential (0600 store, local config, ownership key)', async () => {
    await harden();
    const store = join(process.env.HOME!, '.gbrain', 'git-credentials');
    expect(existsSync(store)).toBe(true);
    expect(statSync(store).mode & 0o077).toBe(0); // not group/other readable
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toContain('store --file');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('true');
  });

  test('D11 — reuses an existing credential.helper (no plaintext store written)', async () => {
    git(work, 'config', 'credential.helper', 'osxkeychain');
    await harden();
    const store = join(process.env.HOME!, '.gbrain', 'git-credentials');
    expect(existsSync(store)).toBe(false);
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toBe('osxkeychain');
  });

  test('PAT never appears in the serialized report', async () => {
    const r = await harden();
    expect(JSON.stringify(r).includes(PAT)).toBe(false);
  });

  test('detached HEAD → pull step needs_attention (refuses to push to a wrong ref)', async () => {
    const sha = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', sha); // detached
    const r = await harden({ verify: false });
    const pull = r.steps.find(s => s.step === 'pull');
    expect(pull?.status).toBe('needs_attention');
  });

  test('D10 — verify reports needs_attention when push-probe fails (read-only/unreachable)', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
    const r = await harden();
    const verify = r.steps.find(s => s.step === 'verify');
    expect(verify?.status).toBe('needs_attention');
    expect(r.clean_against_origin).toBe(false);
    expect(r.needs_attention.length).toBeGreaterThan(0);
    // No scaffolding commit when we can't confirm a push.
    expect(r.steps.find(s => s.step === 'commit')).toBeUndefined();
  });

  test('dry-run makes no commit and writes no files', async () => {
    const before = commitCount(work);
    await harden({ dryRun: true });
    expect(commitCount(work)).toBe(before);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
  });

  test('dry-run does not advance HEAD when origin is ahead', async () => {
    const other = mkdtempSync(join(root, 'other-'));
    execFileSync('git', [
      '-c', 'protocol.file.allow=always', 'clone', '-q', bare, other,
    ], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'other@t.t');
    git(other, 'config', 'user.name', 'other');
    writeFileSync(join(other, 'remote-ahead.md'), 'remote\n');
    git(other, 'add', 'remote-ahead.md');
    git(other, 'commit', '-qm', 'remote ahead');
    git(other, 'push', '-q', 'origin', 'main');

    const beforeHead = git(work, 'rev-parse', 'HEAD');
    await harden({ dryRun: true });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(existsSync(join(work, 'remote-ahead.md'))).toBe(false);
  });

  test('dry-run does not chmod an already-current helper (#3736)', async () => {
    await harden(); // real run installs scripts/brain-commit-push.sh at 0o755
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    chmodSync(helperPath, 0o644); // simulate perms drifting away from +x, content unchanged
    await harden({ dryRun: true });
    expect(statSync(helperPath).mode & 0o777).toBe(0o644); // untouched — preview must not mutate
  });

  test('non-dry-run restores the exec bit on an already-current helper', async () => {
    await harden();
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    chmodSync(helperPath, 0o644);
    await harden();
    expect(statSync(helperPath).mode & 0o111).toBeTruthy(); // exec bit restored
  });

  test('CX2-3 — parent-repo-aware: a subdirectory target hardens the repo ROOT', async () => {
    // Workspace layout: the source dir is `repo/brain` while the enclosing
    // repo owns `.git`. Pre-fix the `.git` assertion failed on the subdir.
    const sub = join(work, 'brain');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'note.md'), '# note\n');
    git(work, 'add', 'brain/note.md'); git(work, 'commit', '-qm', 'brain dir');
    const r = await hardenBrainRepo({ repoPath: sub, sourceId: 'wiki', pat: PAT, installCron: false });
    expect(r.repo_path).toBe(git(work, 'rev-parse', '--show-toplevel'));
    // scaffolding landed at the ROOT, not inside brain/
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(existsSync(join(sub, 'scripts'))).toBe(false);
    expect(r.needs_attention).toEqual([]);
  });

  test('S3#10 — maintainPushLog chmods 0600 and rotates at 1MB', async () => {
    const home = join(process.env.HOME!, '.gbrain');
    mkdirSync(home, { recursive: true });
    const log = join(home, 'brain-push.log');
    writeFileSync(log, 'x'.repeat(1024 * 1024 + 1), { mode: 0o644 });
    maintainPushLog();
    // rotated: predecessor kept as .1, fresh log is empty + 0600
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(readFileSync(log, 'utf-8')).toBe('');
    expect(statSync(log).mode & 0o077).toBe(0);
    // small log: chmod only, no rotation
    rmSync(`${log}.1`);
    writeFileSync(log, 'small\n', { mode: 0o644 });
    maintainPushLog();
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(readFileSync(log, 'utf-8')).toBe('small\n');
    expect(statSync(log).mode & 0o077).toBe(0);
  });
});

describe('unhardenBrainRepo', () => {
  test('removes hook + credential wiring; leaves committed content', async () => {
    await harden();
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('');
    // committed helper stays
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(steps.find(s => s.step === 'hook')?.status).toBe('fixed');
  });

  test('idempotent when not hardened (all skipped)', async () => {
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.every(s => s.status === 'skipped')).toBe(true);
  });
});

describe('acceptPat (D8)', () => {
  test('reads + trims a pat-file', () => {
    const p = join(root, 'pat.txt');
    writeFileSync(p, `${PAT}\n`, { mode: 0o600 });
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings).toEqual([]);
  });
  test('throws on a missing pat-file', () => {
    expect(() => acceptPat({ patFile: join(root, 'nope.txt') })).toThrow();
  });
  test('throws on an empty pat-file', () => {
    const p = join(root, 'empty.txt'); writeFileSync(p, '   \n', { mode: 0o600 });
    expect(() => acceptPat({ patFile: p })).toThrow();
  });
  test('warns (but continues) on loose perms', () => {
    const p = join(root, 'loose.txt'); writeFileSync(p, PAT); chmodSync(p, 0o644);
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings.length).toBeGreaterThan(0);
  });
  test('falls back to GBRAIN_GITHUB_PAT env', () => {
    const old = process.env.GBRAIN_GITHUB_PAT;
    process.env.GBRAIN_GITHUB_PAT = PAT;
    try { expect(acceptPat({})?.source).toBe('env:GBRAIN_GITHUB_PAT'); }
    finally { if (old === undefined) delete process.env.GBRAIN_GITHUB_PAT; else process.env.GBRAIN_GITHUB_PAT = old; }
  });
  test('returns null when no PAT is available', () => {
    const old = process.env.GBRAIN_GITHUB_PAT; delete process.env.GBRAIN_GITHUB_PAT;
    try { expect(acceptPat({})).toBeNull(); }
    finally { if (old !== undefined) process.env.GBRAIN_GITHUB_PAT = old; }
  });
});
