import { KEYRING_ACCOUNT, KEYRING_SERVICE, keyringStoreFromEntries, resolveKey } from '@prjct.app/pi-tui-kit';
import type { Questions } from '@typesafe-ai/sdk';

/**
 * Jev: one typed judgement in about 300 ms, for a fraction of a cent. It
 * never writes and never sits in front of a turn: no key, a timeout or an
 * error leaves self-compact on its token lines alone, exactly as before.
 */
export type NoulAnswer = Readonly<{ type: 'noul'; noul: number }>;
export type ScoreAnswer = Readonly<{ type: 'score'; score: number; confidence: number }>;
export type JevAnswer = NoulAnswer | ScoreAnswer | Readonly<{ type: 'choice'; choice: string; confidence: number }>;
export type Jev = (state: unknown, questions: Questions, signal?: AbortSignal) => Promise<Readonly<Record<string, JevAnswer>>>;
export type ConnectJev = () => Promise<Jev | undefined>;

/** Pinned like pi-qa and pi-memory: a silent model swap would move every threshold. */
export const JEV_MODEL = 'jev-1.13.0';
const TIMEOUT_MS = 8_000;

/** The one TypeSafe key every prjct extension shares: TYPESAFE_API_KEY, then the OS keyring. */
export const connectJev: ConnectJev = async () => {
  // Tests and offline runs never reach the keyring or the network.
  if (process.env.PI_SELF_COMPACT_OFFLINE === '1') return undefined;
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const resolved = await resolveKey(keyringStoreFromEntries(new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT)));
    if (!resolved.key) return undefined;
    const { TypeSafeClient } = await import('@typesafe-ai/sdk');
    // One attempt: a verdict that arrives late is worth less than the token lines alone.
    const client = new TypeSafeClient({ apiKey: resolved.key, defaultModel: JEV_MODEL, logLevel: 'off', timeout: TIMEOUT_MS, retry: { maxRetries: 0 } });
    return async (state, questions, signal) =>
      (await client.systemOne({ state: state as never, questions }, { signal })).answers as unknown as Record<string, JevAnswer>;
  } catch {
    return undefined;
  }
};
