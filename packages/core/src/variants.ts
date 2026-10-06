/**
 * Rule-based test data variants ("Generate variants" in the Test cases tab). No AI: each rule is a
 * classic negative/boundary technique chosen from the field's name and current value.
 */
export type Variant = {
  title: string;
  technique: 'negative' | 'boundary' | 'security' | 'equivalence';
  field: string;
  data: Record<string, unknown>;
  expectedResult: string;
};

type Rule = { name: string; technique: Variant['technique']; value: unknown; expect: string };

const looksLikeEmail = (k: string, v: unknown) =>
  /e-?mail/i.test(k) || (typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v));
const looksLikePhone = (k: string) => /phone|mobile|tel/i.test(k);
const looksLikeDate = (k: string, v: unknown) =>
  /date|dob|birth/i.test(k) || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

function rulesFor(field: string, value: unknown): Rule[] {
  const rules: Rule[] = [
    { name: 'empty', technique: 'negative', value: '', expect: `A validation error is shown for ${field}` },
  ];
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)) && !looksLikePhone(field))
  ) {
    const n = Number(value);
    rules.push(
      { name: 'zero', technique: 'boundary', value: 0, expect: `0 is handled for ${field}` },
      {
        name: 'negative',
        technique: 'boundary',
        value: -1,
        expect: `Negative values are rejected for ${field}`,
      },
      {
        name: 'very large',
        technique: 'boundary',
        value: 2_147_483_648,
        expect: `Out-of-range values are rejected for ${field}`,
      },
      {
        name: 'decimal',
        technique: 'equivalence',
        value: Number.isInteger(n) ? n + 0.5 : Math.round(n),
        expect: `${field} accepts or rejects decimals as specified`,
      },
      {
        name: 'non-numeric',
        technique: 'negative',
        value: 'abc',
        expect: `Non-numeric input is rejected for ${field}`,
      },
    );
    return rules;
  }
  rules.push(
    {
      name: 'whitespace only',
      technique: 'negative',
      value: '   ',
      expect: `Whitespace-only input is rejected for ${field}`,
    },
    {
      name: 'too long (256 chars)',
      technique: 'boundary',
      value: 'a'.repeat(256),
      expect: `Overly long input is rejected or truncated for ${field}`,
    },
  );
  if (looksLikeEmail(field, value)) {
    rules.push(
      {
        name: 'missing @',
        technique: 'negative',
        value: 'user.example.test',
        expect: 'An invalid email error is shown',
      },
      {
        name: 'missing domain',
        technique: 'negative',
        value: 'user@',
        expect: 'An invalid email error is shown',
      },
    );
  } else if (looksLikePhone(field)) {
    rules.push({
      name: 'letters',
      technique: 'negative',
      value: 'phone-number',
      expect: 'An invalid phone error is shown',
    });
  } else if (looksLikeDate(field, value)) {
    rules.push(
      {
        name: 'invalid date',
        technique: 'negative',
        value: '2026-02-30',
        expect: 'An invalid date error is shown',
      },
      {
        name: 'far future',
        technique: 'boundary',
        value: '2999-12-31',
        expect: 'Unrealistic dates are rejected',
      },
    );
  }
  rules.push(
    {
      name: 'HTML/script',
      technique: 'security',
      value: '<script>alert(1)</script>',
      expect: `${field} is stored and shown escaped (no script runs)`,
    },
    {
      name: 'SQL quote',
      technique: 'security',
      value: "O'Brien' OR '1'='1",
      expect: `${field} is handled safely (no SQL error)`,
    },
  );
  return rules;
}

export function generateVariants(base: Record<string, unknown>, fields: string[]): Variant[] {
  const out: Variant[] = [];
  for (const field of fields) {
    for (const r of rulesFor(field, base[field])) {
      out.push({
        title: `${field}: ${r.name}`,
        technique: r.technique,
        field,
        data: { ...base, [field]: r.value },
        expectedResult: r.expect,
      });
    }
  }
  return out;
}
