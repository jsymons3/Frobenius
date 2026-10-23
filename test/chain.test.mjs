import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chain, MAX_SYNC_RESPONSE_BYTES } from '../src/chain.mjs';
import { Mempool } from '../src/mempool.mjs';
import { MemoryStore, SQLiteStore } from '../src/store.mjs';
import { ConsensusError, buildBlock, transactionId } from '../src/consensus.mjs';
import { BEAN, approve, certify, commitBlock, quorumOf, testParams, transfer, validatorWallets, wallet } from './helpers.mjs';

const newChain = (params = testParams()) => new Chain(params, new MemoryStore());
const candidateOn = (chain, { proposer = wallet(2), now } = {}) =>
  buildBlock({ params: chain.params, parent: chain.tip, proposer: proposer.address, now: now ?? chain.tip.timestamp + 1 });

describe('committing blocks', () => {
  it('appends blocks, pays the proposer, and reports the chain state', () => {
    const chain = newChain();
    for (let i = 0; i < 3; i += 1) commitBlock(chain, { proposer: wallet(2) });
    assert.equal(chain.height, 3);
    assert.equal(chain.balance(wallet(2).address), 150n * BEAN);
    assert.equal(chain.held(), chain.issued);
    const info = chain.info();
    assert.equal(info.height, 3);
    assert.equal(info.tipHash, chain.tip.hash);
    assert.equal(info.quorum, 3);
    assert.equal(chain.hashAt(3), chain.tip.hash);
    assert.equal(chain.hashAt(0), chain.params.genesisHash);
  });

  it('rejects blocks that do not extend the tip or come from a non-validator', () => {
    const chain = newChain();
    const first = commitBlock(chain);
    const stale = first.block;
    assert.throws(() => chain.commit(stale, first.certificate), /height must be 2/);
    const wrongParent = candidateOn(chain);
    wrongParent.header.previousHash = chain.params.genesisHash;
    assert.throws(() => chain.commit(wrongParent, certify(chain.params, wrongParent, quorumOf(chain))), /does not extend/);
    const early = candidateOn(chain);
    early.header.timestamp = chain.tip.timestamp;
    assert.throws(() => chain.validate(early), /after its parent/);
    const future = candidateOn(chain, { now: chain.tip.timestamp + 3_600_000 });
    assert.throws(() => chain.validate(future, { now: chain.tip.timestamp }), /too far in the future/);
    chain.validate(future);
    const outsider = candidateOn(chain, { proposer: wallet(8) });
    assert.throws(() => chain.validate(outsider), /not an active validator/);
  });

  it('requires a certificate from a quorum of the active set', () => {
    const chain = newChain();
    const candidate = candidateOn(chain);
    assert.throws(() => chain.commit(candidate, null), ConsensusError);
    assert.throws(() => chain.commit(candidate, certify(chain.params, candidate, validatorWallets(2))), /quorum/);
    assert.throws(() => chain.commit(candidate, certify(chain.params, candidate, [wallet(1), wallet(8), wallet(9)])), /non-validator/);
    const other = candidateOn(chain, { proposer: wallet(3) });
    assert.throws(() => chain.commit(candidate, certify(chain.params, other, quorumOf(chain))), /does not match/);
    chain.commit(candidate, certify(chain.params, candidate, quorumOf(chain)));
    assert.equal(chain.height, 1);
  });

  it('switches validator sets through an approved update and certifies the next block with the new set', () => {
    const chain = newChain();
    const oldQuorum = quorumOf(chain);
    commitBlock(chain, { validatorUpdate: approve(chain, validatorWallets(5)) });
    assert.equal(chain.validators.length, 5);
    assert.equal(chain.validatorSequence, 1);
    assert.equal(chain.quorum, 4);
    const next = candidateOn(chain);
    assert.throws(() => chain.commit(next, certify(chain.params, next, oldQuorum)), /quorum/);
    chain.commit(next, certify(chain.params, next, validatorWallets(5).slice(1)));
    assert.throws(() => commitBlock(chain, { validatorUpdate: approve(chain, validatorWallets(5), { sequence: 1 }) }), /sequence must be 2/);
    commitBlock(chain, { validatorUpdate: approve(chain, [wallet(1), wallet(2), wallet(3)]) });
    assert.deepEqual(chain.validators.map(v => v.address), [wallet(1), wallet(2), wallet(3)].map(w => w.address));
    assert.equal(chain.quorum, 3);
  });

  it('indexes history and transactions and drops included transfers from the mempool', () => {
    const chain = newChain();
    const pool = new Mempool(chain);
    const sent = transfer(chain, wallet(1), wallet(5), 3n * BEAN, { memo: 'lunch' });
    pool.add(sent);
    commitBlock(chain, { mempool: pool, proposer: wallet(3) });
    assert.equal(pool.size, 0);
    assert.deepEqual(chain.findTransaction(transactionId(sent)), { height: 1, index: 0 });
    const [receive] = chain.history(wallet(5).address);
    assert.deepEqual([receive.type, receive.amount, receive.memo, receive.height], ['receive', (3n * BEAN).toString(), 'lunch', 1]);
    assert.deepEqual(chain.history(wallet(1).address).map(item => item.type), ['send', 'genesis']);
    const [reward] = chain.history(wallet(3).address);
    assert.deepEqual([reward.type, reward.amount], ['reward', (50n * BEAN + 1_000n).toString()]);
    assert.equal(chain.block(1).certificate.height, 1);
    assert.equal(chain.blockByHash(chain.tip.hash).block.header.height, 1);
  });
});

