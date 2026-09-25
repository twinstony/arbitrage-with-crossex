/**
 * The opportunity notification scanner (server/notify).
 *
 * The contract worth pinning: the TG summary is the web panel's pair list in
 * message form — one row per viable PAIR, ranked by the SAME comparator chain
 * as web/src/panels/opportunityFilters.ts `toRows`, viability = finite and
 * non-negative capital APR. Telegram gets a Top-5 EVERY pass, the fwalert
 * webhook only on FIRST threshold crossings (re-armed below), a failed or
 * empty scan is silent on both channels, and neither channel can take the
 * scanner down.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  OpportunityGroup,
  OpportunityPair,
  OpportunitiesResult,
} from '../../src/core/boros/opportunities';
import { readFwAlertConfig } from '../../src/server/notify/fwalert';
import {
  countViable,
  dedupeCrossings,
  formatAlertDetails,
  formatPositionsSection,
  formatTopSummary,
  pairKey,
  rankPairs,
  readNotifyConfig,
  rolloverKey,
  rolloverKeysFrom,
  scanPass,
  startOpportunityScanner,
} from '../../src/server/notify/scanner';
import type { PositionsSnapshot } from '../../src/server/notify/positions';
import type { AssetGroup, AssetViewResponse, CrossexAccount } from '../../web/src/api/types';
import { readTelegramConfig } from '../../src/server/notify/telegram';

function makePair(over: Partial<OpportunityPair> = {}): OpportunityPair {
  const leg = (venue: string, execApr: number | null, midApr: number, marketId: number, settleFeeApr = 0.001) => ({
    marketId,
    venue,
    crossexVenue: venue,
    crossexSymbol: `${venue}_BTCUSDT`,
    base: 'BTC',
    midApr,
    execApr,
    settleFeeApr,
  });
  return {
    base: 'BTC',
    shortLeg: leg('BINANCE', 0.082, 0.081, 1, 0.001),
    longLeg: leg('BYBIT', 0.031, 0.032, 2, 0.001),
    grossSpreadApr: 0.049,
    execSpreadApr: 0.051,
    borosImpactApr: -0.002,
    makerLeg: null,
    costs: {
      borosTakerFeeUsd: 10,
      borosSettleFeeUsd: 20,
      perpEntryFeesUsd: 5,
      perpEntrySlippageUsd: 3,
      perpExitFeesUsd: 0,
      perpExitSlippageUsd: 0,
      totalUsd: 46,
      annualizedApr: 0.0159,
    },
    capital: {
      borosShortImUsd: 500,
      borosLongImUsd: 500,
      perpShortImUsd: 1000,
      perpLongImUsd: 1000,
      shortLeverageMax: 10,
      longLeverageMax: 10,
    },
    capitalUsd: 3000,
    netFixedApr: 0.123,
    netFixedAprOnCapital: 0.3452,
    effectiveLeverage: 3.33,
    estProfitUsd: 1234,
    secondsToMaturity: 2_592_000,
    reasons: [],
    ...over,
  };
}

let marketSeq = 10;
let groupSeq = 0;
function makeGroup(pairs: number[], over: Partial<OpportunityGroup> = {}): OpportunityGroup {
  groupSeq += 1;
  const built = pairs.map((apr) => {
    marketSeq += 2;
    return makePair({
      netFixedAprOnCapital: apr,
      shortLeg: { ...(apr === null ? makePair().shortLeg : makePair().shortLeg), marketId: marketSeq },
      longLeg: { ...makePair().longLeg, marketId: marketSeq + 1 },
    });
  });
  return {
    tokenId: groupSeq,
    collateral: 'USDT',
    collateralPriceUsd: 1,
    maturity: 1788480000,
    secondsToMaturity: 2_592_000,
    underlying: 'BTC',
    markets: [],
    pairs: built,
    bestPair: built[0] ?? null,
    warnings: [],
    ...over,
  };
}

function makeResult(groups: OpportunityGroup[], warnings: string[] = []): OpportunitiesResult {
  return {
    groups,
    meta: {
      asOfSec: 0,
      notionalUsd: 10_000,
      borosEntry: 'market',
      entryMode: 'both-market',
      exitMode: 'roll',
    },
    warnings,
  };
}

describe('readNotifyConfig', () => {
  it('is null when neither channel is configured', () => {
    expect(readNotifyConfig({})).toBeNull();
    expect(readNotifyConfig({ TG_ENABLED: '0', TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' })).toBeNull();
  });

  it('enables Telegram only with BOTH token and chat id', () => {
    // A webhook keeps the config non-null, isolating the Telegram decision.
    const env = { APR_ALERT_WEBHOOK_URL: 'u' };
    expect(readNotifyConfig({ ...env, TG_BOT_TOKEN: 't' })?.telegram).toBeNull();
    expect(readNotifyConfig({ ...env, TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' })?.telegram).not.toBeNull();
  });

  it('reads the webhook url and applies the documented defaults', () => {
    const cfg = readNotifyConfig({ APR_ALERT_WEBHOOK_URL: 'https://fwalert.com/x' })!;
    expect(cfg.webhook).toEqual({ url: 'https://fwalert.com/x' });
    expect(cfg.telegram).toBeNull();
    expect(cfg.threshold).toBe(0.3);
    expect(cfg.intervalMs).toBe(300_000);
    expect(cfg.notionalUsd).toBe(10_000);
  });

  it('converts the percent threshold to a fraction and clamps the interval', () => {
    const cfg = readNotifyConfig({
      APR_ALERT_WEBHOOK_URL: 'u',
      APR_ALERT_THRESHOLD_PCT: '30',
      APR_SCAN_INTERVAL_SECONDS: '5', // below the 30s floor
      APR_SCAN_NOTIONAL_USD: 'not-a-number',
    })!;
    expect(cfg.threshold).toBe(0.3);
    expect(cfg.intervalMs).toBe(30_000);
    expect(cfg.notionalUsd).toBe(10_000);
  });
});

describe('readTelegramConfig / readFwAlertConfig', () => {
  it('refuses a half-configured Telegram channel', () => {
    expect(readTelegramConfig({ TG_BOT_TOKEN: 't' })).toBeNull();
    expect(readTelegramConfig({ TG_CHAT_ID: 'c' })).toBeNull();
  });

  it('honours TG_ENABLED=0 even with a full config', () => {
    expect(readTelegramConfig({ TG_ENABLED: '0', TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' })).toBeNull();
  });

  it('reads the fwalert url, blank is unconfigured', () => {
    expect(readFwAlertConfig({ APR_ALERT_WEBHOOK_URL: ' https://fwalert.com/x ' })).toEqual({
      url: 'https://fwalert.com/x',
    });
    expect(readFwAlertConfig({})).toBeNull();
    expect(readFwAlertConfig({ APR_ALERT_WEBHOOK_URL: '  ' })).toBeNull();
  });
});

describe('rankPairs — the panel pairing, viability and ordering', () => {
  it('flattens ALL pairs of a group, not just the best', () => {
    // One group, three viable pairs — the web list serves all three cards.
    const rows = rankPairs(makeResult([makeGroup([0.1, 0.05, 0.02])]), 5);
    expect(rows).toHaveLength(3);
  });

  it('applies the viability rule: null and negative capital APRs are out', () => {
    const rows = rankPairs(makeResult([makeGroup([0.1, -0.01]), makeGroup([])]), 5);
    expect(rows).toHaveLength(1);
    expect(countViable(makeResult([makeGroup([0.1, -0.01]), makeGroup([])]))).toBe(1);
  });

  it('ranks by capital APR desc, then the panel tiebreak chain', () => {
    const rows = rankPairs(
      makeResult([
        makeGroup([0.1]), // group 1: best pair 10%
        makeGroup([0.3, 0.2]), // group 2: 30% and 20%
      ]),
      5,
    );
    expect(rows.map((r) => r.apr)).toEqual([0.3, 0.2, 0.1]);
  });

  it('slices to topN AFTER ranking', () => {
    const rows = rankPairs(makeResult([makeGroup([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])]), 5);
    expect(rows).toHaveLength(5);
    expect(rows[0].apr).toBe(0.6);
  });

  it('keys pairs by group + the two Boros markets', () => {
    const [g] = makeResult([makeGroup([0.1, 0.2])]).groups;
    const [p1, p2] = g.pairs;
    expect(pairKey(g, p1)).not.toBe(pairKey(g, p2));
    expect(pairKey(g, p1)).toBe(`${g.tokenId}:${g.maturity}:${p1.shortLeg.marketId}:${p1.longLeg.marketId}`);
  });
});

describe('dedupeCrossings — per PAIR, first crossing only, re-armed below', () => {
  it('notifies the first crossing, then stays quiet while it holds', () => {
    const result = makeResult([makeGroup([0.35])]);
    const first = dedupeCrossings(new Set(), result, 0.3);
    expect(first.notify).toHaveLength(1);
    const second = dedupeCrossings(first.state, result, 0.3);
    expect(second.notify).toHaveLength(0);
  });

  it('re-arms after the APR falls back below the threshold', () => {
    // Same group object, mutated in place — the pair identity must be stable
    // across scans for the re-arm to mean anything.
    const g = makeGroup([0.35]);
    const first = dedupeCrossings(new Set(), makeResult([g]), 0.3);
    expect(first.notify).toHaveLength(1);
    g.pairs[0].netFixedAprOnCapital = 0.25;
    const armed = dedupeCrossings(first.state, makeResult([g]), 0.3);
    expect(armed.notify).toHaveLength(0);
    expect(armed.state.size).toBe(0);
    g.pairs[0].netFixedAprOnCapital = 0.35;
    const again = dedupeCrossings(armed.state, makeResult([g]), 0.3);
    expect(again.notify).toHaveLength(1);
  });

  it('tracks pairs INDEPENDENTLY within one group', () => {
    // Pair A crossed long ago; pair B crossing now must still alert.
    const g = makeGroup([0.35, 0.32]);
    const onlyFirst = { ...g, pairs: [g.pairs[0]] }; // same pair identity
    const first = dedupeCrossings(new Set(), makeResult([onlyFirst]), 0.3);
    expect(first.notify).toHaveLength(1);
    const both = dedupeCrossings(first.state, makeResult([g]), 0.3);
    expect(both.notify).toHaveLength(1);
    expect(both.notify[0].pair).toBe(g.pairs[1]);
  });

  it('ignores pairs with no priced capital APR', () => {
    const g = makeGroup([null as unknown as number]);
    const out = dedupeCrossings(new Set(), makeResult([g]), 0.3);
    expect(out.notify).toHaveLength(0);
    expect(out.state.size).toBe(0);
  });
});

describe('formatTopSummary', () => {
  it('renders the card fields: hero APR, legs, capital/return/notional, extras', () => {
    const g = makeGroup([0.3452], {
      underlying: 'BTC',
      maturity: 1790294400,
      collateral: 'BTC',
      collateralPriceUsd: 79_365,
    });
    g.pairs[0].estProfitUsd = 1234;
    const text = formatTopSummary(rankPairs(makeResult([g]), 5), {
      notionalUsd: 10_000,
      now: new Date('2026-08-28T09:00:00Z'),
      totalGroups: 6,
      viable: 11,
    });
    expect(text).toContain('<b>Boros 套利机会 Top 1</b> · 名义 $10k');
    expect(text).toContain('扫描 6 组 · 可交易 11');
    expect(text).toContain('BTC · 2026-09-25 到期（30 天）');
    expect(text).toContain('34.52% APR');
    expect(text).toContain('SHORT · BINANCE ｜ LONG · BYBIT');
    expect(text).toContain('~$3,000');
    expect(text).toContain('$1,234');
    expect(text).toContain('名义 $10k (0.126 BTC)'); // non-USD collateral bracket
    expect(text).toContain('名义年化 12.30%');
    expect(text).toContain('锁定价差 5.10%（空 8.20% ／ 多 3.10%）');
  });

  it('keeps USDT-collateral notionals pure-dollar', () => {
    // Viability excludes negative APRs, so the summary only ever shows
    // 🟢 rows — a USDT group just never grows a token bracket.
    const g = makeGroup([0.0123], { underlying: 'ETH' });
    const text = formatTopSummary(rankPairs(makeResult([g]), 5), {
      notionalUsd: 10_000,
      now: new Date(),
      totalGroups: 1,
      viable: 1,
    });
    expect(text).toContain('🟢 1.23% APR');
    expect(text).toContain('｜ 名义 $10k');
    expect(text).not.toContain('(');
  });

  it('badges pairs whose venue pair + direction match an open strategy (♻️ rollover)', () => {
    // Open strategy: SHORT HYPERLIQUID / LONG OKX. A pair on the SAME venue
    // pair + direction is the zero-perp-fee rollover; anything else is not.
    const matching = makeGroup([0.2], {
      underlying: 'BTC',
    });
    matching.pairs[0].shortLeg.venue = 'Hyperliquid';
    matching.pairs[0].longLeg.venue = 'OKX';
    const other = makeGroup([0.1]); // BINANCE/BYBIT — no match
    const text = formatTopSummary(rankPairs(makeResult([matching, other]), 5), {
      notionalUsd: 10_000,
      now: new Date(),
      totalGroups: 2,
      viable: 2,
      rolloverKeys: new Set(['BTC:HYPERLIQUID:OKX']),
    });
    const matchingBlock = text.split('\n\n').find((b) => b.includes('Hyperliquid ｜ LONG · OKX')) ?? '';
    expect(matchingBlock).toContain('♻️ 可续期');
    const otherBlock = text.split('\n\n').find((b) => b.includes('SHORT · BINANCE')) ?? '';
    expect(otherBlock).not.toContain('♻️');
  });

  it('escapes HTML-significant characters in upstream venue strings', () => {
    const g = makeGroup([0.35]);
    g.pairs[0].shortLeg.venue = 'A<B>&C';
    const text = formatTopSummary(rankPairs(makeResult([g]), 5), {
      notionalUsd: 10_000,
      now: new Date(),
      totalGroups: 1,
      viable: 1,
    });
    expect(text).toContain('A&lt;B&gt;&amp;C');
    expect(text).not.toContain('A<B>&C');
  });
});

describe('formatAlertDetails', () => {
  it('carries every effective fact in the details body', () => {
    const g = makeGroup([0.3452]);
    const details = formatAlertDetails({ group: g, pair: g.pairs[0], apr: 0.3452 }, {
      threshold: 0.3,
      notionalUsd: 10_000,
      now: new Date(),
    });
    expect(details).toContain('34.52% APR');
    expect(details).toContain('SHORT · BINANCE');
    expect(details).toContain('阈值: 30.00% APR on capital');
    expect(details).toContain('$1,234');
    expect(details).toContain('锁定价差 5.10%');
  });
});

// ---- positions section ----

const NOW_SEC = 1_790_000_000;
const DAY_SEC = 86_400;

/**
 * One ETH book, hand-derived: Boros SHORT Hyperliquid 10% / LONG Gate 4% on
 * $20k a leg (settle fee 0.1% APR, both legs 30 days out), hedged by a matching
 * perp pair, 120/−20 of settled history, capital $2,400, 180 days of clock.
 *
 * The expectations below are HAND-DERIVED from these numbers on purpose —
 * do not compute them with the model under test.
 */
