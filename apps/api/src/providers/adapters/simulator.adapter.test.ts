import { describe, expect, it } from 'vitest';
import { SimulatorAdapter } from './simulator.adapter';

describe('Simulator fee model', () => {
  it('declares half-up rounding, matching the 2 percent it adds on top of what it is sent', () => {
    expect(new SimulatorAdapter().capabilities().collectionFeeRounding).toBe('half_up');
  });

  it('needs no credentials', () => {
    expect(new SimulatorAdapter().capabilities().credentialKeys).toEqual([]);
  });
});
