/**
 * The web panel's OWN display implementations, re-exported for the
 * notification formatter.
 *
 * THE PANEL IS THE SOURCE OF TRUTH. Its numbers are (API payload + these
 * client-side transforms); importing the transforms verbatim is what makes the
 * TG message and the cards agree BY CONSTRUCTION instead of by vigilance —
 * the hand-copies this file replaces had already drifted twice.
 *
 * All four modules are pure (no browser APIs at module scope), so Node imports
 * them safely. The `as unknown as` casts at each boundary are the JSON
 * contract: web/src/api/types.ts hand-mirrors the server payload types, and a
 * route response is literally the object both sides read.
 */
export { toRows, maturityDays, venueKey, type OpportunityRow } from '../../../web/src/panels/opportunityFilters';
export { fixedAprOnCapital, SECONDS_IN_YEAR } from '../math';
export { fmtUsd, fmtNotionalShort, fmtTokenQty, fmtPct } from '../../../web/src/lib/fmt';
export { marginParts, type MarginParts } from '../../../web/src/lib/margin';
export type {
  OpportunityGroup as WebGroup,
  OpportunityPair as WebPair,
  OpportunitiesResult as WebOpportunitiesResult,
  CrossexAccount as WebAccount,
} from '../../../web/src/api/types';