function makeAssetGroup(over: Partial<AssetGroup> = {}): AssetGroup {
  const maturity = NOW_SEC + 30 * DAY_SEC;
  return {
    base: 'ETH',
    supported: true,
    priceUsd: 2000,
    earliestSec: NOW_SEC - 180 * DAY_SEC,
    perpOpen: [
      {
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        venue: 'HYPERLIQUID',
        side: 'SHORT',
        qty: 10,
        notionalUsd: 20_000,
        entryPrice: 2000,
        markPrice: 2000,
        leverage: 25,
        upnlUsd: 100,
        fundingUsd: 40,
        feesUsd: 10,
        imUsd: 800,
        openedAt: NOW_SEC - 180 * DAY_SEC,
      },
      {
        symbol: 'GATE_FUTURE_ETH_USDT',
        venue: 'GATE',
        side: 'LONG',
        qty: 10,
        notionalUsd: 20_000,
        entryPrice: 2000,
        markPrice: 2000,
        leverage: 25,
        upnlUsd: -90,
        fundingUsd: 30,
        feesUsd: 10,
        imUsd: 900,
        openedAt: NOW_SEC - 180 * DAY_SEC,
      },
    ],
    perpClosed: [],
    borosOpen: [
      {
        marketId: 201,
        venue: 'HYPERLIQUID',
        maturity,
        collateral: 'USDT',
        side: 'SHORT',
        sizeToken: 10,
        notionalUsd: 20_000,
        entryApr: 0.1,
        markApr: 0.095,
        floatingApr: 0.09,
        settleUsd: 120,
        mtmUsd: 50,
        imUsd: 400,
        settleFeeApr: 0.001,
      },
      {
        marketId: 205,
        venue: 'GATE',
        maturity,
        collateral: 'USDT',
        side: 'LONG',
        sizeToken: 10,
        notionalUsd: 20_000,
        entryApr: 0.04,
        markApr: 0.041,
        floatingApr: 0.09,
        settleUsd: -20,
        mtmUsd: -20,
        imUsd: 300,
        settleFeeApr: 0.001,
      },
    ],
    borosHistory: [
      {
        marketId: 201,
        venue: 'HYPERLIQUID',
        maturity,
        settleUsd: 120,
        settleFeeUsd: 12,
        tradePnlUsd: 0,
        tradeFeeUsd: 0,
        firstEventSec: NOW_SEC - 180 * DAY_SEC,
        entryApr: 0.1,
        side: 'SHORT',
      },
      {
        marketId: 205,
        venue: 'GATE',
        maturity,
        settleUsd: -20,
        settleFeeUsd: 2,
        tradePnlUsd: 0,
        tradeFeeUsd: 0,
        firstEventSec: NOW_SEC - 180 * DAY_SEC,
        entryApr: 0.04,
        side: 'LONG',
      },
    ],
    ...over,
  };
}

