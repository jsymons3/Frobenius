import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Chain } from '../src/chain.mjs';
import { buildBlock } from '../src/consensus.mjs';
import { MemoryStore } from '../src/store.mjs';
import { BEAN, certify, commitBlock, quorumOf, testParams, transfer, wallet } from './helpers.mjs';

describe('commit validation boundary', () => {
  it('rejects a changed body even when supplied with a previously checked result', () => {
    const store = new MemoryStore();
    const chain = new Chain(testParams(), store);
    const transaction = transfer(chain, wallet(1), wallet(5), BEAN);
    const block = buildBlock({ params: chain.params, parent: chain.tip,
      proposer: wallet(2).address, transactions: [transaction], now: chain.tip.timestamp + 1 });
    const checked = chain.validate(block);
    const certificate = certify(chain.params, block, quorumOf(chain));
    const changed = structuredClone(block);
    changed.transactions = [];
    // The old API accepted this cached result, allowing the persisted body to
    // disagree with the state it applied. Extra arguments must not bypass checks.
    assert.throws(() => chain.commit(changed, certificate, { checked }), /root/i);
    assert.equal(chain.height, 0);
    assert.equal(store.height, 0);
    assert.equal(chain.balance(wallet(5).address), 0n);
    chain.commit(block, certificate);
    assert.equal(chain.balance(wallet(5).address), BEAN);
    assert.deepEqual(store.getBlock(1).block, block);
  });

  it('revalidates a checked candidate against the current chain tip', () => {
    const chain = new Chain(testParams(), new MemoryStore());
    const block = buildBlock({ params: chain.params, parent: chain.tip,
      proposer: wallet(2).address, now: chain.tip.timestamp + 1 });
    const checked = chain.validate(block);
    const certificate = certify(chain.params, block, quorumOf(chain));
    commitBlock(chain);
    const tip = chain.tip;
    const issued = chain.issued;
    assert.throws(() => chain.commit(block, certificate, { checked }), /height must be 2/);
    assert.deepEqual(chain.tip, tip);
    assert.equal(chain.issued, issued);
  });
});
