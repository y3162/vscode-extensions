// Design B: record cursor/create_plan, answer cancelled, and start implementation only from Build.
// Spike on 2026-10-16: after session/set_mode plan, cancelled returned stopReason end_turn.
export const acpCreatePlanPolicy: 'release' | 'hold' = 'release';
export const acpCreatePlanReleaseOutcome: 'cancelled' | 'rejected' = 'cancelled';