function makeAssetView(groups: AssetGroup[], over: Partial<AssetViewResponse> = {}): AssetViewResponse {
  return {
    sinceSec: 0,
    nowSec: NOW_SEC,
    defaultSinceSec: null,
    assets: groups,
    supportedCoins: [],
    earliestSec: NOW_SEC - 180 * DAY_SEC,
    coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
    interest: { paidUsd: 0, byCoin: {}, coversFromSec: 0, available: true },
    warnings: [],
    ...over,
  };
}

describe('formatPositionsSection', () => {
  it('renders the panel strip and each asset card, from the panel derivation', () => {
    const text = formatPositionsSection(makeAssetView([makeAssetGroup()]) as never);
    expect(text).toContain('<b>💼 持仓汇总</b>（1 个资产 · 全周期）');
    // portfolioTotals: Σ card PnL = perp (100 + 40 − 10) + (−90 + 30 − 10)
    // + Boros history (120 − 20) = 160; capital = perp 1,700 + Boros 700.
    expect(text).toContain('总 PnL +$160（已实现 APR ≈ 13.52%） ｜ 资金 ~$2,400 ｜ 对冲 ✅ 已完全对冲');
    expect(text).toContain('1. ETH · $2,000 ✅');
    expect(text).toContain('总 PnL +$160（ROI 6.67%） ｜ Fixed APR 48.33% ｜ 已运行 180.0 天');
    expect(text).toContain('资金 ~$2,400 ｜ MTM +$30');
    expect(text).toContain('Boros SHORT · Hyperliquid 10.00% ｜ 名义 ~$20,000 ｜');
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} 到期（30 天）/);
    expect(text).toContain('Boros LONG · Gate 4.00% ｜ 名义 ~$20,000');
    expect(text).toContain('perp SHORT · Hyperliquid ~$20,000 ｜ uPnL +$100 ｜ 资金 $800');
    expect(text).toContain('perp LONG · Gate ~$20,000 ｜ uPnL -$90 ｜ 资金 $900');
  });

  it('marks a half-hedged book and withholds the locked APR, exactly like the card', () => {
    // 5 of the 10 ETH perp leg on Gate: a 5 ETH deficit → no deterministic
    // carry, so `Fixed APR —` (the card gates on the same flag).
    const group = makeAssetGroup();
    group.perpOpen = [group.perpOpen[0], { ...group.perpOpen[1], qty: 5, notionalUsd: 10_000 }];
    const text = formatPositionsSection(makeAssetView([group]) as never);
    expect(text).toContain('对冲 ⚠️ 1 条腿待补');
    expect(text).toContain('1. ETH · $2,000 ⚠️ 1 条腿待补');
    expect(text).toContain('Fixed APR —');
    expect(text).toContain('⚠️ Gate：加 LONG 5 ETH perp');
  });

  it('renders the CrossEx margin line through the shared donut math', () => {
    const account = {
      marginBalance: '3431.77',
      initialMargin: '2185.49',
      maintenanceMargin: '877.83',
      availableMargin: '1246.28',
    } as unknown as CrossexAccount;
    const text = formatPositionsSection(makeAssetView([makeAssetGroup()]) as never, account);
    expect(text).toContain('IM 64% ｜ MM 26%');
    expect(text).toContain('可用 $1,246 / 余额 $3,432 · 维持 $878'); // available derived: balance − initial
  });

  it('carries the payload warnings verbatim — they say why the numbers look odd', () => {
    const view = makeAssetView([makeAssetGroup()], {
      warnings: [
        "Couldn't load Gate positions right now (network) — showing the Boros side only.",
      ],
    });
    expect(formatPositionsSection(view as never)).toContain("Couldn't load Gate positions");
  });

  it('charges borrow interest once, on the total — no card can carry it', () => {
    const view = makeAssetView([makeAssetGroup()], {
      interest: { paidUsd: 10, byCoin: { USDT: 10 }, coversFromSec: 0, available: true },
    });
    const text = formatPositionsSection(view as never);
    expect(text).toContain('总 PnL +$150'); // 160 − 10
    expect(text).toContain('1. ETH'); // the card itself is untouched
    expect(text).toContain('总 PnL +$160（ROI 6.67%');
  });

  it('names what it did not expand instead of dropping it silently', () => {
    const view = makeAssetView([
      makeAssetGroup(),
      makeAssetGroup({ base: 'BTC' }),
      makeAssetGroup({ base: 'SOL' }),
      makeAssetGroup({ base: 'DOGE' }),
      makeAssetGroup({ base: 'XRP', perpOpen: [], borosOpen: [] }),
    ]);
    const text = formatPositionsSection(view as never);
    expect(text).toContain('另有 1 个资产有持仓未展开（已计入总 PnL）');
    expect(text).toContain('XRP 仅有历史（已计入总 PnL）');
    expect(text).not.toContain('4. DOGE'); // the cut keeps the biggest footprint
  });

  it('says so explicitly when the account holds nothing at all', () => {
    const view = makeAssetView([]);
    view.assets = [];
    expect(formatPositionsSection(view as never)).toContain('当前无持仓');
  });
});

