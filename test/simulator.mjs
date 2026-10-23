import { canonicalJSON, sha3Hex } from '../src/crypto.mjs';
import { Tendermint, payloadOf } from '../src/bft.mjs';
import { headerHash, transactionRoot, updateHash, votePayload } from '../src/consensus.mjs';

// A deterministic network of consensus engines on a virtual clock. Messages take a
// random (seeded) time to arrive, may be dropped, and may be blocked by partitions.
// Like the real node, every node pushes what it sends and periodically pulls what
// it missed from its peers' buffers. Validators can be crashed, restarted from
// their write-ahead record, or made byzantine. Signatures are fake hashes so a run
// takes milliseconds; the node tests exercise the real ML-DSA path.

export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fakeSign = (payload, key) => sha3Hex(`${canonicalJSON(payload)}|${key}`);
const fakeVerify = (payload, publicKey, signature) => signature === fakeSign(payload, publicKey);
const keyOf = message => `${message.type}:${message.height}:${message.round}:${message.validator}:${message.hash}`;

export class Simulation {
  constructor({
    count = 4, seed = 1, delay = [10, 60], drop = 0, blockInterval = 500, pollInterval = 300,
    timeouts = { propose: 400, prevote: 200, precommit: 200, delta: 200, max: 5_000 }, faults = {}, messageFilter = () => true,
  } = {}) {
    this.random = rng(seed);
    this.now = 0;
    this.events = [];
    this.sequence = 0;
    this.chainId = 'frobenius-sim';
    this.delay = delay;
    this.drop = drop;
    this.blockInterval = blockInterval;
    this.pollInterval = pollInterval;
    this.timeouts = timeouts;
    this.messageFilter = messageFilter;
    this.partitions = [];
    this.proposals = new Map(); // height -> Map(hash -> { message, block })
    this.signed = new Map();    // honest validator:height:round:type -> Set(hash)
    this.violations = [];
    this.validators = Array.from({ length: count }, (_, i) => ({ address: `v${i}`, publicKey: `v${i}` }));
    this.nodes = this.validators.map((entry, index) => {
      const node = {
        index, address: entry.address, fault: faults[index] ?? null, online: faults[index] !== 'crashed',
        height: 1, hashes: ['genesis'], decisions: new Map(), committed: new Map(), inbox: new Map(), wal: null, tm: null,
      };
      node.tm = this.#engine(node);
      return node;
    });
  }

  get honest() { return this.nodes.filter(node => node.fault === null); }

