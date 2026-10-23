import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tendermint, payloadOf } from '../src/bft.mjs';
import { headerHash, proposalPayload, transactionRoot, updateHash, votePayload } from '../src/consensus.mjs';
import { canonicalJSON, sha3Hex } from '../src/crypto.mjs';

const chainId = 'frobenius-bft-regression';
const validators = Array.from({ length: 4 }, (_, index) => ({ address: `v${index}`, publicKey: `v${index}` }));
const sign = (payload, key) => sha3Hex(`${canonicalJSON(payload)}|${key}`);
const signed = (payload, validator) => ({ ...payload, validator, signature: sign(payload, validator) });
const block = () => ({
  header: { chainId, height: 1, previousHash: sha3Hex('genesis'), timestamp: 1, proposer: 'v1', txRoot: transactionRoot([]), updateHash: updateHash(null) },
  transactions: [], validatorUpdate: null,
});
const proposal = (value, round = 0, validRound = -1) => signed(proposalPayload(chainId, value.header.height, round, headerHash(value.header), validRound), `v${(value.header.height + round) % 4}`);

function engine({ me = null, validate = () => true, wal = null } = {}) {
  const broadcasts = []; const decisions = []; const records = [];
  const tm = new Tendermint({
    chainId, me, sign: payload => sign(payload, me), verify: (payload, key, signature) => signature === sign(payload, key),
    effects: {
      broadcast: (message, value) => broadcasts.push({ message, block: value }),
      schedule: () => () => {}, decide: (value, certificate) => decisions.push({ block: value, certificate }),
      persist: value => records.push(structuredClone(value)), propose: block, validate,
    },
  });
  tm.setValidators(validators);
  tm.start(1, wal);
  const receive = (message, value = null) => {
    assert.equal(tm.verify(message), null);
    return tm.receive(message, value);
  };
  return { tm, broadcasts, decisions, records, receive };
}

