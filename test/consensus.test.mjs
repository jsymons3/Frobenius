import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload } from '../src/crypto.mjs';
import {
  ConsensusError, EMPTY_HASH, LedgerState, applyBlock, approvalPayload, buildBlock, checkBlock, checkBlockShape,
  checkValidatorUpdate, connectBlock, createGenesis, faultTolerance, headerHash, loadParams, proposerAt, quorum,
  transactionHash, transactionId, updateHash, verifyCertificate,
} from '../src/consensus.mjs';
import { createTransfer } from '../src/wallet.mjs';
import { BEAN, certify, testGenesis, testParams, validatorEntry, validatorWallets, wallet } from './helpers.mjs';

const block = (transactions, proposer = wallet(2).address, validatorUpdate = null) => ({ header: { proposer }, transactions, validatorUpdate });

describe('genesis', () => {
  it('derives parameters, the validator set, and a chain id that names the network', () => {
    const params = testParams();
    assert.match(params.chainId, /^frobenius-test-[0-9a-f]{96}$/);
    assert.equal(params.allocated, 1_000n * BEAN);
    assert.deepEqual(params.validators.map(v => v.address), validatorWallets(4).map(w => w.address));
    assert.notEqual(loadParams(testGenesis({ salt: '11'.repeat(32) })).chainId, params.chainId);
  });

  it('supports a fair launch with no allocations', () => {
    const params = loadParams(createGenesis({ name: 'fair', createdAt: 1, validators: [validatorEntry(wallet(1))] }));
    assert.equal(params.allocated, 0n);
    assert.equal(params.blockReward, 2n * BEAN);
    assert.equal(params.blockInterval, 5_000);
  });

  it('rejects malformed or unsafe parameters', () => {
    const valid = testGenesis();
    const forged = { ...validatorEntry(wallet(5)), address: wallet(6).address };
    const cases = [
      { ...valid, extra: 1 },
      { ...valid, allocations: [{ address: wallet(1).address, amount: '10000000001' }] },
      { ...valid, allocations: [{ address: wallet(1).address, amount: '1' }, { address: wallet(1).address, amount: '1' }] },
      { ...valid, validators: [] },
      { ...valid, validators: [validatorEntry(wallet(1)), validatorEntry(wallet(1))] },
      { ...valid, validators: [forged] },
      { ...valid, name: 'Bad Name' },
      { ...valid, blockReward: '10000000001' },
      { ...valid, blockInterval: 500 },
    ];
    for (const genesis of cases) assert.throws(() => loadParams(genesis), ConsensusError);
  });
});

describe('quorums and proposers', () => {
  it('tolerates floor((n-1)/3) faults and needs n-f votes', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 7, 10].map(n => [faultTolerance(n), quorum(n)]), [[0, 1], [0, 2], [0, 3], [1, 3], [1, 4], [2, 5], [3, 7]]);
  });

  it('rotates the proposer by height and round', () => {
    const validators = testParams().validators;
    assert.equal(proposerAt(validators, 1, 0).address, wallet(2).address);
    assert.equal(proposerAt(validators, 1, 1).address, wallet(3).address);
    assert.equal(proposerAt(validators, 4, 0).address, wallet(1).address);
  });
});

