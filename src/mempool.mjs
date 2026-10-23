import { ConsensusError, checkTransactionAuth, checkTransactionShape, transactionHash, transactionId, transactionSize } from './consensus.mjs';

/** A local relay rule, not a consensus rule: other nodes may choose differently. */
export class PolicyError extends Error {}

/**
 * Unconfirmed transfers that are valid on top of the current tip. Each sender's
 * pending transfers must form a gap-free nonce sequence paid for by that sender's
 * *confirmed* balance, so every per-sender prefix stays valid in any block order.
 */
export class Mempool {
  #chain;
  #byId = new Map();     // txid -> item
  #bySender = new Map(); // address -> items sorted by nonce
  #sequence = 0;

  constructor(chain, { maxTransactions = 2_000, maxPerSender = 25, minRelayFee = 1_000n } = {}) {
    this.#chain = chain;
    this.options = { maxTransactions, maxPerSender, minRelayFee: BigInt(minRelayFee) };
    chain.onTipChange(change => this.#rebuild(change));
  }

  get size() { return this.#byId.size; }
  has(id) { return this.#byId.has(id); }
  get(id) { return this.#byId.get(id)?.transaction ?? null; }
  ids() { return [...this.#byId.keys()]; }

  /** Validate and add one signed transfer. Returns `{ id, status }`; throws on rejection. */
  add(transaction) {
    const params = this.#chain.params;
    const { payload, amount, fee } = checkTransactionShape(transaction, params);
    const id = transactionId(transaction);
    if (this.#byId.has(id)) return { id, status: 'pending' };
    if (this.#chain.findTransaction(id)) return { id, status: 'confirmed' };
    if (fee < this.options.minRelayFee) throw new PolicyError(`Fee is below this node's minimum of ${this.options.minRelayFee} atomic units`);
    const pending = this.#bySender.get(payload.from) ?? [];
    const confirmedNonce = this.#chain.nonce(payload.from);
    const position = payload.nonce - confirmedNonce;
    if (position < 0) throw new ConsensusError(`Invalid nonce: expected at least ${confirmedNonce}`);
    if (position > pending.length) throw new ConsensusError(`Invalid nonce: expected ${confirmedNonce + pending.length}`);
    const replacing = pending[position] ?? null;
    if (replacing && fee <= replacing.fee) throw new PolicyError('A pending transfer already uses this nonce; a replacement must pay a higher fee');
    if (!replacing && pending.length >= this.options.maxPerSender) throw new PolicyError(`This sender already has ${pending.length} pending transfers`);
    if (!replacing && this.#byId.size >= this.options.maxTransactions) throw new PolicyError('The pending transfer pool is full; try again after the next block');
    const sequence = [...pending];
    const item = this.#item(transaction, id, amount, fee);
    sequence[position] = item;
    const spend = sequence.reduce((total, entry) => total + entry.amount + entry.fee, 0n);
    if (spend > this.#chain.balance(payload.from)) throw new ConsensusError('Insufficient confirmed balance for this and earlier pending transfers');
    const digest = transactionHash(transaction);
    if (!this.#chain.signatureCache.has(digest)) {
      checkTransactionAuth(transaction);
      this.#chain.signatureCache.add(digest);
    }
    if (replacing) this.#byId.delete(replacing.id);
    this.#byId.set(id, item);
    this.#bySender.set(payload.from, sequence);
    return { id, status: 'pending', replaced: replacing?.id };
  }

  #item(transaction, id, amount, fee) {
    return {
      transaction, id, amount, fee, from: transaction.payload.from, nonce: transaction.payload.nonce,
      size: transactionSize(transaction), sequence: this.#sequence++, receivedAt: Date.now(),
    };
  }

  /** After a tip change, keep what is still valid and return disconnected transfers to the pool. */
  #rebuild({ disconnected }) {
    const params = this.#chain.params;
    const candidates = [];
    for (const block of disconnected) for (const transaction of block.transactions) {
      const { amount, fee } = checkTransactionShape(transaction, params);
      candidates.push(this.#item(transaction, transactionId(transaction), amount, fee));
    }
    candidates.push(...this.#byId.values());
    this.#byId.clear();
    this.#bySender.clear();
    const groups = new Map();
    for (const item of candidates) {
      if (this.#chain.findTransaction(item.id)) continue;
      const group = groups.get(item.from) ?? new Map();
      if (!group.has(item.nonce)) group.set(item.nonce, item);
      groups.set(item.from, group);
    }
    for (const [sender, group] of groups) {
      let nonce = this.#chain.nonce(sender);
      let budget = this.#chain.balance(sender);
      const sequence = [];
      while (group.has(nonce) && sequence.length < this.options.maxPerSender && this.#byId.size < this.options.maxTransactions) {
        const item = group.get(nonce);
        if (item.amount + item.fee > budget) break;
        budget -= item.amount + item.fee;
        sequence.push(item);
        this.#byId.set(item.id, item);
        nonce += 1;
      }
      if (sequence.length) this.#bySender.set(sender, sequence);
    }
  }

  /** Highest-fee-first selection that keeps each sender's nonces in order. */
  select({ maxBytes, maxCount }) {
    const queues = [...this.#bySender.values()].map(list => ({ list, next: 0 }));
    const chosen = [];
    let bytes = 0;
    while (chosen.length < maxCount) {
      let best = null;
      for (const queue of queues) {
        const item = queue.list[queue.next];
        if (!item) continue;
        const head = best?.list[best.next];
        if (!head || item.fee > head.fee || (item.fee === head.fee && item.sequence < head.sequence)) best = queue;
      }
      if (!best) break;
      const item = best.list[best.next];
      if (bytes + item.size + 1 > maxBytes) { best.list = []; continue; }
      bytes += item.size + 1;
      chosen.push(item.transaction);
      best.next += 1;
    }
    return chosen;
  }

  /** Pending transfers that touch an address, oldest first. */
  forAddress(address) {
    return [...this.#byId.values()]
      .filter(item => item.from === address || item.transaction.payload.to === address)
      .sort((a, b) => a.sequence - b.sequence)
      .map(item => item.transaction);
  }
}
