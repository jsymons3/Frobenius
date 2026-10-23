import { generateWallet, signPayload } from '../src/crypto.mjs';
import { approvalPayload, buildBlock, createGenesis, headerHash, loadParams, votePayload } from '../src/consensus.mjs';
import { createTransfer } from '../src/wallet.mjs';

export const BEAN = 1_000_000n;

const wallets = new Map();
const byAddress = new Map();
/** Deterministic test wallets: wallet(1), wallet(2), ... Wallet 1 is funded at genesis. */
export function wallet(n) {
  if (!wallets.has(n)) {
    const created = generateWallet(new Uint8Array(32).fill(n));
    wallets.set(n, created);
    byAddress.set(created.address, created);
  }
  return wallets.get(n);
}

export const validatorEntry = w => ({ address: w.address, publicKey: w.publicKey });
/** Wallets 1..count form the default validator set. */
export const validatorWallets = (count = 4) => Array.from({ length: count }, (_, i) => wallet(i + 1));

export function testGenesis(overrides = {}) {
  return createGenesis({
    name: 'test', createdAt: 1_000_000, salt: '00'.repeat(32),
    validators: validatorWallets(4).map(validatorEntry),
    allocations: [{ address: wallet(1).address, amount: 1_000n * BEAN }],
    totalSupply: 10_000n * BEAN, blockReward: 50n * BEAN, blockInterval: 1_000,
    maxBlockBytes: 256 * 1024, maxBlockTransactions: 50,
    ...overrides,
  });
}

export const testParams = overrides => loadParams(testGenesis(overrides));

export function transfer(chain, from, to, amount, { fee = 1_000n, nonce = chain.nonce(from.address), memo = '' } = {}) {
  return createTransfer({ seed: from.seed, from: from.address, chainId: chain.params.chainId, to: to.address, amount, fee, nonce, memo });
}

/** A commit certificate for `block` signed by the given wallets. */
export function certify(params, block, signers, round = 0) {
  const hash = headerHash(block.header);
  const payload = votePayload('precommit', params.chainId, block.header.height, round, hash);
  return {
    height: block.header.height, round, hash,
    signatures: signers.map(w => ({ validator: w.address, signature: signPayload(payload, w.seed).signature })),
  };
}

/** The first `quorum` wallets of the chain's active set (they must be test wallets). */
export function quorumOf(chain) {
  return chain.validators.slice(0, chain.quorum).map(entry => {
    const w = byAddress.get(entry.address);
    if (!w) throw new Error(`No test wallet for validator ${entry.address}`);
    return w;
  });
}

/** A validator update approved by `signers` (default: a quorum of the current set). */
export function approve(chain, validators, { signers = quorumOf(chain), sequence = chain.validatorSequence + 1 } = {}) {
  const list = validators.map(validatorEntry);
  const payload = approvalPayload(chain.params.chainId, sequence, list);
  return { sequence, validators: list, approvals: signers.map(w => ({ validator: w.address, signature: signPayload(payload, w.seed).signature })) };
}

/** Build, certify, and commit one block on the tip. */
export function commitBlock(chain, { proposer = wallet(1), transactions = [], validatorUpdate = null, signers, timestamp, mempool = null } = {}) {
  const txs = mempool ? mempool.select({ maxBytes: chain.params.maxBlockBytes - 4096, maxCount: chain.params.maxBlockTransactions }) : transactions;
  const block = buildBlock({
    params: chain.params, parent: chain.tip, proposer: proposer.address, transactions: txs, validatorUpdate,
    now: timestamp ?? chain.tip.timestamp + chain.params.blockInterval,
  });
  const certificate = certify(chain.params, block, signers ?? quorumOf(chain));
  const result = chain.commit(block, certificate);
  return { block, certificate, hash: result.hash };
}
