# Frobenius Beans protocol, version 3

Status: **draft for a friends testnet**. Not audited. Anything here may change
before a mainnet, and any change to a consensus rule requires a new genesis or a
coordinated upgrade of every node.

Sections 1–10 are **consensus rules**: every node must apply them identically or the
network splits. Section 11 is **node policy**: local choices that do not split the
network. Sections 12–13 describe the reference node's HTTP interfaces.

`test/vectors.json` pins the exact bytes for every hash and signature below. A
compatible implementation must reproduce it.

## 1. Encoding

- **Canonical JSON.** Signed and hashed objects are encoded as JSON with object keys
  sorted by UTF-16 code unit order, no whitespace, strings escaped as `JSON.stringify`
  escapes them, and numbers only as safe integers (|n| ≤ 2^53 − 1). Floats, sparse
  arrays, accessors, symbols, and nesting deeper than 64 levels are rejected.
- **Amounts** are canonical decimal strings in atomic units: `0` or `[1-9][0-9]{0,17}`.
  1 Bean = 1,000,000 atomic units.
- **Hashes and keys** are lowercase hexadecimal. `H(x)` is SHA3-384 over the UTF-8
  bytes of `x`, written as 96 hex characters.
- **Timestamps** are Unix milliseconds.
- Objects must have exactly the listed fields: missing or extra fields are invalid.

## 2. Cryptography and addresses

- Signatures: **ML-DSA-65** (FIPS 204). Public keys are 1,952 bytes and signatures
  are 3,309 bytes, both hex-encoded. Keys come from a 32-byte seed via
  `ML-DSA-65.KeyGen(seed)`.
- Every signed object, whether a transfer, a consensus vote, or a validator
  approval, is signed over the bytes of
  `"Frobenius/Beans/signed-payload/v1\0" + canonicalJSON(payload)`. Consensus and
  approval payloads carry a `type` field that transfer payloads never have, so the
  kinds cannot be confused. Signers may use hedged (randomized) or deterministic
  signing; verifiers accept both.
- Canonical signed payloads are limited to 128 KiB, except validator approvals
  (`type: "validators"`), which allow 512 KiB to accommodate all 100 public keys.
  This changes the size bound, not the signing domain or canonical encoding.
- Address: with `d = H(publicKeyBytes)`, the address is
  `"beans1" + d + H("Frobenius/Beans/address/v1\0" + d)[0..8]`, 110 characters, the
  last 8 a checksum. Addresses are unchanged from v1 and v2.

## 3. Genesis and chain identity

A network is defined entirely by its genesis document:

| Field | Rule |
| --- | --- |
| `version` | `3` |
| `network` | `"frobenius"` |
| `name` | `[a-z0-9][a-z0-9-]{0,31}` |
| `createdAt` | positive safe integer (ms); the timestamp of height 0 |
| `salt` | 64 hex characters; makes each genesis unique |
| `allocations` | ≤ 1000 `{address, amount}` with unique, valid addresses and positive amounts |
| `totalSupply` | positive amount; hard cap on all Beans ever issued |
| `blockReward` | amount ≤ `totalSupply`; may be `0` for a fixed supply |
| `blockInterval` | 1,000 – 86,400,000 ms |
| `validators` | 1–100 `{address, publicKey}`; each address must derive from its key; no duplicates |
| `maxBlockBytes` | 16 KiB – 32 MiB |
| `maxBlockTransactions` | 1 – 5000 |

The sum of allocations must not exceed `totalSupply`. An empty `allocations` list
means every Bean is issued as block rewards.

- `genesisHash = H(canonicalJSON(genesis))`. This is the block hash of height 0.
- `chainId = "frobenius-" + name + "-" + genesisHash`. Every transaction, block,
  vote, and approval carries it, so nothing signed for one network is valid on another.

Reference defaults (`frob genesis`): 100,000,000 Beans total supply, a 2-Bean
reward, 5-second blocks, 1 MiB blocks, at most 250 transactions per block.

