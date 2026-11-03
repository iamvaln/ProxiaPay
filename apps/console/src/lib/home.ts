/** Response of GET /console/home. The console shares no code with the API, so the shape is copied here. */
export interface Problem { severity: 'warning' | 'critical'; kind: string; subject_type: string; subject_reference: string | null; subject_name: string | null; count: number; since: string; title: string; link: string }
export interface RateVsBaseline { current: number | null; baseline: number | null; sample: number }
export interface CollectedToday { currency: string; today: number; last_week: number | null }
export interface RouteSeries {
  route_id: string; payment_method_code: string; payment_method_name: string; country_code: string; currency: string; direction: 'collection' | 'disbursement';
  baseline: number | null; current: number | null; sample: number; alerted: boolean; departing: boolean;
  hours: { hour: string; terminal: number; succeeded: number }[];
}
export interface HomeCards {
  verdict?: { problems: Problem[] };
  success_rate?: RateVsBaseline;
  collected_today?: CollectedToday[];
  undetermined?: number;
  lowest_float?: { id: string; provider: string; country: string; currency: string; direction: string; cover_hours: number | null; band: string; proposed_transfer: number | null } | null;
  routes?: { scoped: boolean; series: RouteSeries[] };
  awaiting_your_approval: { id: string; type: string; summary: string; amount: number | null; currency: string | null; initiator: string; created_at: string }[];
  assigned_discrepancies?: { id: string; type: string; subject_reference: string; difference: number | null; currency_code: string | null }[];
  earnings?: { period: string; scoped: boolean; rows: { currency: string; platform_revenue: number; margin: number }[] };
}
