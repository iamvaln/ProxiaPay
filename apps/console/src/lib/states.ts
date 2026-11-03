/**
 * Every state the console shows belongs to one family, and each family is told three ways at
 * once: a colour, a symbol and the word. Values that are not states (a credential's role, a
 * discrepancy's type) and values this table does not know get a plain tag, so a symbol never
 * asserts a meaning the value does not have.
 */
export type StateFamily = 'confirmed' | 'refused' | 'pending' | 'checking' | 'information' | 'tag';

export const STATE_SYMBOL: Record<Exclude<StateFamily, 'tag'>, string> = { confirmed: '✓', refused: '✕', pending: '◷', checking: '!', information: 'i' };

const FAMILIES: Record<Exclude<StateFamily, 'tag'>, string[]> = {
  confirmed: ['succeeded', 'healthy', 'active', 'matched', 'delivered', 'confirmed', 'approved', 'completed', 'resolved', 'cleared', 'done', 'present', 'contracted'],
  refused: ['failed', 'expired', 'critical', 'suspended', 'exhausted', 'revoked', 'declined', 'rejected', 'dead', 'disabled', 'deleted', 'abandoned'],
  // action_required waits on the payer, not on an operator.
  pending: ['processing', 'submitted', 'pending', 'action_required', 'created', 'submitting', 'pending_approval', 'under_review', 'running', 'queued', 'half_open'],
  // An undetermined payment is one a person must look at.
  checking: ['undetermined', 'watch', 'warning', 'disputed', 'degraded', 'open', 'unreviewed', 'indicative'],
  information: ['informational', 'acknowledged', 'examined', 'corrected'],
};

const BY_VALUE = new Map(Object.entries(FAMILIES).flatMap(([family, values]) => values.map((v) => [v, family as StateFamily])));

export function stateFamily(value: string): StateFamily {
  return BY_VALUE.get(value) ?? 'tag';
}
