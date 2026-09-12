/** Pure arithmetic shared by the notification formatter — inlined from the
 * web panel's strategyMath.ts, which the upstream 1.6.0 asset-view rewrite
 * deleted along with the strategy tab it shipped with. These two helpers are
 * all the server-side renderer used; keeping the whole panel file would drag
 * dead CostFlags/PerpEntryCostPart types that no longer exist in api/types. */

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** Fixed APY on capital, annualised from the strategy clock start — the
 * OWNED position's expected PnL expressed as a yearly return on the deployed
 * capital. Returns null when the clock or capital is unknowable (the card
 * hides the stat in exactly those cases). */
export function fixedAprOnCapital(
  expectedUsd: number | null,
  capitalUsd: number,
  clockStartSec: number | null,
  maturitySec: number,
): number | null {
  const lifeSeconds = clockStartSec === null ? null : maturitySec - clockStartSec;
  return lifeSeconds !== null && lifeSeconds > 0 && capitalUsd > 0 && expectedUsd !== null
    ? expectedUsd / (capitalUsd * (lifeSeconds / SECONDS_IN_YEAR))
    : null;
}
