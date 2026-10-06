import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** Generates a new ULID. All StepForge entity IDs are ULIDs. */
export function newId(): string {
  return next();
}

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
