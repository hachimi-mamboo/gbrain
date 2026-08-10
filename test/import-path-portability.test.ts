import { describe, expect, test } from 'bun:test';
import { win32 } from 'node:path';

import { normalizeImportRelativePath } from '../src/commands/import.ts';

describe('import source_path portability', () => {
  test('normalizes Windows-native relative paths before persistence', () => {
    const nativePath = win32.relative(
      'C:\\brain\\.sources\\project-p',
      'C:\\brain\\.sources\\project-p\\decisions\\retention.md',
    );

    expect(nativePath).toBe('decisions\\retention.md');
    expect(normalizeImportRelativePath(nativePath, '\\')).toBe(
      'decisions/retention.md',
    );
  });

  test('does not reinterpret a POSIX literal backslash as a directory separator', () => {
    expect(normalizeImportRelativePath('decisions\\retention.md', '/')).toBe(
      'decisions\\retention.md',
    );
  });
});
