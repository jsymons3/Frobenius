import { randomBytes } from 'node:crypto';
import { canonicalJSON, sha3Hex, addressFromPublicKey, validateAddress, verifyPayload } from './crypto.mjs';

// Protocol v3 consensus rules. Every rule here is normative and described in
// docs/SPEC.md; changing one splits the network unless every node upgrades.
export const PROTOCOL_VERSION = 3;
export const NETWORK = 'frobenius';
export const ATOMIC_UNITS = 1_000_000n;
export const MAX_VALIDATORS = 100;
export const EMPTY_HASH = sha3Hex('');

const HASH = /^[0-9a-f]{96}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,17})$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PUBLIC_KEY_HEX = 1952 * 2;
const SIGNATURE_HEX = 3309 * 2;
const LARGE_JSON = 64 * 1024 * 1024;

const GENESIS_KEYS = [
  'version', 'network', 'name', 'createdAt', 'salt', 'allocations', 'totalSupply', 'blockReward',
  'blockInterval', 'validators', 'maxBlockBytes', 'maxBlockTransactions',
];
const HEADER_KEYS = ['version', 'chainId', 'height', 'previousHash', 'timestamp', 'proposer', 'txRoot', 'updateHash'];
const PAYLOAD_KEYS = ['version', 'chainId', 'from', 'to', 'amount', 'fee', 'nonce', 'memo'];
const VALIDATOR_KEYS = ['address', 'publicKey'];
const UPDATE_KEYS = ['sequence', 'validators', 'approvals'];
const SIGNATURE_KEYS = ['validator', 'signature'];
const CERTIFICATE_KEYS = ['height', 'round', 'hash', 'signatures'];

/** A rule violation by the data itself (as opposed to an I/O or programming error). */
export class ConsensusError extends Error {}

export function requireThat(condition, message) {
  if (!condition) throw new ConsensusError(message);
}

function exactKeys(value, keys, name) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  requireThat(prototype === Object.prototype || prototype === null, `${name} must be a plain object`);
  const actual = Object.keys(value);
  requireThat(actual.length === keys.length && actual.every(key => keys.includes(key)), `${name} has missing or unknown fields`);
}

function safeInteger(value, min, max, message) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, message);
  return value;
}

function amount(value, name, { allowZero = false, max } = {}) {
  requireThat(typeof value === 'string' && AMOUNT.test(value), `${name} must be a canonical integer string in atomic units`);
  const parsed = BigInt(value);
  requireThat(allowZero || parsed > 0n, `${name} must be positive`);
  requireThat(max === undefined || parsed <= max, `${name} exceeds the total supply`);
  return parsed;
}

const isHash = value => typeof value === 'string' && HASH.test(value);
const isHex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const digest = value => sha3Hex(canonicalJSON(value, LARGE_JSON));

// ---------------------------------------------------------------- validators

/** With n validators, up to f = floor((n-1)/3) may be faulty; a quorum is n - f. */
export function faultTolerance(count) { return Math.floor((count - 1) / 3); }
export function quorum(count) { return count - faultTolerance(count); }
/** Round-robin: the proposer for a height and round is fixed by the active set. */
export function proposerAt(validators, height, round) { return validators[(height + round) % validators.length]; }

function checkValidatorList(list, name = 'Validator list') {
  requireThat(Array.isArray(list) && list.length >= 1 && list.length <= MAX_VALIDATORS, `${name} must hold 1-${MAX_VALIDATORS} validators`);
  const seen = new Set();
  return list.map(entry => {
    exactKeys(entry, VALIDATOR_KEYS, 'Validator');
    requireThat(isHex(entry.publicKey, PUBLIC_KEY_HEX), 'Invalid validator public key');
    requireThat(addressFromPublicKey(entry.publicKey) === entry.address, 'Validator address does not match its public key');
    requireThat(!seen.has(entry.address), 'Duplicate validator');
    seen.add(entry.address);
    return { address: entry.address, publicKey: entry.publicKey };
  });
}

/** Signed by a validator over `payload`; used for votes, proposals, and update approvals. */
function countSignatures(signatures, payload, validators, name) {
  requireThat(Array.isArray(signatures) && signatures.length <= validators.length, `${name} has too many signatures`);
  const keys = new Map(validators.map(entry => [entry.address, entry.publicKey]));
  const seen = new Set();
  for (const entry of signatures) {
    exactKeys(entry, SIGNATURE_KEYS, `${name} signature`);
    requireThat(keys.has(entry.validator), `${name} is signed by a non-validator`);
    requireThat(!seen.has(entry.validator), `${name} has a duplicate signer`);
    requireThat(isHex(entry.signature, SIGNATURE_HEX) && verifyPayload(payload, keys.get(entry.validator), entry.signature), `${name} has an invalid signature`);
    seen.add(entry.validator);
  }
  return seen.size;
}

