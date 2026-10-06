import { z } from 'zod';
import { ULID_REGEX } from '../ids.ts';

export const Id = z.string().regex(ULID_REGEX, 'must be a ULID');
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes only');
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB colour');
export const Priority = z.enum(['P1', 'P2', 'P3', 'P4']);
export type Priority = z.infer<typeof Priority>;

export const Timestamps = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
});
