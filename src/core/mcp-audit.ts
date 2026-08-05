import {
  isClientPathShapedText,
  structuredValueContainsClientPath,
} from './client-local-path.ts';
import {
  resolveClientBrainRepoPath,
  resolveClientSourcePath,
} from './source-resolver.ts';

function activeClientBindingPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const brainRepoPath = resolveClientBrainRepoPath(env);
  if (brainRepoPath) return brainRepoPath;
  const sourceId = env.GBRAIN_SOURCE;
  if (!sourceId || !env.GBRAIN_SOURCE_PATH) return null;
  return resolveClientSourcePath(sourceId, env);
}

/** Client-local binding always wins over the operator's raw audit opt-in. */
export function allowFullMcpAuditParams(
  requested: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return requested === true && activeClientBindingPath(env) === null;
}

/** Keep path-bearing failures useful to callers without sharing the path. */
export function redactClientLocalMcpAuditError(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const clientPath = activeClientBindingPath(env);
  if (!clientPath || !isClientPathShapedText(message, [clientPath])) {
    return message;
  }
  return 'client-local path omitted from MCP audit error';
}

export function redactClientLocalMcpAuditOperation(
  operation: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const clientPath = activeClientBindingPath(env);
  if (!clientPath || !isClientPathShapedText(operation, [clientPath])) {
    return operation;
  }
  return 'unknown_operation';
}

export interface ClientLocalMcpAuditFields {
  tokenName: string | null;
  agentName: string | null;
  operation: string;
  params: unknown;
  errorMessage: string | null;
}

export function sanitizeClientLocalMcpAuditFields(
  fields: ClientLocalMcpAuditFields,
  env: NodeJS.ProcessEnv = process.env,
): ClientLocalMcpAuditFields {
  const clientPath = activeClientBindingPath(env);
  if (!clientPath) return fields;
  const sanitizeIdentity = (value: string | null): string | null =>
    value !== null && isClientPathShapedText(value, [clientPath])
      ? 'client-local-identity'
      : value;
  return {
    ...fields,
    tokenName: sanitizeIdentity(fields.tokenName),
    agentName: sanitizeIdentity(fields.agentName),
    operation: redactClientLocalMcpAuditOperation(fields.operation, env),
    params: structuredValueContainsClientPath(fields.params, [clientPath])
      ? { redacted: true, kind: 'client_local_path' }
      : fields.params,
    errorMessage: fields.errorMessage === null
      ? null
      : redactClientLocalMcpAuditError(fields.errorMessage, env),
  };
}
