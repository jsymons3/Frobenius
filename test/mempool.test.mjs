import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Chain } from '../src/chain.mjs';
import { Mempool, PolicyError } from '../src/mempool.mjs';
import { MemoryStore } from '../src/store.mjs';
import { ConsensusError, transactionId } from '../src/consensus.mjs';
import { BEAN, commitBlock, testParams, transfer, wallet } from './helpers.mjs';

function setup(options) {
  const chain = new Chain(testParams(), new MemoryStore());
  return { chain, pool: new Mempool(chain, options) };
}

describe('mempool', () => {
  it('treats a re-signed copy of a pending transfer as the same transfer', () => {
    const { chain, pool } = setup();
    const first = pool.add(transfer(chain, wallet(1), wallet(5), BEAN));
    const again = pool.add(transfer(chain, wallet(1), wallet(5), BEAN));
    assert.equal(again.id, first.id);
    assert.equal(pool.size, 1);
  });

  it('accepts a gap-free run of nonces and rejects gaps and reused confirmed nonces', () => {
    const { chain, pool } = setup();
    for (let nonce = 0; nonce < 3; nonce += 1) pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { nonce }));
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { nonce: 5 })), /expected 3/);
    commitBlock(chain, { mempool: pool });
    assert.equal(chain.nonce(wallet(1).address), 3);
    assert.equal(pool.size, 0);
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(5), 2n * BEAN, { nonce: 1 })), ConsensusError);
  });

  it('reports an already confirmed transfer as confirmed', () => {
    const { chain, pool } = setup();
    const sent = transfer(chain, wallet(1), wallet(5), BEAN);
    pool.add(sent);
    commitBlock(chain, { mempool: pool });
    assert.deepEqual(pool.add(sent), { id: transactionId(sent), status: 'confirmed' });
  });

  it('enforces the minimum relay fee and per-sender limit', () => {
    const { chain, pool } = setup({ maxPerSender: 2, minRelayFee: 500n });
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { fee: 499n })), PolicyError);
    pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { nonce: 0 }));
    pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { nonce: 1 }));
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { nonce: 2 })), /already has 2/);
  });

  it('replaces a pending transfer only for a higher fee', () => {
    const { chain, pool } = setup();
    const original = pool.add(transfer(chain, wallet(1), wallet(5), BEAN, { fee: 2_000n }));
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(6), BEAN, { fee: 2_000n })), /higher fee/);
    const replacement = pool.add(transfer(chain, wallet(1), wallet(6), BEAN, { fee: 3_000n }));
    assert.equal(replacement.replaced, original.id);
    assert.equal(pool.size, 1);
    assert.equal(pool.has(original.id), false);
  });

  it('only spends confirmed balance', () => {
    const { chain, pool } = setup();
    pool.add(transfer(chain, wallet(1), wallet(5), 600n * BEAN, { nonce: 0 }));
    assert.throws(() => pool.add(transfer(chain, wallet(1), wallet(5), 500n * BEAN, { nonce: 1 })), /Insufficient/);
    assert.throws(() => pool.add(transfer(chain, wallet(5), wallet(6), BEAN)), /Insufficient/, 'pending incoming funds are not spendable');
  });

  it('fills blocks highest fee first while keeping each sender in nonce order', () => {
    const { chain, pool } = setup();
    commitBlock(chain, { transactions: [transfer(chain, wallet(1), wallet(5), 100n * BEAN)] });
    pool.add(transfer(chain, wallet(1), wallet(6), BEAN, { fee: 1_000n, nonce: 1 }));
    pool.add(transfer(chain, wallet(1), wallet(6), BEAN, { fee: 9_000n, nonce: 2 }));
    pool.add(transfer(chain, wallet(5), wallet(6), BEAN, { fee: 5_000n, nonce: 0 }));
    const order = pool.select({ maxBytes: 1 << 20, maxCount: 10 }).map(({ payload }) => [payload.from === wallet(1).address ? 'w1' : 'w5', payload.nonce]);
    assert.deepEqual(order, [['w5', 0], ['w1', 1], ['w1', 2]]);
    assert.equal(pool.select({ maxBytes: 1 << 20, maxCount: 1 }).length, 1);
    assert.equal(pool.select({ maxBytes: 100, maxCount: 10 }).length, 0);
    commitBlock(chain, { mempool: pool });
    assert.equal(chain.balance(wallet(6).address), 3n * BEAN);
    assert.equal(pool.size, 0);
  });
});