// ---------------------------------------------------------------- genesis

/**
 * Build a genesis document. Allocations are a deliberate choice of whoever launches
 * the network; an empty list means every Bean is issued as block rewards.
 */
export function createGenesis({
  name, validators, createdAt = Date.now(), allocations = [], salt = randomBytes(32).toString('hex'),
  totalSupply = 100_000_000n * ATOMIC_UNITS, blockReward = 2n * ATOMIC_UNITS, blockInterval = 5_000,
  maxBlockBytes = 1024 * 1024, maxBlockTransactions = 250,
}) {
  const genesis = {
    version: PROTOCOL_VERSION, network: NETWORK, name, createdAt, salt,
    allocations: allocations.map(({ address, amount: value }) => ({ address, amount: value.toString() })),
    totalSupply: totalSupply.toString(), blockReward: blockReward.toString(), blockInterval,
    validators: (validators ?? []).map(({ address, publicKey }) => ({ address, publicKey })),
    maxBlockBytes, maxBlockTransactions,
  };
  loadParams(genesis);
  return genesis;
}

/** Validate a genesis document and derive the immutable consensus parameters. */
export function loadParams(genesis) {
  exactKeys(genesis, GENESIS_KEYS, 'Genesis');
  requireThat(genesis.version === PROTOCOL_VERSION && genesis.network === NETWORK, 'Unsupported genesis network or version');
  requireThat(typeof genesis.name === 'string' && NAME.test(genesis.name), 'Network name must be 1-32 lowercase letters, digits, or hyphens');
  safeInteger(genesis.createdAt, 1, Number.MAX_SAFE_INTEGER, 'Invalid genesis timestamp');
  requireThat(typeof genesis.salt === 'string' && /^[0-9a-f]{64}$/.test(genesis.salt), 'Invalid genesis salt');
  const totalSupply = amount(genesis.totalSupply, 'Total supply');
  const blockReward = amount(genesis.blockReward, 'Block reward', { allowZero: true, max: totalSupply });
  safeInteger(genesis.blockInterval, 1_000, 86_400_000, 'Block interval must be 1 second to 1 day in milliseconds');
  safeInteger(genesis.maxBlockBytes, 16 * 1024, 32 * 1024 * 1024, 'Maximum block size must be 16 KiB to 32 MiB');
  safeInteger(genesis.maxBlockTransactions, 1, 5_000, 'Maximum block transactions must be 1-5000');
  const validators = checkValidatorList(genesis.validators, 'Genesis validator list');
  requireThat(Array.isArray(genesis.allocations) && genesis.allocations.length <= 1_000, 'Allocations must be a list of at most 1000 entries');
  const allocations = new Map();
  let allocated = 0n;
  for (const allocation of genesis.allocations) {
    exactKeys(allocation, ['address', 'amount'], 'Allocation');
    requireThat(validateAddress(allocation.address), 'Invalid allocation address');
    requireThat(!allocations.has(allocation.address), 'Duplicate allocation address');
    const value = amount(allocation.amount, 'Allocation', { max: totalSupply });
    allocations.set(allocation.address, value);
    allocated += value;
  }
  requireThat(allocated <= totalSupply, 'Allocations exceed the total supply');
  const genesisHash = digest(genesis);
  return Object.freeze({
    genesis: structuredClone(genesis), genesisHash, chainId: `${NETWORK}-${genesis.name}-${genesisHash}`,
    createdAt: genesis.createdAt, totalSupply, blockReward, blockInterval: genesis.blockInterval,
    allocations, allocated, validators: Object.freeze(validators.map(entry => Object.freeze(entry))),
    maxBlockBytes: genesis.maxBlockBytes, maxBlockTransactions: genesis.maxBlockTransactions,
  });
}

// ---------------------------------------------------------------- transactions

/** Stable across re-signing, so a wallet can safely retry a transfer. */
export const transactionId = transaction => sha3Hex(canonicalJSON(transaction.payload));
/** Commits to the signature too; used for block roots and the signature cache. */
export const transactionHash = transaction => sha3Hex(canonicalJSON(transaction));
export const transactionSize = transaction => Buffer.byteLength(canonicalJSON(transaction), 'utf8');

