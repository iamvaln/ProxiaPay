import { describe, expect, it } from 'vitest';
import { STATE_SYMBOL, stateFamily } from './states';

describe('which family a state belongs to', () => {
  const families = {
    confirmed: ['succeeded', 'healthy', 'active', 'matched', 'delivered', 'confirmed', 'approved', 'completed', 'resolved', 'cleared', 'done', 'present'],
    refused: ['failed', 'expired', 'critical', 'suspended', 'exhausted', 'revoked', 'declined', 'rejected', 'dead', 'disabled', 'deleted', 'abandoned'],
    pending: ['processing', 'submitted', 'pending', 'action_required', 'created', 'submitting', 'pending_approval', 'under_review', 'running', 'queued', 'half_open'],
    checking: ['undetermined', 'watch', 'warning', 'disputed', 'degraded', 'open', 'unreviewed'],
    information: ['informational', 'acknowledged', 'examined', 'corrected'],
  } as const;

  for (const [family, values] of Object.entries(families)) {
    it(`puts ${values.join(', ')} under ${family}`, () => {
      for (const v of values) expect(stateFamily(v), v).toBe(family);
    });
  }

  it('gives values that are not states a plain tag: credential roles, discrepancy types', () => {
    for (const v of ['primary', 'secondary', 'float_drift', 'fee_variance']) expect(stateFamily(v), v).toBe('tag');
  });

  it('never asserts a meaning for a value it does not know', () => {
    expect(stateFamily('brand_new_status')).toBe('tag');
  });

  it('pairs every family but the plain tag with its symbol', () => {
    expect(STATE_SYMBOL).toEqual({ confirmed: '✓', refused: '✕', pending: '◷', checking: '!', information: 'i' });
  });
});
