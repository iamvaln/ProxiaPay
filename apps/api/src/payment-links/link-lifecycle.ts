import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/database';
import { AlertService } from '../alerts/alert.service';

/**
 * What a payment's final state does to its link (spec: payment links, single use). A single-use link never collects twice:
 * while a payment is not final the confirmation refuses a second payer, and here, in the store transaction that makes the
 * state final, the link's status is brought into line with its payments.
 *
 * The status is derived from what the link's payments now are, not from the transition alone, so a correction, a late
 * callback and a status check all leave the same link behind: `completed` while a payment on it stands succeeded, `active`
 * once none does. A link the owner disabled stays disabled.
 */
@Injectable()
export class LinkLifecycle {
  constructor(private readonly alerts: AlertService) {}

  async onTransactionFinal(tx: Tx, txn: { id: string; reference: string; payment_link_id: string | null }, previous: string, next: string): Promise<void> {
    if (!txn.payment_link_id) return;
    // Queues behind a confirmation on the same link, which holds this lock until its transaction is recorded on the link.
    const link = await tx.selectFrom('payment_link').select(['id', 'project_id', 'code', 'single_use', 'status']).where('id', '=', txn.payment_link_id).forUpdate().executeTakeFirstOrThrow();
    if (!link.single_use) return;
    const succeeded = await tx.selectFrom('transaction').select('reference').where('payment_link_id', '=', link.id).where('state', '=', 'succeeded').execute();

    if (next === 'succeeded' && succeeded.some((s) => s.reference !== txn.reference)) {
      // Only a correction gets here (the confirmation refuses a payer once a payment succeeded): the payer paid twice,
      // and there is no refund yet, so the platform settles it by hand.
      await this.alerts.raise({
        category: 'treasury', severity: 'warning', subjectType: 'payment_link', subjectReference: link.code, projectId: link.project_id,
        fingerprint: `link_collected_twice:${link.id}`, title: 'Single-use link collected twice',
        detail: { link: link.code, transactions: succeeded.map((s) => s.reference), corrected: txn.reference, previous_state: previous },
        actionReference: `/projects/${link.project_id}?tab=links`,
      }, tx);
    }
    if (link.status === 'active' && succeeded.length > 0) {
      await tx.updateTable('payment_link').set({ status: 'completed' }).where('id', '=', link.id).execute();
    } else if (link.status === 'completed' && succeeded.length === 0) {
      await tx.updateTable('payment_link').set({ status: 'active' }).where('id', '=', link.id).execute();
    }
  }
}
