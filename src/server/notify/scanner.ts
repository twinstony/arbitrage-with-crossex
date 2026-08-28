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
  fmtNotionalShort,
  fmtPct,
  fmtTokenQty,
  fmtUsd,
  fixedAprOnCapital,
  marginParts,
  toRows,
  type MarginParts,
  type WebOpportunitiesResult,
} from './display';
import { readFwAlertConfig, sendFwAlert, type FwAlertConfig } from './fwalert';
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

/** The Telegram summary: Top-N pairs ranked exactly like the web panel, HTML. */
export function formatTopSummary(
  ranked: RankedPair[],
  opts: { notionalUsd: number; now: Date; totalGroups: number; viable: number },
): string {
  const lines: string[] = [
    `🎯 <b>Boros 套利机会 Top ${ranked.length}</b> · 名义 ${notionalShort(opts.notionalUsd)}`,
    `扫描 ${opts.totalGroups} 组 · 可交易 ${opts.viable} · ${stamp(opts.now)}`,
  ];
  ranked.forEach((row, i) => {
    lines.push('', `${i + 1}. ${pairLines(row, opts.notionalUsd).join('\n   ')}`);
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

// ---- positions section (Boros strategies) ----

/** Structural subset of GET /api/strategy/:address — only what the message
 * renders. Built by the scanner's own call to its own API, so the numbers are
 * the web Positions cards' to the digit. */
export interface StrategyLegLite {
  kind: string;
  side: string;
  venue: string;
  notionalUsd: number;
  entryApr?: number;
}

export interface StrategySummary {
  strategies: Array<{
    strategyId: string;
    base: string;
    maturity: number;
    secondsToMaturity: number;
    hedge: string;
    notionalMismatchUsd: number;
    legs: StrategyLegLite[];
    capitalUsd: number;
    capitalSplit: { perpUsd: number; borosUsd: number };
    realizedPnlUsd: number;
    spread: number;
    lockedAprOnCapital: number;
    expectedPnlToMaturityUsd: number | null;
    elapsedSeconds: number | null;
    /** The spread-lock clock's start — the hero Fixed APY annualizes over the
     * FULL trade life (start → maturity), exactly like StrategyCard. */
    clockStartSec: number | null;
    /** The sizing gate. When false the web card HIDES the headline numbers
     * (a full-life projection on half the notional reads as a great trade);
     * the message must hide them too. */
    hedgeChecks: { fullyHedged: boolean };
  }>;
  /** Degrade reasons from the strategy route ("Couldn't load Gate positions…").
   * Rendered verbatim — they say exactly why the numbers below look odd. */
  warnings?: string[];
  totals: {
    capitalUsd: number;
    realizedPnlUsd: number;
    expectedPnlToMaturityUsd: number;
    strategyCount: number;
  };
}

/** Structural subset of GET /api/account — the CrossEx margin health the
 * web header strip renders as the IM/MM donuts. */
export interface MarginLite {
  marginBalance: number;
  initialMargin: number;
  maintenanceMargin: number;
  availableMargin: number;
}

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

/** The HedgeChip, as text: the risk marker rides the hero line. Mirrors
 * StrategyCard's HedgeChip order — matured wins, then hedge state. */
function hedgeMarker(s: StrategySummary['strategies'][number]): string {
  if (s.maturity > 0 && s.secondsToMaturity === 0) return ' 🕐 matured';
  if (s.hedge === 'hedged') return '';
  if (s.hedge === 'partial') return ' ⚠️ partial hedge';
  return ' ⛔ unhedged';
}

/** The 💼 section appended under the opportunities. Pure; exported for tests.
 *
 * The hero APR is the web card's Fixed APY: expectedPnlToMaturityUsd
 * (already net of every cost the panel's default flags charge) annualized on
 * capital over the FULL trade life, start → maturity — NOT lockedAprOnCapital,
 * which is the spread-based reading and reads higher. */
export function formatPositionsSection(
  s: StrategySummary,
  margin?: MarginLite,
): string {
  const signedUsd = (n: number): string => (n >= 0 ? `+${usd0(n)}` : usd0(n));
  if (s.strategies.length === 0) {
    return '<b>💼 Boros 持仓</b>\n当前无 Boros 持仓';
  }
  const lines: string[] = [
    `<b>💼 Boros 持仓汇总</b>（${s.totals.strategyCount} 个策略）`,
    `资金 ~${usd0(s.totals.capitalUsd)} ｜ PnL now ${signedUsd(s.totals.realizedPnlUsd)}` +
      ` ｜ 到期预期 ${signedUsd(s.totals.expectedPnlToMaturityUsd)}`,
  ];
  for (const w of s.warnings ?? []) {
    lines.push(`⚠️ ${esc(w)}`);
  }
  if (margin && margin.marginBalance > 0) {
    // The web donut's own math (MarginDonut → marginParts), imported verbatim.
    const p: MarginParts = marginParts(margin as never);
    lines.push(
      `保证金 IM ${fmtPct(p.imPct, 0)} ｜ MM ${fmtPct(p.mmPct, 0)}` +
        `（可用 ${usd0(p.available)} / 余额 ${usd0(p.balance)} · 维持 ${usd0(p.maintenance)}）`,
    );
  }
  s.strategies.forEach((st, i) => {
    const days = Math.max(1, Math.round(st.secondsToMaturity / 86_400));
    const boros = st.legs.filter((l) => l.kind === 'boros');
    const short = boros.find((l) => l.side === 'SHORT');
    const long = boros.find((l) => l.side === 'LONG');
    // THE SIZING GATE, mirroring StrategyCard: until the position is fully
    // hedged the headline numbers (Fixed APY / PnL at maturity / Capital) are
    // confidently wrong — a full-life projection on half the notional reads as
    // a great trade — so the web card hides them and shows the hedge cue
    // instead. PnL now stays: real cash + MtM whatever the book's shape.
    const fullyHedged = st.hedgeChecks?.fullyHedged ?? false;
    const fixedApr = fullyHedged
      ? fixedAprOnCapital(st.expectedPnlToMaturityUsd, st.capitalUsd, st.clockStartSec, st.maturity)
      : null;
    lines.push(
      '',
      `${i + 1}. ${esc(st.base)} · ${maturityLabel(st.maturity)} 到期（${days} 天）${hedgeMarker(st)}`,
      `   ${
        fixedApr === null
          ? `⚪ Fixed APY —（${fullyHedged ? '时钟或资金未知' : '对冲不完整，数字已隐藏'}）`
          : `${fixedApr >= 0 ? '🟢' : '🔴'} Fixed APY ${fmtPct(fixedApr)}`
      }`,
    );
    if (short && long && short.entryApr !== undefined && long.entryApr !== undefined) {
      lines.push(
        `   SHORT · ${esc(venueDisplay(short.venue))} ${(short.entryApr * 100).toFixed(2)}%` +
          ` ｜ LONG · ${esc(venueDisplay(long.venue))} ${(long.entryApr * 100).toFixed(2)}%`,
        `   锁定价差 ${(st.spread * 100).toFixed(2)}% ｜ 名义 ~${usd0(short.notionalUsd)}/腿`,
      );
    }
    if (fullyHedged) {
      lines.push(
        `   资金 ~${usd0(st.capitalUsd)}（perp ${usd0(st.capitalSplit.perpUsd)} + Boros ${usd0(st.capitalSplit.borosUsd)}）`,
      );
    }
    lines.push(
      `   PnL now ${signedUsd(st.realizedPnlUsd)}` +
        (fullyHedged && st.expectedPnlToMaturityUsd !== null
          ? ` ｜ 到期预期 ${signedUsd(st.expectedPnlToMaturityUsd)}`
          : '') +
        (st.elapsedSeconds === null ? '' : ` ｜ 已运行 ${(st.elapsedSeconds / 86_400).toFixed(1)} 天`),
    );
  });
  return lines.join('\n');
}

// ---- the runtime loop ----

export interface ScannerDeps {
  config: NotifyConfig;
  /** One full scan — the same pipeline /api/opportunities serves. */
  scan: () => Promise<OpportunitiesResult>;
  /** The operator's Boros strategies — the same pipeline /api/strategy serves
   * (wired in server/index.ts as a self-call with the install's API token).
   * Absent (no BOROS_ROOT_ADDRESS) → the 💼 section is omitted entirely. */
  scanStrategy?: () => Promise<{
    strategy: StrategySummary;
    margin?: MarginLite | null;
  } | null>;
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
      let text = formatTopSummary(ranked, {
        notionalUsd: config.notionalUsd,
        now,
        totalGroups: result.groups.length,
        viable: countViable(result),
      });
      // The positions section rides the SAME message (one pulse). Its own
      // failure costs only the section — the opportunities part still goes.
      if (deps.scanStrategy) {
        try {
          const positions = await deps.scanStrategy();
          if (positions) {
            text += `\n\n──────────────\n\n${formatPositionsSection(positions.strategy, positions.margin ?? undefined)}`;
          }
        } catch (err) {
          error('[notify] positions summary failed — section skipped', err);
        }
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
