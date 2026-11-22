const MiB = 1024 * 1024;

export const PLAN_VERSION = 1;
export const PLAN_LIMITS = Object.freeze({
  sourceBytes: MiB,
  totalBytes: 8 * MiB,
  files: 32,
  depth: 32,
  nodes: 1_000,
  edges: 10_000,
  references: 10_000,
  edgeAttempts: 100_000,
  syntaxTokens: 200_000,
  previewBytes: 4 * MiB,
  idLength: 80,
  pathBytes: 512,
});

export const qualifiedIdLength = PLAN_LIMITS.depth * (PLAN_LIMITS.idLength + 1) - 1;
export const planError = (at, message) => Object.assign(new Error(`${at}: ${message}`), { planDiagnostic: { at, message } });
