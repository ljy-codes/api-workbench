import type { RequestDiagnostics } from '../types';

export class RequestExecutionError extends Error {
  constructor(message: string, public readonly diagnostics: RequestDiagnostics) {
    super(message);
    this.name = 'RequestExecutionError';
  }
}

export function executionDiagnostics(error: unknown): RequestDiagnostics | undefined {
  return error instanceof RequestExecutionError ? error.diagnostics : undefined;
}