## 4. Transactions

```json
{
  "payload": {
    "version": 3, "chainId": "…", "from": "beans1…", "to": "beans1…",
    "amount": "1500000", "fee": "1000", "nonce": 0, "memo": "lunch"
  },
  "publicKey": "…3904 hex…",
  "signature": "…6618 hex…"
}
```

- `amount` > 0 and `fee` ≥ 0, both ≤ `totalSupply`. `nonce` is a safe integer
  ≥ 0. `memo` is at most 140 code points and at most 280 UTF-16 units.
- `transactionId = H(canonicalJSON(payload))`. It excludes the signature, so a wallet
  that re-signs the same transfer on retry gets the same id.
- `transactionHash = H(canonicalJSON(transaction))`. It includes the signature and is
  used for the block's transaction root.
- Valid against a state when: the shape rules hold; `address(publicKey) == from`;
  the signature verifies; `nonce` equals the sender's current nonce; and the sender's
  balance ≥ `amount + fee`.
- Applying a transaction subtracts `amount + fee` from `from`, adds `amount` to `to`,
  and increments the sender's nonce. Sending to yourself is allowed and still costs
  the fee.

## 5. Validators, faults, and quorums

The **active validator set** is part of the ledger state. It starts as the genesis
list and changes only through validator updates (section 8). With `n` active
validators:

- `f = floor((n − 1) / 3)` validators may be faulty (offline or malicious) without
  affecting safety or liveness.
- A **quorum** is `n − f` validators. Any two quorums share at least `f + 1`
  validators, so at least one honest one.
- The **proposer** for height `h` and round `r` is `validators[(h + r) mod n]`, in
  list order.

With 4 validators the quorum is 3 and one may fail; with 7 it is 5 and two may fail.
Three validators tolerate none: any one offline halts the chain.

## 6. Blocks

```json
{
  "header": {
    "version": 3, "chainId": "…", "height": 1, "previousHash": "…",
    "timestamp": 1792643134826, "proposer": "beans1…", "txRoot": "…", "updateHash": "…"
  },
  "transactions": [ … ],
  "validatorUpdate": null
}
```

- `blockHash = H(canonicalJSON(header))`. This is the block's identifier and what
  validators vote on.
- `txRoot = H(canonicalJSON([transactionHash(tx) for tx in transactions]))`. Order matters.
- `updateHash = H("")` when `validatorUpdate` is `null`, else
  `H(canonicalJSON(validatorUpdate))`.

A block is valid on top of its parent when all of the following hold:

1. It has the shape above, `chainId` matches, `proposer` is a valid address, it
   holds at most `maxBlockTransactions` transactions, every transaction passes the
   shape rules, `byteLength(canonicalJSON(block)) ≤ maxBlockBytes`, and `txRoot`
   and `updateHash` match the body.
2. `height = parent.height + 1` and `previousHash = blockHash(parent)` (the genesis
   hash for height 1).
3. `timestamp > parent.timestamp`.
4. `proposer` is in the active validator set.
5. If `validatorUpdate` is not `null`, it is valid against the state (section 8).
6. Its transactions apply in order to the parent's state (section 7). Later
   transactions may spend funds received from earlier ones in the same block.

Nothing in the header identifies the consensus round: the same block may be decided
in any round, and the round lives in the certificate (section 10).

## 7. State transition and supply

- Initial state: each allocation's balance, all nonces 0, `issued = Σ allocations`,
  the genesis validator set, and `validatorSequence = 0`.
- For each block: apply its transactions in order. Then
  `subsidy = min(blockReward, totalSupply − issued)`. Credit `proposer` with
  `subsidy + Σ fees`, set `issued += subsidy`, and apply the validator update if any.
- Invariant: Σ balances = `issued` ≤ `totalSupply`. Fees move existing Beans; only the
  subsidy creates new ones. Once the cap is reached, proposers earn fees only.
