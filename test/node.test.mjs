import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { FrobeniusNode } from '../src/node.mjs';
import { MemoryStore } from '../src/store.mjs';
import { fetchJSON } from '../src/http.mjs';
import { approvalPayload } from '../src/consensus.mjs';
import { signPayload } from '../src/crypto.mjs';
import { createTransfer } from '../src/wallet.mjs';
import { BEAN, testGenesis, validatorEntry, validatorWallets, wallet } from './helpers.mjs';

// Real HTTP between nodes on 127.0.0.1 with real ML-DSA signatures. Blocks every
// second; genesis an hour ago so the first timestamps are valid.
const genesis = testGenesis({ createdAt: Date.now() - 3_600_000, blockInterval: 1_000 });
const TIMEOUTS = { propose: 1_500, prevote: 600, precommit: 600, delta: 300, max: 10_000 };
const running = new Set();

async function startNode({ validator = null, peers = [], store = new MemoryStore() } = {}) {
  const node = new FrobeniusNode({
    genesis, store, port: 0, host: '127.0.0.1', peers, pollInterval: 300, timeouts: TIMEOUTS,
    validatorSeed: validator?.seed ?? null, log: () => {},
  });
  await node.start();
  node.url = `http://127.0.0.1:${node.port}`;
  node.memory = store;
  running.add(node);
  return node;
}

async function stopNode(node) {
  running.delete(node);
  await node.stop();
}

async function waitFor(condition, message, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

const connect = (a, b) => { a.peers.add(b.url); b.peers.add(a.url); };

after(async () => { for (const node of [...running]) await node.stop(); });

describe('a network of validators over HTTP', () => {
  it('produces blocks, confirms transfers, survives validator loss and restart, and changes its validator set', async () => {
    const v = [await startNode({ validator: wallet(1) })];
    for (let i = 1; i < 4; i += 1) {
      v.push(await startNode({ validator: wallet(i + 1), peers: v.map(node => node.url) }));
      for (const earlier of v.slice(0, -1)) earlier.peers.add(v.at(-1).url);
    }
    const observer = await startNode({ peers: v.map(node => node.url) });
    await waitFor(() => v.every(node => node.chain.height >= 3) && observer.chain.height >= 3, 'four validators and an observer to reach height 3');
    const hashes = new Set([...v, observer].map(node => node.chain.hashAt(3)));
    assert.equal(hashes.size, 1, 'everyone has the same block 3');

    // A transfer submitted to the observer is relayed, included, and visible everywhere.
    const info = await fetchJSON(`${observer.url}/api/info`);
    assert.equal(info.protocol, 3);
    const account = await fetchJSON(`${observer.url}/api/account?address=${wallet(1).address}`);
    const sent = createTransfer({ seed: wallet(1).seed, from: wallet(1).address, chainId: info.chainId, to: wallet(6).address, amount: 4n * BEAN, fee: 2_000n, nonce: account.nonce, memo: 'hello' });
    const submitted = await fetchJSON(`${observer.url}/api/tx`, { method: 'POST', body: sent });
    assert.equal(submitted.status, 'pending');
    await waitFor(async () => (await fetchJSON(`${observer.url}/api/tx?id=${submitted.id}`)).status === 'confirmed', 'the transfer to confirm');
    const received = await fetchJSON(`${v[2].url}/api/account?address=${wallet(6).address}`);
    assert.equal(received.balance, (4n * BEAN).toString());
    assert.equal(received.transactions[0].memo, 'hello');

    // Three of four keep going; the fourth comes back from its own store and catches up.
    const store4 = v[3].memory;
    const before = v[0].chain.height;
    await stopNode(v[3]);
    await waitFor(() => v[0].chain.height >= before + 3, 'progress with three of four validators');
    v[3] = await startNode({ validator: wallet(4), peers: [v[0].url, v[1].url], store: store4 });
    for (const node of [v[0], v[1], v[2], observer]) node.peers.add(v[3].url);
    await waitFor(() => v[3].chain.height >= v[0].chain.height - 1 && v[3].bft.isValidator, 'the restarted validator to catch up');

    // A fifth validator joins through an approved update, syncs, and earns rewards.
    const list = validatorWallets(5).map(validatorEntry);
    const payload = approvalPayload(info.chainId, 1, list);
    const update = { sequence: 1, validators: list, approvals: validatorWallets(4).slice(0, 3).map(w => ({ validator: w.address, signature: signPayload(payload, w.seed).signature })) };
    await assert.rejects(fetchJSON(`${observer.url}/api/validators`, { method: 'POST', body: update }), /not an active validator/);
    const accepted = await fetchJSON(`${v[0].url}/api/validators`, { method: 'POST', body: update });
    assert.equal(accepted.status, 'pending');
    await waitFor(() => [...v, observer].every(node => node.chain.validators.length === 5), 'every node to apply the validator update');
    const v5 = await startNode({ validator: wallet(5), peers: v.map(node => node.url) });
    for (const node of v) node.peers.add(v5.url);
    await waitFor(() => v5.chain.height >= v[0].chain.height - 1 && v5.bft.isValidator, 'the new validator to sync and join');
    await waitFor(() => v5.chain.balance(wallet(5).address) > 0n, 'the new validator to propose a block and be paid');
    const validators = await fetchJSON(`${v5.url}/api/validators`);
    assert.deepEqual([validators.validators.length, validators.quorum, validators.sequence], [5, 4, 1]);

    // Two of five gone: no quorum, no blocks. One returns: blocks again.
    const store2 = v[1].memory;
    await stopNode(v[1]);
    await stopNode(v[2]);
    const stalled = v[0].chain.height;
    await new Promise(resolve => setTimeout(resolve, 5_000));
    assert.ok(v[0].chain.height <= stalled + 1, 'at most one in-flight block completes without a quorum');
    v[1] = await startNode({ validator: wallet(2), peers: [v[0].url, v5.url], store: store2 });
    connect(v[0], v[1]);
    connect(v5, v[1]);
    await waitFor(() => v[0].chain.height >= stalled + 3, 'progress to resume with four of five validators');
    assert.equal(v[0].chain.held(), v[0].chain.issued);
  });

  it('answers wallet queries and rejects bad input', async () => {
    const node = await startNode({ validator: wallet(1), peers: [] });
    await assert.rejects(fetchJSON(`${node.url}/api/account?address=nope`), /valid Bean address/);
    await assert.rejects(fetchJSON(`${node.url}/api/tx`, { method: 'POST', body: { payload: {} } }), /Transaction/);
    await assert.rejects(fetchJSON(`${node.url}/api/tx?id=${'ab'.repeat(48)}`), /Unknown transaction/);
    await assert.rejects(fetchJSON(`${node.url}/api/block?height=999`), /Unknown block/);
    await assert.rejects(fetchJSON(`${node.url}/api/validators`, { method: 'POST', body: { sequence: 1 } }), /missing or unknown/);
    assert.equal((await fetchJSON(`${node.url}/api/genesis`)).name, 'test');
    assert.equal((await fetchJSON(`${node.url}/healthz`)).ok, true);
    assert.equal((await fetchJSON(`${node.url}/p2p/consensus?after=0`)).session.length, 16);
  });
});
