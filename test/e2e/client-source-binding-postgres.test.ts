import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from '../../src/core/operations.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('client source binding native seam — Postgres', () => {
  let engine: PostgresEngine;
  let root: string;

  beforeAll(async () => {
    engine = await setupDB();
    root = mkdtempSync(join(tmpdir(), 'gbrain-client-binding-pg-'));
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await teardownDB();
  });

  test('client B idempotently retires client A state through the public local operation', async () => {
    const sourceId = 'client-binding-pg';
    const stableRemote = 'https://git.example.invalid/private/wiki.git';
    const remote = join(root, 'origin.git');
    const clientA = join(root, 'client-a');
    const clientB = join(root, 'client-b');
    const approvedCorpus = join(root, 'approved-corpus');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
    execFileSync('git', ['clone', remote, clientA]);
    execFileSync('git', ['-C', clientA, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', clientA, 'config', 'user.name', 'Test']);
    writeFileSync(join(clientA, 'README.md'), '# fixture\n');
    execFileSync('git', ['-C', clientA, 'add', 'README.md']);
    execFileSync('git', ['-C', clientA, 'commit', '-m', 'initial']);
    execFileSync('git', ['-C', clientA, 'push', 'origin', 'main']);
    execFileSync('git', ['clone', remote, clientB]);
    for (const checkout of [clientA, clientB]) {
      execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', stableRemote]);
      execFileSync('git', [
        '-C',
        checkout,
        'config',
        `url.file://${remote}.insteadOf`,
        stableRemote,
      ]);
    }
    const commit = execFileSync(
      'git',
      ['-C', clientA, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();

    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, last_commit, config)
       VALUES ($1, 'Client Binding PG', $2, $3, $4::text::jsonb)`,
      [
        sourceId,
        clientA,
        commit,
        JSON.stringify({ remote_url: stableRemote, tracked_branch: 'main' }),
      ],
    );
    await engine.setConfig('sync.repo_path', clientA);
    await engine.setConfig('sync.last_commit', 'stable-bookmark');
    await engine.executeRaw(
      `INSERT INTO ingest_log (source_id, source_type, source_ref, summary)
       VALUES ($1, 'git_sync', $2, 'legacy-client-a')`,
      [sourceId, `${clientA} @ ${commit.slice(0, 8)}`],
    );
    const parent = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('subagent-aggregator', 'waiting-children', '{"children_ids":[]}'::jsonb)
       RETURNING id`,
    );
    const waiting = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, error_text, parent_job_id)
       VALUES ('sync', 'waiting', $1::text::jsonb, $2, $3)
       RETURNING id`,
      [
        JSON.stringify({ sourceId, repoPath: clientA, commit }),
        `failed at ${clientA}`,
        parent[0].id,
      ],
    );
    const autopilot = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, error_text)
       VALUES ('autopilot-cycle', 'delayed', $1::text::jsonb, $2)
       RETURNING id`,
      [JSON.stringify({ source_id: sourceId }), `retry ${clientB}`],
    );
    const completed = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (
         name, status, data, result, progress, error_text, stacktrace, parent_job_id
       )
       VALUES (
         'extract-atoms-drain',
         'completed',
         $1::text::jsonb,
         $2::text::jsonb,
         $3::text::jsonb,
         $4,
         $5::text::jsonb,
         $6
       )
       RETURNING id`,
      [
        JSON.stringify({ repoPath: clientA, commit: 'completed-commit' }),
        JSON.stringify({ report: { brain_dir: clientA } }),
        JSON.stringify({ repoPath: clientB, phase: 'done' }),
        `completed at ${clientA}`,
        JSON.stringify([`stack ${clientA}`]),
        parent[0].id,
      ],
    );
    const corpusWaiting = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('corpus-scan', 'waiting', $1::text::jsonb)
       RETURNING id`,
      [JSON.stringify({ repoPath: approvedCorpus, mode: 'approved-corpus' })],
    );
    const legacyGlobal = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (
         name, status, data, result, progress, stacktrace
       )
       VALUES (
         'autopilot-global-maintenance',
         'completed',
         '{"phases":["embed"]}'::jsonb,
         $1::text::jsonb,
         $2::text::jsonb,
         $3::text::jsonb
       )
       RETURNING id`,
      [
        JSON.stringify({ report: { brain_dir: clientA } }),
        JSON.stringify({ checkout: clientB }),
        JSON.stringify([`global maintenance at ${clientA}`]),
      ],
    );
    const racingGlobal = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES (
         'autopilot-global-maintenance',
         'active',
         '{"phases":["embed"]}'::jsonb
       )
       RETURNING id`,
    );
    const legacyActive = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'active', '{}'::jsonb)
       RETURNING id`,
    );
    const safeDbJob = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('embed-backfill', 'waiting', $1::text::jsonb)
       RETURNING id`,
      [JSON.stringify({ sourceId, reason: 'safe-db-only' })],
    );
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{children_ids}', $1::text::jsonb)
        WHERE id = $2`,
      [JSON.stringify([waiting[0].id, completed[0].id]), parent[0].id],
    );
    await engine.executeRaw(
      `INSERT INTO minion_inbox (job_id, sender, payload)
       VALUES
         ($1, 'minions', $2::text::jsonb),
         ($3, 'worker', $4::text::jsonb),
         ($1, 'minions', $5::text::jsonb)`,
      [
        parent[0].id,
        JSON.stringify({
          type: 'child_done',
          child_id: completed[0].id,
          result: { report: { brain_dir: clientA } },
          outcome: 'complete',
        }),
        completed[0].id,
        JSON.stringify({ checkout: clientB }),
        JSON.stringify({
          type: 'child_done',
          child_id: legacyGlobal[0].id,
          result: { report: { brain_dir: clientA } },
          outcome: 'complete',
        }),
      ],
    );

    const operation = operations.find((op) => op.name === 'sources_prepare_client')!;
    expect(operation.localOnly).toBe(true);
    const first = await withEnv(
      { GBRAIN_SOURCE: sourceId, GBRAIN_SOURCE_PATH: clientB },
      () => operation.handler(
        { engine, remote: false, dryRun: false } as never,
        { id: sourceId },
      ),
    ) as {
      cleared_source_local_path: boolean;
      cleared_legacy_repo_path: boolean;
      sanitized_ingest_log_count: number;
      cancelled_job_ids: number[];
    };
    expect(first.cleared_source_local_path).toBe(true);
    expect(first.cleared_legacy_repo_path).toBe(true);
    expect(first.sanitized_ingest_log_count).toBe(1);
    expect(first.cancelled_job_ids).toEqual([
      waiting[0].id,
      autopilot[0].id,
      corpusWaiting[0].id,
      racingGlobal[0].id,
      legacyActive[0].id,
    ]);
    const cleanStateSync = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'waiting', $1::text::jsonb)
       RETURNING id`,
      [JSON.stringify({ sourceId, commit: 'safe-after-prepare' })],
    );
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET status = 'completed',
              result = $1::text::jsonb,
              finished_at = now()
        WHERE id = $2`,
      [
        JSON.stringify({ report: { brain_dir: clientA } }),
        racingGlobal[0].id,
      ],
    );
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET status = 'completed',
              result = $1::text::jsonb,
              finished_at = now()
        WHERE id = $2`,
      [
        JSON.stringify({ scan_root: approvedCorpus }),
        corpusWaiting[0].id,
      ],
    );
    const second = await withEnv(
      { GBRAIN_SOURCE: sourceId, GBRAIN_SOURCE_PATH: clientB },
      () => operation.handler(
        { engine, remote: false, dryRun: false } as never,
        { id: sourceId },
      ),
    );
    expect(second).toMatchObject({
      cleared_source_local_path: false,
      cleared_legacy_repo_path: false,
      sanitized_ingest_log_count: 0,
      sanitized_job_ids: [
        corpusWaiting[0].id,
        racingGlobal[0].id,
      ],
      cancelled_job_ids: [],
    });

    const source = await engine.executeRaw<{
      id: string;
      local_path: string | null;
      last_commit: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, local_path, last_commit, config FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(source[0]).toEqual({
      id: sourceId,
      local_path: null,
      last_commit: commit,
      config: { remote_url: stableRemote, tracked_branch: 'main' },
    });
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
    expect(await engine.getConfig('sync.last_commit')).toBe('stable-bookmark');

    const ingest = await engine.executeRaw<{ source_ref: string }>(
      `SELECT source_ref FROM ingest_log WHERE summary = 'legacy-client-a'`,
    );
    expect(ingest).toEqual([
      { source_ref: `source:${sourceId} @ ${commit.slice(0, 8)}` },
    ]);
    const jobs = await engine.executeRaw<{
      id: number;
      status: string;
      data: Record<string, unknown>;
      result: unknown;
      progress: unknown;
      error_text: string | null;
      stacktrace: unknown;
    }>(
      `SELECT id, status, data, result, progress, error_text, stacktrace
         FROM minion_jobs
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      [[
        parent[0].id,
        waiting[0].id,
        autopilot[0].id,
        completed[0].id,
        corpusWaiting[0].id,
        legacyGlobal[0].id,
        racingGlobal[0].id,
        legacyActive[0].id,
        safeDbJob[0].id,
        cleanStateSync[0].id,
      ]],
    );
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get(parent[0].id)?.status).toBe('waiting');
    expect(byId.get(waiting[0].id)).toMatchObject({
      status: 'cancelled',
      data: { sourceId, commit },
      error_text: 'cancelled: client-local source binding retired queued checkout path',
    });
    expect(byId.get(autopilot[0].id)).toMatchObject({
      status: 'cancelled',
      data: { source_id: sourceId },
      error_text: 'cancelled: client-local source binding retired queued checkout path',
    });
    expect(byId.get(completed[0].id)).toMatchObject({
      status: 'completed',
      data: { sourceId, commit: 'completed-commit' },
      result: { report: { brain_dir: '[client-local-path]' } },
      progress: { phase: 'done' },
      error_text: 'client-local source binding retired checkout path from historical job state',
      stacktrace: ['stack [client-local-path]'],
    });
    expect(byId.get(corpusWaiting[0].id)).toMatchObject({
      status: 'completed',
      data: {
        clientBindingSourceId: sourceId,
        mode: 'approved-corpus',
      },
      result: { scan_root: '[client-local-path]' },
      error_text: 'cancelled: client-local source binding retired queued checkout path',
    });
    expect(byId.get(legacyGlobal[0].id)).toMatchObject({
      status: 'completed',
      data: { phases: ['embed'], sourceId },
      result: { report: { brain_dir: '[client-local-path]' } },
      progress: { checkout: '[client-local-path]' },
      stacktrace: ['global maintenance at [client-local-path]'],
    });
    expect(byId.get(racingGlobal[0].id)).toMatchObject({
      status: 'completed',
      data: { phases: ['embed'], sourceId },
      result: { report: { brain_dir: '[client-local-path]' } },
    });
    expect(byId.get(legacyActive[0].id)).toMatchObject({
      status: 'cancelled',
      data: { sourceId },
      error_text: 'cancelled: client-local source binding retired queued checkout path',
    });
    expect(byId.get(safeDbJob[0].id)).toMatchObject({
      status: 'waiting',
      data: { sourceId, reason: 'safe-db-only' },
    });
    expect(byId.get(cleanStateSync[0].id)).toMatchObject({
      status: 'waiting',
      data: { sourceId, commit: 'safe-after-prepare' },
    });

    const inbox = await engine.executeRaw<{
      job_id: number;
      payload: Record<string, unknown>;
    }>(
      `SELECT job_id, payload FROM minion_inbox
        WHERE job_id = ANY($1::int[])
        ORDER BY id`,
      [[parent[0].id, completed[0].id]],
    );
    expect(inbox.some((row) =>
      row.job_id === parent[0].id &&
      row.payload.child_id === waiting[0].id &&
      row.payload.outcome === 'cancelled'
    )).toBe(true);
    expect(JSON.stringify(inbox)).toContain('[client-local-path]');

    const sharedState = JSON.stringify({
      source,
      config: await engine.executeRaw(`SELECT key, value FROM config`),
      ingest,
      jobs,
      inbox,
    });
    expect(sharedState).not.toContain(clientA);
    expect(sharedState).not.toContain(clientB);
    expect(sharedState).not.toContain(remote);
    expect(sharedState).not.toContain(root);

    const legacySourceId = 'legacy-local-remote-pg';
    const legacyClientPath = join(root, 'legacy-client');
    mkdirSync(legacyClientPath, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, last_commit, config)
       VALUES ($1, 'Legacy Local Remote PG', $2, 'stable-legacy-commit', $3::text::jsonb)`,
      [
        legacySourceId,
        clientA,
        JSON.stringify({
          remote_url: `file://${clientA}`,
          tracked_branch: 'main',
          federated: true,
        }),
      ],
    );
    await withEnv(
      { GBRAIN_SOURCE: legacySourceId, GBRAIN_SOURCE_PATH: legacyClientPath },
      () => operation.handler(
        { engine, remote: false, dryRun: false } as never,
        { id: legacySourceId },
      ),
    );
    const legacySource = await engine.executeRaw<{
      local_path: string | null;
      last_commit: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT local_path, last_commit, config FROM sources WHERE id = $1`,
      [legacySourceId],
    );
    expect(legacySource).toEqual([{
      local_path: null,
      last_commit: 'stable-legacy-commit',
      config: {
        tracked_branch: 'main',
        federated: true,
      },
    }]);
    expect(JSON.stringify(legacySource)).not.toContain(clientA);
  });
});
