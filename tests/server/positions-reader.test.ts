/**
 * THE 404 REGRESSION (issue #1, root cause 1).
 *
 * The TG 💼 positions section is fed by a self-call from the server to its own
 * HTTP API. Upstream 1.6.0 replaced routes/strategy.ts with
 * routes/asset-view.ts, and the local wiring kept calling the deleted
 * /api/strategy/:address — so every pass logged
 *   [notify] positions summary failed — section skipped: HTTP 404
 * and the operator's pulse carried no positions at all (580 logged 404s).
 *
 * This test drives the REAL wiring (makePositionsReader) against a LISTENING
 * server, because the bug lived in the URL, not in any function: an
 * app.inject() test of the route alone would have stayed green throughout.
 * The first case pins the deleted route (the reproduction — it is 404 to this
 * day); the rest pin the endpoint the reader must use and the shapes it must
 * survive.
 */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makePositionsReader } from '../../src/server/notify/positions';
import { raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { makeTestApp, mockGateGet, TEST_TOKEN } from './helpers/gate-nock';

const ADDR = '0x51174Bfe88fB059Cc440cdb5c5DfeD9D4dBb47f8'; // mixed case on purpose
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** One ETH bundle: Boros SHORT Hyperliquid / LONG Gate, $32,792 a leg, plus
 * the matching perp overlay — enough for the section to have real numbers. */
function borosBodies(): Record<string, unknown> {
  const market = (marketId: number, platformName: string) => ({
    marketId,
    tokenId: 3,
    imData: { name: `${platformName} ETH 31 Jul 2026`, maturity: NOW + 15 * DAY },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
    metadata: { platformName, assetSymbol: 'ETH' },
    data: { markApr: 0.076, floatingApr: 0.075, assetMarkPrice: 1880 },
  });
  return {
    '/core/v1/markets': { results: [market(201, 'Hyperliquid'), market(205, 'Gate')], total: 2, skip: 0 },
    '/core/v1/collaterals/summary': {
      collaterals: [
        {
          tokenId: 3,
          crossPosition: {
            isCross: true,
            netBalance: raw(20_000),
            marketPositions: [
              {
                marketId: 201,
                side: 1,
                notionalSize: raw(-17_442),
                fixedApr: 0.083,
                markApr: 0.076,
                pnl: { rateSettlementPnl: raw(120), unrealisedPnl: raw(28) },
                positionInitialMargin: raw(207),
              },
              {
                marketId: 205,
                side: 0,
                notionalSize: raw(17_442),
                fixedApr: 0.053,
                markApr: 0.051,
                pnl: { rateSettlementPnl: raw(-12), unrealisedPnl: raw(-7) },
                positionInitialMargin: raw(155),
              },
            ],
          },
          isolatedPositions: [],
        },
      ],
    },
    '/core/v1/pnl/transactions': { results: [], total: 0, skip: 0 },
    '/apis/v1/accounts/settlement-events': { results: [], total: 0, skip: 0 },
  };
}

const gatePositions = [
  {
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    position_qty: '-17',
    position_value: '31_960'.replace('_', ''),
    entry_price: '1900',
    mark_price: '1880',
    leverage: '25',
    upnl: '340',
    funding_fee: '-12',
    fee: '9',
    initial_margin: '1280',
    position_side: 'SHORT',
    position_id: 'p1',
    create_time: String((NOW - 3 * DAY) * 1000),
  },
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Listen on an ephemeral port: the reader speaks HTTP for real, which is the
 * point (the regression WAS the URL). */
async function listen(overrides: Parameters<typeof makeTestApp>[0]): Promise<string> {
  app = makeTestApp(overrides);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('the positions self-call', () => {
  it('the deleted /api/strategy route is gone — the reproduction', async () => {
    const base = await listen({ borosFetch: borosStub(borosBodies()) });
    const res = await fetch(`${base}/api/strategy/${ADDR}`, { headers: { 'x-arb-token': TEST_TOKEN } });
    expect(res.status).toBe(404);
  });

  it('reads the asset view the web cards read, lower-cased, with the token', async () => {
    const base = await listen({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { body: [] });
    mockGateGet('/history_margin_interests', { body: [] });
    mockGateGet('/accounts', { fixture: 'account.json' });

    const read = makePositionsReader({ baseUrl: base, address: ADDR, token: TEST_TOKEN });
    const snapshot = await read();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.view.assets.map((a) => a.base)).toEqual(['ETH']);
    expect(snapshot!.view.assets[0].borosOpen).toHaveLength(2);
    // The SDK hands the fields through as the JSON strings Gate sent; the
    // formatter coerces through the shared marginParts().
    expect(snapshot!.margin).toMatchObject({ marginBalance: '993.4877', initialMargin: '375.5800' });
  });

  it('drops only the margin line when /api/account fails, never the positions', async () => {
    const base = await listen({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { body: [] });
    mockGateGet('/accounts', { status: 500, body: { label: 'SERVER_ERROR' } });

    const snapshot = await makePositionsReader({ baseUrl: base, address: ADDR, token: TEST_TOKEN })();
    expect(snapshot!.view.assets).toHaveLength(1);
    expect(snapshot!.margin).toBeNull();
  });

  it('refuses to invent positions: a non-200 route throws (the scanner logs and skips)', async () => {
    // No auth token on the self-call → the API gate answers 401, exactly like
    // the 404 did before: the section must fail loudly, not render empty.
    const base = await listen({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { body: [] });
    const read = makePositionsReader({ baseUrl: base, address: ADDR, token: 'wrong-token' });
    await expect(read()).rejects.toThrow('HTTP 401');
  });
});
