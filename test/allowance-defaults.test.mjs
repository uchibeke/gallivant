import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeModelProblems, validateIntakeModelConfig, MODEL_ROUTE_CEILINGS } from '../lib/task_model_config.mjs';

test('planner capacity can be raised without changing explicitly lower route allowances', () => {
  const route = { adapter: 'openai-chat', model: 'configured-model', endpoint: 'https://api.openai.com/v1/chat/completions', credential_env: 'PLANNER_API_KEY',
    budget: { max_calls: 12, max_input_tokens: 100000, max_output_tokens: 16000, allowance_usd: 10, input_usd_per_million: 1, output_usd_per_million: 2 } };
  assert.deepEqual(intakeModelProblems(route), []);
  const larger = validateIntakeModelConfig(route);
  assert.equal(larger.timeoutMs, 120000);
  assert.equal(larger.budget.maxCalls, 12);
  assert.equal(larger.budget.allowanceUsd, 10);
  const lower = validateIntakeModelConfig({ ...route, budget: { ...route.budget, max_calls: 1, allowance_usd: 0.1 } });
  assert.equal(lower.budget.maxCalls, 1); assert.equal(lower.budget.allowanceUsd, 0.1);
  assert.ok(intakeModelProblems({ ...route, budget: { ...route.budget, max_calls: MODEL_ROUTE_CEILINGS.maxCalls + 1 } }).length);
  assert.ok(intakeModelProblems({ ...route, timeout_ms: MODEL_ROUTE_CEILINGS.timeoutMs + 1 }).length);
});
