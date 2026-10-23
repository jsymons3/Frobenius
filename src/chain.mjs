import {
  ConsensusError, LedgerState, applyBlock, checkBlock, checkBlockShape, checkValidatorUpdate, headerHash,
  quorum, requireThat, transactionId, updateHash, verifyCertificate,
} from './consensus.mjs';

/** Insertion-ordered set that forgets its oldest members past a size limit. */
export class BoundedSet {
  #items = new Set();
  constructor(limit) { this.limit = limit; }
  has(value) { return this.#items.has(value); }
  add(value) {
    this.#items.add(value);
    if (this.#items.size > this.limit) this.#items.delete(this.#items.values().next().value);
  }
}

/** How many recent blocks keep their certificate, and the checkpoint spacing below that. */
export const CERTIFICATE_RETENTION = 1_000;
export const CHECKPOINT_INTERVAL = 100;
export const MAX_SYNC_RESPONSE_BYTES = 64 * 1024 * 1024;
// A protocol-v3 certificate has at most 100 signatures (6,618 hex characters
// each), plus addresses and metadata: comfortably less than one MiB.
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const SYNC_ENVELOPE_BYTES = Buffer.byteLength('{"blocks":[]}');
const PRUNED_ITEM_OVERHEAD = Buffer.byteLength('{"block":,"certificate":null},');

/**
 * The committed chain and its ledger state. Blocks are final when committed: there
 * are no forks and no reorganizations, so every operation here is a plain append.
 */
export class Chain {
  #params; #store; #state;
  #tip;
  #signatureCache = new BoundedSet(50_000);
  #listeners = new Set();

  constructor(params, store) {
    this.#params = params;
    this.#store = store;
    store.checkGenesis(params.genesisHash);
    this.#state = LedgerState.fromParams(params);
    this.#tip = { height: 0, hash: params.genesisHash, timestamp: params.createdAt };
  }

  get params() { return this.#params; }
  get tip() { return this.#tip; }
  get height() { return this.#tip.height; }
  get signatureCache() { return this.#signatureCache; }
  get validators() { return this.#state.validators; }
  get validatorSequence() { return this.#state.validatorSequence; }
  get quorum() { return quorum(this.#state.validators.length); }
  get issued() { return this.#state.issued; }

  /** Replay stored blocks. `verify: false` trusts this node's own earlier signature checks. */
  load({ verify = true } = {}) {
    let count = 0;
    for (const row of this.#store.blocks()) {
      this.#commit(row.block, row.certificate, { verify, fromStore: true });
      count += 1;
    }
    return count;
  }

  /** Subscribe to commits: `({ connected: [block], disconnected: [] })`. */
  onTipChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  /**
   * Full validation of a block on top of the current tip. The result is only a
   * preview: commit always validates the actual body and current state again.
   */
  validate(block, { now = null, maxFutureDrift = 15 * 60_000, verify = true, shapeChecked = false } = {}) {
    if (!shapeChecked) checkBlockShape(block, this.#params);
    const { header } = block;
    const tip = this.#tip;
    requireThat(header.height === tip.height + 1, `Block height must be ${tip.height + 1}`);
    requireThat(header.previousHash === tip.hash, 'Block does not extend the chain tip');
    requireThat(header.timestamp > tip.timestamp, 'Block timestamp must be after its parent');
    if (now !== null) requireThat(header.timestamp <= now + maxFutureDrift, 'Block timestamp is too far in the future');
    requireThat(this.#state.isValidator(header.proposer), 'Block proposer is not an active validator');
    return checkBlock(this.#state, block, this.#params, { verifySignatures: verify, signatureCache: this.#signatureCache });
  }

  /** Commit a block with its certificate from a quorum of the active validators. */
  commit(block, certificate) {
    requireThat(certificate !== null && typeof certificate === 'object', 'A commit certificate is required');
    return this.#commit(block, certificate);
  }

  #commit(block, certificate, { verify = true, fromStore = false, uncertified = false, shapeChecked = false } = {}) {
    const result = this.validate(block, { verify, shapeChecked });
    const hash = headerHash(block.header);
    if (certificate !== null) {
      if (verify) verifyCertificate(certificate, { chainId: this.#params.chainId, height: block.header.height, blockHash: hash, validators: this.#state.validators });
    } else {
      requireThat(fromStore || uncertified, 'A commit certificate is required');
    }
    applyBlock(this.#state, result);
    if (!fromStore) this.#store.putBlock(hash, block, certificate, this.#indexFor(block, result));
    this.#tip = { height: block.header.height, hash, timestamp: block.header.timestamp };
    for (const listener of this.#listeners) listener({ connected: [block], disconnected: [] });
    return { hash, reward: result.reward };
  }

  #indexFor(block, result) {
    const transactions = [];
    const addresses = [];
    block.transactions.forEach((transaction, index) => {
      transactions.push({ id: transactionId(transaction), index });
      const { from, to } = transaction.payload;
      addresses.push({ address: from, kind: 'transaction', index, amount: null });
      if (to !== from) addresses.push({ address: to, kind: 'transaction', index, amount: null });
    });
    addresses.push({ address: block.header.proposer, kind: 'reward', index: null, amount: result.reward.toString() });
    return { transactions, addresses };
  }

  // ------------------------------------------------------------ sync

  /**
   * Blocks for a peer that is behind. The batch always ends at a block whose
   * certificate is still stored, so the peer can verify the whole range.
   */
  blocksFrom(from, limit = CHECKPOINT_INTERVAL, { maxBytes = MAX_SYNC_RESPONSE_BYTES } = {}) {
    if (!Number.isSafeInteger(from) || from < 1 || from > this.height) return [];
    requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= CERTIFICATE_RETENTION, 'Invalid sync block limit');
    requireThat(Number.isSafeInteger(maxBytes) && maxBytes >= SYNC_ENVELOPE_BYTES && maxBytes <= MAX_SYNC_RESPONSE_BYTES, 'Invalid sync byte limit');
    const wantedEnd = Math.min(from + limit - 1, this.height);
    const items = [];
    let bytes = SYNC_ENVELOPE_BYTES;
    let certifiedCount = 0;
    for (let height = from; height <= this.height && items.length < CERTIFICATE_RETENTION; height += 1) {
      const row = this.#store.getBlock(height);
      const item = { block: row.block, certificate: row.certificate };
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      if (bytes + itemBytes > maxBytes) break;
      items.push(item);
      bytes += itemBytes;
      if (item.certificate !== null) certifiedCount = items.length;
      if (height >= wantedEnd && certifiedCount > 0) break;
    }
    // Never send an uncertified suffix, nor exceed the receiver's HTTP bound.
    // Pre-fix databases whose certificates were already pruned across oversized
    // spans need an unpruned archive; missing certificates cannot be recreated.
    requireThat(certifiedCount > 0, 'No certified sync batch fits the byte limit; restore missing certificates from an unpruned archive');
    return items.slice(0, certifiedCount);
  }

  /**
   * Verify and commit a batch from a peer. Older blocks may lack certificates
   * (the peer pruned them); the final certificate, the hash links, and the
   * quorum-approved validator updates together cover every block in the batch.
   */
  commitBatch(items) {
    requireThat(Array.isArray(items) && items.length > 0 && items.length <= CERTIFICATE_RETENTION, 'Invalid sync batch');
    let height = this.#tip.height;
    let previous = this.#tip.hash;
    let validators = this.#state.validators;
    let sequence = this.#state.validatorSequence;
    let activeAtLast = validators;
    for (const item of items) {
      requireThat(item !== null && typeof item === 'object' && item.block !== null && typeof item.block === 'object', 'Invalid sync batch item');
      // Anything the certified header does not bind (bodies, roots, the update) is checked
      // here, so a failure in the second pass can only mean the certified content is invalid.
      checkBlockShape(item.block, this.#params);
      const { header, validatorUpdate } = item.block;
      requireThat(header.height === height + 1 && header.previousHash === previous, 'Sync batch does not continue the chain');
      activeAtLast = validators;
      if (validatorUpdate !== null) {
        requireThat(updateHash(validatorUpdate) === header.updateHash, 'Validator update hash mismatch');
        requireThat(item.certificate !== null && item.certificate !== undefined, 'A validator-update block must carry a certificate');
        // The old set must certify the actual transition block, not merely sign
        // approval of the replacement list. Its successor set cannot authenticate
        // a rewritten prefix that changes where that transition took effect.
        verifyCertificate(item.certificate, { chainId: this.#params.chainId, height: header.height, blockHash: headerHash(header), validators });
        validators = checkValidatorUpdate(validatorUpdate, { chainId: this.#params.chainId, validators, sequence });
        sequence += 1;
      }
      previous = headerHash(header);
      height += 1;
    }
    const last = items.at(-1);
    requireThat(last.certificate !== null && last.certificate !== undefined, 'The last block of a sync batch must carry a certificate');
    verifyCertificate(last.certificate, { chainId: this.#params.chainId, height, blockHash: previous, validators: activeAtLast });
    for (const item of items) {
      try {
        this.#commit(item.block, item.certificate ?? null, { uncertified: true, shapeChecked: true });
      } catch (error) {
        // A quorum certified this history, so an invalid block here means more than
        // f validators are faulty. Surface it as fatal rather than as bad peer input.
        if (error instanceof ConsensusError) throw new Error(`Certified chain contains an invalid block at height ${item.block.header.height}: ${error.message}`);
        throw error;
      }
    }
    return items.length;
  }

  /** Drop old certificates, keeping recent ones and periodic checkpoints for sync. */
  prune({ retention = CERTIFICATE_RETENTION, interval = CHECKPOINT_INTERVAL } = {}) {
    requireThat(Number.isSafeInteger(retention) && retention >= 1, 'Invalid certificate retention');
    requireThat(Number.isSafeInteger(interval) && interval >= 1 && interval <= CERTIFICATE_RETENTION, 'Invalid checkpoint interval');
    // Size checkpoints for the largest legal blocks, including JSON framing and
    // a full final certificate. Every pruned span remains fetchable in one page,
    // even if it later becomes surrounded by maximum-size blocks. The store also
    // keeps validator-update certificates at every membership boundary.
    const byteSafeInterval = Math.floor((MAX_SYNC_RESPONSE_BYTES - SYNC_ENVELOPE_BYTES - MAX_CERTIFICATE_BYTES)
      / (this.#params.maxBlockBytes + PRUNED_ITEM_OVERHEAD));
    this.#store.pruneCertificates(this.height - retention, Math.min(interval, byteSafeInterval));
  }

  // ------------------------------------------------------------ queries

  balance(address) { return this.#state.balance(address); }
  nonce(address) { return this.#state.nonce(address); }
  held() { return this.#state.held(); }

  block(height) { return this.#store.getBlock(height); }
  blockByHash(hash) { return this.#store.getBlockByHash(hash); }
  hashAt(height) { return height === 0 ? this.#params.genesisHash : this.#store.getBlock(height)?.hash ?? null; }
  findTransaction(id) { return this.#store.findTransaction(id); }

  info() {
    const tip = this.#tip;
    return {
      protocol: 3, chainId: this.#params.chainId, name: this.#params.genesis.name,
      height: tip.height, tipHash: tip.hash, tipTimestamp: tip.timestamp, blockInterval: this.#params.blockInterval,
      totalSupply: this.#params.totalSupply.toString(), issuedSupply: this.#state.issued.toString(),
      blockReward: this.#params.blockReward.toString(),
      validatorCount: this.#state.validators.length, validatorSequence: this.#state.validatorSequence, quorum: this.quorum,
    };
  }

  /** Newest-first history for one address. */
  history(address, limit = 50) {
    const items = [];
    for (const entry of this.#store.history(address, limit)) {
      const row = this.#store.getBlock(entry.height);
      const timestamp = row.block.header.timestamp;
      if (entry.kind === 'reward') {
        items.push({ type: 'reward', id: row.hash, amount: entry.amount, fee: '0', from: null, to: address, height: entry.height, timestamp, memo: 'Block reward and fees' });
      } else {
        const { payload } = row.block.transactions[entry.index];
        items.push({
          type: payload.from === payload.to ? 'self' : payload.from === address ? 'send' : 'receive',
          id: transactionId({ payload }), amount: payload.amount, fee: payload.fee, from: payload.from, to: payload.to,
          height: entry.height, timestamp, memo: payload.memo,
        });
      }
    }
    const allocation = this.#params.allocations.get(address);
    if (allocation !== undefined && items.length < limit) {
      items.push({ type: 'genesis', id: this.#params.genesisHash, amount: allocation.toString(), fee: '0', from: null, to: address, height: 0, timestamp: this.#params.createdAt, memo: 'Genesis allocation' });
    }
    return items;
  }
}
