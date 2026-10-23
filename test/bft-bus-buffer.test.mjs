import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tendermint } from '../src/bft.mjs';
import { Chain } from '../src/chain.mjs';
import { FrobeniusNode } from '../src/node.mjs';
import { MemoryStore } from '../src/store.mjs';
import { buildBlock, headerHash, proposalPayload, votePayload } from '../src/consensus.mjs';
import { signPayload } from '../src/crypto.mjs';
import { certify, testGenesis, validatorWallets, wallet } from './helpers.mjs';

describe('future proposal buffering through the consensus bus', () => {
  for (const damage of ['transactions', 'validatorUpdate', 'extra field']) {
    it(`rejects a future proposal with ${damage} damage without occupying its signed message key`, () => {
      // Exercise the production bus and real signatures entirely in memory.
      // No server is started and the node has no peers or network traffic.
      const store = new MemoryStore();
      const node = new FrobeniusNode({ genesis: testGenesis(), store, peers: [], log: () => {} });
      node.chain = new Chain(node.params, store);
      node.chain.load();
      node.bft = new Tendermint({
        chainId: node.params.chainId,
        effects: {
          broadcast: () => {}, schedule: () => () => {}, persist: () => {}, propose: () => null,
          validate: block => { node.chain.validate(block); return true; },
          decide: (block, certificate) => node.chain.commit(block, certificate),
        },
      });
      node.bft.setValidators(node.chain.validators);
      node.bft.start(1);
      const parent = buildBlock({ params: node.params, parent: node.chain.tip, proposer: wallet(2).address, now: node.chain.tip.timestamp + 1_000 });
      const future = buildBlock({ params: node.params, parent: { ...parent.header, hash: headerHash(parent.header) }, proposer: wallet(3).address, now: parent.header.timestamp + 1_000 });
      const payload = proposalPayload(node.params.chainId, 2, 0, headerHash(future.header), -1);
      const message = { ...payload, validator: wallet(3).address, signature: signPayload(payload, wallet(3).seed).signature };
      const incorrect = structuredClone(future);
      if (damage === 'transactions') incorrect.transactions.push({ payload: { memo: 'body does not match the header' } });
      if (damage === 'validatorUpdate') incorrect.validatorUpdate = { sequence: 1, validators: [], approvals: [] };
      if (damage === 'extra field') incorrect.uncommitted = 'not part of a block';
      assert.equal(node.bus.receive({ message, block: incorrect }).status, 'rejected');
      assert.equal(node.bus.seq, 0, 'rejected bodies must not enter the bus duplicate cache');
      assert.equal(node.bus.receive({ message, block: future }).status, 'buffered');
      assert.equal(node.bus.seq, 1);
      node.chain.commit(parent, certify(node.params, parent, validatorWallets(3)));
      node.bft.start(2);
      for (const signer of validatorWallets(3)) {
        const vote = votePayload('precommit', node.params.chainId, 2, 0, message.hash);
        node.bus.receive({ message: { ...vote, validator: signer.address, signature: signPayload(vote, signer.seed).signature } });
      }
      assert.equal(node.chain.height, 2);
      assert.equal(node.chain.hashAt(2), message.hash);
      node.bft.stop();
      store.close();
    });
  }
});
