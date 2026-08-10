import { describe, expect, test } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';

function clientBindingEnv() {
  return {
    GBRAIN_SOURCE: process.env.GBRAIN_SOURCE,
    GBRAIN_SOURCE_PATH: process.env.GBRAIN_SOURCE_PATH,
    GBRAIN_BRAIN_REPO_PATH: process.env.GBRAIN_BRAIN_REPO_PATH,
  };
}

describe('client binding test preload', () => {
  test('clears inherited bindings while explicit withEnv scopes still work and restore', async () => {
    expect(clientBindingEnv()).toEqual({
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_BRAIN_REPO_PATH: undefined,
    });

    await withEnv({
      GBRAIN_SOURCE: 'project-p',
      GBRAIN_SOURCE_PATH: '/tmp/gbrain-test-client-source',
      GBRAIN_BRAIN_REPO_PATH: '/tmp/gbrain-test-shared-repo',
    }, async () => {
      expect(clientBindingEnv()).toEqual({
        GBRAIN_SOURCE: 'project-p',
        GBRAIN_SOURCE_PATH: '/tmp/gbrain-test-client-source',
        GBRAIN_BRAIN_REPO_PATH: '/tmp/gbrain-test-shared-repo',
      });
    });

    expect(clientBindingEnv()).toEqual({
      GBRAIN_SOURCE: undefined,
      GBRAIN_SOURCE_PATH: undefined,
      GBRAIN_BRAIN_REPO_PATH: undefined,
    });
  });
});
