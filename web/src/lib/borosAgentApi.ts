/**
 * Delegated-agent provisioning against the Boros REST API directly — no
 * `@pendle/boros-sdk-public`.
 *
 * Two steps, and only ONE wallet prompt:
 *
 *   1. Mint an agent keypair locally, from the browser's CSPRNG.
 *   2. Have the ROOT wallet EIP-712-sign an `ApproveAgentMessage`, encode it
 *      into the router's relayable `approveAgent(req, signature)` overload, and
 *      hand the calldata to the LOCAL terminal (`/api/boros/agent/approve`),
 *      which relays it to Boros's `/v1/send-txs/approve` — where Pendle's bot
 *      submits it and pays the gas, so the user needs no ETH on Arbitrum.
 *
 * ⚠ Never POST straight to api-boros from the browser: that API answers no
 * CORS headers on any response, so a cross-origin script call dies in the
 * preflight. The server-side relay (undici, HTTPS_PROXY-aware) is the only
 * channel that reaches it, and it is the same one every other Boros call in
 * this app uses.
 *
 * ⚠ THE KEY IS RANDOM, not derived from a wallet signature. The SDK derived it
 * from a signed "welcome message", which reads like a recoverable derivation
 * but is not: that message embeds a timestamp and a random nonce, so re-running
 * setup produced a different key anyway. A CSPRNG key is the same strength,
 * costs one fewer wallet popup, and cannot be reconstructed by anyone who
 * phishes a signature out of the user later.
 *
 * The generated key never leaves this machine: it goes from here to the local
 * server and nowhere else. It is not logged, not put in a URL, not rendered.
 */