describe('rolloverKeysFrom', () => {
  it('emits the venue pair of a fully hedged bundle (the zero-perp-fee rollover)', () => {
    const keys = rolloverKeysFrom(makeAssetView([makeAssetGroup()]) as never);
    expect([...keys]).toEqual([rolloverKey('ETH', 'HYPERLIQUID', 'GATE')]);
  });

  it('emits nothing for a one-sided or unwound book', () => {
    const oneSided = makeAssetGroup();
    oneSided.borosOpen = [oneSided.borosOpen[0]];
    expect(rolloverKeysFrom(makeAssetView([oneSided]) as never).size).toBe(0);

    const unwound = makeAssetGroup();
    unwound.perpOpen = [];
    expect(rolloverKeysFrom(makeAssetView([unwound]) as never).size).toBe(0);
  });
});

describe('scanPass', () => {
  const config = (over: Partial<Parameters<typeof scanPass>[0]['config']> = {}) => ({
    telegram: { botToken: 't', chatId: 'c', dispatcher: null },
    webhook: { url: 'https://fwalert.com/x' },
    threshold: 0.3,
    intervalMs: 300_000,
    notionalUsd: 10_000,
    ...over,
  });

  it('sends the Telegram summary EVERY pass, the webhook only on crossings', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const sendWebhook = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])]));
    const alerted = new Set<string>();

    await scanPass({ config: config(), scan, sendTelegram, sendWebhook }, alerted);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendWebhook).toHaveBeenCalledTimes(1);

    await scanPass({ config: config(), scan, sendTelegram, sendWebhook }, alerted);
    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendWebhook).toHaveBeenCalledTimes(1); // deduped
  });

  it('is silent on BOTH channels when the scan fails', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const sendWebhook = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config(),
        scan: vi.fn().mockRejectedValue(new Error('boros down')),
        sendTelegram,
        sendWebhook,
        error: vi.fn(),
      },
      new Set(),
    );
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('is silent when the scan returns no groups', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const sendWebhook = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config(),
        scan: vi.fn().mockResolvedValue(makeResult([])),
        sendTelegram,
        sendWebhook,
        error: vi.fn(),
      },
      new Set(),
    );
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it('skips the Telegram summary when nothing is PRICED (cold-boot warmup)', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const sendWebhook = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config(),
        scan: vi.fn().mockResolvedValue(makeResult([makeGroup([]), makeGroup([])])),
        sendTelegram,
        sendWebhook,
        error: vi.fn(),
      },
      new Set(),
    );
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it('appends the positions section to the SAME message when scanPositions is wired', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const snapshot = { view: makeAssetView([makeAssetGroup()]), margin: null } as unknown as PositionsSnapshot;
    await scanPass(
      {
        config: config({ webhook: null }),
        scan: vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])])),
        scanPositions: vi.fn().mockResolvedValue(snapshot),
        sendTelegram,
      },
      new Set(),
    );
    const text = sendTelegram.mock.calls[0][0] as string;
    expect(text).toContain('🎯');
    expect(text).toContain('──────────────');
    expect(text).toContain('💼 持仓汇总');
  });

  it('badges the pairs whose venue pair a live bundle already holds', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const group = makeAssetGroup();
    // The opportunity the badge rides on: same coin, same two venues.
    const opp = makeGroup([0.35], { underlying: 'ETH' });
    opp.pairs[0] = {
      ...opp.pairs[0],
      shortLeg: { ...opp.pairs[0].shortLeg, venue: 'HYPERLIQUID' },
      longLeg: { ...opp.pairs[0].longLeg, venue: 'GATE' },
    };
    const snapshot = { view: makeAssetView([group]), margin: null } as unknown as PositionsSnapshot;
    await scanPass(
      {
        config: config({ webhook: null }),
        scan: vi.fn().mockResolvedValue(makeResult([opp])),
        scanPositions: vi.fn().mockResolvedValue(snapshot),
        sendTelegram,
      },
      new Set(),
    );
    expect(sendTelegram.mock.calls[0][0] as string).toContain('♻️ 可续期');
  });

  it('a failed positions read costs only the section — the opportunities still go', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config({ webhook: null }),
        scan: vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])])),
        scanPositions: vi.fn().mockRejectedValue(new Error('asset view down')),
        sendTelegram,
        error: vi.fn(),
      },
      new Set(),
    );
    const text = sendTelegram.mock.calls[0][0] as string;
    expect(text).toContain('🎯');
    expect(text).not.toContain('💼');
  });

  it('omits the positions section entirely when no address is wired', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config({ webhook: null }),
        scan: vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])])),
        sendTelegram,
      },
      new Set(),
    );
    expect(sendTelegram.mock.calls[0][0] as string).not.toContain('💼');
  });

  it('a failed send never throws and does not block the other channel', async () => {
    const g = makeGroup([0.35]);
    const sendTelegram = vi.fn().mockRejectedValue(new Error('network gone'));
    const sendWebhook = vi.fn().mockResolvedValue(true);
    await expect(
      scanPass(
        {
          config: config({ telegram: null }),
          scan: vi.fn().mockResolvedValue(makeResult([g])),
          sendTelegram,
          sendWebhook,
        },
        new Set(),
      ),
    ).resolves.toBe(true); // settled — the opportunities pulse went out
    expect(sendWebhook).toHaveBeenCalledTimes(1);
  });

  it('skips the Telegram pass when the channel is unconfigured', async () => {
    const sendTelegram = vi.fn().mockResolvedValue(true);
    const sendWebhook = vi.fn().mockResolvedValue(true);
    await scanPass(
      {
        config: config({ telegram: null }),
        scan: vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])])),
        sendTelegram,
        sendWebhook,
      },
      new Set(),
    );
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(sendWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('startOpportunityScanner', () => {
  it('retries a degraded scan early, at most 5 times, then falls back', async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn().mockResolvedValue(makeResult([makeGroup([])])); // groups, NOTHING priced
      const scanner = startOpportunityScanner({
        config: {
          telegram: null,
          webhook: { url: 'u' },
          threshold: 0.3,
          intervalMs: 300_000,
          notionalUsd: 10_000,
        },
        scan,
        error: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(30_000); // boot grace → pass 1 (degraded)
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000 * 4); // early retries 2..5
      expect(scan).toHaveBeenCalledTimes(5);
      // Retry budget burned → the 6th pass waits the regular 300s cadence.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan).toHaveBeenCalledTimes(5);
      scanner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startOpportunityScanner — chain', () => {
  it('fires the first pass after the boot grace, keeps the chain, stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const sendWebhook = vi.fn().mockResolvedValue(true);
      const scan = vi.fn().mockResolvedValue(makeResult([makeGroup([0.35])]));
      const scanner = startOpportunityScanner({
        config: {
          telegram: null,
          webhook: { url: 'u' },
          threshold: 0.3,
          intervalMs: 10,
          notionalUsd: 10_000,
        },
        scan,
        sendWebhook,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(scan).not.toHaveBeenCalled(); // boot grace
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(sendWebhook).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(sendWebhook).toHaveBeenCalledTimes(1); // deduped across rounds
      scanner.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
