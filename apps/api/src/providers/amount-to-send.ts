import { providerAmountDelivering, providerAmountWithin, type FeeTerms } from '../money/money';
import type { AdapterCapabilities } from './adapter';

/**
 * What a provider is sent for a payment, and what the counterparty then experiences — the payer's
 * debit on a collection, the recipient's receipt on a payout. Providers charge their fee each their
 * own way, which each adapter declares; this is the one place that turns that into an amount, so
 * submission and the checks made before it cannot disagree.
 *
 * Collections: the provider adds its fee on top, so it is sent the largest amount whose debit stays
 * within the payer's quote. Payouts: a provider that deducts its fee is sent enough to deliver the
 * promised amount; one that adds it on top is sent the promised amount itself.
 */
export function amountToSend(
  direction: 'collection' | 'disbursement',
  caps: Pick<AdapterCapabilities, 'collectionFeeRounding' | 'disbursementFee'>,
  terms: FeeTerms,
  figures: { charged: number; settled: number },
): { amount: number; counterparty: number } {
  if (direction === 'collection') {
    const r = providerAmountWithin(figures.charged, terms, caps.collectionFeeRounding);
    return { amount: r.amount, counterparty: r.debit };
  }
  if (caps.disbursementFee === 'deducted') {
    const r = providerAmountDelivering(figures.settled, terms);
    return { amount: r.amount, counterparty: r.delivered };
  }
  return { amount: figures.settled, counterparty: figures.settled };
}
