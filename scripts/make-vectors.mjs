// Regenerates test/vectors.json. Only run this for an intentional protocol change:
// the vectors pin the exact bytes every compatible implementation must produce.
import { writeFileSync } from 'node:fs';
import { canonicalJSON, generateWallet, sha3Hex, signPayload } from '../src/crypto.mjs';
import {
  approvalPayload, buildBlock, headerHash, loadParams, transactionHash, transactionId, transactionRoot, votePayload,
} from '../src/consensus.mjs';

const seeds = ['01'.repeat(32), '02'.repeat(32)];
const [alice, bob] = seeds.map(seed => generateWallet(Buffer.from(seed, 'hex')));
const sign = (payload, seed) => signPayload(payload, seed, { deterministic: true }).signature;

const genesis = {
  version: 3, network: 'frobenius', name: 'vectors', createdAt: 1792643129826, salt: 'ab'.repeat(32),
  allocations: [{ address: alice.address, amount: '1000000000' }],
  totalSupply: '100000000000000', blockReward: '2000000', blockInterval: 5000,
  validators: [{ address: alice.address, publicKey: alice.publicKey }, { address: bob.address, publicKey: bob.publicKey }],
  maxBlockBytes: 1048576, maxBlockTransactions: 250,
};
const params = loadParams(genesis);

const payload = { version: 3, chainId: params.chainId, from: alice.address, to: bob.address, amount: '1500000', fee: '1000', nonce: 0, memo: 'vector ☕' };
const transaction = { payload, publicKey: alice.publicKey, signature: sign(payload, seeds[0]) };

const block = buildBlock({ params, parent: { height: 0, hash: params.genesisHash, timestamp: genesis.createdAt }, proposer: bob.address, transactions: [transaction], now: genesis.createdAt + 5000 });
const blockHash = headerHash(block.header);
const precommit = votePayload('precommit', params.chainId, 1, 0, blockHash);
const certificate = { height: 1, round: 0, hash: blockHash, signatures: [alice, bob].map((w, i) => ({ validator: w.address, signature: sign(precommit, seeds[i]) })) };

const approval = approvalPayload(params.chainId, 1, [{ address: alice.address, publicKey: alice.publicKey }]);
const update = { sequence: 1, validators: approval.validators, approvals: [alice, bob].map((w, i) => ({ validator: w.address, signature: sign(approval, seeds[i]) })) };

const digest = hex => sha3Hex(Buffer.from(hex, 'hex'));
const vectors = {
  note: 'Inputs and expected outputs for Frobenius protocol v3. See docs/SPEC.md.',
  wallets: [alice, bob].map((w, i) => ({ seed: seeds[i], publicKeySha3: digest(w.publicKey), address: w.address })),
  genesis: { input: genesis, genesisHash: params.genesisHash, chainId: params.chainId },
  transaction: {
    payload, canonicalPayload: canonicalJSON(payload), transactionId: transactionId(transaction),
    deterministicSignatureSha3: digest(transaction.signature), transactionHash: transactionHash(transaction),
  },
  block: { header: block.header, txRoot: transactionRoot([transaction]), headerHash: blockHash },
  precommit: { payload: precommit, canonical: canonicalJSON(precommit), signatureSha3: certificate.signatures.map(s => digest(s.signature)) },
  certificate,
  validatorUpdate: { approvalPayload: approval, canonical: canonicalJSON(approval), update },
};
writeFileSync(new URL('../test/vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