- Proposers rotate, so over `n` consecutive heights every validator proposes once;
  rewards spread evenly over time, and a validator that is offline when its turn comes
  earns nothing for that height.
- With the defaults and an empty allocation list, issuance takes 50,000,000 blocks,
  about 7.9 years at 5-second blocks.

## 8. Validator updates

A block may carry one update to the active set:

```json
{
  "sequence": 1,
  "validators": [ { "address": "beans1…", "publicKey": "…" }, … ],
  "approvals": [ { "validator": "beans1…", "signature": "…" }, … ]
}
```

- `sequence` must equal the state's `validatorSequence + 1`.
- `validators` follows the genesis list rules (1–100 entries, keys derive addresses,
  no duplicates).
- Each approval is a signature by a member of the **current** active set over
  `{ "type": "validators", "chainId", "sequence", "validators" }`, with `validators`
  exactly as listed. Signers must be distinct, and there must be at least a quorum of
  the current set.
- Applying the block replaces the active set and increments `validatorSequence`. The
  new set is in force from the next height: it chooses proposers, votes, and signs the
  certificate for `height + 1` onward. The block carrying the update is still
  certified by the old set.

Because every height is decided exactly once (section 9), the set active at any
height is unambiguous: it is whatever the state says after the previous block.

## 9. Consensus

Validators run the Tendermint algorithm (Buchman, Kwon, Milosevic, 2018) one height
at a time. All messages are signed by their sender and carry `chainId`, `height`,
and `round`.

| Message | Signed payload |
| --- | --- |
| proposal | `{type:"proposal", chainId, height, round, hash, validRound}`; the block travels alongside and must hash to `hash` |
| prevote | `{type:"prevote", chainId, height, round, hash}` where `hash` is a block hash or `null` |
| precommit | `{type:"precommit", chainId, height, round, hash}` likewise |

A proposal is only accepted from the proposer of its height and round. A validator
sends at most one proposal, one prevote, and one precommit per round; two different
ones for the same height, round, and type are **equivocation**, which honest nodes
record as evidence and otherwise ignore (the first seen counts).

Per validator, per height, with `lockedRound = validRound = −1` and no locked or
valid block:

1. **Start round r.** If I am the proposer: propose the valid block if one is set,
   with its `validRound`; otherwise build a fresh block (section 6) and propose it with
   `validRound = −1`. Otherwise start the propose timeout.
2. **On the round's proposal** `(block, vr)` while still in the propose step: if
   `vr = −1`, or `0 ≤ vr < r` and I hold a quorum of prevotes for `hash(block)` at round
   `vr`: prevote `hash(block)` if the block is valid and I am either not locked, locked
   on this block, or (when `vr ≥ 0`) locked at a round ≤ `vr`; otherwise prevote `null`.
3. **On a quorum of prevotes of any kind** at round r while in the prevote step, the
   first time: start the prevote timeout.
4. **On the round's proposal plus a quorum of prevotes for its hash**, with the block
   valid, while at or past the prevote step, the first time: set the valid block and
   `validRound = r`; if still in the prevote step, also lock on the block with
   `lockedRound = r` and precommit its hash.
5. **On a quorum of `null` prevotes** at round r while in the prevote step: precommit `null`.
6. **On a quorum of precommits of any kind** at round r, the first time: start the
   precommit timeout.
7. **On a quorum of precommits for one block hash** in any round, with the block
   known: **decide** that block for this height.
8. **On messages from `f + 1` distinct validators at a round `r' > r`**: start round `r'`.
9. **Propose timeout** while in the propose step: prevote `null`. **Prevote timeout**
   while in the prevote step: precommit `null`. **Precommit timeout**: start round `r + 1`.

A validator never signs two different votes of one type in one round, including
across restarts: it writes each vote to a write-ahead record before sending it and
re-sends the recorded votes when it resumes.
The record also keeps the valid block and a quorum of distinct signed prevotes for
its `validRound`. Recovery checks the proof against the active validator set and
rebroadcasts it, so a later proposal remains justified if a proof signer is offline.
Every incoming proposal body must match its header's transaction and update roots;
the engine retains an immutable validated body for that header hash. Committing
revalidates the body against the current chain state.

