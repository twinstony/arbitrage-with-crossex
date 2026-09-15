/**
 * The positions source of the Telegram pulse: a self-call to THIS install's
 * GET /api/asset-view/:address — the same endpoint the web Positions cards
 * read.
 *
 * WHY asset-view and not the old strategy feed: upstream 1.6.0 replaced
 * routes/strategy.ts with routes/asset-view.ts (every perp and Boros leg
 * grouped by its underlying coin, lifetime sums straight from the venues).
 * The local 💼 section kept self-calling the deleted /api/strategy/:address,
 * so it answered HTTP 404 on EVERY pass and the section was dropped — the
 * operator's TG pulse carried no positions at all (580 logged 404s). The fix
 * is the endpoint; the shape of the section follows the payload.
 *
 * The call carries the install's API token and rides a DIRECT dispatcher: it
 * is loopback traffic to ourselves and must not be routed through the
 * outbound proxy the Boros reads need. `margin` comes from GET /api/account
 * and is cosmetic next to the positions — its own failure drops only the
 * health line, never the section.
 */
import { Agent, request } from 'undici';
import type { CrossexAccount } from '../../../web/src/api/types';
import type { AssetViewOut } from '../routes/assetView';

/** One positions read: the asset view the cards render, plus whatever margin
 * the account route answered (null when it failed or is absent). */
export interface PositionsSnapshot {
  view: AssetViewOut;
  /** The CrossEx margin the header strip renders as IM/MM donuts (the web's
   * own CrossexAccount contract) — null when the account read failed. */
  margin: CrossexAccount | null;
}

export interface PositionsReaderOptions {
  /** Origin of this very server, e.g. `http://10.0.0.138:6688` — the bound
   * host, never loopback (HOST may have moved the bind off it). */
  baseUrl: string;
  /** The Boros root the positions belong to (BOROS_ROOT_ADDRESS). */
  address: string;
  /** The install's API token (the self-call must authenticate like any other). */
  token: string;
  timeoutMs?: number;
}

/** Build the reader the scanner's positions section is fed from. Null when the
 * route answers nothing — the section is then omitted, never faked. */
export function makePositionsReader({
  baseUrl,
  address,
  token,
  timeoutMs = 30_000,
}: PositionsReaderOptions): () => Promise<PositionsSnapshot | null> {
  const dispatcher = new Agent();
  const call = async <T>(path: string): Promise<T | null> => {
    const res = await request(`${baseUrl}${path}`, {
      headers: { 'x-arb-token': token },
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.statusCode !== 200) {
      // Drain the body before throwing: an unconsumed response holds its
      // socket, and a 404 every five minutes would leak one per pass.
      await res.body.dump().catch(() => {});
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return ((await res.body.json()) as { data?: T }).data ?? null;
  };
  return async () => {
    const [view, margin] = await Promise.all([
      call<AssetViewOut>(`/api/asset-view/${address.toLowerCase()}`),
      call<CrossexAccount>('/api/account').catch(() => null),
    ]);
    return view ? { view, margin } : null;
  };
}
