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
    const otherSourceId = 'client-binding-other-pg';
    const stableRemote = 'https://git.example.invalid/private/wiki.git';
    const stableAuditHttps = 'https://example.com/C:/repo.git';
    const stableAuditSsh = 'ssh://git@example.com/path:/repo.git';
    const stableAuditScp = 'git@example.com:C:/repo.git';
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
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [otherSourceId]);
    await engine.executeRaw(`DELETE FROM mcp_request_log`);
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
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ($1, 'Client Binding Other PG')`,
      [otherSourceId],
    );
    await engine.setConfig('sync.repo_path', clientA);
    await engine.setConfig('sync.last_commit', 'stable-bookmark');
    await engine.executeRaw(
      `INSERT INTO ingest_log (
         source_id, source_type, source_ref, pages_updated, summary
       )
       VALUES
         ($1, 'git_sync', $2, $3::text::jsonb, $4),
         ($5, 'git_sync', 'source:client-binding-other-pg', $6::text::jsonb, $7)`,
      [
        sourceId,
        `${clientA} @ ${commit.slice(0, 8)}`,
        JSON.stringify([{ cwd: clientA }]),
        `legacy import from ${clientA}`,
        otherSourceId,
        JSON.stringify([{ nested: [{ repoPath: clientA }] }]),
        `misattributed legacy import from ${clientA}`,
      ],
    );
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (
         token_name, agent_name, operation, latency_ms, status, params, error_message
       )
       VALUES
         ($1, $2, $3, 12, 'error', $4::text::jsonb, $5),
         ($6, $7, $8, 8, 'success', $9::text::jsonb, $10)`,
      [
        `token:${clientA}`,
        `agent:${clientB}`,
        `query:${clientA}`,
        JSON.stringify({
          [clientA]: {
            nested: [{ cwd: clientB }, stableAuditHttps],
          },
          stable: stableAuditSsh,
        }),
        `failed at ${clientB}`,
        stableAuditHttps,
        stableAuditSsh,
        stableAuditScp,
        JSON.stringify({
          locator: stableAuditHttps,
          nested: [stableAuditSsh, stableAuditScp],
        }),
        `mirrored from ${stableAuditHttps}`,
      ],
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
    const arbitraryNested = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('arbitrary-nested-pg', 'waiting', $1::text::jsonb)
       RETURNING id`,
      [JSON.stringify({ nested: [{ cwd: clientA }] })],
    );
    const inboxOnly = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES (
         'arbitrary-inbox-pg',
         'waiting',
         '{"commit":"stable-inbox-only"}'::jsonb
       )
       RETURNING id`,
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
    await engine.executeRaw(
      `INSERT INTO minion_inbox (job_id, sender, payload)
       VALUES ($1, 'admin', $2::text::jsonb)`,
      [
        inboxOnly[0].id,
        JSON.stringify({ directive: [{ cwd: clientA }] }),
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
    expect(first.sanitized_ingest_log_count).toBe(2);
    expect(first.cancelled_job_ids).toEqual([
      parent[0].id,
      waiting[0].id,
      autopilot[0].id,
      corpusWaiting[0].id,
      racingGlobal[0].id,
      legacyActive[0].id,
      arbitraryNested[0].id,
      inboxOnly[0].id,
    ]);
    const mcpAfterFirst = await engine.executeRaw<{
      token_name: string | null;
      agent_name: string | null;
      operation: string;
      params: unknown;
      error_message: string | null;
    }>(
      `SELECT token_name, agent_name, operation, params, error_message
         FROM mcp_request_log
        ORDER BY id`,
    );
    expect(mcpAfterFirst).toEqual([
      {
        token_name: 'token:[client-local-path]',
        agent_name: 'agent:[client-local-path]',
        operation: 'query:[client-local-path]',
        params: {
          '[client-local-path]': {
            nested: [{ cwd: '[client-local-path]' }, stableAuditHttps],
          },
          stable: stableAuditSsh,
        },
        error_message: 'failed at [client-local-path]',
      },
      {
        token_name: stableAuditHttps,
        agent_name: stableAuditSsh,
        operation: stableAuditScp,
        params: {
          locator: stableAuditHttps,
          nested: [stableAuditSsh, stableAuditScp],
        },
        error_message: `mirrored from ${stableAuditHttps}`,
      },
    ]);
    await withEnv(
      { GBRAIN_SOURCE: sourceId, GBRAIN_SOURCE_PATH: clientB },
      async () => {
        await expect(engine.logIngest({
          source_id: otherSourceId,
          source_type: 'git_sync',
          source_ref: 'source:client-binding-other-pg',
          pages_updated: ['wiki/stable'],
          summary: `late failure at ${clientB}`,
        })).rejects.toThrow('must not persist client-local paths in ingest log fields');
      },
    );
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
    const mcp = await engine.executeRaw(
      `SELECT token_name, agent_name, operation, params, error_message
         FROM mcp_request_log
        ORDER BY id`,
    );
    expect(mcp).toEqual(mcpAfterFirst);

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

    const ingest = await engine.executeRaw<{
      source_id: string;
      source_ref: string;
      pages_updated: unknown;
      summary: string;
    }>(
      `SELECT source_id, source_ref, pages_updated, summary
         FROM ingest_log
        WHERE source_id = ANY($1::text[])
        ORDER BY id`,
      [[sourceId, otherSourceId]],
    );
    expect(ingest).toEqual([
      {
        source_id: sourceId,
        source_ref: `source:${sourceId} @ ${commit.slice(0, 8)}`,
        pages_updated: [{ cwd: '[client-local-path]' }],
        summary: 'legacy import from [client-local-path]',
      },
      {
        source_id: otherSourceId,
        source_ref: `source:${otherSourceId}`,
        pages_updated: [{ nested: [{}] }],
        summary: 'misattributed legacy import from [client-local-path]',
      },
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
        arbitraryNested[0].id,
        inboxOnly[0].id,
        cleanStateSync[0].id,
      ]],
    );
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get(parent[0].id)?.status).toBe('cancelled');
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
    expect(byId.get(arbitraryNested[0].id)).toMatchObject({
      status: 'cancelled',
      data: {
        clientBindingSourceId: sourceId,
        nested: [{ cwd: '[client-local-path]' }],
      },
    });
    expect(byId.get(inboxOnly[0].id)).toMatchObject({
      status: 'cancelled',
      data: {
        clientBindingSourceId: sourceId,
        commit: 'stable-inbox-only',
      },
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
      [[parent[0].id, completed[0].id, inboxOnly[0].id]],
    );
    expect(inbox.some((row) =>
      row.job_id === parent[0].id &&
      row.payload.child_id === waiting[0].id &&
      row.payload.outcome === 'cancelled'
    )).toBe(false);
    expect(inbox).toContainEqual({
      job_id: inboxOnly[0].id,
      payload: { directive: [{ cwd: '[client-local-path]' }] },
    });
    expect(JSON.stringify(inbox)).toContain('[client-local-path]');

    const sharedState = JSON.stringify({
      source,
      config: await engine.executeRaw(`SELECT key, value FROM config`),
      ingest,
      jobs,
      inbox,
      mcp,
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
