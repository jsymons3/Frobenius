import { faultTolerance, headerHash, proposalPayload, proposerAt, quorum, transactionRoot, updateHash, votePayload } from './consensus.mjs';
import { verifyPayload } from './crypto.mjs';

// Byzantine fault tolerant consensus for one height at a time, following the
// Tendermint algorithm (Buchman, Kwon, Milosevic 2018, Algorithm 1). Rounds are
// propose -> prevote -> precommit; a quorum of precommits for one block in one
// round decides the height and forms its certificate. Locking keeps two different
// blocks from ever being decided at the same height while at most f validators
// misbehave.
//
// The engine is pure: time, signing, networking, persistence, block building, and
// block validation all come in through `effects`, so it runs unchanged inside a
// node and inside the simulated network used by the tests.

const HASH = /^[0-9a-f]{96}$/;
const STEP = { propose: 0, prevote: 1, precommit: 2 };
const STEP_NAMES = ['propose', 'prevote', 'precommit'];
const MESSAGE_KEYS = {
  proposal: ['type', 'chainId', 'height', 'round', 'hash', 'validRound', 'validator', 'signature'],
  prevote: ['type', 'chainId', 'height', 'round', 'hash', 'validator', 'signature'],
  precommit: ['type', 'chainId', 'height', 'round', 'hash', 'validator', 'signature'],
};
const DEFAULT_TIMEOUTS = { propose: 3_000, prevote: 1_000, precommit: 1_000, delta: 500, max: 60_000 };

// Inputs arrive as ordinary JSON. Keep our own immutable snapshot so a caller or
// a later proposal cannot change the body that was validated for a header hash.
function immutableCopy(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
    return item;
  }
  return freeze(copy);
}

/** The fields a validator signed, reconstructed from a message. */
export function payloadOf(message) {
  const { type, chainId, height, round, hash } = message;
  return type === 'proposal' ? proposalPayload(chainId, height, round, hash, message.validRound) : votePayload(type, chainId, height, round, hash);
}

/**
 * effects: {
 *   broadcast(message, block | null), schedule(ms, fn) -> cancel(), decide(block, certificate),
 *   persist(wal), propose() -> block | null, validate(block) -> boolean, missing?(hash)
 * }
 */
export class Tendermint {
  #chainId; #me; #sign; #verify; #effects; #timeouts; #log;
  #validators = []; #keys = new Map(); #f = 0; #q = 1;
  #height = 0; #round = -1; #step = STEP.propose; #decided = false;
  #locked = { round: -1, hash: null };
  #valid = { round: -1, hash: null };
  #proposals = new Map();   // round -> { message, block }
  #blocks = new Map();      // hash -> block
  #prevotes = new Map();    // round -> Map(validator -> message)
  #precommits = new Map();  // round -> Map(validator -> message)
  #flags = new Map();       // round -> once-only rule guards
  #mine = new Map();        // round -> { proposal?, prevote?, precommit? } (persisted)
  #next = [];               // messages for height + 1
  #timers = new Set();
  #pending = null;          // { round, hash } decided without the block

  constructor({ chainId, me = null, sign = null, verify = verifyPayload, effects, timeouts = {}, log = () => {} }) {
    this.#chainId = chainId;
    this.#me = me;
    this.#sign = sign;
    this.#verify = verify;
    this.#effects = effects;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.#log = log;
  }