/** Context-free checks. Cheap: no signature verification and no state access. */
export function checkTransactionShape(transaction, params) {
  exactKeys(transaction, ['payload', 'publicKey', 'signature'], 'Transaction');
  const { payload, publicKey, signature } = transaction;
  exactKeys(payload, PAYLOAD_KEYS, 'Transaction payload');
  requireThat(payload.version === PROTOCOL_VERSION && payload.chainId === params.chainId, 'Transaction belongs to another chain or version');
  requireThat(validateAddress(payload.from) && validateAddress(payload.to), 'Invalid Bean address');
  const value = amount(payload.amount, 'Amount', { max: params.totalSupply });
  const fee = amount(payload.fee, 'Fee', { allowZero: true, max: params.totalSupply });
  safeInteger(payload.nonce, 0, Number.MAX_SAFE_INTEGER - 1, 'Invalid transaction nonce');
  requireThat(typeof payload.memo === 'string' && payload.memo.length <= 280 && [...payload.memo].length <= 140, 'Memo must be at most 140 characters');
  requireThat(isHex(publicKey, PUBLIC_KEY_HEX), 'Invalid public key encoding');
  requireThat(isHex(signature, SIGNATURE_HEX), 'Invalid signature encoding');
  return { payload, amount: value, fee };
}

/** The expensive part: the key must own the sender address and sign the payload. */
export function checkTransactionAuth(transaction) {
  requireThat(addressFromPublicKey(transaction.publicKey) === transaction.payload.from, 'Public key does not match sender address');
  requireThat(verifyPayload(transaction.payload, transaction.publicKey, transaction.signature), 'Invalid transaction signature');
}

// ---------------------------------------------------------------- votes and certificates

/** What a validator signs. The `type` field keeps these apart from transfer payloads. */
export const votePayload = (type, chainId, height, round, hash) => ({ type, chainId, height, round, hash });
export const proposalPayload = (chainId, height, round, hash, validRound) => ({ type: 'proposal', chainId, height, round, hash, validRound });
export const approvalPayload = (chainId, sequence, validators) => ({ type: 'validators', chainId, sequence, validators });

/** A commit certificate: a quorum of precommits for one block hash in one round. */
export function verifyCertificate(certificate, { chainId, height, blockHash, validators }) {
  exactKeys(certificate, CERTIFICATE_KEYS, 'Certificate');
  requireThat(certificate.height === height && certificate.hash === blockHash, 'Certificate does not match the block');
  safeInteger(certificate.round, 0, Number.MAX_SAFE_INTEGER, 'Invalid certificate round');
  const payload = votePayload('precommit', chainId, height, certificate.round, blockHash);
  const signers = countSignatures(certificate.signatures, payload, validators, 'Certificate');
  requireThat(signers >= quorum(validators.length), 'Certificate lacks a quorum of validators');
}

/**
 * A validator-set change: the new list, approved by a quorum of the current set.
 * Returns the normalized new list.
 */
export function checkValidatorUpdate(update, { chainId, validators, sequence }) {
  exactKeys(update, UPDATE_KEYS, 'Validator update');
  requireThat(update.sequence === sequence + 1, `Validator update sequence must be ${sequence + 1}`);
  const list = checkValidatorList(update.validators, 'Validator update list');
  const payload = approvalPayload(chainId, update.sequence, update.validators);
  const signers = countSignatures(update.approvals, payload, validators, 'Validator update');
  requireThat(signers >= quorum(validators.length), 'Validator update lacks a quorum of current validators');
  return list;
}

// ---------------------------------------------------------------- state

/** Balances, nonces, issuance, and the active validator set after the last block. */
export class LedgerState {
  constructor() {
    this.balances = new Map();
    this.nonces = new Map();
    this.issued = 0n;
    this.validators = [];
    this.validatorSequence = 0;
  }

  static fromParams(params) {
    const state = new LedgerState();
    for (const [address, value] of params.allocations) state.balances.set(address, value);
    state.issued = params.allocated;
    state.validators = params.validators.map(entry => ({ ...entry }));
    return state;
  }

  balance(address) { return this.balances.get(address) ?? 0n; }
  nonce(address) { return this.nonces.get(address) ?? 0; }
  isValidator(address) { return this.validators.some(entry => entry.address === address); }

  /** Sum of all balances; equals `issued` whenever the rules hold. */
  held() { let total = 0n; for (const value of this.balances.values()) total += value; return total; }
}

class Overlay {
  constructor(base) { this.base = base; this.balances = new Map(); this.nonces = new Map(); }
  balance(address) { return this.balances.has(address) ? this.balances.get(address) : this.base.balance(address); }
  nonce(address) { return this.nonces.has(address) ? this.nonces.get(address) : this.base.nonce(address); }
}