describe('persistence', () => {
  it('rebuilds the same state, validators, and indexes from SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frobenius-'));
    const file = join(dir, 'chain.sqlite');
    try {
      const params = testParams();
      const store = new SQLiteStore(file);
      const chain = new Chain(params, store);
      const pool = new Mempool(chain);
      pool.add(transfer(chain, wallet(1), wallet(5), 2n * BEAN));
      commitBlock(chain, { mempool: pool });
      commitBlock(chain, { validatorUpdate: approve(chain, validatorWallets(5)) });
      commitBlock(chain, { proposer: wallet(5) });
      const snapshot = c => ({ tip: c.tip.hash, height: c.height, balance: c.balance(wallet(5).address), issued: c.issued, validators: c.validators.length, sequence: c.validatorSequence, history: c.history(wallet(5).address).length });
      const expected = snapshot(chain);
      store.close();

      for (const verify of [true, false]) {
        const reopened = new SQLiteStore(file);
        const reloaded = new Chain(params, reopened);
        assert.equal(reloaded.load({ verify }), 3);
        assert.deepEqual(snapshot(reloaded), expected);
        assert.equal(reloaded.held(), reloaded.issued);
        reopened.close();
      }
      const other = new SQLiteStore(file);
      assert.throws(() => new Chain(testParams({ name: 'other' }), other), /different network/);
      other.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a data directory that another node holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frobenius-'));
    try {
      const first = new SQLiteStore(join(dir, 'chain.sqlite'));
      assert.throws(() => new SQLiteStore(join(dir, 'chain.sqlite')), /already open/);
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sync batches', () => {
  function syncAll(source, target, limit) {
    while (target.height < source.height) {
      const batch = source.blocksFrom(target.height + 1, limit);
      assert.ok(batch.length > 0, 'the source can always serve a certified batch');
      target.commitBatch(batch);
    }
  }

  it('serves certified batches that a fresh node can verify and apply', () => {
    const source = newChain();
    const pool = new Mempool(source);
    pool.add(transfer(source, wallet(1), wallet(5), BEAN));
    commitBlock(source, { mempool: pool });
    for (let i = 0; i < 11; i += 1) commitBlock(source, { proposer: wallet((i % 4) + 1) });
    const target = newChain();
    syncAll(source, target, 5);
    assert.equal(target.tip.hash, source.tip.hash);
    assert.equal(target.balance(wallet(5).address), BEAN);
    assert.deepEqual(source.blocksFrom(99), []);
    assert.deepEqual(source.blocksFrom(0), []);
  });

  it('keeps checkpoints when pruning so old ranges stay verifiable', () => {
    const source = newChain();
    for (let i = 0; i < 12; i += 1) commitBlock(source, { proposer: wallet((i % 4) + 1), validatorUpdate: i === 5 ? approve(source, validatorWallets(5)) : null });
    source.prune({ retention: 3, interval: 4 });
    assert.equal(source.block(3).certificate, null);
    assert.equal(source.block(5).certificate, null);
    assert.notEqual(source.block(4).certificate, null);
    assert.notEqual(source.block(6).certificate, null, 'validator membership changes keep their own certificates');
    assert.notEqual(source.block(8).certificate, null);
    assert.notEqual(source.block(10).certificate, null);
    const batch = source.blocksFrom(1, 2);
    assert.equal(batch.length, 4, 'extends to the next certified block');
    assert.equal(batch[1].certificate, null);
    const target = newChain();
    syncAll(source, target, 3);
    assert.equal(target.tip.hash, source.tip.hash);
    assert.equal(target.validators.length, 5);
  });

  it('paginates by exact UTF-8 response bytes, including certificates and JSON framing', () => {
    const source = newChain();
    for (let i = 0; i < 6; i += 1) {
      commitBlock(source, { transactions: [transfer(source, wallet(1), wallet(5), BEAN, { memo: 'Beans 🌱' })] });
    }
    const firstTwo = source.blocksFrom(1, 2);
    const maxBytes = Buffer.byteLength(JSON.stringify({ blocks: firstTwo }));
    assert.deepEqual(source.blocksFrom(1, 100, { maxBytes }), firstTwo, 'an exactly full page fits');
    assert.equal(source.blocksFrom(1, 100, { maxBytes: maxBytes - 1 }).length, 1, 'one byte below the full page sends only its certified prefix');
    const target = newChain();
    let pages = 0;
    while (target.height < source.height) {
      const batch = source.blocksFrom(target.height + 1, 100, { maxBytes });
      assert.ok(Buffer.byteLength(JSON.stringify({ blocks: batch })) <= maxBytes);
      assert.notEqual(batch.at(-1).certificate, null);
      target.commitBatch(batch);
      pages += 1;
    }
    assert.ok(pages >= 3);
    assert.equal(target.tip.hash, source.tip.hash);
    assert.equal(target.balance(wallet(5).address), source.balance(wallet(5).address));
  });

  it('sizes old checkpoint spans for maximum-size blocks so pruning cannot strand sync', () => {
    for (const maxBlockBytes of [8 * 1024 * 1024, 32 * 1024 * 1024]) {
      const params = testParams({ maxBlockBytes });
      const source = newChain(params);
      for (let i = 0; i < 16; i += 1) commitBlock(source);
      source.prune({ retention: 1, interval: 100 });
      let previousCheckpoint = 0;
      let certificateCount = 0;
      for (let height = 1; height <= source.height; height += 1) {
        if (source.block(height).certificate === null) continue;
        const span = height - previousCheckpoint;
        const wrapperBytes = Buffer.byteLength('{"blocks":[]}') + span * Buffer.byteLength('{"block":,"certificate":null},');
        assert.ok(span * maxBlockBytes + wrapperBytes + 1024 * 1024 <= MAX_SYNC_RESPONSE_BYTES,
          `checkpoint span ${previousCheckpoint + 1}-${height} fits even with maximum-size blocks and a full certificate`);
        previousCheckpoint = height;
        certificateCount += 1;
      }
      if (maxBlockBytes === 32 * 1024 * 1024) assert.equal(certificateCount, source.height, '32 MiB blocks need a certificate at every height');
      else assert.equal(source.block(1).certificate, null, 'smaller blocks still benefit from certificate pruning');
      const target = newChain(params);
      syncAll(source, target, 1);
      assert.equal(target.tip.hash, source.tip.hash);
    }
  });

  it('fails explicitly instead of sending an oversized or uncertified pre-fix checkpoint span', () => {
    const source = newChain();
    for (let i = 0; i < 6; i += 1) commitBlock(source);
    source.prune({ retention: 1, interval: 100 });
    const full = source.blocksFrom(1, 1);
    assert.equal(full.length, 5);
    const maxBytes = Buffer.byteLength(JSON.stringify({ blocks: full })) - 1;
    assert.throws(() => source.blocksFrom(1, 1, { maxBytes }), /restore missing certificates from an unpruned archive/);
  });

  it('retains validator-update certificates when pruning SQLite history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frobenius-pruning-'));
    const file = join(dir, 'chain.sqlite');
    let store;
    try {
      const params = testParams();
      store = new SQLiteStore(file);
      const source = new Chain(params, store);
      commitBlock(source);
      commitBlock(source, { validatorUpdate: approve(source, validatorWallets(5)) });
      for (let i = 0; i < 4; i += 1) commitBlock(source);
      source.prune({ retention: 1, interval: 4 });
      assert.equal(source.block(1).certificate, null);
      assert.notEqual(source.block(2).certificate, null);
      assert.notEqual(source.block(4).certificate, null);
      const target = newChain(params);
      syncAll(source, target, 1);
      assert.equal(target.tip.hash, source.tip.hash);
      assert.equal(target.validators.length, 5);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('authenticates each validator transition with the previous set before trusting its successors', () => {
    const source = newChain();
    commitBlock(source);
    commitBlock(source, { validatorUpdate: approve(source, validatorWallets(5)) });
    for (let i = 0; i < 3; i += 1) commitBlock(source);
    source.prune({ retention: 1, interval: 100 });
    const good = source.blocksFrom(1, 100);
    const target = newChain();
    const missing = structuredClone(good);
    missing[1].certificate = null;
    assert.throws(() => target.commitBatch(missing), /validator-update block must carry a certificate/);
    const forged = structuredClone(good);
    forged[1].certificate = certify(source.params, forged[1].block, [wallet(1)]);
    assert.throws(() => target.commitBatch(forged), /quorum/);
    assert.equal(target.height, 0);
    assert.equal(target.validators.length, 4);
    target.commitBatch(good);
    assert.equal(target.tip.hash, source.tip.hash);
    assert.equal(target.validators.length, 5);
  });

  it('rejects tampered, broken, or uncertified batches without changing state', () => {
    const source = newChain();
    for (let i = 0; i < 6; i += 1) commitBlock(source, { transactions: i === 1 ? [transfer(source, wallet(1), wallet(5), BEAN)] : [] });
    source.prune({ retention: 1, interval: 10 });
    const target = newChain();
    const good = source.blocksFrom(1, 6);
    assert.equal(good.length, 6);

    const tampered = structuredClone(good);
    tampered[1].block.transactions[0].payload.memo = 'stolen';
    assert.throws(() => target.commitBatch(tampered), /root mismatch/);

    const broken = structuredClone(good);
    broken[2].block.header.previousHash = source.params.genesisHash;
    assert.throws(() => target.commitBatch(broken), /does not continue/);

    const uncertified = structuredClone(good);
    uncertified[5].certificate = null;
    assert.throws(() => target.commitBatch(uncertified), /must carry a certificate/);

    const forged = structuredClone(good);
    forged[5].certificate = certify(source.params, forged[5].block, validatorWallets(2));
    assert.throws(() => target.commitBatch(forged), /quorum/);

    assert.equal(target.height, 0);
    target.commitBatch(good);
    assert.equal(target.tip.hash, source.tip.hash);
  });
});
