import assert from 'node:assert/strict';

import { test } from 'node:test';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

test('secret redaction covers assignment forms, short keys, and jwt-shaped tokens', () => {
  assert.equal(redactSecrets('api_key: super-secret'), 'api_key=[redacted]');
  assert.equal(redactSecrets('Authorization: Bearer abc.def'), 'Authorization=[redacted] abc.def');
  assert.equal(redactSecrets('bearer=abc.def'), 'bearer=[redacted]');
  assert.equal(redactSecrets('password=hunter2 token=abc'), 'password=[redacted] token=[redacted]');
  assert.equal(redactSecrets('sk-1234567'), 'sk-1234567');
  assert.equal(redactSecrets('sk-12345678'), 'sk-[redacted]');
  assert.equal(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue'), '[redacted]');
  assert.equal(errorMessage(new Error('secret=value')), 'secret=[redacted]');
  assert.equal(errorMessage('plain'), 'plain');
});;
