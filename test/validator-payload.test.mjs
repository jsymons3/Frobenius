import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvalPayload, checkValidatorUpdate, quorum } from '../src/consensus.mjs';
import { canonicalJSON, signPayload, verifyPayload } from '../src/crypto.mjs';
import { testParams, validatorEntry, validatorWallets, wallet } from './helpers.mjs';

describe('validator approval payload bounds', () => {
  for (const count of [33, 100]) {
    it(`signs and verifies an update to ${count} validators`, () => {
      const params = testParams();
      const validators = validatorWallets(count).map(validatorEntry);
      const payload = approvalPayload(params.chainId, 1, validators);
      assert.ok(Buffer.byteLength(canonicalJSON(payload, 512 * 1024)) > 128 * 1024);
      const approvals = validatorWallets(3).map(w => ({
        validator: w.address, signature: signPayload(payload, w.seed).signature,
      }));
      assert.deepEqual(checkValidatorUpdate({ sequence: 1, validators, approvals }, {
        chainId: params.chainId, validators: params.validators, sequence: 0,
      }), validators);
    });
  }

  it('accepts the required quorum from a full 100-validator set', () => {
    const signers = validatorWallets(100);
    const validators = signers.map(validatorEntry);
    const params = testParams({ validators });
    const payload = approvalPayload(params.chainId, 1, validators);
    const approvals = signers.slice(0, quorum(100)).map(w => ({
      validator: w.address, signature: signPayload(payload, w.seed).signature,
    }));
    assert.equal(checkValidatorUpdate({ sequence: 1, validators, approvals }, {
      chainId: params.chainId, validators, sequence: 0,
    }).length, 100);
  });

  it('keeps separate finite limits for approvals and ordinary signed messages', () => {
    const signer = wallet(1);
    const signature = signPayload({ type: 'prevote' }, signer.seed).signature;
    for (const payload of [
      { type: 'validators', padding: 'a'.repeat(512 * 1024) },
      { type: 'prevote', padding: 'a'.repeat(128 * 1024) },
    ]) {
      assert.throws(() => signPayload(payload, signer.seed), /too large/);
      assert.equal(verifyPayload(payload, signer.publicKey, signature), false);
    }
  });
});
