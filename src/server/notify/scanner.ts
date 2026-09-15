/**
 * The background opportunity scanner: a setTimeout-chained pass (same style as
 * engine/loop.ts — never setInterval, overlap impossible by construction) that
 * re-prices every Boros arb group through the SAME pipeline the
 * /api/opportunities route serves, then pushes the results out of band.
 *
 * THE WEB PANEL IS THE RANKING SOURCE OF TRUTH. The Telegram summary mirrors
 * web/src/panels/opportunityFilters.ts `toRows`: one row per viable PAIR (a
 * group with three markets offers three venue combinations), viable meaning a
 * finite, non-negative netFixedAprOnCapital, ranked by the same comparator
 * chain — capital APR desc, then notional APR, then exec spread, then gross
 * spread. The scanner must also be CALLED with the panel's default params
 * (`exitMode: 'roll'` — see the wiring in server/index.ts) or its numbers
 * silently diverge from the cards the operator compares them against.
 *
 *   - Telegram: a Top-N pair summary, EVERY pass (the operator asked for the
 *     full pulse, duplicates included).
 *   - fwalert webhook: only threshold crossings — a pair whose
 *     netFixedAprOnCapital rose to ≥ the configured threshold for the FIRST
 *     time (in-memory dedup; re-armed when it falls back below; a restart
 *     re-alerts currently-crossed pairs, which is the documented cost of not
 *     persisting dedup state).
 *
 * A failed or empty scan is SILENT on both channels — the notifications exist
 * to carry the positive signal "there is a worthwhile opportunity"; routing
 * infrastructure failures into them would drown that signal. Failures land in
 * the server log only.
 *
 * The crossing detection and both message formatters are pure and exported for
 * tests; startOpportunityScanner is the only stateful piece.
 */
import type { OpportunityGroup, OpportunityPair, OpportunitiesResult } from '../../core/boros/opportunities';
import {
  deriveAsset,
  fmtNotionalShort,
  fmtPct,
  fmtTokenQty,
  fmtUsd,
  marginParts,
  portfolioTotals,
  toRows,
  venueKey,
  type AssetBorosOpen,
  type AssetDerivedPair,
  type AssetGroup,
  type AssetViewOut,
  type AssetViewResponse,
  type HedgeGapRow,
  type WebAccount,
  type WebOpportunitiesResult,
} from './display';
import { readFwAlertConfig, sendFwAlert, type FwAlertConfig } from './fwalert';
import type { PositionsSnapshot } from './positions';
import { readTelegramConfig, sendTelegramMessage, type TelegramConfig } from './telegram';

export interface NotifyConfig {
  telegram: TelegramConfig | null;
  webhook: FwAlertConfig | null;
  /** Alert threshold as a decimal fraction (0.30 = 30%) on capital APR. */
  threshold: number;
  /** Scan cadence, ms. */
  intervalMs: number;
  /** The notional every scan prices at, USD. */
  notionalUsd: number;
}

/** Clamps so a typo can neither spin the scanner into a loop nor disable it. */
const MIN_INTERVAL_MS = 30_000;
const MIN_NOTIONAL_USD = 1_000;
const MAX_NOTIONAL_USD = 100_000_000;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_NOTIONAL_USD = 10_000;
/** The web panel's exitMode default — see the module comment. */
const PANEL_EXIT_MODE = 'roll' as const;

/**
 * Read the scanner config. Null when NEITHER channel is configured — the
 * scanner then never runs, so an install that only watches the web UI pays
 * nothing for this feature.
 */
export function readNotifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  const telegram = readTelegramConfig(env);
  const webhook = readFwAlertConfig(env);
  if (!telegram && !webhook) return null;
  const pct = Number(env.APR_ALERT_THRESHOLD_PCT);
  // Input is a percent (30 = 30%); internally everything is a fraction.
  const threshold = Number.isFinite(pct) && pct > 0 ? pct / 100 : DEFAULT_THRESHOLD;
  const sec = Number(env.APR_SCAN_INTERVAL_SECONDS);
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_INTERVAL_MS,
  );
  const n = Number(env.APR_SCAN_NOTIONAL_USD);
  const notionalUsd =
    Number.isFinite(n) && n >= MIN_NOTIONAL_USD && n <= MAX_NOTIONAL_USD ? n : DEFAULT_NOTIONAL_USD;
  return { telegram, webhook, threshold, intervalMs, notionalUsd };
}