describe('proposal body validation and recovery records', () => {
  for (const field of ['transactions', 'validatorUpdate']) {
    it(`rejects an inconsistent ${field} re-proposal and retains the validated body`, () => {
      let validations = 0;
      const node = engine({ validate: () => { validations += 1; return true; } });
      const good = block();
      assert.equal(node.receive(proposal(good), good), 'accepted');
      const replacement = structuredClone(good);
      replacement[field] = field === 'transactions' ? [{ payload: { memo: 'different body' } }] : { sequence: 1, validators: [], approvals: [] };
      assert.equal(node.receive(proposal(replacement, 1, 0), replacement), 'rejected');
      assert.equal(validations, 1, 'a mismatched body must fail before using the validation cache');
      const hash = headerHash(good.header);
      for (const validator of ['v0', 'v1', 'v2']) node.receive(signed(votePayload('precommit', chainId, 1, 0, hash), validator));
      assert.equal(node.decisions.length, 1);
      assert.deepEqual(node.decisions[0].block, good);
    });
  }

  it('does not allow callers to mutate the body retained after validation', () => {
    const node = engine();
    const original = block();
    const expected = structuredClone(original);
    const hash = headerHash(original.header);
    node.receive(proposal(original), original);
    original.transactions.push({ payload: { memo: 'changed after receipt' } });
    for (const validator of ['v0', 'v1', 'v2']) node.receive(signed(votePayload('precommit', chainId, 1, 0, hash), validator));
    assert.deepEqual(node.decisions[0].block, expected);
    assert.ok(Object.isFrozen(node.decisions[0].block));
    assert.ok(Object.isFrozen(node.decisions[0].block.transactions));
  });

  it('does not let a rejected body prevent acceptance of a correct proposal with the same header', () => {
    const node = engine();
    const good = block();
    const malformed = { ...good, transactions: [{ payload: { memo: 'inconsistent root' } }] };
    assert.equal(node.receive(proposal(malformed), malformed), 'rejected');
    assert.equal(node.receive(proposal(good), good), 'accepted');
  });

  it('revalidates a previously rejected proposal instead of caching a false result', () => {
    let valid = false;
    const node = engine({ validate: () => valid });
    const good = block();
    assert.equal(node.receive(proposal(good), good), 'rejected');
    valid = true;
    assert.equal(node.receive(proposal(good), good), 'accepted');
  });

  it('snapshots future proposals and defers state validation until their height begins', () => {
    let validations = 0;
    const node = engine({ validate: () => { validations += 1; return true; } });
    const future = block();
    future.header.height = 2;
    future.header.proposer = 'v2';
    const expected = structuredClone(future);
    const message = proposal(future);
    const hash = message.hash;
    assert.equal(node.receive(message, future), 'buffered');
    assert.equal(validations, 0);
    future.transactions.push({ payload: { memo: 'mutated outside the engine' } });
    message.hash = sha3Hex('changed message');
    node.tm.start(2);
    assert.equal(validations, 1);
    for (const validator of ['v0', 'v1', 'v2']) node.receive(signed(votePayload('precommit', chainId, 2, 0, hash), validator));
    assert.equal(node.decisions.length, 1);
    assert.deepEqual(node.decisions[0].block, expected);
  });

  function lockedRecord() {
    const node = engine({ me: 'v0' });
    const good = block();
    const hash = headerHash(good.header);
    node.receive(proposal(good), good);
    for (const validator of ['v1', 'v3']) node.receive(signed(votePayload('prevote', chainId, 1, 0, hash), validator));
    return structuredClone(node.tm.wal());
  }

  it('persists a bounded quorum proof and rebroadcasts its original signed votes on recovery', () => {
    const wal = lockedRecord();
    assert.equal(wal.validPrevotes.length, 3);
    assert.ok(wal.validPrevotes.every(message => message.hash === wal.valid.hash && message.round === wal.valid.round));
    const restarted = engine({ me: 'v0', wal });
    for (const message of wal.validPrevotes) assert.ok(restarted.broadcasts.some(entry => entry.message.signature === message.signature));
    assert.deepEqual(restarted.tm.info().locked, wal.locked);
    assert.deepEqual(restarted.tm.info().valid, wal.valid);
  });

  it('persists a newly learned quorum proof when the local precommit was already saved', () => {
    const good = block();
    const hash = headerHash(good.header);
    const wal = {
      height: 1, round: 0, locked: { round: -1, hash: null }, valid: { round: -1, hash: null }, validBlock: null,
      votes: { 0: { prevote: signed(votePayload('prevote', chainId, 1, 0, hash), 'v0'), precommit: signed(votePayload('precommit', chainId, 1, 0, null), 'v0') } },
    };
    const restarted = engine({ me: 'v0', wal });
    restarted.receive(proposal(good), good);
    for (const validator of ['v1', 'v3']) restarted.receive(signed(votePayload('prevote', chainId, 1, 0, hash), validator));
    const saved = restarted.records.at(-1);
    assert.equal(saved.valid.round, 0);
    assert.equal(saved.validPrevotes.length, 3);
    assert.equal(saved.votes[0].precommit.hash, null, 'recovery must not re-sign an existing vote');
  });

  it('retains legacy WAL locks without writing an incomplete quorum proof', () => {
    const wal = lockedRecord();
    delete wal.validPrevotes;
    const restarted = engine({ me: 'v0', wal });
    assert.deepEqual(restarted.tm.info().locked, wal.locked);
    assert.deepEqual(restarted.tm.wal().validPrevotes, []);
  });

  for (const damage of ['signature', 'duplicate', 'round', 'short']) {
    it(`rejects a recovery quorum proof with ${damage} damage`, () => {
      const wal = lockedRecord();
      if (damage === 'signature') wal.validPrevotes[0].signature = 'invalid';
      if (damage === 'duplicate') wal.validPrevotes[1] = wal.validPrevotes[0];
      if (damage === 'round') {
        wal.validPrevotes[0].round = 1;
        wal.validPrevotes[0].signature = sign(payloadOf(wal.validPrevotes[0]), wal.validPrevotes[0].validator);
      }
      if (damage === 'short') wal.validPrevotes.pop();
      assert.throws(() => engine({ me: 'v0', wal }), /recovery prevote proof/);
    });
  }
});
