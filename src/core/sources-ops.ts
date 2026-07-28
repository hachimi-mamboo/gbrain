/**
 * gbrain sources-ops — pure async functions for source-management operations
 * (v0.28). Extracted from src/commands/sources.ts so the CLI handlers and the
 * MCP ops (sources_add / list / remove / status) share one implementation.
 *
 * Atomicity contract for addSource with --url (D3, eng-review):
 *
 *                    sources add --url <url>
 *                              │
 *                              ▼
 *                  parseRemoteUrl(url) → SSRF gate
 *                              │
 *                              ▼  (URL ok)
 *                  pre-flight SELECT id ─── id taken? ──► error (Q4)
 *                              │
 *                              ▼  (id free)
 *                  mkdir $GBRAIN_HOME/clones/.tmp/<id>-<rand>/
 *                              │
 *                              ▼
 *                  cloneRepo(url, tmp/) ─── fail ──► rm -rf tmp/, throw
 *                              │
 *                              ▼
 *                  INSERT INTO sources ─── fail ──► rm -rf tmp/, throw
 *                              │
 *                              ▼
 *                  fs.renameSync(tmp/, final) ─── fail ──► rm -rf tmp/, throw
 *                                                              + best-effort
 *                                                              DELETE row
 *                              │
 *                              ▼
 *                       return SourceRow
 *
 * Symlink-safe clone-cleanup for removeSource: realpath + lstat confinement
 * mirroring src/core/operations.ts:61 validateUploadPath. String startsWith
 * is symlink-unsafe and would let $GBRAIN_HOME/clones/<id> → /etc resolve
 * out of the confine.
 */