/** The exitMode the scanner must price with so its numbers ARE the cards'. */
export const panelExitMode = (): 'roll' => PANEL_EXIT_MODE;

/** Stable per-pair identity — the same key the web panel's rows use. */
export function pairKey(group: OpportunityGroup, pair: OpportunityPair): string {
  return `${group.tokenId}:${group.maturity}:${pair.shortLeg.marketId}:${pair.longLeg.marketId}`;
}

/** One ranked row — the TG twin of the web panel's OpportunityRow. */
export interface RankedPair {
  group: OpportunityGroup;
  pair: OpportunityPair;
  /** netFixedAprOnCapital — finite and ≥ 0 by construction. */
  apr: number;
}

/**
 * Every viable pair across every group, best first — the panel's `toRows`
 * without the UI-only hysteresis band (that exists to stop cards flickering
 * under the reader's cursor; a push message has no such concern).
 *
 * Viable means the pair prices a real, non-negative net APR on capital: the
 * server still serves pairs whose inputs degraded to null and ones whose costs
 * swallow the whole spread, and neither belongs in a list of things worth
 * executing.
 */
export function rankPairs(result: OpportunitiesResult, topN: number): RankedPair[] {
  return toRows((result as unknown as WebOpportunitiesResult).groups).slice(0, topN) as unknown as RankedPair[];
}

/** All viable pairs (untruncated) — the header's "可交易 N" count. */
export function countViable(result: OpportunitiesResult): number {
  let n = 0;
  for (const group of result.groups) {
    for (const pair of group.pairs) {
      const apr = pair.netFixedAprOnCapital;
      if (apr !== null && Number.isFinite(apr) && apr >= 0) n += 1;
    }
  }
  return n;
}

/**
 * Pure crossing detector over PAIRS: which pairs newly crossed the threshold,
 * and the next dedup state. A pair above threshold never seen before is
 * notified and remembered; one back below threshold is re-armed (forgotten) —
 * a pair pricing a negative APR therefore re-arms too, exactly like the web
 * list dropping it. A pair with no capital APR (null) is invisible: only a
 * PRICED pair can alert.
 */
export function dedupeCrossings(
  alerted: ReadonlySet<string>,
  result: OpportunitiesResult,
  threshold: number,
): { notify: RankedPair[]; state: Set<string> } {
  const state = new Set(alerted);
  const notify: RankedPair[] = [];
  for (const group of result.groups) {
    for (const pair of group.pairs) {
      const apr = pair.netFixedAprOnCapital;
      if (apr === null || !Number.isFinite(apr)) continue;
      const key = pairKey(group, pair);
      if (apr >= threshold) {
        if (!state.has(key)) {
          state.add(key);
          notify.push({ group, pair, apr });
        }
      } else {
        state.delete(key); // re-arm
      }
    }
  }
  return { notify, state };
}

// ---- formatting (pure; exported for tests) ----

