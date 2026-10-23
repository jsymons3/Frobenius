import { mkdirSync, chmodSync, chownSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateWallet, signPayload, validateAddress } from './crypto.mjs';
import { ConsensusError, buildBlock, checkValidatorUpdate, loadParams, proposerAt, transactionId } from './consensus.mjs';
import { Chain, MAX_SYNC_RESPONSE_BYTES } from './chain.mjs';
import { Mempool, PolicyError } from './mempool.mjs';
import { SQLiteStore } from './store.mjs';
import { Tendermint } from './bft.mjs';
import { HTTPError, fetchJSON, startServer } from './http.mjs';

export const SOFTWARE = 'frobenius-node/0.4.0-alpha.1';
const HASH = /^[0-9a-f]{96}$/;
const defaultLog = entry => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const messageKey = message => `${message.type}:${message.height}:${message.round}:${message.validator}:${message.hash}`;

function normalizePeer(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Peer URL must use http or https: ${value}`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`Peer URL must be a plain origin: ${value}`);
  return url.href.replace(/\/+$/, '');
}

function badRequest(error) {
  if (error instanceof ConsensusError || error instanceof PolicyError) return new HTTPError(400, error.message);
  return error;
}

/**
 * A node: stores and serves the chain, relays transfers and consensus messages, and
 * runs the consensus engine. With a validator key whose address is in the active
 * set it votes and proposes; otherwise it follows the votes as an observer and
 * commits blocks as soon as a quorum has precommitted them.
 */
export class FrobeniusNode {
  #nextHeightTimer = null;
  #running = false;

  constructor({
    genesis, dataDir, store, port = 8800, host = '127.0.0.1', peers = [], publicUrl = null, validatorSeed = null,
    minRelayFee = 1_000n, maxPeers = 12, pollInterval = 3_000, discover = true, verifyOnLoad = true,
    timeouts = {}, maxFutureDrift = 15 * 60_000, dropPrivileges = false, log = defaultLog,
  }) {
    this.params = loadParams(genesis);
    if (!store && (typeof dataDir !== 'string' || !isAbsolute(dataDir))) throw new Error('The data directory must be an absolute path.');
    this.me = null;
    this.sign = null;
    if (validatorSeed !== null) {
      if (typeof validatorSeed !== 'string' || !/^[0-9a-f]{64}$/.test(validatorSeed)) throw new Error('The validator key must be a 32-byte hex seed.');
      const wallet = generateWallet(new Uint8Array(Buffer.from(validatorSeed, 'hex')));
      this.me = { address: wallet.address, publicKey: wallet.publicKey };
      this.sign = payload => signPayload(payload, validatorSeed).signature;
    }
    this.options = { dataDir, store, port, host, publicUrl: publicUrl && normalizePeer(publicUrl), minRelayFee, maxPeers, pollInterval, discover, verifyOnLoad, timeouts, maxFutureDrift, dropPrivileges };
    this.log = log;
    this.pendingUpdate = null;
    this.peers = new PeerSet(this, peers);
    this.bus = new ConsensusBus(this);
  }

  async start() {
    let store = this.options.store;
    if (!store) {
      mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(this.options.dataDir, 0o700);
      // In a container that starts as root only to prepare a mounted disk, hand the
      // directory to the unprivileged user and become it before opening anything.
      if (this.options.dropPrivileges && process.getuid?.() === 0) {
        chownSync(this.options.dataDir, 1000, 1000);
        process.setgroups([]);
        process.setgid(1000);
        process.setuid(1000);
      }
      store = new SQLiteStore(join(this.options.dataDir, 'chain.sqlite'));
    }
    this.store = store;
    try {
      this.chain = new Chain(this.params, store);
      const started = Date.now();
      const loaded = this.chain.load({ verify: this.options.verifyOnLoad });
      this.log({ event: 'loaded', blocks: loaded, height: this.chain.height, chainId: this.params.chainId, ms: Date.now() - started });
      this.mempool = new Mempool(this.chain, { minRelayFee: this.options.minRelayFee });
      this.bft = new Tendermint({
        chainId: this.params.chainId, me: this.me?.address ?? null, sign: this.sign, effects: this.#effects(), timeouts: this.options.timeouts,
        log: entry => { if (entry.event !== 'round' || entry.round > 0) this.log({ scope: 'consensus', ...entry }); },
      });
      this.bft.setValidators(this.chain.validators);
      this.server = await startServer({ routes: this.#routes(), port: this.options.port, host: this.options.host, maxInFlight: 64, log: this.log });
    } catch (error) {
      store.close();
      throw error;
    }
    this.port = this.server.port;
    this.#running = true;
    this.peers.start();
    this.#startHeight();
    this.log({ event: 'listening', host: this.options.host, port: this.port, peers: this.peers.urls().length, validator: this.me?.address ?? null, inValidatorSet: this.bft.isValidator });
    return this;
  }

  async stop() {
    this.#running = false;
    clearTimeout(this.#nextHeightTimer);
    this.bft?.stop();
    this.peers.stop();
    await this.server?.close();
    this.store?.close();
  }

  // ------------------------------------------------------------ consensus glue

  #effects() {
    return {
      broadcast: (message, block) => this.bus.publish({ message, block }, null),
      schedule: (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); },
      decide: (block, certificate) => this.#decided(block, certificate),
      persist: wal => this.store.saveConsensus(wal),
      propose: () => this.#buildProposal(),
      validate: block => this.#validateProposal(block),
    };
  }

  #startHeight() {
    if (!this.#running) return;
    clearTimeout(this.#nextHeightTimer);
    this.#nextHeightTimer = null;
    const height = this.chain.height + 1;
    if (this.bft.height === height && !this.bft.decided) return;
    this.bft.setValidators(this.chain.validators);
    const wal = this.me ? this.store.loadConsensus() : null;
    this.bft.start(height, wal && wal.height === height ? wal : null);
    this.bus.replay(height);
  }

  #buildProposal() {
    let update = this.pendingUpdate;
    if (update) {
      try {
        checkValidatorUpdate(update, { chainId: this.params.chainId, validators: this.chain.validators, sequence: this.chain.validatorSequence });
      } catch (error) {
        this.log({ event: 'validator-update-dropped', error: error.message });
        this.pendingUpdate = null;
        update = null;
      }
    }
    const headroom = 8 * 1024 + (update ? JSON.stringify(update).length + 1024 : 0);
    const transactions = this.mempool.select({ maxBytes: this.params.maxBlockBytes - headroom, maxCount: this.params.maxBlockTransactions });
    const block = buildBlock({ params: this.params, parent: this.chain.tip, proposer: this.me.address, transactions, validatorUpdate: update, now: Date.now() });
    try {
      this.chain.validate(block, { now: Date.now(), maxFutureDrift: this.options.maxFutureDrift });
      return block;
    } catch (error) {
      this.log({ event: 'proposal-failed', error: error.message });
      return null;
    }
  }

  #validateProposal(block) {
    try {
      this.chain.validate(block, { now: Date.now(), maxFutureDrift: this.options.maxFutureDrift });
      return true;
    } catch (error) {
      if (!(error instanceof ConsensusError)) throw error;
      this.log({ event: 'proposal-rejected', height: block.header?.height, error: error.message });
      return false;
    }
  }

  #decided(block, certificate) {
    try {
      this.chain.commit(block, certificate);
    } catch (error) {
      // A quorum decided a block this node finds invalid: more than f validators are
      // faulty, or this node disagrees with the rules. Stop rather than diverge.
      this.log({ event: 'fatal', error: `Consensus decided an invalid block: ${error.message}` });
      this.#running = false;
      this.bft.stop();
      return;
    }
    this.#afterCommit({ block, certificate, source: 'consensus' });
  }

  #afterCommit({ block, certificate, source, from = null }) {
    this.bus.prune(this.chain.height + 1);
    if (this.pendingUpdate && this.pendingUpdate.sequence <= this.chain.validatorSequence) this.pendingUpdate = null;
    this.log({ event: 'block', height: block.header.height, hash: certificate.hash.slice(0, 16), transactions: block.transactions.length, proposer: block.header.proposer.slice(0, 16), round: certificate.round, source });
    if (source !== 'sync') this.peers.broadcast('/p2p/block', { block, certificate }, from);
    if (this.chain.height % 100 === 0) this.chain.prune();
    // Pace the chain: the next height starts one interval after the last block's time,
    // bounded so a proposer's clock cannot stall everyone.
    const delay = source === 'consensus' ? Math.min(this.params.blockInterval, Math.max(0, block.header.timestamp + this.params.blockInterval - Date.now())) : 0;
    clearTimeout(this.#nextHeightTimer);
    this.#nextHeightTimer = setTimeout(() => this.#startHeight(), delay);
    this.#nextHeightTimer.unref();
  }

  /** A committed block with its certificate, from a peer's push or our own sync. */
  acceptBlock(item, { from = null, source = 'peer' } = {}) {
    const height = item?.block?.header?.height;
    if (!Number.isSafeInteger(height)) return { status: 'invalid', error: 'Missing block header' };
    if (height <= this.chain.height) return { status: 'duplicate' };
    if (height > this.chain.height + 1) {
      if (from) this.peers.requestSync(from);
      return { status: 'ahead' };
    }
    try {
      this.chain.commitBatch([item]);
    } catch (error) {
      if (error instanceof ConsensusError) return { status: 'invalid', error: error.message };
      throw error;
    }
    this.#afterCommit({ block: item.block, certificate: item.certificate, source, from });
    return { status: 'accepted' };
  }

  /** Blocks fetched from a peer that is ahead. */
  acceptBatch(items, from) {
    if (!items.length || items[0]?.block?.header?.height !== this.chain.height + 1) return 0;
    const count = this.chain.commitBatch(items);
    const last = items.at(-1);
    this.#afterCommit({ block: last.block, certificate: last.certificate, source: 'sync', from });
    return count;
  }

  // ------------------------------------------------------------ transfers and queries

  #relayed = new Set();
  submitTransaction(transaction, { from = null } = {}) {
    const result = this.mempool.add(transaction);
    if (result.status === 'pending' && !this.#relayed.has(result.id)) {
      this.#relayed.add(result.id);
      if (this.#relayed.size > 10_000) this.#relayed.delete(this.#relayed.values().next().value);
      this.peers.broadcast('/p2p/tx', transaction, from);
    }
    return result;
  }

  submitValidatorUpdate(update) {
    checkValidatorUpdate(update, { chainId: this.params.chainId, validators: this.chain.validators, sequence: this.chain.validatorSequence });
    if (!this.bft.isValidator) throw new HTTPError(400, 'This node is not an active validator; submit the update to one that is.');
    this.pendingUpdate = structuredClone(update);
    return { status: 'pending', sequence: update.sequence, proposer: this.me.address };
  }

  account(address) {
    const pending = this.mempool.forAddress(address);
    let pendingBalance = this.chain.balance(address);
    let outgoing = 0;
    for (const { payload } of pending) {
      if (payload.from === address) { pendingBalance -= BigInt(payload.amount) + BigInt(payload.fee); outgoing += 1; }
      if (payload.to === address) pendingBalance += BigInt(payload.amount);
    }
    const confirmedNonce = this.chain.nonce(address);
    return {
      address, balance: this.chain.balance(address).toString(), pendingBalance: pendingBalance.toString(),
      nonce: confirmedNonce + outgoing, confirmedNonce,
      pending: pending.map(transaction => ({ id: transactionId(transaction), ...transaction.payload, status: 'pending' })),
      transactions: this.chain.history(address),
    };
  }

  // ------------------------------------------------------------ HTTP

  #routes() {
    const json = body => ({ body });
    const blockBody = this.params.maxBlockBytes * 2 + 2 * 1024 * 1024;
    const blockResponse = row => json({ hash: row.hash, height: row.block.header.height, confirmations: this.chain.height - row.block.header.height + 1, block: row.block, certificate: row.certificate });
    return {
      'GET /': { handler: () => json({ name: 'Frobenius node', software: SOFTWARE, chainId: this.params.chainId, information: '/api/info' }) },
      'GET /healthz': { handler: () => json({ ok: this.#running, chainId: this.params.chainId, height: this.chain.height }) },
      'GET /api/info': {
        handler: () => json({
          ...this.chain.info(), software: SOFTWARE, pendingCount: this.mempool.size, peers: this.peers.urls().length,
          minRelayFee: this.mempool.options.minRelayFee.toString(), validator: this.me?.address ?? null,
          inValidatorSet: this.bft.isValidator, consensus: this.bft.info(),
        }),
      },
      'GET /api/genesis': { handler: () => json(this.params.genesis) },
      'GET /api/validators': {
        handler: () => json({
          sequence: this.chain.validatorSequence, quorum: this.chain.quorum,
          validators: this.chain.validators.map(entry => entry.address),
          nextProposer: proposerAt(this.chain.validators, this.chain.height + 1, 0).address,
        }),
      },
      'POST /api/validators': { bodyLimit: 2 * 1024 * 1024, handler: ({ body }) => { try { return json(this.submitValidatorUpdate(body)); } catch (error) { throw badRequest(error); } } },
      'GET /api/account': {
        handler: ({ query }) => {
          const address = query.get('address');
          if (!validateAddress(address)) throw new HTTPError(400, 'Enter a valid Bean address.');
          return json(this.account(address));
        },
      },
      'GET /api/tx': {
        handler: ({ query }) => {
          const id = query.get('id');
          if (!HASH.test(id ?? '')) throw new HTTPError(400, 'Enter a transaction id.');
          const location = this.chain.findTransaction(id);
          if (location) {
            const row = this.chain.block(location.height);
            return json({ id, status: 'confirmed', height: location.height, blockHash: row.hash, confirmations: this.chain.height - location.height + 1, transaction: row.block.transactions[location.index] });
          }
          const transaction = this.mempool.get(id);
          if (transaction) return json({ id, status: 'pending', transaction });
          throw new HTTPError(404, 'Unknown transaction.');
        },
      },
      'GET /api/block': {
        handler: ({ query }) => {
          const height = query.get('height');
          const hash = query.get('hash');
          const row = height !== null && /^\d{1,15}$/.test(height) ? this.chain.block(Number(height)) : HASH.test(hash ?? '') ? this.chain.blockByHash(hash) : null;
          if (!row) throw new HTTPError(404, 'Unknown block.');
          return blockResponse(row);
        },
      },
      'POST /api/tx': { handler: ({ body }) => { try { return json(this.submitTransaction(body)); } catch (error) { throw badRequest(error); } } },

      'GET /p2p/hello': {
        handler: () => json({ protocol: 3, software: SOFTWARE, chainId: this.params.chainId, height: this.chain.height, tipHash: this.chain.tip.hash, publicUrl: this.options.publicUrl, validator: this.bft.isValidator }),
      },
      'GET /p2p/blocks': {
        handler: ({ query }) => {
          const from = Number(query.get('from'));
          const limit = Math.min(Math.max(Math.trunc(Number(query.get('limit'))) || 100, 1), 100);
          try { return json({ blocks: this.chain.blocksFrom(from, limit, { maxBytes: MAX_SYNC_RESPONSE_BYTES }) }); }
          catch (error) {
            if (error instanceof ConsensusError) throw new HTTPError(503, error.message);
            throw error;
          }
        },
      },
      'POST /p2p/block': {
        bodyLimit: blockBody,
        handler: ({ body, request }) => {
          const result = this.acceptBlock(body, { from: this.peers.identify(request) });
          return { status: result.status === 'invalid' ? 400 : 200, body: result };
        },
      },
      'GET /p2p/consensus': {
        handler: async ({ query }) => {
          const after = Number(query.get('after')) || 0;
          const wait = Math.min(Math.max(Number(query.get('wait')) || 0, 0), 3_000);
          let messages = this.bus.since(after);
          if (!messages.length && wait > 0) { await this.bus.waitFor(after, wait); messages = this.bus.since(after); }
          return json({ session: this.bus.session, seq: this.bus.seq, messages });
        },
      },
      'POST /p2p/consensus': {
        bodyLimit: blockBody,
        handler: ({ body, request }) => {
          const entries = body?.messages;
          if (!Array.isArray(entries) || entries.length > 50) throw new HTTPError(400, 'Send at most 50 consensus messages.');
          const from = this.peers.identify(request);
          let accepted = 0;
          for (const entry of entries) if (this.bus.receive(entry, from).status === 'accepted') accepted += 1;
          return json({ accepted });
        },
      },
      'POST /p2p/tx': { handler: ({ body, request }) => { try { return json(this.submitTransaction(body, { from: this.peers.identify(request) })); } catch (error) { throw badRequest(error); } } },
      'GET /p2p/mempool': { handler: () => json({ ids: this.mempool.ids() }) },
      'POST /p2p/txs': {
        handler: ({ body }) => {
          const ids = body?.ids;
          if (!Array.isArray(ids) || ids.length > 100 || !ids.every(id => typeof id === 'string' && HASH.test(id))) throw new HTTPError(400, 'Request at most 100 transaction ids.');
          return json({ transactions: ids.map(id => this.mempool.get(id)).filter(Boolean) });
        },
      },
      'GET /p2p/peers': { handler: () => json({ peers: this.peers.urls() }) },
    };
  }
}

/**
 * Consensus messages this node has verified, in arrival order, for the current
 * height and the next. Peers push to us and pull from us; both paths land here,
 * are de-duplicated, fed to the engine, and relayed onward.
 */
class ConsensusBus {
  #node;
  #entries = [];
  #keys = new Set();
  #seq = 0;
  #waiters = new Set();
  session = randomBytes(8).toString('hex');

  constructor(node) { this.#node = node; }
  get seq() { return this.#seq; }

  /** A message this node signed itself. */
  publish(entry, from) {
    if (!this.#add(entry)) return;
    this.#node.peers.broadcast('/p2p/consensus', { messages: [entry] }, from);
  }

  /** A message from a peer: verify, feed, buffer, relay. */
  receive(entry, from) {
    const message = entry?.message;
    const block = entry?.block ?? null;
    if (message === null || typeof message !== 'object' || !Number.isSafeInteger(message.height)) return { status: 'rejected', reason: 'malformed' };
    const next = this.#node.chain.height + 1;
    if (message.height < next) return { status: 'stale' };
    if (message.height > next + 1) {
      if (from) this.#node.peers.requestSync(from);
      return { status: 'ahead' };
    }
    if (this.#keys.has(messageKey(message))) return { status: 'duplicate' };
    const reason = this.#node.bft.verify(message);
    if (reason !== null) return { status: 'rejected', reason };
    const status = this.#node.bft.receive(message, block);
    if (status === 'rejected') return { status };
    if (this.#add({ message, block })) this.#node.peers.broadcast('/p2p/consensus', { messages: [{ message, block }] }, from);
    return { status };
  }

  #add({ message, block }) {
    const key = messageKey(message);
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    this.#entries.push({ seq: ++this.#seq, message, block: block ?? null });
    if (this.#entries.length > 5_000) this.#keys.delete(messageKey(this.#entries.shift().message));
    for (const wake of this.#waiters) wake();
    return true;
  }

  /** Feed buffered messages for a height the engine has just started. */
  replay(height) {
    for (const entry of this.#entries) {
      if (entry.message.height === height || entry.message.height === height + 1) this.#node.bft.receive(entry.message, entry.block);
    }
  }

  since(after) {
    const start = after > this.#seq ? 0 : after;
    return this.#entries.filter(entry => entry.seq > start).slice(0, 200);
  }

  prune(minHeight) {
    this.#entries = this.#entries.filter(entry => entry.message.height >= minHeight);
    this.#keys = new Set(this.#entries.map(entry => messageKey(entry.message)));
  }

  waitFor(after, ms) {
    if (this.#seq > after || after > this.#seq) return Promise.resolve();
    return new Promise(resolve => {
      let timer = null;
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      timer = setTimeout(done, ms);
      timer.unref();
      this.#waiters.add(done);
    });
  }
}

/** Outbound peers: polled for their height, synced from, pushed to, and long-polled for consensus messages. */
class PeerSet {
  #node;
  #peers = new Map();
  #timer = null;
  #running = false;

  constructor(node, seeds) {
    this.#node = node;
    for (const seed of seeds) this.add(seed);
  }

  add(value) {
    const url = normalizePeer(value);
    if (url === this.#node.options.publicUrl || this.#peers.has(url)) return false;
    if (this.#peers.size >= this.#node.options.maxPeers) return false;
    const peer = { url, failures: 0, bannedUntil: 0, busy: false, ticks: 0, height: 0, cursor: 0, session: null };
    this.#peers.set(url, peer);
    if (this.#running) this.#pull(peer);
    return true;
  }

  urls() { return [...this.#peers.values()].filter(peer => peer.bannedUntil <= Date.now()).map(peer => peer.url); }

  /** The peer URL a request came from, when it told us (X-Frobenius-Node header). */
  identify(request) {
    const header = request?.headers?.['x-frobenius-node'];
    if (typeof header !== 'string') return null;
    try { return normalizePeer(header); } catch { return null; }
  }

  start() {
    this.#running = true;
    this.#timer = setInterval(() => this.tick(), this.#node.options.pollInterval);
    this.#timer.unref();
    this.tick();
    for (const peer of this.#peers.values()) this.#pull(peer);
  }

  stop() {
    this.#running = false;
    clearInterval(this.#timer);
  }

  tick() { for (const peer of this.#peers.values()) this.#visit(peer); }

  requestSync(url) {
    const peer = this.#peers.get(url);
    if (peer) this.#visit(peer); else this.tick();
  }

  #headers() {
    return this.#node.options.publicUrl ? { 'X-Frobenius-Node': this.#node.options.publicUrl } : {};
  }

  broadcast(path, body, except = null) {
    for (const url of this.urls()) {
      if (url === except) continue;
      fetchJSON(`${url}${path}`, { method: 'POST', body, headers: this.#headers(), timeout: 10_000, maxBytes: 64 * 1024 }).catch(() => {});
    }
  }

  #ban(peer, ms, reason) {
    peer.bannedUntil = Date.now() + ms;
    this.#node.log({ event: 'peer-banned', peer: peer.url, reason, seconds: Math.round(ms / 1000) });
  }

  async #visit(peer) {
    if (peer.busy || peer.bannedUntil > Date.now() || !this.#running) return;
    peer.busy = true;
    const node = this.#node;
    try {
      const hello = await fetchJSON(`${peer.url}/p2p/hello`, { timeout: 5_000, maxBytes: 16 * 1024 });
      if (hello?.chainId !== node.params.chainId) { this.#ban(peer, 24 * 3_600_000, 'different network'); return; }
      peer.failures = 0;
      peer.height = Number.isSafeInteger(hello.height) ? hello.height : 0;
      if (peer.height > node.chain.height) await this.#syncFrom(peer);
      if (peer.ticks % 3 === 0) await this.#syncMempool(peer);
      if (node.options.discover && peer.ticks % 12 === 0) await this.#discover(peer);
    } catch (error) {
      peer.failures += 1;
      if (peer.failures >= 3) peer.bannedUntil = Date.now() + Math.min(peer.failures * node.options.pollInterval, 300_000);
      if (peer.failures === 3) node.log({ event: 'peer-unreachable', peer: peer.url, error: error.message });
    } finally {
      peer.ticks += 1;
      peer.busy = false;
    }
  }

  async #syncFrom(peer) {
    const node = this.#node;
    for (let round = 0; round < 1_000 && peer.height > node.chain.height; round += 1) {
      const response = await fetchJSON(`${peer.url}/p2p/blocks?from=${node.chain.height + 1}&limit=100`, { timeout: 60_000, maxBytes: MAX_SYNC_RESPONSE_BYTES });
      const items = Array.isArray(response?.blocks) ? response.blocks : [];
      if (!items.length) return;
      try {
        if (node.acceptBatch(items, peer.url) === 0) return;
      } catch (error) {
        if (error instanceof ConsensusError) { this.#ban(peer, 3_600_000, `bad sync batch: ${error.message}`); return; }
        node.log({ event: 'fatal', error: error.message, peer: peer.url });
        this.#ban(peer, 24 * 3_600_000, 'certified invalid history');
        return;
      }
    }
    node.log({ event: 'synced', peer: peer.url, height: node.chain.height });
  }

  /** Long-poll one peer for consensus messages for as long as the node runs. */
  async #pull(peer) {
    const node = this.#node;
    while (this.#running) {
      if (peer.bannedUntil > Date.now()) { await sleep(1_000); continue; }
      try {
        const response = await fetchJSON(`${peer.url}/p2p/consensus?after=${peer.cursor}&wait=3000`, { headers: this.#headers(), timeout: 15_000, maxBytes: 32 * 1024 * 1024 });
        if (typeof response?.session !== 'string' || !Number.isSafeInteger(response.seq)) throw new Error('Malformed consensus response');
        if (peer.session !== null && response.session !== peer.session) { peer.session = response.session; peer.cursor = 0; continue; }
        peer.session = response.session;
        peer.cursor = response.seq;
        for (const entry of Array.isArray(response.messages) ? response.messages : []) node.bus.receive(entry, peer.url);
      } catch {
        if (!this.#running) return;
        await sleep(1_000 + Math.random() * 500);
      }
    }
  }

  async #syncMempool(peer) {
    const node = this.#node;
    const response = await fetchJSON(`${peer.url}/p2p/mempool`, { timeout: 5_000, maxBytes: 1024 * 1024 });
    const ids = Array.isArray(response?.ids) ? response.ids : [];
    const missing = ids.filter(id => typeof id === 'string' && HASH.test(id) && !node.mempool.has(id) && !node.chain.findTransaction(id)).slice(0, 100);
    if (!missing.length) return;
    const { transactions = [] } = await fetchJSON(`${peer.url}/p2p/txs`, { method: 'POST', body: { ids: missing }, timeout: 10_000, maxBytes: 4 * 1024 * 1024 }) ?? {};
    for (const transaction of Array.isArray(transactions) ? transactions : []) {
      try { node.submitTransaction(transaction, { from: peer.url }); } catch { /* stale or invalid relays are simply dropped */ }
    }
  }

  async #discover(peer) {
    const node = this.#node;
    const response = await fetchJSON(`${peer.url}/p2p/peers`, { timeout: 5_000, maxBytes: 64 * 1024 });
    for (const candidate of Array.isArray(response?.peers) ? response.peers.slice(0, 32) : []) {
      if (this.#peers.size >= node.options.maxPeers) return;
      let url;
      try { url = normalizePeer(candidate); } catch { continue; }
      if (this.#peers.has(url) || url === node.options.publicUrl) continue;
      try {
        const hello = await fetchJSON(`${url}/p2p/hello`, { timeout: 5_000, maxBytes: 16 * 1024 });
        if (hello?.chainId === node.params.chainId && this.add(url)) node.log({ event: 'peer-discovered', peer: url, via: peer.url });
      } catch { /* unreachable candidates are skipped */ }
    }
  }
}