  #engine(node) {
    const sim = this;
    // Effects are tied to this engine instance so a stale engine (before a restart)
    // can no longer act for the node.
    let tm = null;
    const live = () => node.tm === tm && node.online;
    tm = new Tendermint({
      chainId: this.chainId, me: node.address, sign: payload => fakeSign(payload, node.address), verify: fakeVerify,
      timeouts: this.timeouts,
      effects: {
        broadcast: (message, block) => { if (live()) sim.#broadcast(node, message, block); },
        schedule: (ms, fn) => sim.schedule(ms, fn),
        decide: (block, certificate) => { if (live()) sim.#decided(node, block, certificate); },
        persist: wal => { if (live()) node.wal = structuredClone(wal); },
        propose: () => ({ header: { chainId: sim.chainId, height: node.height, previousHash: node.hashes.at(-1), timestamp: sim.now, proposer: node.address, txRoot: transactionRoot([]), updateHash: updateHash(null) }, transactions: [], validatorUpdate: null }),
        validate: block => block.header.height === node.height && block.header.previousHash === node.hashes.at(-1),
        missing: hash => { if (live()) sim.#refetch(node, hash); },
      },
    });
    tm.setValidators(this.validators);
    return tm;
  }

  // ------------------------------------------------------------ clock

  schedule(ms, fn) {
    const event = { time: this.now + Math.round(ms), sequence: this.sequence++, fn, cancelled: false };
    this.events.push(event);
    return () => { event.cancelled = true; };
  }

  /** Run every event up to the virtual time `until`. */
  run(until) {
    while (this.events.length) {
      let best = 0;
      for (let i = 1; i < this.events.length; i += 1) {
        const a = this.events[i]; const b = this.events[best];
        if (a.time < b.time || (a.time === b.time && a.sequence < b.sequence)) best = i;
      }
      if (this.events[best].time > until) break;
      const [event] = this.events.splice(best, 1);
      this.now = event.time;
      if (!event.cancelled) event.fn();
    }
    this.now = Math.max(this.now, until);
  }

  start() {
    for (const node of this.nodes) {
      if (node.online) node.tm.start(node.height, null);
      this.schedule(this.pollInterval + node.index * 7, () => this.#poll(node));
    }
  }

  crash(index) { this.nodes[index].online = false; }

  /** Bring a node back as a fresh process: new engine, resumed from its write-ahead record. */
  restart(index) {
    const node = this.nodes[index];
    node.online = true;
    node.inbox.clear();
    node.tm = this.#engine(node);
    node.tm.start(node.height, node.wal);
  }

  partition(...groups) { this.partitions = groups.map(group => new Set(group)); }
  heal() { this.partitions = []; }

  // ------------------------------------------------------------ network

  #reachable(a, b) {
    if (!a.online || !b.online) return false;
    for (const group of this.partitions) if (group.has(a.index) !== group.has(b.index)) return false;
    return true;
  }

  #latency() { const [min, max] = this.delay; return Math.round(min + this.random() * (max - min)); }

  #remember(node, message, block) {
    if (message.height >= node.height) node.inbox.set(keyOf(message), { message, block });
  }

  #broadcast(node, message, block) {
    this.#recordSigned(node, message);
    this.#remember(node, message, block);
    if (message.type === 'proposal') this.#rememberProposal(message, block);
    for (const peer of this.nodes) {
      if (peer === node) continue;
      let outgoing = { message, block };
      if (node.fault === 'equivocator' && message.type !== 'proposal' && message.hash !== null && peer.index % 2 === 1) {
        const alternate = { ...message, hash: null };
        alternate.signature = fakeSign(payloadOf(alternate), node.address);
        outgoing = { message: alternate, block: null };
      }
      if (node.fault === 'double-proposer' && message.type === 'proposal' && peer.index % 2 === 1) {
        const altBlock = { ...block, header: { ...block.header, timestamp: block.header.timestamp + 1 } };
        const alternate = { ...message, hash: headerHash(altBlock.header) };
        alternate.signature = fakeSign(payloadOf(alternate), node.address);
        outgoing = { message: alternate, block: altBlock };
        this.#rememberProposal(alternate, altBlock);
      }
      this.#deliver(node, peer, outgoing);
    }
  }