// Number formatting IS the web's fmt.ts (fmtUsd / fmtNotionalShort /
// fmtTokenQty / fmtPct) — imported through display.ts, never re-implemented.
const usd0 = (n: number): string => fmtUsd(n, 0);
const notionalShort = (n: number): string => fmtNotionalShort(n);

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad = (n: number): string => String(n).padStart(2, '0');
const maturityLabel = (maturitySec: number): string => {
  const d = new Date(maturitySec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const stamp = (now: Date): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

/** The notional bracket: non-USD collateral sizes in the token — "$10k (0.126 BTC)". */
function notionalLine(group: OpportunityGroup, notionalUsd: number): string {
  const base = notionalShort(notionalUsd);
  const isUsdCollateral = group.collateral === 'USDT' || group.collateral === 'USDC';
  if (isUsdCollateral || group.collateralPriceUsd === null || group.collateralPriceUsd <= 0) {
    return base;
  }
  return `${base} (${fmtTokenQty(notionalUsd / group.collateralPriceUsd, group.collateral)})`;
}

/** The five stat lines one pair renders as — shared by both channels. */
function pairLines(row: RankedPair, notionalUsd: number): string[] {
  const { group, pair, apr } = row;
  const days = Math.max(1, Math.round(group.secondsToMaturity / 86_400));
  const dot = apr >= 0 ? '🟢' : '🔴';
  const lines = [
    `${esc(group.underlying)} · ${maturityLabel(group.maturity)} 到期（${days} 天）`,
    `${dot} ${(apr * 100).toFixed(2)}% APR`,
    `SHORT · ${esc(pair.shortLeg.venue)} ｜ LONG · ${esc(pair.longLeg.venue)}`,
  ];
  const profit =
    pair.estProfitUsd === null ? '—' : usd0(pair.estProfitUsd);
  lines.push(
    `资金 ~${usd0(pair.capitalUsd ?? 0)} ｜ 预计收益 ${profit} ｜ 名义 ${notionalLine(group, notionalUsd)}`,
  );
  let extra =
    pair.netFixedApr === null
      ? '名义年化 —'
      : `名义年化 ${(pair.netFixedApr * 100).toFixed(2)}%`;
  if (pair.execSpreadApr !== null && pair.shortLeg.execApr !== null && pair.longLeg.execApr !== null) {
    extra += ` ｜ 锁定价差 ${(pair.execSpreadApr * 100).toFixed(2)}%` +
      `（空 ${(pair.shortLeg.execApr * 100).toFixed(2)}% ／ 多 ${(pair.longLeg.execApr * 100).toFixed(2)}%）`;
  }
  lines.push(extra);
  return lines;
}

/** The Telegram summary: Top-N pairs ranked exactly like the web panel, HTML.
 * Pairs whose venue pair + direction match a live, fully hedged bundle on the
 * account get the ♻️ badge (see rolloverKeysFrom): their perp legs are already
 * in place, so this is a zero-perp-fee rollover. */
export function formatTopSummary(
  ranked: RankedPair[],
  opts: {
    notionalUsd: number;
    now: Date;
    totalGroups: number;
    viable: number;
    rolloverKeys?: ReadonlySet<string>;
  },
): string {
  const lines: string[] = [
    `🎯 <b>Boros 套利机会 Top ${ranked.length}</b> · 名义 ${notionalShort(opts.notionalUsd)}`,
    `扫描 ${opts.totalGroups} 组 · 可交易 ${opts.viable} · ${stamp(opts.now)}`,
  ];
  ranked.forEach((row, i) => {
    const badge =
      opts.rolloverKeys?.has(
        rolloverKey(row.group.underlying, row.pair.shortLeg.venue, row.pair.longLeg.venue),
      ) === true
        ? ' ♻️ 可续期'
        : '';
    lines.push('', `${i + 1}. ${pairLines(row, opts.notionalUsd).join('\n   ')}${badge}`);
  });
  return lines.join('\n');
}

/** The fwalert alert body: every effective fact lives in this one field. */
export function formatAlertDetails(
  row: RankedPair,
  opts: { threshold: number; notionalUsd: number; now: Date },
): string {
  const { group, pair } = row;
  const lines = [
    `【Boros 套利机会告警】`,
    ...pairLines(row, opts.notionalUsd).map((l) => l),
    `阈值: ${(opts.threshold * 100).toFixed(2)}% APR on capital`,
    `触发时间: ${stamp(opts.now)}`,
  ];
  if (pair.reasons.length > 0) {
    lines.push(`备注: ${pair.reasons.join(' ')}`);
  }
  return lines.join('\n');
}

// ---- positions section (the web "Funding farm by asset" cards) ----

/** How many assets get a leg-by-leg block. Telegram caps a message at 4096
 * chars and the opportunity summary rides above this section; the payload
 * arrives biggest-footprint-first, so the cut keeps what the operator holds.
 * The rest are counted in one tail line, never silently dropped. */
const MAX_POSITION_ASSETS = 3;
/** Leg lines per asset — the same bound, for the same reason. */
const MAX_ASSET_LEGS = 6;

const signedUsd = (n: number): string => (n >= 0 ? `+${usd0(n)}` : usd0(n));

/** Boros platformName → the display name the web cards use. */
const VENUE_DISPLAY: Record<string, string> = {
  HYPERLIQUID: 'Hyperliquid',
  BINANCE: 'Binance',
  BYBIT: 'Bybit',
  GATE: 'Gate',
  OKX: 'OKX',
  KRAKEN: 'Kraken',
};
const venueDisplay = (venue: string): string => VENUE_DISPLAY[venue.trim().toUpperCase()] ?? venue;

/** The rollover key of a pair: underlying + both legs' venues, case-normalized.
 * A live bundle with the SAME key can hand its perp legs straight to this pair
 * at maturity — the zero-perp-fee rollover. */
export function rolloverKey(underlying: string, shortVenue: string, longVenue: string): string {
  return `${underlying}:${venueKey(shortVenue)}:${venueKey(longVenue)}`;
}

/**
 * The ♻️ key set read off the asset view.
 *
 * The old gate was the strategy feed's `hedgeChecks.fullyHedged` — only a
 * fully hedged book may lend its perp legs (a partial book's floating streams
 * are already spoken for). The asset view carries no strategy grouping, so the
 * gate is rebuilt from what it does carry: a (base, maturity) bundle holding
 * BOTH a Boros SHORT and a LONG leg on an asset whose derived book is
 * `perfect` (delta-neutral, every venue covered). A one-sided bundle, or one
 * on an uncovered venue, earns nothing.
 */
export function rolloverKeysFrom(view: AssetViewOut): Set<string> {
  const meta = view as unknown as AssetViewResponse;
  const keys = new Set<string>();
  for (const raw of view.assets) {
    const group = raw as unknown as AssetGroup;
    const derived = deriveAsset(group, {}, meta.sinceSec ?? 0, meta.nowSec);
    if (!derived.perfect) continue;
    const byMaturity = new Map<number, { short?: AssetBorosOpen; long?: AssetBorosOpen }>();
    for (const leg of group.borosOpen) {
      const bundle = byMaturity.get(leg.maturity) ?? {};
      if (leg.side === 'SHORT') bundle.short = leg;
      else bundle.long = leg;
      byMaturity.set(leg.maturity, bundle);
    }
    for (const bundle of byMaturity.values()) {
      if (bundle.short && bundle.long) {
        keys.add(rolloverKey(group.base, bundle.short.venue, bundle.long.venue));
      }
    }
  }
  return keys;
}

/** "8.30%" for a leg's rate, "—" when the venue sent none. */
const rate = (r: number | null | undefined): string =>
  r === null || r === undefined || !Number.isFinite(r) ? '—' : fmtPct(r);

/** The gap's ask, in the unit the book is judged in — mirrors the card's
 * gapAsk(): "LONG 0.0012 BTC perp". */
function gapAsk(gap: HedgeGapRow, base: string): string {
  const dir = gap.action.startsWith('long') ? 'LONG' : 'SHORT';
  const what = gap.leg === 'boros' ? 'YU（Boros）' : 'perp';
  const size = gap.unit === 'base' ? fmtTokenQty(gap.size, base) : usd0(gap.size);
  return `${dir} ${size} ${what}`;
}

const maturityWithDays = (maturitySec: number, nowSec: number): string =>
  `${maturityLabel(maturitySec)} 到期（${Math.max(0, Math.ceil((maturitySec - nowSec) / 86_400))} 天）`;

/**
 * The 💼 section: the web Positions (asset) cards in message form.
 *
 * Upstream 1.6.0 replaced the strategy feed with /api/asset-view — every leg
 * grouped by its underlying coin, the numbers the venues' own lifetime
 * records. The section reads that payload and runs the SAME derivation the
 * cards run (assetModel.deriveAsset + portfolioTotals, through display.ts), so
 * the message and the panel agree BY CONSTRUCTION instead of by vigilance.
 *
 * Two honest differences from the cards, both stated in the header: TG has no
 * per-asset start date and no exclusion controls (they are per-browser prefs),
 * so the section prices the whole life, uncut. Pure; exported for tests.
 */
export function formatPositionsSection(
  view: AssetViewOut,
  margin?: WebAccount | null,
): string {
  const meta = view as unknown as AssetViewResponse;
  const nowSec = meta.nowSec;
  const all: AssetDerivedPair[] = view.assets.map((raw) => {
    const group = raw as unknown as AssetGroup;
    return { group, derived: deriveAsset(group, {}, meta.sinceSec ?? 0, nowSec) };
  });
  if (all.length === 0) return '<b>💼 持仓汇总</b>\n当前无持仓';
  const interestUsd = meta.interest?.available === true ? meta.interest.paidUsd : 0;
  const totals = portfolioTotals(all, interestUsd, nowSec);
  const lines: string[] = [
    `<b>💼 持仓汇总</b>（${totals.carded.length} 个资产 · 全周期）`,
  ];
  const hedge =
    totals.gapCount === 0 && !totals.nonNeutral
      ? '✅ 已完全对冲'
      : [
          totals.gapCount > 0 ? `⚠️ ${totals.gapCount} 条腿待补` : '',
          totals.nonNeutral ? '⛔ perp 未中性' : '',
        ]
          .filter(Boolean)
          .join(' ');
  lines.push(
    `总 PnL ${signedUsd(totals.totalPnlUsd)}` +
      (totals.blendedApr === null ? '' : `（已实现 APR ≈ ${fmtPct(totals.blendedApr)}）`) +
      ` ｜ 资金 ~${usd0(totals.totalCapitalUsd)} ｜ 对冲 ${hedge}`,
  );
  // The payload's degradation reasons, verbatim — they say exactly why the
  // numbers below look odd (the cards print the same sentences).
  for (const w of (meta.warnings ?? []).slice(0, 3)) lines.push(`⚠️ ${esc(w)}`);
  // The CrossEx waterline: the same donut math the header strip uses.
  const m = margin ? marginParts(margin) : null;
  if (m?.hasFunds) {
    lines.push(
      `保证金 IM ${fmtPct(m.imPct, 0)} ｜ MM ${fmtPct(m.mmPct, 0)}` +
        `（可用 ${usd0(m.available)} / 余额 ${usd0(m.balance)} · 维持 ${usd0(m.maintenance)}）`,
    );
  }

  const live = totals.carded.filter((a) => a.group.perpOpen.length > 0 || a.group.borosOpen.length > 0);
  const history = totals.carded.filter((a) => !live.includes(a));
  live.slice(0, MAX_POSITION_ASSETS).forEach((a, i) => {
    const d = a.derived;
    const marker =
      d.gaps.length > 0 ? ` ⚠️ ${d.gaps.length} 条腿待补` : !d.deltaNeutral ? ' ⛔ perp 未中性' : ' ✅';
    lines.push(
      '',
      `${i + 1}. ${esc(a.group.base)}` +
        (a.group.priceUsd > 0 ? ` · ${fmtUsd(a.group.priceUsd, 0)}` : '') +
        marker,
      `   总 PnL ${signedUsd(d.totals.pnlUsd)}` +
        (d.roi === null ? '' : `（ROI ${fmtPct(d.roi)}）`) +
        ` ｜ Fixed APR ${d.lockedAprFwd === null ? '—' : fmtPct(d.lockedAprFwd)}` +
        (d.clockStartSec === null ? '' : ` ｜ 已运行 ${((nowSec - d.clockStartSec) / 86_400).toFixed(1)} 天`),
      `   资金 ~${usd0(d.totals.capitalUsd)}` +
        (d.totals.mtmUsd === 0 ? '' : ` ｜ MTM ${signedUsd(d.totals.mtmUsd)}`),
    );
    const legs: string[] = [];
    for (const l of a.group.borosOpen) {
      legs.push(
        `Boros ${l.side} · ${esc(venueDisplay(l.venue))} ${rate(l.entryApr)}` +
          ` ｜ 名义 ~${usd0(l.notionalUsd)} ｜ ${maturityWithDays(l.maturity, nowSec)}`,
      );
    }
    for (const p of a.group.perpOpen) {
      legs.push(
        `perp ${p.side} · ${esc(venueDisplay(p.venue))} ~${usd0(p.notionalUsd)}` +
          ` ｜ uPnL ${signedUsd(p.upnlUsd)} ｜ 资金 ${usd0(p.imUsd)}`,
      );
    }
    for (const leg of legs.slice(0, MAX_ASSET_LEGS)) lines.push(`   ${leg}`);
    if (legs.length > MAX_ASSET_LEGS) lines.push(`   …还有 ${legs.length - MAX_ASSET_LEGS} 条腿`);
    for (const g of d.gaps.slice(0, 2)) {
      lines.push(`   ⚠️ ${esc(venueDisplay(g.venue))}：加 ${gapAsk(g, a.group.base)}`);
    }
    if (d.gaps.length > 2) lines.push(`   ⚠️ 还有 ${d.gaps.length - 2} 处缺口`);
  });

  // What the message did not expand, named rather than dropped. The dust fold
  // is the panel's own (under $1 of history and nothing open): it is NOT in the
  // total, and the line says so.
  const rest = [
    live.length > MAX_POSITION_ASSETS
      ? `另有 ${live.length - MAX_POSITION_ASSETS} 个资产有持仓未展开（已计入总 PnL）`
      : '',
    history.length > 0
      ? `${history.map((a) => esc(a.group.base)).join('、')} 仅有历史（已计入总 PnL）`
      : '',
    totals.dust.length > 0
      ? `另有 ${totals.dust.length} 个资产无持仓、历史 < $1（未计入）`
      : '',
  ].filter(Boolean);
  if (rest.length > 0) lines.push('', `（${rest.join(' ｜ ')}）`);
  return lines.join('\n');
}

// ---- the runtime loop ----

export interface ScannerDeps {
  config: NotifyConfig;
  /** One full scan — the same pipeline /api/opportunities serves. */
  scan: () => Promise<OpportunitiesResult>;
  /** The operator's positions — the same /api/asset-view payload the web cards
   * render (wired in server/index.ts as a self-call with the install's API
   * token). Absent (no BOROS_ROOT_ADDRESS) → the 💼 section is omitted. */
  scanPositions?: () => Promise<PositionsSnapshot | null>;
  /** Overridable senders (tests); default to the real channels. */
  sendTelegram?: (text: string) => Promise<boolean>;
  sendWebhook?: (details: string, coin: string) => Promise<boolean>;
  log?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
}

/** How soon a DEGRADED pass is retried (see scanPass's return), and how many
 * early retries one degradation may burn before the chain falls back to the
 * regular cadence — a dead upstream must not be polled at 60s forever. */
const DEGRADED_RETRY_MS = 60_000;
const MAX_DEGRADED_RETRIES = 5;

/**
 * One scanner pass. Exported so tests drive rounds without timers; the caller
 * owns the dedup state (the startOpportunityScanner chain keeps one).
 *
 * Returns whether the pass "settled": true means the next pass should run on
 * the regular cadence — either the pulse went out, or the market genuinely
 * prices nothing viable (a real state, not a bug). False means the scan was
 * DEGRADED (failed, empty, or every pair unpriced — the cold-boot burst),
 * which is worth retrying SOON: waiting the full interval to learn the boot
 * warm-up finished stretches the first pulse to ten minutes for nothing.
 */
export async function scanPass(deps: ScannerDeps, alerted: Set<string>): Promise<boolean> {
  const { config } = deps;
  const log = deps.log ?? console.log;
  const error =
    deps.error ??
    ((msg, err) => console.error(err ? `${msg}: ${(err as Error).message}` : msg));
  let result: OpportunitiesResult;
  try {
    result = await deps.scan();
  } catch (err) {
    error(`[notify] scan failed — notifications skipped this round`, err);
    return false;
  }
  if (result.groups.length === 0) {
    // An empty market view is either a real empty board or a degraded scan;
    // both would be noise on the notification channels.
    error(
      `[notify] scan returned no groups (${result.warnings.length} warnings) — skipping notifications`,
    );
    return false;
  }
  // Degraded vs real: if NO pair priced a capital APR anywhere, the inputs
  // (leverage caps, books) didn't arrive — the cold-boot burst — and a retry
  // will almost certainly price. If pairs priced but none is viable, the
  // market genuinely offers nothing worth executing; that is a message-silent
  // but SETTLED state, not an error to chase.
  const priced = result.groups.reduce(
    (n, g) =>
      n + g.pairs.filter((p) => p.netFixedAprOnCapital !== null && Number.isFinite(p.netFixedAprOnCapital)).length,
    0,
  );
  if (priced === 0) {
    error(`[notify] scan priced 0 of ${result.groups.length} groups — degraded, retrying early`);
    return false;
  }
  const now = new Date();
  if (config.telegram) {
    const ranked = rankPairs(result, 5);
    // A summary with no PRICED pair is noise, not information: a cold-boot
    // scan (Gate rules, leverage and the venues' books still warming up) can
    // yield groups but no capital APR. Sending "Top 0" teaches the operator
    // to ignore the channel; staying silent until the pipeline prices
    // something does not lose anything — the next pass is intervalMs away.
    if (ranked.length === 0) {
      error(`[notify] no viable pairs (${result.groups.length} groups) — telegram summary skipped`);
    } else {
      // The positions read comes FIRST: its fully-hedged strategies decide
      // which pairs earn the ♻️ rollover badge. Its own failure costs only
      // the section + the badges — the opportunities part still goes.
      let positions: PositionsSnapshot | null = null;
      let rollover: ReadonlySet<string> | undefined;
      if (deps.scanPositions) {
        try {
          positions = await deps.scanPositions();
          if (positions) rollover = rolloverKeysFrom(positions.view);
        } catch (err) {
          error('[notify] positions summary failed — section skipped', err);
        }
      }
      let text = formatTopSummary(ranked, {
        notionalUsd: config.notionalUsd,
        now,
        totalGroups: result.groups.length,
        viable: countViable(result),
        rolloverKeys: rollover,
      });
      if (positions) {
        text += `\n\n──────────────\n\n${formatPositionsSection(positions.view, positions.margin)}`;
      }
      const ok = await (deps.sendTelegram ?? ((t) => sendTelegramMessage(config.telegram!, t)))(text);
      if (!ok) error('[notify] telegram send failed');
      else log(`[notify] telegram summary sent (${ranked.length} of ${countViable(result)} viable pairs)`);
    }
  }
  if (config.webhook) {
    const { notify, state } = dedupeCrossings(alerted, result, config.threshold);
    state.forEach((k) => alerted.add(k));
    for (const k of [...alerted]) if (!state.has(k)) alerted.delete(k);
    const send = deps.sendWebhook ?? ((d, c) => sendFwAlert(config.webhook!, d, c));
    for (const row of notify) {
      const details = formatAlertDetails(row, {
        threshold: config.threshold,
        notionalUsd: config.notionalUsd,
        now,
      });
      const coin = `${row.group.underlying}-${maturityLabel(row.group.maturity)}`;
      const ok = await send(details, coin);
      if (!ok) error(`[notify] webhook send failed for ${pairKey(row.group, row.pair)}`);
      else log(`[notify] threshold alert sent for ${pairKey(row.group, row.pair)}`);
    }
  }
  return true;
}

/**
 * The production chain: the first pass waits out a short boot grace — the
 * first moments after listen are a cold burst (Gate rules, leverage, every
 * venue book fetched at once) that regularly yields zero PRICED pairs, and
 * the skip rule would then eat the boot pulse. 30s in, the same scan prices
 * fine. Then every intervalMs. Returns a stopper for tests; the server never
 * stops it.
 */
const BOOT_FIRST_DELAY_MS = 30_000;

export function startOpportunityScanner(deps: ScannerDeps): { stop: () => void } {
  const alerted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let degradedRetries = 0;
  const schedule = (ms: number): void => {
    timer = setTimeout(() => {
      void scanPass(deps, alerted)
        .then((settled) => {
          if (settled) {
            degradedRetries = 0;
            return deps.config.intervalMs;
          }
          degradedRetries += 1;
          return degradedRetries >= MAX_DEGRADED_RETRIES ? deps.config.intervalMs : DEGRADED_RETRY_MS;
        })
        .then((delay) => {
          if (!stopped) schedule(delay);
        });
    }, ms);
  };
  schedule(BOOT_FIRST_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