Why it is safe: a decided block has a quorum of precommits in one round, so at least
`f + 1` honest validators locked on it there. Each of them prevotes only for that block
in later rounds unless they see a quorum of prevotes for another block at a later
round, which cannot form without one of them. So no other block can gather a quorum
of prevotes, let alone precommits, at that height.

## 10. Finality, certificates, and sync

- A **certificate** is `{ height, round, hash, signatures: [{validator, signature}] }`
  with at least a quorum of distinct active validators' precommit signatures for
  `hash` in `round`. It verifies against the validator set active at `height`.
- A block is **final** the moment it has a certificate. There are no forks, no
  reorganizations, and no confirmation counting.
- A node commits a block only with its certificate, or inside a **sync batch**:
  consecutive blocks whose last block carries a certificate. Within a batch, every
  header must link to the previous hash, every body must match its header, and every
  validator update must carry its approvals and the transition block's certificate
  from the old validator set. The final certificate covers the suffix after the
  last transition. Other older certificates may therefore be dropped.
- The reference node keeps certificates for the most recent 1,000 blocks and for
  periodic checkpoints forever. Checkpoint spacing is at most 100 blocks and is
  reduced using the genesis maximum block size so the span, JSON envelope, and a
  final certificate fit within 64 MiB. Every validator-change certificate is kept.
  Responses are measured using their actual UTF-8 JSON byte length and always end
  at a certified block. They can contain fewer than the requested number of blocks,
  or extend to the next checkpoint when the requested endpoint was pruned.
- A node joining later replays blocks from genesis, tracking validator updates as it
  goes, so it knows which set must have signed each certificate it checks.

## 11. Node policy (not consensus)

Reference-node defaults that operators may change without splitting the network:

- **Timeouts.** Propose 3 s, prevote 1 s, precommit 1 s, each plus 0.5 s per round,
  capped at 60 s.
- **Pacing.** After deciding a block, a validator waits until
  `block.timestamp + blockInterval` (at most `blockInterval`) before starting the next
  height, so empty blocks arrive at the configured rhythm and a proposer's clock
  cannot stall the chain. After committing a block learned from a peer, it starts the
  next height at once.
- **Clock drift.** A proposal whose timestamp is more than 15 minutes ahead of local
  time is treated as invalid for voting. Committed blocks and sync batches are not
  re-checked against the clock.
- **Observers.** Every node runs the consensus engine. One without a validator key in
  the active set only tracks votes, and commits each block itself as soon as it has
  seen a quorum of precommits, without waiting to be sent the certificate.
- **Mempool.** At least `minRelayFee` (0.001 Bean). Each sender's pending transfers
  must have gap-free nonces and be covered by the sender's confirmed balance; pending
  incoming funds cannot be spent. At most 25 pending per sender and 2,000 in total.
  Replace-by-fee: a transfer with the same sender and nonce replaces the pending one
  only if its fee is strictly higher.
- **Block assembly.** Highest fee first, keeping each sender in nonce order; a
  pending validator update is included by the next proposer who holds it.
- **Gossip.** A node pushes every message it signs or accepts to its peers, and
  long-polls each peer for messages it has not seen. Messages for heights below the
  next one are dropped; messages two heights ahead trigger a sync. Equivocating
  messages are kept as evidence and not re-counted.
- **Startup.** Stored blocks are replayed with full verification by default.
  `--fast-start` trusts this node's own earlier checks of signatures and certificates
  but still applies every state transition.

## 12. Peer-to-peer protocol (HTTP + JSON)

Every node keeps a set of outbound peers: seeds from `--peer`, plus peers learned
through discovery (every twelfth poll). It polls each one's `hello` every 3 seconds
and holds one long-poll on each for consensus messages. A node behind NAT can
validate with only outbound connections: it pulls what it misses and pushes what it
signs to the peers it can reach, which relay onward.

