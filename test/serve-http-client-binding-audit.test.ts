import { describe, expect, test } from 'bun:test';
import {
  allowFullMcpAuditParams,
  redactClientLocalMcpAuditError,
  redactClientLocalMcpAuditOperation,
} from '../src/commands/serve-http.ts';

describe('serve --http client-local audit privacy', () => {
  const activeBinding = {
    GBRAIN_SOURCE: 'default',
    GBRAIN_SOURCE_PATH: '/clients/a/wiki',
  };

  test('forces summarized params despite --log-full-params', () => {
    expect(allowFullMcpAuditParams(true, activeBinding)).toBe(false);
    expect(allowFullMcpAuditParams(false, activeBinding)).toBe(false);
    expect(allowFullMcpAuditParams(true, {})).toBe(true);
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
});
