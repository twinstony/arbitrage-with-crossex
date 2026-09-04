/**
 * Gate transport tuning (src/core/clients.ts): Gate traffic must stay DIRECT to
 * api.gateio.ws (the local Clash proxy's CONNECT path is a bursty failure point;
 * axios would otherwise inherit HTTPS_PROXY from the environment), reads get ONE
 * retry for transient failures, and writes never retry (a lost response after a
 * POST must not resubmit the order — the engine's freeze rules forbid guessing
 * a write's fate).
 *
 * Retry mechanics are exercised through the real seam — gate-api calls exactly
 * `axiosInstance.request(config)` on the instance clients.ts builds — using
 * 5xx responses (nock cannot deliver a prompt TRANSPORT error: replyWithError
 * rides the axios timeout instead, which only proves the timeout works). The
 * no-response branch (ECONNRESET/timeout/DNS) is pinned by the pure predicate
 * test, where `isRetryableGateError` is the honest seam.
 */
import { describe, expect, it } from 'vitest';
import {
  CrossexOrderRequest,
} from 'gate-api';
import { isRetryableGateError, makeClients } from '../../src/core/clients';
import { fixture, gate } from './helpers/gate-nock';

describe('Gate client transport tuning', () => {
  it('talks to api.gateio.ws directly, ignoring any HTTPS_PROXY env proxy', async () => {
    // A dead proxy: if axios honored the env var it would CONNECT 127.0.0.1:9
    // and fail before nock ever saw the request.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    delete process.env.NO_PROXY;
    try {
      const scope = gate()
        .get('/api/v4/crossex/accounts')
        .query(true)
        .reply(200, fixture('account.json'));
      const clients = makeClients({ key: 'test-key', secret: 'test-secret' });
      const { body } = await clients.crossEx.getCrossexAccount();
      expect(body).toBeTruthy();
      scope.done();
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it('retries a transient 5xx once on reads (GET)', async () => {
    const scope = gate()
      .get('/api/v4/crossex/accounts')
      .query(true)
      .reply(500, { label: 'INTERNAL', message: 'boom' })
      .get('/api/v4/crossex/accounts')
      .query(true)
      .reply(200, fixture('account.json'));

    const clients = makeClients({ key: 'test-key', secret: 'test-secret' });
    const { body } = await clients.crossEx.getCrossexAccount();

    expect(body).toBeTruthy();
    scope.done();
  });

  it('never retries writes — a lost response must not resubmit an order', async () => {
    // A single 500 interceptor: a retry would hit "Nock: No match for request"
    // and surface a different error (message lacking the Gate body/label).
    const scope = gate()
      .post('/api/v4/crossex/orders', () => true)
      .reply(500, { label: 'INTERNAL', message: 'boom' });

    const clients = makeClients({ key: 'test-key', secret: 'test-secret' });
    const err = await clients.crossEx
      .createCrossexOrder({
        crossexOrderRequest: {
          symbol: 'BTC_USDT',
          side: CrossexOrderRequest.Side.BUY,
          type: CrossexOrderRequest.Type.MARKET,
          quoteQty: '10',
        },
      })
      .catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/Request failed with status code 500/);
    expect((err as Error).message).not.toMatch(/Nock:/);
    scope.done();
  });

  it('retry predicate: only idempotent GETs, only transport failures or 5xx', () => {
    const noResponse: Record<string, unknown> = { code: 'ECONNRESET' };
    // No-response transport failures on GET → retry.
    expect(isRetryableGateError({ method: 'get' }, noResponse)).toBe(true);
    expect(isRetryableGateError({ method: 'get' }, { code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableGateError({ method: 'get' }, { code: 'EAI_AGAIN' })).toBe(true);
    expect(isRetryableGateError({ method: 'get' }, { code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })).toBe(true);
    // Writes are never retried, whatever the failure.
    expect(isRetryableGateError({ method: 'post' }, noResponse)).toBe(false);
    expect(isRetryableGateError({ method: 'delete' }, noResponse)).toBe(false);
    expect(isRetryableGateError({ method: 'put' }, noResponse)).toBe(false);
    // Response-bearing errors: only 5xx; auth (403) and rate-limit (429) are not retried here.
    expect(isRetryableGateError({ method: 'get' }, { response: { status: 403 } })).toBe(false);
    expect(isRetryableGateError({ method: 'get' }, { response: { status: 429 } })).toBe(false);
    expect(isRetryableGateError({ method: 'get' }, { response: { status: 502 } })).toBe(true);
    // Method defaults to GET when unset (axios default).
    expect(isRetryableGateError({}, noResponse)).toBe(true);
  });
});