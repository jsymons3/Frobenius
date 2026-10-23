# Exchange integration: experimental v3

This document describes the existing interfaces for an exchange integration.
There is no completed AltQuick adapter or official public v3 network. An exchange
should test a dedicated integration against a private development network first;
publishing this repository does not create a listing or make deposits operational.
See [Networks](NETWORKS.md) for the distinction from the older friends service.

## Trust and custody boundary

Run an exchange-controlled observer using the agreed genesis and reviewed source.
The node validates blocks and consensus certificates, stores the ledger, and
accepts signed transactions. It does not store customer keys, create exchange
accounts, authenticate customers, sign withdrawals, or maintain the exchange's
internal balances. Those responsibilities belong to the exchange application and
a separately protected signer. No built-in webhook or custody RPC is provided.

Current finality assumes fewer than one third of the equal-weight approved
validators are faulty, with quorum participation required for progress. The API's
`confirmations` counter is block depth; it is not proof-of-work confirmation
security. A valid quorum commit is the protocol's finality condition. The exchange
still needs an explicit policy for outages, inconsistent nodes, upgrades, and
security incidents. v3 has no light-client implementation: clients querying an
untrusted API need an independently verifying observer rather than treating an
API response alone as a verified consensus proof.

## Network and amounts

- Pin the genesis and derived `chainId` in the integration; verify them on startup
  using `GET /api/genesis` and `GET /api/info`. An address alone does not identify
  its network: address encoding is shared with earlier Frobenius versions.
- One Bean is **1,000,000 atomic units**. API amount and fee fields are decimal
  strings in atomic units. Use integer arithmetic (`BigInt` in JavaScript), never
  floating-point rounding for balances or withdrawals.
- Use `validateAddress()` from `src/crypto.mjs` for checksums. Generate a separate
  wallet with `generateWallet()` or `frob keygen` for each deposit address when
  appropriate. No hierarchical deterministic wallet or extended public-key
  derivation API is implemented. Retain the address-to-customer mapping and key
  backups in exchange-controlled systems.
- Transactions include a public memo. Do not put customer secrets or personal
  account information in it.

## Endpoints currently available

All paths below are relative to your v3 observer, such as
`http://127.0.0.1:8800` on a development machine. These are not endpoints on the
older `beans.f-3.ai` service.

| Request | Relevant result |
| --- | --- |
| `GET /api/info` | `protocol`, `chainId`, `height`, `tipHash`, `tipTimestamp`, supply, `minRelayFee`, consensus state |
| `GET /api/genesis` | Genesis document with allocations, initial validators, and chain rules |
| `GET /api/account?address=ADDRESS` | Confirmed `balance`, `confirmedNonce`, mempool-adjusted `pendingBalance` and next `nonce`, pending transfers, recent history |
| `GET /api/block?height=HEIGHT` | `hash`, `height`, `block`, `certificate`, `confirmations` |
| `GET /api/tx?id=ID` | `confirmed` with height/block hash, or `pending`; HTTP 404 if this node does not know the transaction |
| `POST /api/tx` | Submit `{payload, publicKey, signature}`; returns `{id, status}` where status is `pending` or `confirmed` |
| `GET /api/validators` | Current validator addresses, quorum, sequence, next proposer |

There is no API token or HTTP authentication layer in the node. Restrict access to
exchange infrastructure and add appropriate transport and access controls there.
Signing a transaction is the authorization to spend; no seed is sent to the API.
Existing protocol rules and exact response definitions are in [SPEC](SPEC.md).

## Deposits and reconciliation

1. Poll `/api/info`, then scan every committed block height after your durable
   scan cursor via `/api/block?height=...`. Validate the chain identity and link to
   the previous block; your own observer already checks consensus on ingestion.
2. Inspect each block's `transactions` for transfers to registered deposit
   addresses. Derive each ID using `transactionId()` from `src/consensus.mjs`.
   Account history returns only the most recent 50 entries and has no pagination;
   it is unsuitable as the only deposit index.
3. Record the network, transaction ID, block hash, height, destination, and amount.
   Credit each deposit once, using an atomic database operation that also advances
   the scan cursor. Re-scans must be idempotent. Never credit `pendingBalance` or a
   mempool acceptance response as a deposit.
4. Reconcile exchange ledger balances against on-chain accounts, accounting for
   withdrawals, fees, and internal sweeps. Treat genesis allocations and proposer
   rewards separately if the exchange deliberately uses addresses that receive
   them; they are not ordinary transfer records.

Old blocks may have `certificate: null` after certificate pruning. This is not a
signal to credit an unverified remote block: the observer verifies synchronization
through retained certificates and validator transitions. The exchange should
retain the evidence required by its own reconciliation policy. Do not silently
reset a cursor or switch genesis when an API reports a different network.

## Withdrawals, nonces, and retries

Serialize creation of withdrawals from each sending address in the exchange
database. `/api/account` returns `confirmedNonce` and a next `nonce` that includes
this node's pending outgoing transfers; other nodes may have different mempools.
Reserve nonces durably in the exchange rather than having parallel clients race
to use that value. A sender must have confirmed funds for the amount plus fee;
pending incoming transfers cannot fund another pending transfer.

Use `createTransfer()` in `src/wallet.mjs` to produce the v3 envelope. Its input is
`{seed, from, chainId, to, amount, fee, nonce, memo}`; amounts and fees are integer
atomic units. The result has a `payload` containing `version: 3`, chain ID, sender,
recipient, amount, fee, nonce, and memo, plus the ML-DSA public key and signature.
Keep the private seed within the signer. Use the published test vectors to verify
any implementation in another language.

Read the destination node's `minRelayFee` from `/api/info`. The reference default
is 1,000 atomic units (0.001 Bean); this is node policy, not a universal consensus
minimum. The mempool permits up to 25 pending transactions per sender by default.

Before broadcasting, persist the withdrawal request, reserved nonce, complete
payload, transaction ID, and signed envelope. The transaction ID is
`SHA3-384(canonicalJSON(payload))`: it excludes both public key and signature, so
re-signing the same payload retains the same ID. It is different from the full
signed transaction hash used in block roots.

After a timeout, query the stored ID and retry the **same signed transaction**.
`POST /api/tx` is idempotent by ID. A 404 means that node does not know it; it does
not prove the transfer was never submitted elsewhere. Do not increment the nonce
or create a fresh payment simply because the response was lost. Reconcile against
committed blocks before changing a pending withdrawal.

A same-sender, same-nonce replacement must pay a strictly higher fee under the
reference mempool policy. Changing a fee changes the payload and therefore the
transaction ID. Track replacements as one withdrawal intent and reconcile every
associated ID. A replacement is not a cancellation guarantee: the earlier
transaction may already have committed elsewhere.

## Local integration checks

Use the [operator guide](OPERATORS.md) to start a disposable network. Confirm:

- Deposit scanning resumes after interruption and credits each transfer once.
- Amount conversion covers six decimal places without rounding.
- Concurrent withdrawal requests cannot reuse a nonce accidentally.
- A lost submission response and repeated broadcast do not duplicate a payment.
- Replacement transactions, insufficient funds, stale nonces, and low fees are
  handled explicitly.
- Network mismatch, node lag, quorum loss, and node restart pause or retry work
  according to a documented policy rather than assuming a healthy process means
  a progressing chain.

An exchange-specific adapter, independent security review, launch configuration,
and operational acceptance remain required before real deposits or withdrawals.