describe('transactions and block state transitions', () => {
  const params = testParams();
  const send = (from, to, amount, { fee = 1_000n, nonce = 0, chainId = params.chainId } = {}) =>
    createTransfer({ seed: from.seed, from: from.address, chainId, to: to.address, amount, fee, nonce });

  it('moves the amount, pays fee and subsidy to the proposer, and conserves supply', () => {
    const state = LedgerState.fromParams(params);
    connectBlock(state, block([send(wallet(1), wallet(5), 10n * BEAN, { fee: 5n })]), params);
    assert.equal(state.balance(wallet(1).address), 990n * BEAN - 5n);
    assert.equal(state.balance(wallet(5).address), 10n * BEAN);
    assert.equal(state.balance(wallet(2).address), 50n * BEAN + 5n);
    assert.equal(state.nonce(wallet(1).address), 1);
    assert.equal(state.held(), state.issued);
  });

  it('keeps the transaction id stable when the same transfer is signed again', () => {
    const first = send(wallet(1), wallet(5), 1n);
    const second = send(wallet(1), wallet(5), 1n);
    assert.notEqual(first.signature, second.signature);
    assert.equal(transactionId(first), transactionId(second));
    assert.notEqual(transactionHash(first), transactionHash(second));
  });

  it('rejects bad nonces, overspending, other chains, forged amounts, and stolen keys', () => {
    const forged = send(wallet(1), wallet(5), 1n);
    forged.payload.amount = '2';
    const stolen = createTransfer({ seed: wallet(5).seed, from: wallet(1).address, chainId: params.chainId, to: wallet(5).address, amount: 1n, fee: 0n, nonce: 0 });
    for (const transaction of [
      send(wallet(1), wallet(5), 1n, { nonce: 1 }),
      send(wallet(1), wallet(5), 1_000n * BEAN),
      send(wallet(1), wallet(5), 1n, { chainId: 'frobenius-other' }),
      forged,
      stolen,
    ]) assert.throws(() => checkBlock(LedgerState.fromParams(params), block([transaction]), params), ConsensusError);
  });

  it('checks a block without touching state, so a failure leaves nothing behind', () => {
    const state = LedgerState.fromParams(params);
    const good = send(wallet(1), wallet(5), 1n);
    const bad = send(wallet(1), wallet(5), 1n, { nonce: 5 });
    assert.throws(() => connectBlock(state, block([good, bad]), params), ConsensusError);
    assert.equal(state.balance(wallet(5).address), 0n);
    assert.equal(state.nonce(wallet(1).address), 0);
    assert.equal(state.issued, params.allocated);
  });

  it('lets a recipient spend funds received earlier in the same block', () => {
    const state = LedgerState.fromParams(params);
    connectBlock(state, block([send(wallet(1), wallet(5), 5n * BEAN), send(wallet(5), wallet(6), 4n * BEAN)]), params);
    assert.equal(state.balance(wallet(6).address), 4n * BEAN);
  });

  it('pays the remaining subsidy and then fees only once the supply cap is reached', () => {
    const capped = loadParams(testGenesis({ totalSupply: (1_070n * BEAN).toString() }));
    const state = LedgerState.fromParams(capped);
    connectBlock(state, block([]), capped);
    connectBlock(state, block([]), capped);
    assert.equal(state.balance(wallet(2).address), 70n * BEAN);
    connectBlock(state, block([send(wallet(1), wallet(5), 1n, { fee: 7n, chainId: capped.chainId })]), capped);
    assert.equal(state.balance(wallet(2).address), 70n * BEAN + 7n);
    assert.equal(state.issued, capped.totalSupply);
    assert.equal(state.held(), state.issued);
  });

  it('accepts self-transfers but still charges the fee', () => {
    const state = LedgerState.fromParams(params);
    connectBlock(state, block([send(wallet(1), wallet(1), 5n * BEAN, { fee: 3n })]), params);
    assert.equal(state.balance(wallet(1).address), 1_000n * BEAN - 3n);
  });
});

describe('certificates', () => {
  const params = testParams();
  const candidate = buildBlock({ params, parent: { height: 0, hash: params.genesisHash, timestamp: params.createdAt }, proposer: wallet(2).address, now: params.createdAt + 1 });
  const hash = headerHash(candidate.header);
  const context = { chainId: params.chainId, height: 1, blockHash: hash, validators: params.validators };
  const signers = validatorWallets(4);

  it('accepts a quorum of distinct validator precommits', () => {
    verifyCertificate(certify(params, candidate, signers.slice(0, 3)), context);
    verifyCertificate(certify(params, candidate, signers), context);
    verifyCertificate(certify(params, candidate, signers.slice(1), 7), context);
  });

  it('rejects certificates without a quorum, with repeats, outsiders, or the wrong block', () => {
    const cases = [
      certify(params, candidate, signers.slice(0, 2)),
      certify(params, candidate, [signers[0], signers[0], signers[1]]),
      certify(params, candidate, [signers[0], signers[1], wallet(9)]),
      { ...certify(params, candidate, signers), hash: EMPTY_HASH },
      { ...certify(params, candidate, signers), height: 2 },
      { ...certify(params, candidate, signers, 1), round: 0 },
      { ...certify(params, candidate, signers), extra: true },
    ];
    for (const certificate of cases) assert.throws(() => verifyCertificate(certificate, context), ConsensusError);
  });
});

