export interface FundingTargets {
  provider_accounts: { id: string; name: string; wallets: { country: string; currency: string; direction: string }[] }[];
}

export interface FundingForm {
  target: string;
  provider_account_id: string;
  country: string;
  currency: string;
  direction: string;
  project_id: string;
  amount: number;
  justification: string;
  reference: string;
}

export const emptyFunding: FundingForm = { target: 'float', provider_account_id: '', country: '', currency: 'XAF', direction: '', project_id: '', amount: 0, justification: '', reference: '' };

/** The values the confirmation code is bound to and the request carries: only what the chosen target needs. */
export function fundingRequest(f: FundingForm): Record<string, unknown> {
  const common = { currency: f.currency, amount: f.amount, justification: f.justification, ...(f.reference ? { reference: f.reference } : {}) };
  return f.target === 'float'
    ? { target: 'float', provider_account_id: f.provider_account_id, country: f.country, direction: f.direction, ...common }
    : { target: 'project', project_id: f.project_id, ...common };
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

/** The countries, currencies and directions a provider account holds wallets in, each narrowed by the choices made before it. */
export function walletChoices(targets: FundingTargets | null, providerAccountId: string, picked: { country?: string; currency?: string; direction?: string }) {
  const wallets = targets?.provider_accounts.find((p) => p.id === providerAccountId)?.wallets ?? [];
  const inCountry = wallets.filter((w) => !picked.country || w.country === picked.country);
  const inCurrency = inCountry.filter((w) => !picked.currency || w.currency === picked.currency);
  return {
    countries: sorted(wallets.map((w) => w.country)),
    currencies: sorted(inCountry.map((w) => w.currency)),
    directions: sorted(inCurrency.map((w) => w.direction)),
    complete: wallets.some((w) => w.country === picked.country && w.currency === picked.currency && w.direction === picked.direction),
  };
}

/** Where a funding went, as the confirmation message names it: the wallet, or the project. */
export function fundingTarget(f: FundingForm, targets: FundingTargets | null, projectName: string | undefined, t: (key: string) => string): string {
  if (f.target !== 'float') return projectName ?? f.project_id;
  const provider = targets?.provider_accounts.find((p) => p.id === f.provider_account_id)?.name ?? f.provider_account_id;
  return `${provider} · ${f.country} · ${f.currency} · ${t(`fund.${f.direction}`)}`;
}
