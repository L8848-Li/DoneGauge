export class DoneGaugeError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONFIG' | 'GIT' | 'IO' | 'USAGE' | 'TRUST',
  ) {
    super(message);
    this.name = 'DoneGaugeError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
