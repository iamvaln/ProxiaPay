import { describe, expect, it } from 'vitest';
import { amountToSend } from './amount-to-send';
import { EjaraAdapter } from './adapters/ejara.adapter';
import { SimulatorAdapter } from './adapters/simulator.adapter';

const ejara = new EjaraAdapter().capabilities();
const simulator = new SimulatorAdapter().capabilities();

describe('what a provider is sent, and what the counterparty then experiences', () => {
  it('collections: the largest amount whose debit stays within the quote (the live OM deposit)', () => {
    expect(amountToSend('collection', ejara, { bps: 200, fixed: 0 }, { charged: 513, settled: 500 })).toEqual({ amount: 502, counterparty: 513 });
  });

  it('payouts at a provider that deducts its fee: enough to deliver the promised amount', () => {
    expect(amountToSend('disbursement', ejara, { bps: 150, fixed: 0 }, { charged: 533, settled: 520 })).toEqual({ amount: 528, counterparty: 520 });
  });

  it('payouts at a provider that adds its fee on top: the promised amount itself', () => {
    expect(amountToSend('disbursement', simulator, { bps: 150, fixed: 0 }, { charged: 1030, settled: 1000 })).toEqual({ amount: 1000, counterparty: 1000 });
  });

  it('each adapter declares how it charges on payouts', () => {
    expect(ejara.disbursementFee).toBe('deducted');
    expect(simulator.disbursementFee).toBe('on_top');
  });
});
