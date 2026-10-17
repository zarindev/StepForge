import { describe, expect, it } from 'vitest';
import { findPlaceholders, MASK, VariableResolutionError, VariableResolver } from '../src/index.ts';

const make = () =>
  new VariableResolver({
    env: { baseUrl: 'http://localhost:8101', port: 8101 },
    secret: { adminPassword: 'hunter2!' },
    data: { email: 'a@b.test', user: { name: 'Ana' } },
    run: { id: 'RUN1' },
    vars: {},
  });

describe('VariableResolver', () => {
  it('interpolates strings', () => {
    expect(make().resolve('{{env.baseUrl}}/login?u={{data.email}}')).toBe(
      'http://localhost:8101/login?u=a@b.test',
    );
  });

  it('keeps raw types for whole placeholders', () => {
    expect(make().resolve('{{env.port}}')).toBe(8101);
    expect(make().resolve({ n: '{{ data.user }}' })).toEqual({ n: { name: 'Ana' } });
  });

  it('resolves nested paths and deep structures', () => {
    expect(make().resolve({ a: ['{{data.user.name}}', 1, null] })).toEqual({ a: ['Ana', 1, null] });
  });

  it('throws a descriptive error for unknown variables', () => {
    expect(() => make().resolve('{{env.nope}}')).toThrow(VariableResolutionError);
    expect(() => make().resolve('{{bogus.x}}')).toThrow(/unknown scope/);
    expect(() => make().resolve('{{random.nope}}')).toThrow(/unknown random generator/);
  });

  it('generates random values', () => {
    const r = make();
    expect(r.resolve('{{random.email}}')).toMatch(/@example\.test$/);
    expect(r.resolve('{{random.uuid}}')).not.toBe(r.resolve('{{random.uuid}}'));
  });

  it('stores captured vars', () => {
    const r = make();
    r.setVar('otp', '123456');
    expect(r.resolve('code={{vars.otp}}')).toBe('code=123456');
  });

  it('masks secrets', () => {
    const r = make();
    const body = r.resolve('{"password":"{{secret.adminPassword}}"}');
    expect(r.mask(`sent ${body}`)).toBe(`sent {"password":"${MASK}"}`);
  });

  it('masks secrets inside any value: numbers, quotes and backslashes, keys — never breaking it', () => {
    const r = new VariableResolver({ secret: { pin: '1234', pw: 'pa"ss\\w', on: 'true' } });
    const masked = r.maskDeep({
      id: 1234,
      flag: true,
      text: 'pin is 1234; pw is pa"ss\\w',
      list: [1234, 12345, 'x'],
      'key-pa"ss\\w': null,
      nested: { deep: [{ v: 'pa"ss\\w' }] },
    });
    expect(masked).toEqual({
      id: MASK,
      flag: MASK,
      text: `pin is ${MASK}; pw is ${MASK}`,
      list: [MASK, 12345, 'x'],
      [`key-${MASK}`]: null,
      nested: { deep: [{ v: MASK }] },
    });
    expect(r.maskDeep(undefined)).toBeUndefined();
  });

  it('finds placeholders', () => {
    expect(findPlaceholders({ a: '{{env.baseUrl}}', b: ['{{vars.x}} {{data.y}}'] }).sort()).toEqual([
      'data.y',
      'env.baseUrl',
      'vars.x',
    ]);
  });
});
