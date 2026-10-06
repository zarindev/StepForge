import { describe, expect, it } from 'vitest';
import { generateVariants } from '../src/index.ts';

describe('generateVariants', () => {
  it('derives rules from field names and values', () => {
    const v = generateVariants({ email: 'a@b.test', age: 30, name: 'Ana' }, ['email', 'age']);
    const titles = v.map((x) => x.title);
    expect(titles).toContain('email: missing @');
    expect(titles).toContain('age: negative');
    expect(titles).not.toContain('age: HTML/script');
    expect(v.every((x) => x.data.name === 'Ana')).toBe(true);
    expect(v.find((x) => x.title === 'email: too long (256 chars)')?.data.email).toHaveLength(256);
    expect(new Set(v.map((x) => x.technique))).toEqual(
      new Set(['negative', 'boundary', 'security', 'equivalence']),
    );
  });

  it('handles dates and phones', () => {
    const titles = generateVariants({ dob: '1990-01-01', phone: '+1-555' }, ['dob', 'phone']).map(
      (x) => x.title,
    );
    expect(titles).toContain('dob: invalid date');
    expect(titles).toContain('phone: letters');
  });
});
