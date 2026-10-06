export * from './types.ts';
export { buildFacts, describeLocator } from './facts.ts';
export { loadRules, parseRules, matches, render, RuleSchema, type Rule } from './rules.ts';
export { diagnose, lastGreenDiff, builtinRules, BUILTIN_RULES_DIR } from './engine.ts';
