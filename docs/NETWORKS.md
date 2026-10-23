# Network status and identity

Protocol v3 source availability is separate from launching a network. This
repository does not yet designate a public v3 genesis, chain ID, validator roster,
or bootstrap peer list. Do not infer an official network from example commands,
test fixtures, or a node that happens to run this source.

| Network | Status | Compatibility |
| --- | --- | --- |
| Existing friends service at `https://beans.f-3.ai` | Earlier experimental service used by the released 0.2 Mac wallet; endpoint availability is independent of this repository | Older protocol and `/network/*` API; not a v3 bootstrap peer |
| Local v3 development networks | Create your own genesis using [OPERATORS.md](OPERATORS.md) | v3 nodes using that exact genesis; local balances and keys belong to that test network |
| Official public v3 testnet | Not configured or announced here | Genesis, chain ID, bootstrap peers, and operator details still to be published |
| Mainnet | Not launched by this repository | Requires a separately reviewed launch configuration and release |

## What identifies a v3 network

The exact genesis defines the chain. Its canonical hash produces the chain ID;
the name alone is not sufficient. Genesis includes a creation time and random salt,
so independently running `frob genesis --name ...` creates a different network.
Distribute one agreed genesis and verify it before connecting nodes.

When an official network is ready, its release should publish:

- The complete genesis file, canonical genesis hash, and derived chain ID.
- Initial validator addresses and public keys, with independent operator identities
  and an admission policy.
- Public bootstrap origins, operator contacts, and a tested source tag or commit.
- Supply cap, initial allocations, reward and fee rules, and any implemented
  vesting or staking restrictions.
- The launch time, upgrade process, status reporting, and any reset policy.

The existing intent is a **60% founder allocation**. That allocation has not been
activated in an official v3 genesis. The CLI defaults to a 100,000,000 Bean cap,
but defaults and the earlier testnet are not a finalized v3 launch configuration.
If that cap is retained, 60% would be 60,000,000 Beans. Publish the actual founder
receiving address and allocation in genesis; its private key remains private.
Do not claim coins are locked, vested, staked, or excluded from voting unless the
protocol actually enforces the stated restriction. v3 currently has no vesting or
stake-based voting mechanism.

## Approved validators and a future staking network

Current v3 uses one vote per approved validator and quorum-approved set changes.
There is no automatic transition at a validator count, and no stake escrow,
delegation, stake-weighted selection, unbonding period, or slashing implementation.
An observer can join without approval, but does not vote or earn proposer rewards.

A proposed route to open proof of stake needs its own protocol specification,
implementation, tests, and activation plan. Counting nodes alone cannot establish
independent ownership: one operator can create many keys. Publishing a roadmap
does not change today's admission rules or promise a date for conversion.

## Moving from the friends service

The current Mac wallet's API and transaction format need updating for v3. Matching
address formats do not make networks or balances interchangeable. Keys and
addresses can be reused technically, but balances exist only in their own ledger.

A migration would need an agreed snapshot or other allocation process, a
published balance mapping, a new reviewed genesis or explicitly specified import
mechanism, and updated wallet and exchange clients. State whether test balances
will carry over at all. There is no automatic bridge or migration in this release,
and this repository does not promise redemption of test Beans into mainnet Beans.