  get height() { return this.#height; }
  get round() { return this.#round; }
  get step() { return STEP_NAMES[this.#step]; }
  get decided() { return this.#decided; }
  get validators() { return this.#validators; }
  get isValidator() { return this.#me !== null && this.#keys.has(this.#me); }
  get quorum() { return this.#q; }
  get pending() { return this.#pending; }

  setValidators(list) {
    this.#validators = list.map(entry => ({ address: entry.address, publicKey: entry.publicKey }));
    this.#keys = new Map(this.#validators.map(entry => [entry.address, entry.publicKey]));
    this.#f = faultTolerance(this.#validators.length);
    this.#q = quorum(this.#validators.length);
  }

  proposer(round = this.#round) { return proposerAt(this.#validators, this.#height, round).address; }

  info() {
    return { height: this.#height, round: this.#round, step: this.step, proposer: this.#validators.length ? this.proposer() : null, locked: { ...this.#locked }, valid: { ...this.#valid }, decided: this.#decided };
  }

  /** Begin a height. `wal` (as given to persist) restores locks and cast votes after a restart. */
  start(height, wal = null) {
    this.#cancelTimers();
    this.#height = height;
    this.#decided = false;
    this.#pending = null;
    this.#locked = { round: -1, hash: null };
    this.#valid = { round: -1, hash: null };
    for (const map of [this.#proposals, this.#blocks, this.#prevotes, this.#precommits, this.#flags, this.#mine]) map.clear();
    let round = 0;
    if (wal && wal.height === height) {
      this.#locked = { ...wal.locked };
      this.#valid = { ...wal.valid };
      if (wal.validBlock && this.#valid.hash && !this.#validatedBlock(wal.validBlock, this.#valid.hash)) throw new Error('Consensus recovery has an invalid valid block');
      // A validRound is justified by a quorum of signed prevotes, not merely the
      // validator's saved lock. Preserve that proof even when its signers are now
      // offline, and replay it for peers that restarted without the proof.
      const proof = wal.validPrevotes ?? [];
      if (!Array.isArray(proof) || proof.length > this.#q) throw new Error('Invalid consensus recovery prevote proof');
      const signers = new Set();
      for (const message of proof) {
        if (this.verify(message) !== null || message.type !== 'prevote' || message.height !== height || message.round !== this.#valid.round || message.hash !== this.#valid.hash || signers.has(message.validator)) {
          throw new Error('Invalid consensus recovery prevote proof');
        }
        signers.add(message.validator);
        this.#record(message, null);
      }
      if (proof.length !== 0 && proof.length < this.#q) throw new Error('Consensus recovery prevote proof lacks a quorum');
      for (const [key, votes] of Object.entries(wal.votes)) {
        const mine = {};
        if (votes.proposal) mine.proposal = votes.proposal;
        if (votes.prevote) mine.prevote = votes.prevote;
        if (votes.precommit) mine.precommit = votes.precommit;
        this.#mine.set(Number(key), mine);
        // Count and re-send what this validator already signed, so it never signs twice.
        if (mine.proposal) { this.#record(mine.proposal.message, mine.proposal.block); this.#effects.broadcast(mine.proposal.message, mine.proposal.block); }
        for (const message of [mine.prevote, mine.precommit]) if (message) { this.#record(message, null); this.#effects.broadcast(message, null); }
      }
      for (const message of proof) this.#effects.broadcast(message, null);
      round = wal.round;
      this.#log({ event: 'resumed', height, round });
    }
    const buffered = this.#next;
    this.#next = [];
    this.#startRound(round);
    for (const { message, block } of buffered) if (this.verify(message) === null) this.receive(message, block);
  }

  /** Cancel timers and stop acting; used at shutdown. */
  stop() {
    this.#cancelTimers();
    this.#decided = true;
  }

  /** Shape and signature check against the active set. Returns a reason, or null when valid. */
  verify(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return 'not an object';
    const keys = MESSAGE_KEYS[message.type];
    if (!keys) return 'unknown message type';
    const actual = Object.keys(message);
    if (actual.length !== keys.length || !keys.every(key => actual.includes(key))) return 'wrong fields';
    if (message.chainId !== this.#chainId) return 'another chain';
    if (!Number.isSafeInteger(message.height) || message.height < 1) return 'bad height';
    if (!Number.isSafeInteger(message.round) || message.round < 0) return 'bad round';
    if (message.type === 'proposal') {
      if (typeof message.hash !== 'string' || !HASH.test(message.hash)) return 'bad hash';
      if (!Number.isSafeInteger(message.validRound) || message.validRound < -1 || message.validRound >= message.round) return 'bad valid round';
    } else if (message.hash !== null && (typeof message.hash !== 'string' || !HASH.test(message.hash))) return 'bad hash';
    const key = this.#keys.get(message.validator);
    if (!key) return 'not a validator';
    if (typeof message.signature !== 'string' || !this.#verify(payloadOf(message), key, message.signature)) return 'bad signature';
    return null;
  }

  /**
   * Feed a verified message. Returns accepted | duplicate | equivocation | buffered
   * (next height) | ahead (we are behind) | ignored | rejected.
   */
  receive(message, block = null) {
    if (message.height === this.#height + 1) {
      // The bus de-duplicates accepted messages by their signed header hash.
      // Reject inconsistent bodies before it remembers a future proposal;
      // state-dependent validation still waits until this height starts.
      const copy = message.type === 'proposal' ? this.#bodySnapshot(block, message.hash) : null;
      if (message.type === 'proposal' && !copy) return 'rejected';
      if (this.#next.length < 10_000) this.#next.push({ message: immutableCopy(message), block: copy });
      return 'buffered';
    }
    if (message.height > this.#height + 1) return 'ahead';
    if (message.height !== this.#height || this.#decided) return 'ignored';
    if (!this.#keys.has(message.validator)) return 'rejected';
    if (message.type === 'proposal') {
      if (message.validator !== this.proposer(message.round)) return 'rejected';
    }
    const status = this.#record(message, block);
    if (status === 'accepted') {
      this.#maybeSkip(message.round);
      this.#evaluate();
    }
    return status;
  }

  // ------------------------------------------------------------ bookkeeping

  #record(message, block) {
    const { type, round, validator } = message;
    if (type === 'proposal') {
      const validated = this.#validatedBlock(block, message.hash);
      if (!validated) return 'rejected';
      const existing = this.#proposals.get(round);
      if (existing) {
        if (existing.message.hash !== message.hash) { this.#equivocation(existing.message, message); return 'equivocation'; }
        return 'duplicate';
      }
      this.#proposals.set(round, { message: immutableCopy(message), block: validated });
      return 'accepted';
    }
    const table = type === 'prevote' ? this.#prevotes : this.#precommits;
    let votes = table.get(round);
    if (!votes) { votes = new Map(); table.set(round, votes); }
    const existing = votes.get(validator);
    if (existing) {
      if (existing.hash !== message.hash) { this.#equivocation(existing, message); return 'equivocation'; }
      return 'duplicate';
    }
    votes.set(validator, immutableCopy(message));
    return 'accepted';
  }

  #equivocation(first, second) {
    // Two conflicting signed messages from one validator for the same height, round,
    // and type: proof of misbehavior. Kept as evidence; slashing is future work.
    this.#log({ event: 'equivocation', validator: first.validator, type: first.type, height: first.height, round: first.round, first: first.hash, second: second.hash });
  }

  #count(votes, hash) {
    let total = 0;
    if (votes) for (const message of votes.values()) if (message.hash === hash) total += 1;
    return total;
  }

  #maybeSkip(round) {
    if (round <= this.#round) return;
    const seen = new Set();
    const proposal = this.#proposals.get(round);
    if (proposal) seen.add(proposal.message.validator);
    for (const validator of this.#prevotes.get(round)?.keys() ?? []) seen.add(validator);
    for (const validator of this.#precommits.get(round)?.keys() ?? []) seen.add(validator);
    if (seen.size >= this.#f + 1) this.#startRound(round);
  }

  #bodySnapshot(block, hash) {
    try {
      const copy = immutableCopy(block);
      // Check the *incoming* body before using a hash-keyed validation result.
      // The header alone does not authenticate a replacement transaction list
      // or validator update. Never let an invalid body poison a valid hash.
      if (!copy?.header || Object.keys(copy).length !== 3 || !['header', 'transactions', 'validatorUpdate'].every(key => Object.hasOwn(copy, key)) || headerHash(copy.header) !== hash || !Array.isArray(copy.transactions) || transactionRoot(copy.transactions) !== copy.header.txRoot || updateHash(copy.validatorUpdate) !== copy.header.updateHash) return null;
      return copy;
    } catch { return null; }
  }

  #validatedBlock(block, hash) {
    try {
      const copy = this.#bodySnapshot(block, hash);
      if (!copy) return null;
      if (this.#blocks.has(hash)) return this.#blocks.get(hash);
      if (this.#effects.validate(copy) !== true) return null;
      this.#blocks.set(hash, copy);
      return copy;
    } catch { return null; }
  }

  // ------------------------------------------------------------ the algorithm

  #startRound(round) {
    this.#round = round;
    this.#step = STEP.propose;
    if (!this.#flags.has(round)) this.#flags.set(round, { prevoteTimeout: false, precommitTimeout: false, polka: false });
    this.#log({ event: 'round', height: this.#height, round, proposer: this.proposer() });
    if (this.isValidator && this.proposer() === this.#me) {
      const mine = this.#mine.get(round);
      if (mine?.proposal) {
        this.#effects.broadcast(mine.proposal.message, mine.proposal.block);
      } else {
        // Re-propose the value that already earned a polka, if any; otherwise build fresh.
        let block = this.#valid.round >= 0 ? (this.#blocks.get(this.#valid.hash) ?? null) : this.#effects.propose();
        if (block) block = this.#validatedBlock(block, headerHash(block.header));
        if (block) {
          const hash = headerHash(block.header);
          const message = this.#signed(proposalPayload(this.#chainId, this.#height, round, hash, this.#valid.round));
          this.#remember(round, 'proposal', { message, block });
          this.#persist();
          this.#effects.broadcast(message, block);
          this.#record(message, block);
        } else {
          this.#schedule('propose', round);
        }
      }
    } else {
      this.#schedule('propose', round);
    }
    this.#evaluate();
  }

  #evaluate() {
    for (let i = 0; i < 16 && this.#pass(); i += 1);
  }

  /** One pass over the rules for the current round. Returns true if anything changed. */
  #pass() {
    if (this.#decided) return false;
    const r = this.#round;
    const flags = this.#flags.get(r);
    const proposal = this.#proposals.get(r);
    const prevotes = this.#prevotes.get(r);
    const precommits = this.#precommits.get(r);
    let changed = false;

    // The round's proposal arrives while we are still in the propose step.
    if (this.#step === STEP.propose && proposal) {
      const { hash, validRound: vr } = proposal.message;
      const polkaForVr = vr >= 0 && vr < r && this.#count(this.#prevotes.get(vr), hash) >= this.#q;
      if (vr === -1 || polkaForVr) {
        const unlockedFor = vr === -1 ? (this.#locked.round === -1 || this.#locked.hash === hash) : (this.#locked.round <= vr || this.#locked.hash === hash);
        this.#vote('prevote', unlockedFor ? hash : null);
        this.#step = STEP.prevote;
        changed = true;
      }
    }
    // A quorum of prevotes of any kind: the round will resolve one way or another soon.
    if (this.#step === STEP.prevote && (prevotes?.size ?? 0) >= this.#q && !flags.prevoteTimeout) {
      flags.prevoteTimeout = true;
      this.#schedule('prevote', r);
      changed = true;
    }
    // A polka (quorum of prevotes) for the round's proposal: lock on it and precommit.
    if (proposal && this.#step >= STEP.prevote && !flags.polka && this.#count(prevotes, proposal.message.hash) >= this.#q) {
      flags.polka = true;
      const hash = proposal.message.hash;
      this.#valid = { round: r, hash };
      if (this.#step === STEP.prevote) {
        this.#locked = { round: r, hash };
        this.#vote('precommit', hash);
        this.#step = STEP.precommit;
      } else {
        this.#persist();
      }
      changed = true;
    }
    // A quorum of nil prevotes: nothing can be decided this round.
    if (this.#step === STEP.prevote && this.#count(prevotes, null) >= this.#q) {
      this.#vote('precommit', null);
      this.#step = STEP.precommit;
      changed = true;
    }
    // A quorum of precommits of any kind: give the round a moment, then move on.
    if ((precommits?.size ?? 0) >= this.#q && !flags.precommitTimeout) {
      flags.precommitTimeout = true;
      this.#schedule('precommit', r);
      changed = true;
    }
    // A quorum of precommits for one block, in any round, decides the height.
    for (const [round, votes] of this.#precommits) {
      const tally = new Map();
      for (const message of votes.values()) if (message.hash !== null) tally.set(message.hash, (tally.get(message.hash) ?? 0) + 1);
      for (const [hash, total] of tally) {
        if (total < this.#q) continue;
        const block = this.#blocks.get(hash);
        if (!block) {
          if (this.#pending?.hash !== hash) { this.#pending = { round, hash }; this.#effects.missing?.(hash); }
          continue;
        }
        this.#decide(block, hash, round, votes);
        return true;
      }
    }
    return changed;
  }

  #decide(block, hash, round, votes) {
    this.#decided = true;
    this.#pending = null;
    this.#cancelTimers();
    const signatures = [...votes.values()].filter(message => message.hash === hash).map(message => ({ validator: message.validator, signature: message.signature }));
    this.#log({ event: 'decided', height: this.#height, round, signatures: signatures.length });
    this.#effects.decide(block, { height: this.#height, round, hash, signatures });
  }

  #vote(type, hash) {
    if (!this.isValidator) return;
    const round = this.#round;
    let message = this.#mine.get(round)?.[type];
    if (!message) {
      // Never sign two different votes of one type in one round: the WAL check above
      // and persisting before sending keep that true across restarts.
      message = this.#signed(votePayload(type, this.#chainId, this.#height, round, hash));
      this.#remember(round, type, message);
    }
    // Restored votes may already exist while a newly learned polka changes our
    // lock/proof. Save that state even when we are only replaying a signed vote.
    this.#persist();
    this.#effects.broadcast(message, null);
    this.#record(message, null);
  }

  #signed(payload) {
    return { ...payload, validator: this.#me, signature: this.#sign(payload) };
  }

  #remember(round, type, value) {
    let mine = this.#mine.get(round);
    if (!mine) { mine = {}; this.#mine.set(round, mine); }
    mine[type] = value;
  }

  /** Everything a restarted validator needs to continue the height without equivocating. */
  wal() {
    const votes = {};
    for (const [round, mine] of this.#mine) votes[round] = { proposal: mine.proposal ?? null, prevote: mine.prevote ?? null, precommit: mine.precommit ?? null };
    const proof = this.#valid.hash ? [...(this.#prevotes.get(this.#valid.round)?.values() ?? [])].filter(message => message.hash === this.#valid.hash).slice(0, this.#q) : [];
    // Old records did not retain the proof. Keep their lock while waiting for
    // peer gossip, but never write a partial proof that appears self-contained.
    const validPrevotes = proof.length === this.#q ? proof : [];
    return {
      height: this.#height, round: this.#round, locked: { ...this.#locked }, valid: { ...this.#valid },
      validBlock: this.#valid.hash ? (this.#blocks.get(this.#valid.hash) ?? null) : null, validPrevotes, votes,
    };
  }

  #persist() {
    if (this.isValidator) this.#effects.persist(this.wal());
  }

  // ------------------------------------------------------------ timers

  #schedule(kind, round) {
    const delay = Math.min(this.#timeouts[kind] + round * this.#timeouts.delta, this.#timeouts.max);
    const height = this.#height;
    const timer = {};
    timer.cancel = this.#effects.schedule(delay, () => {
      this.#timers.delete(timer);
      this.#onTimeout(kind, height, round);
    });
    this.#timers.add(timer);
  }

  #cancelTimers() {
    for (const timer of this.#timers) timer.cancel?.();
    this.#timers.clear();
  }

  #onTimeout(kind, height, round) {
    if (height !== this.#height || round !== this.#round || this.#decided) return;
    if (kind === 'propose' && this.#step === STEP.propose) {
      this.#vote('prevote', null);
      this.#step = STEP.prevote;
      this.#evaluate();
    } else if (kind === 'prevote' && this.#step === STEP.prevote) {
      this.#vote('precommit', null);
      this.#step = STEP.precommit;
      this.#evaluate();
    } else if (kind === 'precommit') {
      this.#startRound(round + 1);
    }
  }
}
