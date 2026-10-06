/** Repository errors carry an HTTP-friendly status so the server can map them directly. */
export class RepoError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export const notFound = (what: string, id: string) =>
  new RepoError(404, 'not_found', `${what} "${id}" not found`);
export const conflict = (message: string) => new RepoError(409, 'conflict', message);
export const invalid = (message: string) => new RepoError(400, 'invalid', message);

export function now(): string {
  return new Date().toISOString();
}

/** Converts SQLite UNIQUE violations into a readable 409. */
export function mapUnique<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict(message);
    throw err;
  }
}