function applyTransfer(view, payload, value, fee) {
  const expected = view.nonce(payload.from);
  requireThat(payload.nonce === expected, `Invalid nonce: expected ${expected}`);
  const balance = view.balance(payload.from);
  requireThat(balance >= value + fee, 'Insufficient balance for amount plus fee');
  view.balances.set(payload.from, balance - value - fee);
  view.balances.set(payload.to, view.balance(payload.to) + value);
  view.nonces.set(payload.from, expected + 1);
}

export function blockSubsidy(params, issued) {
  const remaining = params.totalSupply - issued;
  return remaining < params.blockReward ? remaining : params.blockReward;
}

/**
 * Check a shape-valid block against `state` without changing it. Throws a
 * ConsensusError on any rule violation; otherwise returns what applyBlock needs.
 */
export function checkBlock(state, block, params, { verifySignatures = true, signatureCache } = {}) {
  const view = new Overlay(state);
  let fees = 0n;
  for (const transaction of block.transactions) {
    const { payload, amount: value, fee } = checkTransactionShape(transaction, params);
    applyTransfer(view, payload, value, fee);
    if (verifySignatures) {
      const hash = transactionHash(transaction);
      if (!signatureCache?.has(hash)) {
        checkTransactionAuth(transaction);
        signatureCache?.add(hash);
      }
    }
    fees += fee;
  }
  const validators = block.validatorUpdate === null ? null : checkValidatorUpdate(block.validatorUpdate, {
    chainId: params.chainId, validators: state.validators, sequence: state.validatorSequence,
  });
  const subsidy = blockSubsidy(params, state.issued);
  const proposer = block.header.proposer;
  view.balances.set(proposer, view.balance(proposer) + subsidy + fees);
  return { balances: view.balances, nonces: view.nonces, subsidy, fees, reward: subsidy + fees, validators };
}

export function applyBlock(state, checked) {
  for (const [address, value] of checked.balances) state.balances.set(address, value);
  for (const [address, value] of checked.nonces) state.nonces.set(address, value);
  state.issued += checked.subsidy;
  if (checked.validators) {
    state.validators = checked.validators;
    state.validatorSequence += 1;
  }
}

export function connectBlock(state, block, params, options) {
  const checked = checkBlock(state, block, params, options);
  applyBlock(state, checked);
  return checked;
}

// ---------------------------------------------------------------- blocks

export const headerHash = header => sha3Hex(canonicalJSON(header));
export const blockSize = block => Buffer.byteLength(canonicalJSON(block, LARGE_JSON), 'utf8');
export const transactionRoot = transactions => sha3Hex(canonicalJSON(transactions.map(transactionHash), LARGE_JSON));
export const updateHash = update => (update === null ? EMPTY_HASH : digest(update));

/** Context-free block checks, including every transaction's shape (not signatures). */
export function checkBlockShape(block, params) {
  exactKeys(block, ['header', 'transactions', 'validatorUpdate'], 'Block');
  const { header, transactions, validatorUpdate } = block;
  exactKeys(header, HEADER_KEYS, 'Block header');
  requireThat(header.version === PROTOCOL_VERSION && header.chainId === params.chainId, 'Block belongs to another chain or version');
  safeInteger(header.height, 1, Number.MAX_SAFE_INTEGER, 'Invalid block height');
  safeInteger(header.timestamp, 1, Number.MAX_SAFE_INTEGER, 'Invalid block timestamp');
  requireThat(isHash(header.previousHash) && isHash(header.txRoot) && isHash(header.updateHash), 'Invalid block hash field');
  requireThat(validateAddress(header.proposer), 'Invalid proposer address');
  requireThat(Array.isArray(transactions) && transactions.length <= params.maxBlockTransactions, 'Too many block transactions');
  for (const transaction of transactions) checkTransactionShape(transaction, params);
  if (validatorUpdate !== null) exactKeys(validatorUpdate, UPDATE_KEYS, 'Validator update');
  requireThat(blockSize(block) <= params.maxBlockBytes, 'Block exceeds the maximum size');
  requireThat(transactionRoot(transactions) === header.txRoot, 'Transaction root mismatch');
  requireThat(updateHash(validatorUpdate) === header.updateHash, 'Validator update hash mismatch');
}

/** Assemble an unsigned block on top of `parent` ({ height, hash, timestamp }). */
export function buildBlock({ params, parent, proposer, transactions = [], validatorUpdate = null, now = Date.now() }) {
  return {
    header: {
      version: PROTOCOL_VERSION, chainId: params.chainId, height: parent.height + 1, previousHash: parent.hash,
      timestamp: Math.max(now, parent.timestamp + 1), proposer,
      txRoot: transactionRoot(transactions), updateHash: updateHash(validatorUpdate),
    },
    transactions: structuredClone(transactions),
    validatorUpdate: structuredClone(validatorUpdate),
  };
}