import { BOROS_NETWORK } from './borosNetwork';
import { encodeFunctionData, toHex, type Address, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** The documented production host (the OpenAPI spec's only `servers` entry). */
export const BOROS_API_BASE = BOROS_NETWORK.apiBase;

/** Arbitrum One, and the router the approval is bound to. Both are part of the
 * EIP-712 domain, so a wrong value yields a signature the contract rejects
 * rather than an approval that silently does the wrong thing. */
const CHAIN_ID = BOROS_NETWORK.chainId;
const ROUTER_ADDRESS = BOROS_NETWORK.routerAddress;

const EIP712_DOMAIN = {
  name: 'Pendle Boros Router',
  version: '1.0',
  chainId: CHAIN_ID,
  verifyingContract: ROUTER_ADDRESS as Hex,
} as const;

/** The struct the root wallet signs. Field order and types are the contract's. */
const APPROVE_AGENT_TYPES = {
  ApproveAgentMessage: [
    { name: 'root', type: 'address' },
    { name: 'accountId', type: 'uint8' },
    { name: 'agent', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/**
 * The RELAYABLE overload.
 *
 * ⚠ `approveAgent` is overloaded. The one-argument form
 * (`approveAgent(req)` with no nonce) requires `msg.sender` to BE the root, so
 * the user would have to send the transaction and pay gas themselves. Only this
 * two-argument form carries the root's signature inside the calldata, which is
 * what lets Pendle's bot submit it on their behalf.
 */
const APPROVE_AGENT_ABI = [
  {
    type: 'function',
    name: 'approveAgent',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      {
        type: 'tuple',
        name: 'req',
        components: [
          { name: 'root', type: 'address' },
          { name: 'accountId', type: 'uint8' },
          { name: 'agent', type: 'address' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

export interface GeneratedAgent {
  privateKey: Hex;
  address: Address;
}

/** A fresh agent keypair from the browser's CSPRNG. */
export function generateAgentKey(): GeneratedAgent {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const privateKey = toHex(bytes) as Hex;
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/**
 * A nonce the router will accept.
 *
 * The contract wants one strictly above the root's last used `signerNonce`,
 * and the SDK took `max(signerNonce + 1, Date.now() * 1000)`. The clock term
 * always wins in practice — a microsecond timestamp is ~1.8e15 while the
 * counter only ever advances to a previously-used timestamp — and it stays
 * monotonic across approvals without an RPC round-trip, so it is used alone
 * rather than adding a public-RPC dependency (and its CORS and rate limits) to
 * a one-time flow.
 */
const approvalNonce = (): bigint => BigInt(Date.now()) * 1000n;

export class BorosApiError extends Error {}

/**
 * The per-install API token injected into index.html by the serving backend.
 * Absent, or still the untouched placeholder, means this page did not come
 * from the terminal backend — send nothing (matches `client.ts`'s authHeader).
 */
function arbToken(): string {
  if (typeof document === 'undefined') return '';
  const content =
    document.querySelector('meta[name="arb-token"]')?.getAttribute('content') ?? '';
  return content && content !== '__ARB_TOKEN__' ? content : '';
}

/**
 * POST to the LOCAL terminal (same origin — no CORS), which relays the
 * approval to Boros server-side. The browser must never call api-boros
 * directly: that API answers no CORS headers on any response, so a
 * cross-origin script request dies in the preflight. The server's own fetch
 * (undici, riding HTTPS_PROXY like every other Boros call) is the one channel
 * that actually gets there.
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The relay route sits behind the terminal's auth hook — carry the same
      // per-install token every other /api call does (see client.ts).
      'x-arb-token': arbToken(),
    },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => null)) as
    | (T & { message?: string | string[]; error?: string })
    | null;
  if (!resp.ok) {
    const detail = json?.message ?? json?.error;
    throw new BorosApiError(
      `Boros ${path} failed (HTTP ${resp.status})${detail ? `: ${Array.isArray(detail) ? detail.join('; ') : detail}` : ''}`,
    );
  }
  return json as T;
}

export interface ApproveAgentInput {
  walletClient: WalletClient;
  /** The account being delegated — the connected wallet's address. */
  root: Address;
  accountId?: number;
  /** The agent address from `generateAgentKey`. */
  agentAddress: Address;
  /** ABSOLUTE unix seconds. ⚠ Not a duration: the contract stores it verbatim,
   * so a duration approves the agent until 1971 and every later order fails
   * with `AuthAgentExpired()`. */
  expiry: number;
}

/**
 * Approve the agent on-chain, submitted by Pendle's relayer.
 *
 * Returns once the endpoint answers, and throws on a refusal it reports. The
 * calldata is NOT checked here or known to be checked upstream, so nothing
 * catches a malformed encoding before it is broadcast — what protects the user
 * is the signature itself: it commits to this exact message under the router's
 * EIP-712 domain, so calldata that does not match is rejected on-chain rather
 * than approving something else.
 */
export async function approveAgent(
  input: ApproveAgentInput,
): Promise<{ txHash?: string; expiryTime: number }> {
  const accountId = input.accountId ?? 0;
  const message = {
    root: input.root,
    accountId,
    agent: input.agentAddress,
    expiry: BigInt(input.expiry),
    nonce: approvalNonce(),
  };
  const account = input.walletClient.account ?? input.root;
  const signature = await input.walletClient.signTypedData({
    account: account as never,
    domain: EIP712_DOMAIN,
    types: APPROVE_AGENT_TYPES,
    primaryType: 'ApproveAgentMessage',
    message,
  });
  const approveAgentCalldata = encodeFunctionData({
    abi: APPROVE_AGENT_ABI,
    functionName: 'approveAgent',
    args: [message, signature],
  });
  // Relayed by the local server (`skipReceipt` — the bot broadcasts and
  // answers immediately), then polled on-chain until the approval lands. The
  // chain is the truth: an approval the bot could not confirm stays 0 forever
  // and must read as a failure, not a silent success.
  const relayRes = await postJson<{
    data?: { txHash?: string; status?: string; error?: string };
  }>('/api/boros/agent/approve', { approveAgentCalldata });
  const relayed = relayRes?.data;
  if (relayed?.error) throw new BorosApiError(`Boros refused the approval: ${relayed.error}`);
  if (relayed?.status === 'reverted') {
    throw new BorosApiError(`Boros approval was reverted on-chain`);
  }

  const deadlineAt = Date.now() + APPROVAL_CONFIRM_MS;
  let expiryTime = 0;
  let lastLookupError: unknown = null;
  while (Date.now() < deadlineAt) {
    try {
      expiryTime = await chainExpiry();
      if (expiryTime > Math.floor(Date.now() / 1000)) {
        return { txHash: relayed?.txHash, expiryTime };
      }
    } catch (err) {
      lastLookupError = err;
    }
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
  }
  // The broadcast was accepted but the chain never showed the approval.
  // Reverted (nonce/sim), dropped, or merely slow — all read the same here.
  if (lastLookupError instanceof BorosApiError) throw lastLookupError;
  throw new BorosApiError(
    `The approval was submitted but the chain has not confirmed it within ${Math.round(APPROVAL_CONFIRM_MS / 60_000)} min. Check the agent list in the Boros app before retrying.`,
  );
}

/** How long to wait for the on-chain approval to land after relaying. */
const APPROVAL_CONFIRM_MS = 3 * 60 * 1000;
/** Poll interval for the chain-side status. */
const APPROVAL_POLL_MS = 1_500;

/** The chain's expiry for the currently configured agent (0 = not approved). */
async function chainExpiry(): Promise<number> {
  const resp = await fetch('/api/boros/agent/chain-expiry', {
    headers: { 'x-arb-token': arbToken() },
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await resp.json().catch(() => null)) as {
    ok?: boolean;
    data?: { expiryTime?: number };
    error?: { message?: string };
  } | null;
  if (!resp.ok || !json?.ok) {
    throw new BorosApiError(json?.error?.message ?? `chain-expiry lookup failed (HTTP ${resp.status})`);
  }
  return json.data?.expiryTime ?? 0;
}
