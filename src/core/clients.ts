import 'dotenv/config';
import https from 'node:https';
import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { ApiClient, CrossExApi, FuturesApi, SpotApi } from 'gate-api';
import { CoreError } from './errors';

/** Hard HTTP deadline on every Gate call. The SDK's default axios instance has
 * NO timeout — one hung request would stall the reconcile loop (and with it
 * every deal's convergence, e.g. a pending Stop) indefinitely. A timed-out call
 * surfaces as a network error → the engine's UNKNOWN/error paths, which are
 * safe by design (probe-and-resolve, never guess). */
const HTTP_TIMEOUT_MS = 15_000;

/** Backoff between the first failed Gate read and its single retry. */
const GATE_RETRY_DELAY_MS = 300;

/** Shared keep-alive HTTPS agent for every Gate call. axios' default agent
 * opens a fresh TCP+TLS connection per request; from networks where the path to
 * api.gateio.ws is slow/flaky (handshake seconds, bursty handshake failures),
 * reusing warm sockets across the ~10 concurrent reads of each refresh is the
 * difference between a working overlay and the perpsUnavailableWarning degrade.
 * The pool is a single module-level agent so the signed and public clients (and
 * hot-swapped credentials) all ride the same warm sockets. */
const gateHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

/** Transport-level failure codes worth one retry. These all mean "no response
 * arrived" — the server cannot have acted on the request, so repeating a GET is
 * safe (GETs are idempotent at Gate). Response-bearing errors are handled by
 * the status branch below (5xx only). */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPROTO',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** A transient failure is one where retrying cannot double-execute anything:
 * the request was an idempotent GET and either no response ever arrived
 * (network error) or the server itself said 5xx. POST/DELETE writes are never
 * retried — a lost response after a write must not resubmit the order (the
 * engine's freeze/quarantine rules exist precisely because guessing a write's
 * fate is forbidden). Exported for the unit test that pins the no-response
 * branch (nock cannot emulate transport errors promptly, so the predicate is
 * the honest seam for ECONNRESET/timeout/EAI_AGAIN coverage). */
export function isRetryableGateError(
  config: AxiosRequestConfig | InternalAxiosRequestConfig,
  err: unknown,
): boolean {
  const method = String(config.method ?? 'get').toLowerCase();
  if (method !== 'get') return false;
  const e = err as { response?: { status: number } | undefined; code?: string; message?: string };
  if (e?.response) return e.response.status >= 500 && e.response.status !== 429;
  return Boolean(e?.code && RETRYABLE_NETWORK_CODES.has(e.code)) ||
    /socket hang up|timeout/i.test(e?.message ?? '');
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The Gate axios instance: hard timeout, DIRECT to api.gateio.ws (`proxy:
 * false` — axios otherwise inherits the process's HTTPS_PROXY env var and the
 * local Clash proxy is a bursty CONNECT-failure point in front of the exchange
 * API; the .env SHIPPED comment says Gate stays direct, this makes it true),
 * warm keep-alive sockets, and one retry for transient read failures. The SDK
 * (gate-api) calls exactly `axiosInstance.request(config)`, so wrapping that
 * one method covers every Gate call — reads and writes alike — without touching
 * the SDK. */
function gateAxios(): AxiosInstance {
  const ax = axios.create({ timeout: HTTP_TIMEOUT_MS, proxy: false, httpsAgent: gateHttpsAgent });
  const rawRequest = ax.request;
  const requestWithRetry = async (config: InternalAxiosRequestConfig) => {
    try {
      return await rawRequest(config);
    } catch (err) {
      if (!isRetryableGateError(config, err)) throw err;
      await delay(GATE_RETRY_DELAY_MS);
      return await rawRequest(config);
    }
  };
  ax.request = requestWithRetry as typeof ax.request;
  return ax;
}

/** Gate Broker Program channel id, sent as X-Gate-Channel-Id on every signed
 * request so Gate can attribute this tool's order flow (the same mechanism
 * CCXT and Hummingbot use). Inert until Gate registers the id to us —
 * unregistered values are ignored server-side. */
const GATE_CHANNEL_ID = 'boros';

export interface Clients {
  api: ApiClient;
  crossEx: CrossExApi;
  spot: SpotApi;
  futures: FuturesApi;
}

export interface Credentials {
  key: string;
  secret: string;
}

/**
 * Build an authenticated official `gate-api` ApiClient and the typed API objects.
 * The official SDK (v7.2+) ships a native `CrossExApi`; we use it directly.
 * Credentials default to `.env` (GATE_API_KEY / GATE_API_SECRET); pass `creds`
 * to build a client for other keys (the server's hot-swap + candidate validation).
 */
export function makeClients(creds?: Credentials): Clients {
  const key = creds?.key ?? process.env.GATE_API_KEY;
  const secret = creds?.secret ?? process.env.GATE_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      'Missing GATE_API_KEY / GATE_API_SECRET. Add them to a .env file in the project root.',
    );
  }
  const api = new ApiClient(undefined, gateAxios());
  api.setApiKeySecret(key, secret);
  // Mutate rather than assign: the SDK's defaultHeaders setter replaces the
  // whole object, which would drop its stock X-Gate-Size-Decimal header.
  api.defaultHeaders['X-Gate-Channel-Id'] = GATE_CHANNEL_ID;
  return {
    api,
    crossEx: new CrossExApi(api),
    spot: new SpotApi(api),
    futures: new FuturesApi(api),
  };
}

/**
 * Server-boot variant: null when no credentials are configured yet, so the app
 * can start and serve the first-run credentials UI. Other callers keep using
 * `makeClients` and its hard throw.
 */
export function makeClientsIfConfigured(): Clients | null {
  if (!process.env.GATE_API_KEY || !process.env.GATE_API_SECRET) return null;
  return makeClients();
}

/**
 * Unsigned CrossEx client for the endpoints Gate serves PUBLICLY — the SDK
 * declares `authSettings = []` for `/crossex/rule/symbols` and
 * `/crossex/rule/risk_limits`, and both answer an unsigned request. That is the
 * whole tradable universe plus every symbol's leverage cap, so the market view
 * never has to gate them behind credentials (only `/crossex/fee` and the
 * account/order endpoints are genuinely per-user).
 *
 * Memoized: one ApiClient, same base path and interceptors as the signed one.
 */
let publicClient: CrossExApi | undefined;
export function publicCrossEx(): CrossExApi {
  publicClient ??= new CrossExApi(new ApiClient(undefined, gateAxios()));
  return publicClient;
}

/** Gate for routes that need a live client while the server may be unconfigured. */
export function requireClients(clients: Clients | null): Clients {
  if (!clients) {
    throw new CoreError(
      'Gate API credentials are not configured — enter them in the setup guide in the web app.',
      'not-configured',
    );
  }
  return clients;
}
