import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJSON, generateWallet, sha3Hex, signPayload, verifyPayload } from '../src/crypto.mjs';
import {
  LedgerState, checkValidatorUpdate, headerHash, loadParams, transactionHash, transactionId, transactionRoot,
  verifyCertificate, votePayload,
} from '../src/consensus.mjs';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const digest = hex => sha3Hex(Buffer.from(hex, 'hex'));

it('reproduces the published protocol test vectors', () => {
  const wallets = vectors.wallets.map(entry => generateWallet(Buffer.from(entry.seed, 'hex')));
  wallets.forEach((wallet, i) => {
    assert.equal(wallet.address, vectors.wallets[i].address);
    assert.equal(digest(wallet.publicKey), vectors.wallets[i].publicKeySha3);
  });

  const params = loadParams(vectors.genesis.input);
  assert.equal(params.genesisHash, vectors.genesis.genesisHash);
  assert.equal(params.chainId, vectors.genesis.chainId);

  const { payload } = vectors.transaction;
  assert.equal(canonicalJSON(payload), vectors.transaction.canonicalPayload);
  const { publicKey, signature } = signPayload(payload, vectors.wallets[0].seed, { deterministic: true });
  const transaction = { payload, publicKey, signature };
  assert.equal(digest(signature), vectors.transaction.deterministicSignatureSha3);
  assert.equal(transactionId(transaction), vectors.transaction.transactionId);
  assert.equal(transactionHash(transaction), vectors.transaction.transactionHash);
  assert.ok(verifyPayload(payload, publicKey, signature));

  assert.equal(transactionRoot([transaction]), vectors.block.txRoot);
  assert.equal(headerHash(vectors.block.header), vectors.block.headerHash);

  const precommit = votePayload('precommit', params.chainId, 1, 0, vectors.block.headerHash);
  assert.equal(canonicalJSON(precommit), vectors.precommit.canonical);
  vectors.wallets.forEach((entry, i) => {
    assert.equal(digest(signPayload(precommit, entry.seed, { deterministic: true }).signature), vectors.precommit.signatureSha3[i]);
  });
  verifyCertificate(vectors.certificate, { chainId: params.chainId, height: 1, blockHash: vectors.block.headerHash, validators: params.validators });

  assert.equal(canonicalJSON(vectors.validatorUpdate.approvalPayload), vectors.validatorUpdate.canonical);
  const state = LedgerState.fromParams(params);
  const list = checkValidatorUpdate(vectors.validatorUpdate.update, { chainId: params.chainId, validators: state.validators, sequence: state.validatorSequence });
  assert.equal(list.length, 1);
});