import { existsSync, mkdirSync, renameSync, rmSync, lstatSync } from 'fs';
import { join, dirname, basename, resolve as resolvePath } from 'path';
import { isPathContained } from './path-confine.ts';
import { randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import {
  parseRemoteUrl,
  cloneRepo,
  validateRepoState,
  isInsideGitRepo,
  hasTrackedContent,
  RemoteUrlError,
  GitOperationError,
  type RepoState,
} from './git-remote.ts';
import { gbrainPath } from './config.ts';
import { isValidSourceId } from './source-id.ts';
import {
  assertClientSourceCheckout,
  resolveClientSourcePath,
  resolveSourceWithTier,
  type SourceTier,
} from './source-resolver.ts';
import { isUndefinedTableError } from './utils.ts';

// ── Errors ──────────────────────────────────────────────────────────────────

export type SourceOpErrorCode =
  | 'invalid_id'
  | 'source_id_taken'
  | 'overlapping_path'
  | 'invalid_remote_url'
  | 'clone_failed'
  | 'insert_failed'
  | 'rename_failed'
  | 'not_found'
  | 'protected_id'
  | 'clone_dir_outside_gbrain'
  | 'symlink_escape'
  | 'unmanaged_path'
  | 'not_a_git_repo';

export class SourceOpError extends Error {
  constructor(
    public code: SourceOpErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceOpError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown>;
  created_at: Date;
  /**
   * v0.40.3.0: per-source CR mode override. NULL falls through to global
   * mode bundle. Written only by `gbrain sources set-cr-mode <id> <mode>`
   * (CLI-write-only per D15 security gate); MCP / OAuth callers cannot
   * mutate this field.
   */
  contextual_retrieval_mode?: string | null;
  /**
   * v0.40.3.0: per-source mount-frontmatter trust gate (D15). FALSE for
   * mounted sources by default. Flipped via
   * `gbrain mounts trust-frontmatter <id>`. Host source (id='default') is
   * always trusted in the resolver regardless of this column value.
   */
  trust_frontmatter_overrides?: boolean;
}

export interface SourceListEntry {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
}

export interface SourceStatus {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
  last_commit: string | null;
  archived: boolean;
  /**
   * Discriminated union from validateRepoState. 'not-applicable' if the
   * source has no local_path (pure DB source). Lets a remote MCP caller
   * diagnose "is the clone OK?" without SSH access to the brain host.
   */
  clone_state: RepoState | 'not-applicable';
}

export interface AddSourceOpts {
  id: string;
  name?: string;
  localPath?: string | null;
  remoteUrl?: string;
  federated?: boolean | null;
  /**
   * Override clone destination. Defaults to $GBRAIN_HOME/clones/<id>/.
   * Only honored when remoteUrl is set.
   */
  cloneDir?: string;
  /**
   * Skip the #2707 git-repo validation on `localPath`. Opt-in escape hatch
   * for registering a path before it's git-initialized (e.g. an automated
   * pipeline that populates + `git init`s the directory after `sources add`
   * runs). Does NOT auto-`git init` anything — see `addSource` docstring.
   */
  force?: boolean;
}

export interface RemoveSourceOpts {
  id: string;
  confirmDestructive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  keepStorage?: boolean;
}

export interface PrepareClientSourceBindingResult {
  source_id: string;
  cleared_source_local_path: boolean;
  cleared_legacy_repo_path: boolean;
  sanitized_ingest_log_count: number;
  sanitized_job_ids: number[];
  cancelled_job_ids: number[];
}

const CLIENT_BOUND_FILESYSTEM_JOB_NAMES = new Set([
  'sync',
  'autopilot-cycle',
]);
const LEGACY_GLOBAL_FILESYSTEM_JOB_NAMES = new Set([
  'sync',
  'autopilot-cycle',
  'autopilot-global-maintenance',
]);
const LEGACY_GLOBAL_INVALIDATE_JOB_NAMES = new Set([
  'sync',
  'autopilot-cycle',
  'autopilot-global-maintenance',
]);
const CLIENT_BINDING_MARKER_KEY = 'clientBindingSourceId';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * POSIX single-quote `arg` unless it's already shell-safe. #2707 codex round
 * 1: the `not_a_git_repo` remediation error prints a pasteable `git ...`
 * command built from the caller-supplied path — spaces, `$()`, backticks,
 * etc. must be inert literals when pasted, which double-quoting would not
 * guarantee (command substitution still runs inside "..."). Mirrors
 * `src/commands/connect.ts:shellQuote` (not imported — that file is a
 * commands/ caller of core/, not the other way around).
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate via the canonical regex from `source-id.ts` but rethrow as the
 * sources-ops-tagged error so `gbrain sources add` keeps its user-facing
 * SourceOpError shape. The regex itself is in one place; only the error
 * envelope differs per caller.
 */
function validateSourceId(id: string): void {
  if (!isValidSourceId(id)) {
    throw new SourceOpError(
      'invalid_id',
      `Invalid source id "${id}". Must be 1-32 lowercase alnum chars with optional interior hyphens.`,
    );
  }
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try {
      return JSON.parse(config) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
}

function isFederated(config: unknown): boolean {
  return parseConfig(config).federated === true;
}

function getRemoteUrl(config: unknown): string | null {
  const v = parseConfig(config).remote_url;
  return typeof v === 'string' ? v : null;
}

function isClientLocalRemoteLocator(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const locator = value.trim();
  if (/^https:\/\//i.test(locator)) return false;
  return (
    /^(?:file|directory|path):/i.test(locator) ||
    /^git:[\\/](?![\\/])/i.test(locator) ||
    locator.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(locator) ||
    locator.startsWith('\\\\')
  );
}

function uniquePathSpellings(paths: Array<string | null>): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    values.add(path);
    values.add(resolvePath(path));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function pathBelongsToRoot(candidate: unknown, roots: string[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const normalized = resolvePath(candidate);
  return roots.some((root) => normalized === resolvePath(root) || normalized.startsWith(resolvePath(root) + '/'));
}

function textContainsRoot(candidate: unknown, roots: string[]): boolean {
  return typeof candidate === 'string' && roots.some((root) => candidate.includes(root));
}

function isClientPathShapedText(value: string): boolean {
  return (
    // Historical locator schemes, including file:/// and directory:/ forms.
    /(?:^|[^A-Za-z0-9+.-])(?:file|directory|git|path):(?:\/\/)?[\\/]/i.test(value) ||
    // A POSIX path at the start or after a free-text/key-value boundary.
    /(?:^|[\s="'([{=,])\/(?!\/)/.test(value) ||
    // Forward-slash UNC/network paths at a boundary; exclude URL schemes.
    /(?:^|[\s="'([{=,])\/\/[^/\s]+\/[^/\s]+/.test(value) ||
    // A prefixed POSIX path such as "checkout:/srv/wiki", but not https://.
    /:\/(?!\/)/.test(value) ||
    // Windows drive paths, raw or embedded in a small provenance phrase.
    /(?:^|[\s="'([{=,:])[A-Za-z]:[\\/]/.test(value) ||
    // UNC paths, raw or embedded.
    /(?:^|[\s="'([{=,:])\\\\[^\\/\s]+[\\/]/.test(value)
  );
}

function parseSharedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function redactKnownRoots(
  value: unknown,
  roots: string[],
  dropRepoPath = false,
): unknown {
  if (typeof value === 'string') {
    const redacted = roots.reduce(
      (redacted, root) => redacted.split(root).join('[client-local-path]'),
      value,
    );
    return isClientPathShapedText(redacted) ? '[client-local-path]' : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactKnownRoots(entry, roots, dropRepoPath));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (dropRepoPath && key === 'repoPath') continue;
      const sanitizedKey = redactKnownRoots(key, roots) as string;
      sanitized[sanitizedKey] = redactKnownRoots(entry, roots, dropRepoPath);
    }
    return sanitized;
  }
  return value;
}

function structuredValueContainsClientPath(value: unknown, roots: string[]): boolean {
  if (typeof value === 'string') {
    return textContainsRoot(value, roots) || isClientPathShapedText(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => structuredValueContainsClientPath(entry, roots));
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

function parseJobData(data: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof data !== 'string') return data;
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Historical directory/import writers stored either a raw absolute path or a
 * small path URI in source_ref. Keep any trailing commit/ref marker, but
 * replace the machine locator with the stable source identity.
 */
export function sanitizeClientPathSourceRef(
  sourceId: string,
  sourceRef: string,
): string | null {
  const value = sourceRef.trim();
  if (!isClientPathShapedText(value)) return null;

  const suffixMatch = value.match(
    /\s+@\s+([A-Za-z0-9][A-Za-z0-9._~^/-]{0,255})\s*$/,
  );
  const suffix = suffixMatch ? ` @ ${suffixMatch[1]}` : '';
  return `source:${sourceId}${suffix}`;
}

async function fetchSourceRow(engine: BrainEngine, id: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    local_path: string | null;
    last_commit: string | null;
    last_sync_at: Date | null;
    config: unknown;
    created_at: Date;
  }>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
       FROM sources WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, config: parseConfig(r.config) };
}

async function countAllPages(engine: BrainEngine, id: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [id],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Retire machine-local state before one client uses GBRAIN_SOURCE_PATH.
 *
 * This is the public/native ownership seam for client-local source bindings.
 * It deliberately leaves ordinary `sources add --path` registrations alone:
 * callers must opt in with a matching `GBRAIN_SOURCE` + absolute
 * `GBRAIN_SOURCE_PATH`. The operation is idempotent and preserves source
 * identity, valid stable remote/config fields, last_commit, and sync bookmarks
 * while removing historical checkout roots from shared state.
 */
export async function prepareClientSourceBinding(
  engine: BrainEngine,
  sourceId: string,
): Promise<PrepareClientSourceBindingResult> {
  validateSourceId(sourceId);
  const source = await fetchSourceRow(engine, sourceId);
  if (!source) {
    throw new SourceOpError('not_found', `Source "${sourceId}" not found.`);
  }

  const clientPath = resolveClientSourcePath(sourceId);
  if (!clientPath) {
    throw new Error(
      `Client-local binding for source "${sourceId}" requires matching ` +
      `GBRAIN_SOURCE=${sourceId} and an absolute GBRAIN_SOURCE_PATH.`,
    );
  }
  const preparedSourceConfig = { ...parseConfig(source.config) };
  const clearsLocalRemoteLocator =
    isClientLocalRemoteLocator(preparedSourceConfig.remote_url);
  const localRemoteLocator = clearsLocalRemoteLocator
    ? preparedSourceConfig.remote_url as string
    : null;
  if (clearsLocalRemoteLocator) {
    delete preparedSourceConfig.remote_url;
  }
  assertClientSourceCheckout(sourceId, clientPath, preparedSourceConfig);

  const legacyRepoPath = await engine.getConfig('sync.repo_path');
  const sourceRoots = uniquePathSpellings([
    source.local_path,
    clientPath,
  ]);
  const clearLegacyRepoPath =
    legacyRepoPath !== null &&
    (sourceId === 'default' || pathBelongsToRoot(legacyRepoPath, sourceRoots));
  const sharedRoots = uniquePathSpellings([
    source.local_path,
    clientPath,
    clearLegacyRepoPath ? legacyRepoPath : null,
  ]);
  const retiringLegacyBinding =
    source.local_path !== null || clearLegacyRepoPath;
  const retireLegacyGlobalState =
    clearLegacyRepoPath || sourceId === 'default';

  let hasMinionJobs = true;
  let hasMinionInbox = true;
  try {
    await engine.executeRaw(`SELECT 1 FROM minion_jobs LIMIT 1`);
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    hasMinionJobs = false;
  }
  try {
    await engine.executeRaw(`SELECT 1 FROM minion_inbox LIMIT 1`);
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    hasMinionInbox = false;
  }

  return engine.transaction(async (tx) => {
    const sanitizedJobIds: number[] = [];
    const cancelledJobIds: number[] = [];

    if (hasMinionJobs) {
      const nonterminal = new Set([
        'waiting',
        'active',
        'delayed',
        'waiting-children',
        'paused',
      ]);
      const rows = await tx.executeRaw<{
        id: number;
        name: string;
        status: string;
        data: Record<string, unknown> | string;
        parent_job_id: number | null;
        result: unknown;
        progress: unknown;
        error_text: string | null;
        stacktrace: unknown;
      }>(
        `SELECT id, name, status, data, parent_job_id,
                result, progress, error_text, stacktrace
           FROM minion_jobs
          WHERE data->>'sourceId' = $1
             OR data->>'source_id' = $1
             OR data->>'clientBindingSourceId' = $1
             OR data ? 'repoPath'
             OR name = ANY($2::text[])
          FOR UPDATE`,
        [sourceId, [...LEGACY_GLOBAL_FILESYSTEM_JOB_NAMES]],
      );
      const candidateIds = rows.map((row) => row.id);
      const candidateInboxPathIds = new Set<number>();
      if (hasMinionInbox && candidateIds.length > 0) {
        const candidateInbox = await tx.executeRaw<{
          job_id: number;
          payload: unknown;
        }>(
          `SELECT job_id, payload
             FROM minion_inbox
            WHERE job_id = ANY($1::int[])
               OR payload->>'child_id' = ANY($2::text[])`,
          [candidateIds, candidateIds.map(String)],
        );
        for (const inbox of candidateInbox) {
          const payload = parseSharedJson(inbox.payload);
          if (!structuredValueContainsClientPath(payload, sharedRoots)) continue;
          if (candidateIds.includes(inbox.job_id)) {
            candidateInboxPathIds.add(inbox.job_id);
          }
          if (payload && typeof payload === 'object') {
            const childId = (payload as Record<string, unknown>).child_id;
            if (typeof childId === 'number' && candidateIds.includes(childId)) {
              candidateInboxPathIds.add(childId);
            }
          }
        }
      }
      const targetRows = rows.filter((row) => {
        const data = parseJobData(row.data);
        const matchesSource =
          data.sourceId === sourceId || data.source_id === sourceId;
        const matchesClientBinding =
          data[CLIENT_BINDING_MARKER_KEY] === sourceId;
        const hasExplicitSource =
          typeof data.sourceId === 'string' || typeof data.source_id === 'string';
        const isLegacyGlobalFilesystemJob =
          !hasExplicitSource && LEGACY_GLOBAL_FILESYSTEM_JOB_NAMES.has(row.name);
        const hasClientRepoPath =
          typeof data.repoPath === 'string' &&
          (
            pathBelongsToRoot(data.repoPath, sharedRoots) ||
            isClientPathShapedText(data.repoPath)
          );
        const hasStructuredPath = [
          data,
          row.result,
          row.progress,
          row.stacktrace,
          row.error_text,
        ].some((value) =>
          structuredValueContainsClientPath(parseSharedJson(value), sharedRoots));
        return (
          hasClientRepoPath ||
          (
            isLegacyGlobalFilesystemJob &&
            retireLegacyGlobalState &&
            (hasStructuredPath || candidateInboxPathIds.has(row.id))
          ) ||
          (
            (matchesSource || matchesClientBinding) &&
            (
              hasStructuredPath ||
              candidateInboxPathIds.has(row.id) ||
              (
                matchesSource &&
                retiringLegacyBinding &&
                CLIENT_BOUND_FILESYSTEM_JOB_NAMES.has(row.name) &&
                nonterminal.has(row.status)
              )
            )
          ) ||
          (
            isLegacyGlobalFilesystemJob &&
            LEGACY_GLOBAL_INVALIDATE_JOB_NAMES.has(row.name) &&
            retireLegacyGlobalState &&
            retiringLegacyBinding &&
            nonterminal.has(row.status)
          )
        );
      });
      const targetIds = targetRows.map((row) => row.id).sort((a, b) => a - b);
      const cancelIds = targetRows
        .filter((row) => nonterminal.has(row.status))
        .map((row) => row.id)
        .sort((a, b) => a - b);
      const cancelIdSet = new Set(cancelIds);
      const allTargetRoots = uniquePathSpellings([
        ...sharedRoots,
        ...targetRows.map((row) => {
          const repoPath = parseJobData(row.data).repoPath;
          return typeof repoPath === 'string' ? repoPath : null;
        }),
      ]);

      if (targetIds.length > 0) {
        await tx.executeRaw(
          `UPDATE minion_jobs
              SET status = CASE
                    WHEN id = ANY($2::int[]) THEN 'cancelled'
                    ELSE status
                  END,
                  lock_token = CASE WHEN id = ANY($2::int[]) THEN NULL ELSE lock_token END,
                  lock_until = CASE WHEN id = ANY($2::int[]) THEN NULL ELSE lock_until END,
                  delay_until = CASE WHEN id = ANY($2::int[]) THEN NULL ELSE delay_until END,
                  finished_at = CASE WHEN id = ANY($2::int[]) THEN now() ELSE finished_at END,
                  updated_at = now()
            WHERE id = ANY($1::int[])`,
          [targetIds, cancelIds],
        );
      }

      for (const row of targetRows) {
        const data = parseJobData(row.data);
        const repoPath = typeof data.repoPath === 'string' ? data.repoPath : null;
        const rowRoots = uniquePathSpellings([...allTargetRoots, repoPath]);
        const sanitizedData = redactKnownRoots(data, rowRoots, true) as Record<string, unknown>;
        const hasExplicitSource =
          typeof data.sourceId === 'string' || typeof data.source_id === 'string';
        const matchesSource =
          data.sourceId === sourceId || data.source_id === sourceId;
        if (!hasExplicitSource) {
          const ownsRepoPath = pathBelongsToRoot(repoPath, sharedRoots);
          const ownsLegacyGlobal =
            LEGACY_GLOBAL_FILESYSTEM_JOB_NAMES.has(row.name) &&
            retireLegacyGlobalState;
          if (ownsRepoPath || ownsLegacyGlobal) {
            sanitizedData.sourceId = sourceId;
          } else {
            // An arbitrary absolute repoPath is enough to require cleanup, but
            // not enough to infer product source ownership. Keep only a stable
            // cleanup marker so a racing late result is caught on the next
            // idempotent call without fabricating sourceId semantics.
            sanitizedData[CLIENT_BINDING_MARKER_KEY] = sourceId;
          }
        } else if (!matchesSource) {
          // Preserve the row's original source identity, but retain the
          // path-cleanup binding independently for a possible late result.
          sanitizedData[CLIENT_BINDING_MARKER_KEY] = sourceId;
        }
        const pathShapedError = structuredValueContainsClientPath(
          row.error_text,
          rowRoots,
        );
        const errorText = cancelIdSet.has(row.id)
          ? 'cancelled: client-local source binding retired queued checkout path'
          : pathShapedError || textContainsRoot(row.error_text, rowRoots)
            ? 'client-local source binding retired checkout path from historical job state'
            : row.error_text;

        await tx.executeRaw(
          `UPDATE minion_jobs
              SET data = $1::text::jsonb,
                  result = $2::text::jsonb,
                  progress = $3::text::jsonb,
                  error_text = $4,
                  stacktrace = $5::text::jsonb
            WHERE id = $6`,
          [
            JSON.stringify(sanitizedData),
            row.result === null
              ? null
              : JSON.stringify(redactKnownRoots(parseSharedJson(row.result), rowRoots, true)),
            row.progress === null
              ? null
              : JSON.stringify(redactKnownRoots(parseSharedJson(row.progress), rowRoots, true)),
            errorText,
            JSON.stringify(
              redactKnownRoots(parseSharedJson(row.stacktrace) ?? [], rowRoots, true),
            ),
            row.id,
          ],
        );
      }

      if (hasMinionInbox && targetIds.length > 0) {
        const inboxRows = await tx.executeRaw<{
          id: number;
          payload: unknown;
        }>(
          `SELECT id, payload
             FROM minion_inbox
            WHERE job_id = ANY($1::int[])
               OR payload->>'child_id' = ANY($2::text[])
            FOR UPDATE`,
          [targetIds, targetIds.map(String)],
        );
        for (const row of inboxRows) {
          await tx.executeRaw(
            `UPDATE minion_inbox SET payload = $1::text::jsonb WHERE id = $2`,
            [
              JSON.stringify(
                redactKnownRoots(
                  parseSharedJson(row.payload),
                  allTargetRoots,
                  true,
                ),
              ),
              row.id,
            ],
          );
        }
      }

      const cancelledChildren = targetRows.filter(
        (row) => cancelIdSet.has(row.id) && row.parent_job_id !== null,
      );
      const parentIds = new Set<number>();
      for (const row of cancelledChildren) {
        const parentId = row.parent_job_id!;
        parentIds.add(parentId);
        if (hasMinionInbox) {
          await tx.executeRaw(
            `INSERT INTO minion_inbox (job_id, sender, payload)
             SELECT $1, 'minions', $2::text::jsonb
              WHERE EXISTS (
                SELECT 1 FROM minion_jobs
                 WHERE id = $1
                   AND status NOT IN ('completed','failed','dead','cancelled')
              )`,
            [
              parentId,
              JSON.stringify({
                type: 'child_done',
                child_id: row.id,
                job_name: row.name,
                result: null,
                outcome: 'cancelled',
                error: 'cancelled',
              }),
            ],
          );
        }
      }
      for (const parentId of parentIds) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
            WHERE id = $1 AND status = 'waiting-children'
              AND NOT EXISTS (
                SELECT 1 FROM minion_jobs
                 WHERE parent_job_id = $1
                   AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
              )`,
          [parentId],
        );
      }
      sanitizedJobIds.push(...targetIds);
      cancelledJobIds.push(...cancelIds);
    }

    const ingestRows = await tx.executeRaw<{ id: number; source_ref: string }>(
      `SELECT id, source_ref FROM ingest_log WHERE source_id = $1 FOR UPDATE`,
      [sourceId],
    );
    const sanitizedIngestIds: number[] = [];
    for (const row of ingestRows) {
      const sanitized = sanitizeClientPathSourceRef(sourceId, row.source_ref);
      if (sanitized === null || sanitized === row.source_ref) continue;
      await tx.executeRaw(
        `UPDATE ingest_log SET source_ref = $1 WHERE id = $2`,
        [sanitized, row.id],
      );
      sanitizedIngestIds.push(row.id);
    }

    if (clearsLocalRemoteLocator) {
      const updated = await tx.executeRaw<{ id: string }>(
        `UPDATE sources
            SET local_path = NULL,
                config = config - 'remote_url'
          WHERE id = $1
            AND config->>'remote_url' = $2
        RETURNING id`,
        [sourceId, localRemoteLocator],
      );
      if (updated.length !== 1) {
        throw new Error(
          `Source "${sourceId}" config changed while preparing the client-local binding; retry.`,
        );
      }
    } else {
      await tx.executeRaw(
        `UPDATE sources SET local_path = NULL WHERE id = $1`,
        [sourceId],
      );
    }
    if (clearLegacyRepoPath) {
      await tx.unsetConfig('sync.repo_path');
    }

    return {
      source_id: sourceId,
      cleared_source_local_path: source.local_path !== null,
      cleared_legacy_repo_path: clearLegacyRepoPath,
      sanitized_ingest_log_count: sanitizedIngestIds.length,
      sanitized_job_ids: sanitizedJobIds,
      cancelled_job_ids: cancelledJobIds,
    };
  });
}

async function countVisiblePages(engine: BrainEngine, id: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0]?.n ?? 0;
}

/** Default clone dir for a remote-URL source: $GBRAIN_HOME/clones/<id>/ */
export function defaultCloneDir(id: string): string {
  return gbrainPath('clones', id);
}

/** Temp clone dir under $GBRAIN_HOME/clones/.tmp/<id>-<rand>/ */
function makeTempCloneDir(id: string): string {
  const rand = randomBytes(6).toString('hex');
  return gbrainPath('clones', '.tmp', `${id}-${rand}`);
}

// `isPathContained` moved to `src/core/path-confine.ts` (shared with the
// dotfile-trust + skills-dir confinement helpers). Re-exported here so existing
// importers (and recloneIfMissing below) keep working unchanged.
export { isPathContained };

/**
 * Did gbrain CREATE this clone (so re-clone/delete is safe)? Ownership, NOT
 * path-containment — a user-supplied working tree is NEVER owned, even if it
 * happens to sit under $GBRAIN_HOME. This is the #1881 guard: recloneIfMissing
 * deletes local_path, so it must only ever fire on a clone gbrain owns.
 *
 * Ownership is proven by either:
 *   1. config.managed_clone === true — written by addSource's --url path
 *      (covers both default-location and --clone-dir clones), OR
 *   2. local_path === defaultCloneDir(id) — back-compat for clones created
 *      before the marker existed (gbrain's default location), via exact
 *      normalized-path equality (symlink-free, so none of isPathContained's
 *      symlinked-parent / lexical-escape edge cases apply).
 *
 * Everything else is fail-closed (NOT owned → refuse to touch): the bug's
 * federated row (remote_url + a user tree), and pre-marker --clone-dir clones
 * (rare, local-only) which are byte-for-byte indistinguishable from it. Those
 * must be re-added to regain auto-reclone — the correct trade-off when ownership
 * is unprovable.
 */
export function isOwnedClone(src: {
  id: string;
  local_path: string | null;
  config: unknown;
}): boolean {
  if (!src.local_path) return false;
  const cfg =
    typeof src.config === 'string'
      ? (JSON.parse(src.config) as Record<string, unknown>)
      : ((src.config ?? {}) as Record<string, unknown>);
  if (cfg.managed_clone === true) return true;
  return resolvePath(src.local_path) === resolvePath(defaultCloneDir(src.id));
}

/**
 * Recovery hint for an unowned source with a remote_url. Splits guidance by
 * on-disk state: a healthy unowned path syncs read-only (just drop remote_url),
 * but a degraded one (missing/no-git/not-a-dir) cannot be recovered by dropping
 * remote_url — that would only defer the failure to the "Not a git repository"
 * check. Shared by the core SourceOpError and the sync.ts CLI error so they read
 * identically.
 */
export function unownedHint(
  src: { id: string; local_path: string | null },
  state: RepoState,
): string {
  const path = src.local_path ?? '(none)';
  if (state === 'healthy') {
    return (
      `Source "${src.id}" has config.remote_url set but local_path ${path} is not a ` +
      `clone gbrain created. gbrain syncs it read-only and will never re-clone or delete ` +
      `it. To silence this, drop config.remote_url, or re-register with --url so gbrain ` +
      `owns the clone.`
    );
  }
  return (
    `Source "${src.id}" has config.remote_url set but local_path ${path} is not a clone ` +
    `gbrain created and is not a usable git repo (state: ${state}). gbrain will NOT ` +
    `re-clone over it (it is your working tree, not a gbrain-managed mirror). Restore the ` +
    `directory yourself, or remove + re-add the source with --url to let gbrain manage the ` +
    `clone.`
  );
}

// ── addSource ───────────────────────────────────────────────────────────────

/**
 * #2707: `--path` registration used to accept any existing directory with
 * zero git validation, deferring the failure to the first `gbrain sync`
 * ("Not inside a git repository: ..."). By the time that surfaces the
 * source has already been silently stale for however long nobody read the
 * sync logs. This is registration-time, fail-fast validation ONLY — it
 * never auto-`git init`s the directory (that would cross the consent
 * boundary #2967 established for sync-time self-heal: a `--path` source is
 * the user's own external directory, and gbrain must not mutate it without
 * explicit ask). Callers who want to register before git-init exists opt in
 * via `force: true` (CLI: `--force`).
 */
export async function addSource(
  engine: BrainEngine,
  opts: AddSourceOpts,
): Promise<SourceRow> {
  validateSourceId(opts.id);

  // Q4: pre-flight collision check before any clone work.
  const existing = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`,
    [opts.id],
  );
  if (existing.length > 0) {
    throw new SourceOpError(
      'source_id_taken',
      `Source id "${opts.id}" is already registered. ` +
        `Use 'gbrain sources remove ${opts.id} --confirm-destructive' first, then re-add.`,
    );
  }

  // Validate URL before doing any filesystem work.
  let parsedUrl: { url: string; hostname: string } | null = null;
  if (opts.remoteUrl) {
    try {
      parsedUrl = parseRemoteUrl(opts.remoteUrl);
    } catch (e) {
      if (e instanceof RemoteUrlError) {
        throw new SourceOpError('invalid_remote_url', e.message, e);
      }
      throw e;
    }
  }

  // Overlap check for any local path (existing behavior).
  let finalPath = opts.localPath ?? null;
  if (parsedUrl) {
    finalPath = opts.cloneDir ?? defaultCloneDir(opts.id);
  }
  if (finalPath) {
    const others = await engine.executeRaw<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND id != $1`,
      [opts.id],
    );
    for (const other of others) {
      const a = finalPath;
      const b = other.local_path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
        throw new SourceOpError(
          'overlapping_path',
          `path "${a}" overlaps with existing source "${other.id}" at "${b}". ` +
            `Overlapping sources are not allowed.`,
        );
      }
    }
  }

  // ── Path A: --url (clone + INSERT + rename) ────────────────────────────
  if (parsedUrl) {
    const tempDir = makeTempCloneDir(opts.id);
    mkdirSync(dirname(tempDir), { recursive: true });

    try {
      cloneRepo(parsedUrl.url, tempDir);
    } catch (e) {
      // Clone failed before we've touched the DB. tempDir may or may not
      // exist; nuke it just in case.
      rmSync(tempDir, { recursive: true, force: true });
      if (e instanceof GitOperationError) {
        throw new SourceOpError('clone_failed', e.message, e);
      }
      throw e;
    }

    // managed_clone:true is the ownership marker (#1881). It authorizes
    // recloneIfMissing to rm+replace this clone — gbrain created it, here or at
    // a --clone-dir path. A user-tree row (created by an external INSERT, no
    // --url) never carries this, so it can never be deleted by reclone.
    const config: Record<string, unknown> = {
      remote_url: parsedUrl.url,
      managed_clone: true,
    };
    if (opts.federated !== null && opts.federated !== undefined) {
      config.federated = opts.federated;
    }
    const displayName = opts.name ?? opts.id;

    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
             VALUES ($1, $2, $3, $4::text::jsonb)`,
        [opts.id, displayName, finalPath, JSON.stringify(config)],
      );
    } catch (e) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new SourceOpError(
        'insert_failed',
        `INSERT failed for source "${opts.id}": ${(e as Error).message}`,
        e,
      );
    }

    // Final step: rename temp dir to final clone path. EXDEV (cross-device
    // rename) is rare on a single-host brain but possible if $GBRAIN_HOME
    // and the temp dir are on different mounts. We don't fall back to
    // recursive copy because the temp dir is in $GBRAIN_HOME by design.
    try {
      mkdirSync(dirname(finalPath!), { recursive: true });
      // Refuse to rename over an existing path. If finalPath exists at this
      // point (race: another process created it between our pre-flight and
      // now), back out cleanly.
      if (existsSync(finalPath!)) {
        throw new Error(`destination ${finalPath} appeared mid-flight`);
      }
      renameSync(tempDir, finalPath!);
    } catch (e) {
      rmSync(tempDir, { recursive: true, force: true });
      // Best-effort DB rollback.
      await engine
        .executeRaw(`DELETE FROM sources WHERE id = $1`, [opts.id])
        .catch(() => {});
      throw new SourceOpError(
        'rename_failed',
        `Could not move clone to final path ${finalPath}: ${(e as Error).message}`,
        e,
      );
    }
  } else {
    // ── Path B: --path or no path (existing behavior, pre-v0.28) ─────────
    // #2707: only validate when the path actually exists — a not-yet-created
    // path is a different (pre-existing, out of scope) failure mode, and
    // gating on existsSync keeps this a fail-fast check on the exact bug
    // report ("plain directory accepted, sync fails later") rather than a
    // broader "does this path exist" check nobody asked for.
    //
    // Both isInsideGitRepo AND hasTrackedContent must hold. isInsideGitRepo
    // alone lets through a `git init`ed-but-never-committed directory (fails
    // sync's "No commits in repo ..."), AND an empty-commit-then-untracked-
    // files directory (git resolves HEAD fine but the tree is empty — the
    // exact silent-staleness footgun #2707(c) describes: sync "succeeds"
    // importing nothing, then never notices the untracked files change).
    // hasTrackedContent's `ls-tree HEAD -- .` catches both (codex round 2).
    if (
      opts.localPath &&
      !opts.force &&
      existsSync(opts.localPath) &&
      (!isInsideGitRepo(opts.localPath) || !hasTrackedContent(opts.localPath))
    ) {
      const q = shellQuote(opts.localPath);
      throw new SourceOpError(
        'not_a_git_repo',
        `"${opts.localPath}" is not a git repository with committed, tracked files ` +
          `(or a subdirectory of one). GBrain sync requires every --path source to ` +
          `be git-initialized, with the files actually committed — an empty commit ` +
          `is not enough (the walker reads through git objects, so untracked files ` +
          `stay invisible). Fix: \`git -C ${q} init && git -C ${q} add -A && ` +
          `git -C ${q} commit -m "initial import"\`, then re-run this command. To ` +
          `register anyway and git-init later, pass --force.`,
      );
    }
    const config: Record<string, unknown> = {};
    if (opts.federated !== null && opts.federated !== undefined) {
      config.federated = opts.federated;
    }
    const displayName = opts.name ?? opts.id;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
           VALUES ($1, $2, $3, $4::text::jsonb)`,
      [opts.id, displayName, finalPath, JSON.stringify(config)],
    );
  }

  const created = await fetchSourceRow(engine, opts.id);
  if (!created) {
    throw new SourceOpError(
      'insert_failed',
      `Source "${opts.id}" disappeared after INSERT (concurrent delete?).`,
    );
  }
  return created;
}

// ── resolveDefaultSource ────────────────────────────────────────────────────
//
// v0.34 W0b — canonical helper for CLI commands that take an optional
// --source flag. The contract per the eng review D7:
//   - exactly 1 registered source → return its id (single-source brains,
//     the 80% case; --source flag is unnecessary friction)
//   - 0 sources → throw (no source to scope to)
//   - 2+ sources → throw with the list, forcing the caller to be explicit
//
// Codex finding #7: src/commands/code-callers.ts:54 + code-callees.ts:43
// historically set `allSources: allSources || !sourceId` — which means
// the documented "source-scoped by default" behavior INVERTED to global
// whenever `--source` was omitted. Multi-source brains silently
// cross-contaminated structural retrieval despite the docstring claim.
//
// Helper consolidates the resolution rule so blast/flow/clusters/wiki
// (v0.34 new commands) and code-callers/callees (v0.20.0 retrofit)
// behave identically.

export class SourceResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: 'no_sources' | 'multiple_sources_ambiguous',
    public readonly availableSources: string[],
  ) {
    super(message);
    this.name = 'SourceResolutionError';
  }
}

export async function resolveDefaultSource(engine: BrainEngine): Promise<string> {
  const sources = await listSources(engine);
  if (sources.length === 0) {
    throw new SourceResolutionError(
      'no sources registered; run `gbrain sources add` first',
      'no_sources',
      [],
    );
  }
  if (sources.length === 1) {
    return sources[0]!.id;
  }
  const ids = sources.map((s) => s.id);
  throw new SourceResolutionError(
    `multi-source brain — specify --source from: ${ids.join(', ')}`,
    'multiple_sources_ambiguous',
    ids,
  );
}

/** Result of `resolveScopedSourceOrThrow`: the resolved source id plus the
 * tier that won, so callers can nudge (sole_non_default) or surface the
 * source in their output envelope. */
export interface ScopedSourceResolution {
  source_id: string;
  tier: SourceTier;
}

/**
 * Source scope for the structural-retrieval commands (`code-callers` /
 * `code-callees`) when neither `--source` nor `--all-sources` is given.
 *
 * Runs the FULL 7-tier resolution chain via `resolveSourceWithTier`
 * (flag → env → dotfile → local_path → brain_default → sole_non_default →
 * seed_default), so a `.gbrain-source` pin (or any real signal) selects the
 * source. The multi-source ambiguity guard (`resolveDefaultSource`) is
 * applied ONLY when the chain matched nothing real (tier `seed_default`):
 * 1 source → returns it, 0 → `no_sources` throw, 2+ → `multiple_sources_ambiguous`.
 *
 * Contrast with `resolveSourceId` (silently returns `'default'` and never
 * throws on ambiguity) — this helper deliberately preserves the loud
 * multi-source error when there's genuinely no signal.
 *
 * @throws SourceResolutionError  on a no-signal 0/2+-source brain (seed_default tier).
 * @throws Error ("Source \"…\" not found." / "Invalid …")  on a bad pin / env value
 *         via `assertSourceExists` inside `resolveSourceWithTier` — callers should
 *         surface these as clean usage errors, not uncaught stacks.
 */
export async function resolveScopedSourceOrThrow(
  engine: BrainEngine,
  cwd: string = process.cwd(),
): Promise<ScopedSourceResolution> {
  const resolved = await resolveSourceWithTier(engine, null, cwd);
  if (resolved.tier !== 'seed_default') {
    return { source_id: resolved.source_id, tier: resolved.tier };
  }
  // Nothing in the chain matched → apply the ambiguity guard (may throw).
  const id = await resolveDefaultSource(engine);
  return { source_id: id, tier: 'seed_default' };
}

// ── listSources ─────────────────────────────────────────────────────────────

export async function listSources(
  engine: BrainEngine,
  opts: { includeArchived?: boolean } = {},
): Promise<SourceListEntry[]> {
  // v0.28.1 codex finding (MEDIUM): the prior version ignored the
  // includeArchived flag and returned every row. That leaked archived
  // sources' ids, local_paths, and remote_urls to read-scoped MCP callers
  // who shouldn't see soft-deleted state. Filter at the SQL level so the
  // archived rows never reach the wire by default.
  const archivedFilter = opts.includeArchived
    ? ''
    : 'WHERE archived IS NOT TRUE';
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    local_path: string | null;
    last_sync_at: Date | null;
    config: unknown;
  }>(
    `SELECT id, name, local_path, last_sync_at, config
       FROM sources ${archivedFilter} ORDER BY (id = 'default') DESC, id`,
  );
  const out: SourceListEntry[] = [];
  for (const r of rows) {
    const cfg = parseConfig(r.config);
    out.push({
      id: r.id,
      name: r.name,
      local_path: r.local_path,
      remote_url: typeof cfg.remote_url === 'string' ? cfg.remote_url : null,
      federated: cfg.federated === true,
      page_count: await countVisiblePages(engine, r.id),
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    });
  }
  return out;
}

// ── removeSource ────────────────────────────────────────────────────────────

export interface RemoveResult {
  id: string;
  pages_deleted: number;
  clone_removed: boolean;
  clone_path: string | null;
  dryRun: boolean;
}

/**
 * Hard-remove a source row + cascade. v0.28 additions:
 *  - protected-id guard for "default"
 *  - clone-cleanup: delete the on-disk clone IFF its resolved path is
 *    confined under $GBRAIN_HOME/clones/. realpath+lstat (not startsWith)
 *    to defeat symlink escape attacks.
 *
 * Soft-delete (archive / restore) lives in destructive-guard.ts and is the
 * preferred path for users; this hard-remove is for the admin operator
 * confirming via --confirm-destructive after the impact preview.
 */
export async function removeSource(
  engine: BrainEngine,
  opts: RemoveSourceOpts,
): Promise<RemoveResult> {
  validateSourceId(opts.id);

  if (opts.id === 'default') {
    throw new SourceOpError(
      'protected_id',
      'Cannot remove the "default" source (it backs the pre-v0.17 brain).',
    );
  }

  const src = await fetchSourceRow(engine, opts.id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${opts.id}" not found.`);
  }

  const pageCount = await countAllPages(engine, opts.id);

  if (opts.dryRun) {
    return {
      id: opts.id,
      pages_deleted: pageCount,
      clone_removed: false,
      clone_path: src.local_path,
      dryRun: true,
    };
  }

  // Confirmation gate (caller should usually have already shown the impact
  // preview from destructive-guard.ts).
  if (pageCount > 0 && !opts.confirmDestructive && !opts.yes) {
    throw new SourceOpError(
      'protected_id', // closest existing code; caller can frame as "needs confirm"
      `Refusing to remove source "${opts.id}" with ${pageCount} pages without --confirm-destructive or --yes.`,
    );
  }

  // Decide whether we own the clone dir before removing the row.
  const remoteUrl = getRemoteUrl(src.config);
  const cloneRoot = gbrainPath('clones');
  let cloneRemoved = false;
  if (
    !opts.keepStorage &&
    src.local_path &&
    remoteUrl && // only auto-clean when this was a --url-managed clone
    isPathContained(src.local_path, cloneRoot)
  ) {
    try {
      // Extra symlink-escape paranoia: lstat the resolved final path; if
      // it's a symlink itself (not just contained under the parent), bail
      // out rather than rm -rf following the link.
      const lst = lstatSync(src.local_path);
      if (lst.isSymbolicLink()) {
        throw new SourceOpError(
          'symlink_escape',
          `Refusing to delete clone at ${src.local_path}: path is a symlink.`,
        );
      }
      rmSync(src.local_path, { recursive: true, force: true });
      cloneRemoved = true;
    } catch (e) {
      if (e instanceof SourceOpError) throw e;
      // Don't fail the whole remove if rmSync had a permission hiccup — log
      // and continue. The DB row deletion is the user-facing operation.
      console.error(
        `[gbrain] WARN: clone cleanup at ${src.local_path} failed: ${(e as Error).message}`,
      );
    }
  }

  await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [opts.id]);

  return {
    id: opts.id,
    pages_deleted: pageCount,
    clone_removed: cloneRemoved,
    clone_path: src.local_path,
    dryRun: false,
  };
}

// ── getSourceStatus ─────────────────────────────────────────────────────────

export async function getSourceStatus(
  engine: BrainEngine,
  id: string,
): Promise<SourceStatus> {
  validateSourceId(id);
  const src = await fetchSourceRow(engine, id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${id}" not found.`);
  }

  // Archived check — sources.config.archived is a forward-compat slot;
  // schema.sql also has dedicated `archived` column post-v0.26.5. Read the
  // column directly via a separate query so we don't need to widen the
  // SourceRow shape just for status.
  const archivedRows = await engine.executeRaw<{ archived: boolean | null }>(
    `SELECT archived FROM sources WHERE id = $1`,
    [id],
  );
  const archived = archivedRows[0]?.archived === true;

  const remoteUrl = getRemoteUrl(src.config);
  const localPath = resolveClientSourcePath(id) ?? src.local_path;
  let cloneState: SourceStatus['clone_state'] = 'not-applicable';
  if (localPath) {
    cloneState = validateRepoState(localPath, remoteUrl ?? undefined);
  }

  return {
    id: src.id,
    name: src.name,
    local_path: localPath,
    remote_url: remoteUrl,
    federated: isFederated(src.config),
    page_count: await countVisiblePages(engine, id),
    last_sync_at: src.last_sync_at ? new Date(src.last_sync_at).toISOString() : null,
    last_commit: src.last_commit,
    archived,
    clone_state: cloneState,
  };
}

// ── recloneIfNeeded (used by sources.ts restore path) ──────────────────────

/**
 * Re-clone a source's remote_url into its local_path if the clone is
 * missing on disk. Used by `gbrain sources restore` after an operator
 * autopurged $GBRAIN_HOME/clones/. Idempotent: returns false (didn't clone)
 * if the clone is already there.
 *
 * Throws SourceOpError on clone failure. Does NOT touch the DB row.
 */
export async function recloneIfMissing(
  engine: BrainEngine,
  id: string,
): Promise<boolean> {
  const src = await fetchSourceRow(engine, id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${id}" not found.`);
  }
  const remoteUrl = getRemoteUrl(src.config);
  if (!remoteUrl || !src.local_path) return false;

  const state = validateRepoState(src.local_path, remoteUrl);
  if (state === 'healthy') return false;

  // #1881 ownership guard — abort BEFORE any filesystem op. recloneIfMissing
  // deletes local_path; gbrain may only do that to a clone it created, never a
  // user working tree. A row with remote_url + an unowned local_path (the
  // gstack-orchestrator federated shape) is refused here, loudly, untouched.
  if (!isOwnedClone(src)) {
    throw new SourceOpError('unmanaged_path', unownedHint(src, state));
  }

  // EXDEV-safe atomic reclone. Clone into a SIBLING temp of local_path (not the
  // shared clones/.tmp, which can be on a different mount than a --clone-dir
  // target → EXDEV → "deleted but not recloned"). Then swap: move old aside →
  // move new in → drop old, so local_path is never left missing-and-unrecoverable.
  const parent = dirname(src.local_path);
  mkdirSync(parent, { recursive: true });
  const rand = randomBytes(6).toString('hex');
  const tempDir = join(parent, `.gbrain-reclone-${basename(src.local_path)}-${rand}`);
  try {
    cloneRepo(remoteUrl, tempDir);
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true });
    if (e instanceof GitOperationError) {
      throw new SourceOpError('clone_failed', e.message, e);
    }
    throw e;
  }

  // TOCTOU re-check immediately before the destructive move: re-confirm
  // ownership AND reject a symlink leaf swapped in after the entry check (never
  // rm-rf / rename through a symlink).
  if (!isOwnedClone(src)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new SourceOpError('unmanaged_path', unownedHint(src, state));
  }
  let aside: string | null = null;
  try {
    if (existsSync(src.local_path)) {
      // Symlink leaf guard: never rename/rm *through* a symlinked leaf — that's
      // the TOCTOU swap-in vector (an attacker plants a symlink at local_path
      // between the entry ownership check and this rename). An owned clone's leaf
      // is a real dir gbrain created; a symlink here means tamper, so fail closed.
      // (Symlinked ANCESTORS are intentionally NOT rejected here: for an owned
      // clone gbrain created the dir at this path — cloneRepo refuses a non-empty
      // dest, so a pre-existing user tree can never become an owned clone — and a
      // realpath-chain check false-positives on ubiquitous system symlinks like
      // macOS /var -> /private/var. The residual DB-trust risk, a forged
      // managed_clone marker on an arbitrary path, is tracked as a TODO and is
      // not closable by a path check.)
      if (lstatSync(src.local_path).isSymbolicLink()) {
        rmSync(tempDir, { recursive: true, force: true });
        throw new SourceOpError(
          'symlink_escape',
          `Refusing to re-clone "${id}": local_path ${src.local_path} is a symlink.`,
        );
      }
      aside = `${src.local_path}.old-${rand}`;
      renameSync(src.local_path, aside); // same fs (sibling) — no EXDEV
    }
    renameSync(tempDir, src.local_path); // same fs — no EXDEV
  } catch (e) {
    // Best-effort restore of the original if the swap left local_path missing.
    if (aside && !existsSync(src.local_path)) {
      try {
        renameSync(aside, src.local_path);
      } catch {
        /* original kept at `aside`; surfaced via the thrown error below */
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
    if (e instanceof SourceOpError) throw e;
    // If the original is still parked at `aside` (restore failed), tell the user
    // exactly where it is — otherwise a "cleanup the failed reclone" reflex would
    // delete their only copy.
    const asideNote =
      aside && existsSync(aside)
        ? ` Your original clone is preserved at ${aside} — restore it manually; do not delete it.`
        : '';
    throw new SourceOpError(
      'rename_failed',
      `Could not move re-cloned repo to ${src.local_path}: ${(e as Error).message}.${asideNote}`,
      e,
    );
  }
  if (aside) rmSync(aside, { recursive: true, force: true });
  return true;
}