describe('validator updates', () => {
  const params = testParams();
  const current = validatorWallets(4);
  const update = (validators, approvers, sequence = 1) => {
    const list = validators.map(validatorEntry);
    const payload = approvalPayload(params.chainId, sequence, list);
    return { sequence, validators: list, approvals: approvers.map(w => ({ validator: w.address, signature: signPayload(payload, w.seed).signature })) };
  };
  const context = { chainId: params.chainId, validators: params.validators, sequence: 0 };

  it('accepts a new set approved by a quorum of the current set', () => {
    const list = checkValidatorUpdate(update(validatorWallets(5), current.slice(0, 3)), context);
    assert.equal(list.length, 5);
    assert.equal(list[4].address, wallet(5).address);
  });

  it('rejects stale sequences, thin approvals, outsiders, bad entries, and tampered lists', () => {
    const tampered = update(validatorWallets(5), current);
    tampered.validators[4] = validatorEntry(wallet(6));
    const forgedEntry = { ...validatorEntry(wallet(5)), address: wallet(6).address };
    const cases = [
      update(validatorWallets(5), current, 2),
      update(validatorWallets(5), current.slice(0, 2)),
      update(validatorWallets(5), [current[0], current[1], wallet(9)]),
      { ...update(validatorWallets(5), current), validators: [forgedEntry], approvals: [] },
      tampered,
    ];
    for (const candidate of cases) assert.throws(() => checkValidatorUpdate(candidate, context), ConsensusError);
  });

  it('switches the active set and bumps the sequence when the block applies', () => {
    const state = LedgerState.fromParams(params);
    const checked = checkBlock(state, block([], wallet(2).address, update([wallet(1), wallet(2), wallet(3)], current)), params);
    assert.equal(checked.validators.length, 3);
    applyBlock(state, checked);
    assert.deepEqual(state.validators.map(v => v.address), [wallet(1), wallet(2), wallet(3)].map(w => w.address));
    assert.equal(state.validatorSequence, 1);
    assert.throws(() => checkBlock(state, block([], wallet(2).address, update(validatorWallets(5), current)), params), /sequence must be 2/);
  });
});

describe('block shape', () => {
  const params = testParams();
  const parent = { height: 0, hash: params.genesisHash, timestamp: params.createdAt };

  it('builds shape-valid blocks and binds transactions and updates through the header', () => {
    const transaction = createTransfer({ seed: wallet(1).seed, from: wallet(1).address, chainId: params.chainId, to: wallet(5).address, amount: 1n, fee: 1n, nonce: 0 });
    const candidate = buildBlock({ params, parent, proposer: wallet(2).address, transactions: [transaction], now: 5 });
    checkBlockShape(candidate, params);
    assert.equal(candidate.header.updateHash, EMPTY_HASH);
    assert.equal(candidate.header.timestamp, params.createdAt + 1, 'never earlier than the parent');
    const tamperedTx = structuredClone(candidate);
    tamperedTx.transactions[0].payload.memo = 'changed';
    assert.throws(() => checkBlockShape(tamperedTx, params), /root mismatch/);
    const tamperedUpdate = structuredClone(candidate);
    tamperedUpdate.validatorUpdate = { sequence: 1, validators: [], approvals: [] };
    assert.throws(() => checkBlockShape(tamperedUpdate, params), /update hash mismatch/);
    tamperedUpdate.header.updateHash = updateHash(tamperedUpdate.validatorUpdate);
    assert.notEqual(headerHash(tamperedUpdate.header), headerHash(candidate.header), 'the update changes the block hash');
    const { validatorUpdate: _dropped, ...missingKey } = candidate;
    assert.throws(() => checkBlockShape(missingKey, params), /missing or unknown fields/);
  });

  it('enforces the transaction count and size limits', () => {
    const small = loadParams(testGenesis({ maxBlockTransactions: 1 }));
    const tx = n => createTransfer({ seed: wallet(1).seed, from: wallet(1).address, chainId: small.chainId, to: wallet(5).address, amount: 1n, fee: 1n, nonce: n });
    const candidate = buildBlock({ params: small, parent, proposer: wallet(2).address, transactions: [tx(0), tx(1)], now: 5 });
    assert.throws(() => checkBlockShape(candidate, small), /Too many/);
  });
});