  #rememberProposal(message, block) {
    let byHash = this.proposals.get(message.height);
    if (!byHash) { byHash = new Map(); this.proposals.set(message.height, byHash); }
    byHash.set(message.hash, { message, block });
  }

  #deliver(from, to, { message, block }) {
    if (!this.#reachable(from, to) || !this.messageFilter({ from: from.index, to: to.index, message, block }) || this.random() < this.drop) return;
    this.schedule(this.#latency(), () => { if (this.#reachable(from, to)) this.#receive(to, message, block); });
  }

  #receive(node, message, block) {
    if (node.tm.verify(message) !== null) { this.violations.push(`${node.address} received an unverifiable message`); return; }
    const status = node.tm.receive(message, block);
    if (status === 'accepted' || status === 'buffered' || status === 'duplicate' || status === 'equivocation') this.#remember(node, message, block);
    if (status === 'ahead') this.#sync(node);
  }

  /** The pull side of gossip: fetch what peers have buffered for our height and beyond. */
  #poll(node) {
    if (node.online) {
      for (const peer of this.nodes) {
        if (peer === node || !this.#reachable(node, peer)) continue;
        if (peer.height > node.height) this.#sync(node);
        for (const [key, entry] of peer.inbox) {
          if (entry.message.height >= node.height && !node.inbox.has(key)) this.#deliver(peer, node, entry);
        }
      }
    }
    this.schedule(this.pollInterval, () => this.#poll(node));
  }

  #recordSigned(node, message) {
    if (node.fault !== null) return;
    const key = `${message.validator}:${message.height}:${message.round}:${message.type}`;
    let hashes = this.signed.get(key);
    if (!hashes) { hashes = new Set(); this.signed.set(key, hashes); }
    hashes.add(message.hash);
    if (hashes.size > 1) this.violations.push(`honest ${message.validator} signed conflicting ${message.type}s at ${message.height}/${message.round}`);
  }

  /** A decided block's proposal is re-sent, as a node's pull from its peers would. */
  #refetch(node, hash) {
    const entry = this.proposals.get(node.tm.height)?.get(hash);
    if (!entry) return;
    this.schedule(this.#latency(), () => { if (node.online) this.#receive(node, entry.message, entry.block); });
  }

  /** A node that is behind pulls committed blocks from a reachable peer, as /p2p/blocks would. */
  #sync(node) {
    for (const peer of this.nodes) {
      if (peer === node || !this.#reachable(node, peer)) continue;
      while (peer.height > node.height && peer.committed.has(node.height)) {
        const { block, certificate } = peer.committed.get(node.height);
        this.#commit(node, block, certificate, 'sync');
      }
    }
    if (node.online && node.tm.height < node.height) node.tm.start(node.height, null);
  }

  // ------------------------------------------------------------ commits

  #decided(node, block, certificate) {
    const hash = headerHash(block.header);
    if (certificate.hash !== hash || certificate.height !== block.header.height) this.violations.push(`${node.address} produced a certificate for the wrong block`);
    this.#checkCertificate(node, certificate);
    this.#commit(node, block, certificate, 'own');
    // Pacing: the next height starts one block interval after this one was decided.
    this.schedule(this.blockInterval, () => { if (node.online && node.tm.height < node.height) node.tm.start(node.height, null); });
  }

  #checkCertificate(node, certificate) {
    const payload = votePayload('precommit', this.chainId, certificate.height, certificate.round, certificate.hash);
    const signers = new Set();
    for (const entry of certificate.signatures) {
      if (!fakeVerify(payload, entry.validator, entry.signature)) this.violations.push(`${node.address} accepted a bad certificate signature`);
      signers.add(entry.validator);
    }
    if (signers.size < node.tm.quorum) this.violations.push(`${node.address} accepted a certificate without a quorum`);
  }

  #commit(node, block, certificate, source) {
    const height = block.header.height;
    if (height !== node.height) return;
    if (source !== 'own') this.#checkCertificate(node, certificate);
    const hash = headerHash(block.header);
    if (block.header.previousHash !== node.hashes.at(-1)) this.violations.push(`${node.address} committed a block that does not extend its chain at height ${height}`);
    if (node.fault === null) {
      for (const other of this.honest) {
        const decision = other.decisions.get(height);
        if (decision && decision.hash !== hash) this.violations.push(`disagreement at height ${height} between ${node.address} and ${other.address}`);
      }
    }
    node.decisions.set(height, { hash, round: certificate.round, source, time: this.now });
    node.committed.set(height, { block, certificate });
    node.hashes.push(hash);
    node.height = height + 1;
    node.wal = null;
    for (const [key, entry] of node.inbox) if (entry.message.height < node.height) node.inbox.delete(key);
    for (const peer of this.nodes) {
      if (peer === node || !this.#reachable(node, peer) || this.random() < this.drop) continue;
      this.schedule(this.#latency(), () => {
        if (!this.#reachable(node, peer)) return;
        if (block.header.height === peer.height) this.#commit(peer, block, certificate, 'peer');
        if (peer.online && peer.tm.height < peer.height) peer.tm.start(peer.height, null);
      });
    }
  }

  // ------------------------------------------------------------ assertions

  /** Throws unless every honest online node agrees and has reached `minHeight` committed blocks. */
  check({ minHeight }) {
    const problems = [...this.violations];
    const honest = this.honest.filter(node => node.online);
    const longest = honest.reduce((best, node) => (node.hashes.length > best.hashes.length ? node : best), honest[0]);
    for (const node of honest) {
      if (node.height - 1 < minHeight) problems.push(`${node.address} reached only height ${node.height - 1} (wanted ${minHeight})`);
      for (let i = 0; i < node.hashes.length; i += 1) {
        if (node.hashes[i] !== longest.hashes[i]) problems.push(`${node.address} diverges from ${longest.address} at height ${i}`);
      }
    }
    if (problems.length) throw new Error(`Simulation failed:\n  ${[...new Set(problems)].join('\n  ')}`);
  }

  rounds() { return this.honest.flatMap(node => [...node.decisions.values()].map(decision => decision.round)); }
}