| Endpoint | Purpose |
| --- | --- |
| `GET /p2p/hello` | `{protocol, software, chainId, height, tipHash, publicUrl, validator}` |
| `GET /p2p/blocks?from=&limit=` | `{blocks: [{block, certificate}]}`: target 1–100 blocks, adjusted to a certified endpoint, at most 64 MiB |
| `POST /p2p/block` `{block, certificate}` | A committed block; returns `{status}` |
| `GET /p2p/consensus?after=&wait=` | `{session, seq, messages: [{message, block?}]}`; waits up to `wait` ms (≤ 3000) for news |
| `POST /p2p/consensus` `{messages}` | Up to 50 `{message, block?}` entries |
| `POST /p2p/tx` | Relay a transfer |
| `GET /p2p/mempool`, `POST /p2p/txs` `{ids}` | Pending transfer ids and bodies |
| `GET /p2p/peers` | URLs of this node's peers |

`seq` is a per-node counter and `session` changes when the node restarts; a client
whose `session` changes restarts from `after=0`. A request may carry
`X-Frobenius-Node: <publicUrl>` so the receiver can avoid echoing messages back.

Status values for blocks: `accepted`, `duplicate`, `ahead` (the receiver is behind
and will sync), `invalid`. A peer that serves a different `chainId` is ignored for a
day; one that serves a batch that fails verification is ignored for an hour.

## 13. Wallet API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/info` | Height, tip, supply, validator count, quorum, pending count, minimum fee, this node's validator address and consensus state |
| `GET /api/genesis` | The genesis document |
| `GET /api/validators` | Active set, sequence, quorum, next proposer |
| `POST /api/validators` | Submit a validator update for inclusion; only a node in the active set accepts it |
| `GET /api/account?address=` | Balance, pending balance, next nonce, pending and recent history |
| `GET /api/tx?id=` | Confirmed (height, block, confirmations) or pending |
| `GET /api/block?height=` or `?hash=` | A block with its certificate (null once pruned) |
| `POST /api/tx` | Submit a signed transfer; idempotent by `transactionId` |

## 14. Changes from v2 (the proof-of-work draft)

| v2 | v3 |
| --- | --- |
| Anyone mines; the most-work chain wins | A known validator set votes; a quorum of precommits decides |
| Probabilistic finality; reorganizations up to 100 blocks | Final on commit; no forks |
| scrypt proof of work and difficulty retargeting | No hashing; blocks paced by a timer |
| Rewards and fees to the miner | Rewards and fees to the round's proposer, rotating through the set |
| Block header carries `target` and `nonce` | Header carries `proposer` and `updateHash`; the round lives in the certificate |
| Validator set: none | In state; changed by quorum-approved updates |
| Block locator and most-work sync | Height-based sync batches with certificates and checkpoints |
| Transaction `version: 2` | `version: 3` |

Keys, addresses, the transaction payload layout, fees, and the mempool rules carry
over unchanged. v2 and v3 chains are separate networks; to carry balances forward,
list them as v3 genesis allocations.

## 15. Known gaps before a mainnet

- No independent audit of the consensus engine or the cryptography. The JavaScript
  ML-DSA signer is not constant-time.
- **Permissioned.** The validator set is whoever the current set approves. Open
  staking (bond Beans to become a validator) and slashing (destroying stake for
  provable equivocation) are not implemented; equivocation is only logged.
- Validator keys are hot: the seed sits on the server that signs votes.
- Certificates carry one 3.3 KB signature per validator, so the design is practical
  up to roughly 100 validators; beyond that, committees would be needed.
- No per-IP rate limiting. A peer can make a node verify many bad signatures.
- Proposals are downloaded from every peer that has them before de-duplication.
- Ledger balances are kept in memory; the indexes are on disk.
- No light clients: a wallet trusts the node it talks to.
- Gossip is HTTP push plus long-poll; a streaming transport would reduce latency.
