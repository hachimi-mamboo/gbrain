import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  allowFullMcpAuditParams,
  redactClientLocalMcpAuditError,
  redactClientLocalMcpAuditOperation,
  sanitizeClientLocalMcpAuditFields,
} from '../src/commands/serve-http.ts';

describe('serve --http client-local audit privacy', () => {
  const activeBinding = {
    GBRAIN_SOURCE: 'default',
    GBRAIN_SOURCE_PATH: '/clients/a/wiki',
  };

  const sharedBrainRepoBinding = {
    GBRAIN_BRAIN_REPO_PATH: '/clients/a/team-brain',
  };

  test('forces summarized params despite --log-full-params', () => {
    expect(allowFullMcpAuditParams(true, activeBinding)).toBe(false);
    expect(allowFullMcpAuditParams(false, activeBinding)).toBe(false);
    expect(allowFullMcpAuditParams(true, {})).toBe(true);
  });

  test('shared brain-repo binding forces summarized params and redacts its checkout path', () => {
    expect(allowFullMcpAuditParams(true, sharedBrainRepoBinding)).toBe(false);
    expect(sanitizeClientLocalMcpAuditFields({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: 'query',
      params: { nested: [{ cwd: '/clients/a/team-brain/.sources/project-p' }] },
      errorMessage: 'failed in /clients/a/team-brain',
    }, sharedBrainRepoBinding)).toEqual({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: 'query',
      params: {
        redacted: true,
        kind: 'client_local_path',
      },
      errorMessage: 'client-local path omitted from MCP audit error',
    });
  });

  test('redacts path-bearing errors and unknown operation names but preserves stable locators', () => {
    expect(redactClientLocalMcpAuditError(
      'failed in /clients/a/wiki',
      activeBinding,
    )).toBe('client-local path omitted from MCP audit error');
    expect(redactClientLocalMcpAuditOperation(
      '/clients/a/wiki',
      activeBinding,
    )).toBe('unknown_operation');
    expect(redactClientLocalMcpAuditError(
      'remote https://example.com/C:/repo.git failed',
      activeBinding,
    )).toBe('remote https://example.com/C:/repo.git failed');
    expect(redactClientLocalMcpAuditOperation(
      'https://example.com/path:/repo.git',
      activeBinding,
    )).toBe('https://example.com/path:/repo.git');
  });

  test('redacts path-bearing audit identities under an active binding', () => {
    expect(sanitizeClientLocalMcpAuditFields({
      tokenName: '/clients/a/wiki',
      agentName: 'C:\\clients\\legacy\\wiki',
      operation: 'tools/list',
      params: null,
      errorMessage: null,
    }, activeBinding)).toEqual({
      tokenName: 'client-local-identity',
      agentName: 'client-local-identity',
      operation: 'tools/list',
      params: null,
      errorMessage: null,
    });

    expect(sanitizeClientLocalMcpAuditFields({
      tokenName: 'https://example.com/C:/repo.git',
      agentName: 'git@example.com:org/repo.git',
      operation: 'tools/list',
      params: null,
      errorMessage: null,
    }, activeBinding)).toEqual({
      tokenName: 'https://example.com/C:/repo.git',
      agentName: 'git@example.com:org/repo.git',
      operation: 'tools/list',
      params: null,
      errorMessage: null,
    });
  });

  test('redacts path-bearing operation, params, and error fields recursively', () => {
    expect(sanitizeClientLocalMcpAuditFields({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: '/clients/a/wiki',
      params: {
        nested: [{
          '/clients/legacy/wiki': 'file:///clients/a/wiki/page.md',
        }],
      },
      errorMessage: 'failed in /clients/a/wiki',
    }, activeBinding)).toEqual({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: 'unknown_operation',
      params: {
        redacted: true,
        kind: 'client_local_path',
      },
      errorMessage: 'client-local path omitted from MCP audit error',
    });
  });

  test('preserves stable remote and repo-relative structured audit locators', () => {
    const params = {
      https: 'https://example.com/C:/repo.git',
      ssh: 'ssh://git@example.com/path:/repo.git',
      scp: 'git@example.com:org/repo.git',
      git: 'git://example.com/org/repo.git',
      repo: {
        identity: 'org/repo',
        commit: '0123456789abcdef',
        ref: 'docs/runbook.md',
      },
    };
    expect(sanitizeClientLocalMcpAuditFields({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: 'query',
      params,
      errorMessage: 'remote fetch completed',
    }, activeBinding)).toEqual({
      tokenName: 'client-1',
      agentName: 'agent-1',
      operation: 'query',
      params,
      errorMessage: 'remote fetch completed',
    });
  });

  test('routes all request-log inserts through one sanitizing writer', () => {
    const source = readFileSync(
      new URL('../src/commands/serve-http.ts', import.meta.url),
      'utf8',
    );
    expect(source.match(/INSERT INTO mcp_request_log/g)?.length).toBe(1);
    expect(source).toContain(
      'const safeFields = sanitizeClientLocalMcpAuditFields(fields);',
    );
  });

  test('projects only sanitized audit fields to the admin SSE feed', () => {
    const source = readFileSync(
      new URL('../src/commands/serve-http.ts', import.meta.url),
      'utf8',
    );
    const projections = [
      ...source.matchAll(/broadcastEvent\(\{([\s\S]*?)\n\s*\}\);/g),
    ].map((match) => match[1] ?? '');
    expect(projections).toHaveLength(7);
    for (const projection of projections) {
      expect(projection).toMatch(
        /agent: (?:auditFields|broadcastFields)\.agentName/,
      );
      expect(projection).toMatch(
        /operation: (?:auditFields|broadcastFields)\.operation/,
      );
      expect(projection).not.toContain('agent: agentName');
      expect(projection).not.toContain('operation: name');
      expect(projection).not.toContain('params: broadcastParams');
    }
  });
});
