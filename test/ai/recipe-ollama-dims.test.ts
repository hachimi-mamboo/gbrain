/**
 * Ollama Matryoshka dims passthrough.
 *
 * Several embedding models served via Ollama (Qwen3-Embedding family) support
 * Matryoshka truncation through the `dimensions` field on /v1/embeddings.
 * Without this passthrough, gbrain ignores user-selected reduced dims and the
 * provider returns its native size, causing dim-mismatch failures against
 * brains configured for smaller widths.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  embed,
  resetGateway,
} from '../../src/core/ai/gateway.ts';

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('dims: ollama Matryoshka models', () => {
  test('qwen3-embedding:4b threads dimensions=1536', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('qwen3-embedding:0.6b threads dimensions=512', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:0.6b', 512))
      .toEqual({ openaiCompatible: { dimensions: 512 } });
  });

  test('qwen3-embedding:8b threads dimensions=2048', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2048))
      .toEqual({ openaiCompatible: { dimensions: 2048 } });
  });

  test('bare qwen3-embedding (no quant tag) also recognized', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('preserves exact Qwen3 server model casing while threading dimensions', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen3-Embedding-8B', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('unrelated openai-compat model returns undefined (regression guard)', () => {
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768))
      .toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'mxbai-embed-large', 1024))
      .toBeUndefined();
  });
});

describe('gateway: exact Qwen3 server model wire shape', () => {
  test('keeps Qwen3-Embedding-8B unchanged and requests 1024 dimensions', async () => {
    configureGateway({
      embedding_model: 'llama-server:Qwen3-Embedding-8B',
      embedding_dimensions: 1024,
      env: {},
    });

    let captured: any;
    __setEmbedTransportForTests((async (args: any) => {
      captured = args;
      return { embeddings: [new Array(1024).fill(0)] };
    }) as any);

    await embed(['document']);

    expect(captured.model.modelId).toBe('Qwen3-Embedding-8B');
    expect(captured.providerOptions).toEqual({
      openaiCompatible: { dimensions: 1024 },
    });
  });
});
