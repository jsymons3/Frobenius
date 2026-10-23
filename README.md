# Frobenius — Beans

Experimental node software for Frobenius, whose currency unit is the **Bean**.
This public repository contains the protocol, full node, command-line wallet,
transaction-signing library, tests, and operator documentation. The native Mac
wallet is a separate application.

**Status: protocol v3, permissioned Byzantine fault tolerant consensus.** Approved
validators have equal voting power. Anyone can run an observer. Open staking,
bonding, delegation, unbonding, and slashing are **not implemented**. This software
has not had an independent security audit and is not a production currency release.

There is **no official public v3 genesis or bootstrap network in this release**.
The existing v0.2 Mac apps and friends-testnet service use a different protocol;
publishing this code does not migrate their balances or clients. See
[network status](docs/NETWORKS.md).

## Build and test

Use Node.js **22.22.0 or newer**. Node 22.22.0 is the release baseline.

```sh
git clone https://github.com/jsymons3/Frobenius.git
cd Frobenius
npm ci --ignore-scripts
npm test
npm run check:public
```

Start an isolated development network using the [operator guide](docs/OPERATORS.md).
Generate private wallets under `.local/keys/`, which is ignored by Git. Never use
the published deterministic test keys for real holdings or a public network.

## Protocol and participation

- Transactions and consensus votes use **ML-DSA-65** signatures; addresses and
  commitments use **SHA3-384**. This is not a claim that the complete system has
  been audited or is immune to all future attacks.
- A quorum of approved validators certifies blocks. Under the protocol's fault
  assumptions, committed blocks have deterministic finality. Progress requires a
  reachable quorum and eventually timely message delivery.
- Validator admission currently needs signatures from a quorum of the existing
  validator set. An observer does not earn validator rewards by simply running.
- The reference implementation supports up to 100 active validators. Each signature
  is large; that bound is not evidence of tested mainnet capacity.

The proposed direction is **approved bootstrap → bonded staking testnet → open
validator candidacy**, with a bounded active committee. Opening participation
requires implemented staking rules, testing, review, and an announced coordinated
upgrade. It is not triggered by counting nodes in this release.

The proposed launch allocation is **60% founder / 40% remaining issuance**. No
official v3 launch genesis has committed that allocation. Reduced staking capacity
for the founder allocation is a design proposal; its limits and transfer rules are
not selected or implemented. Read the [staking roadmap](docs/STAKING-ROADMAP.md)
for the distinction between economic ownership and consensus voting power.

## Documentation

| Document | Purpose |
| --- | --- |
| [Protocol specification](docs/SPEC.md) | Current v3 rules, encodings, certificates, APIs, and known gaps |
| [Operator guide](docs/OPERATORS.md) | Local setup, admission, storage, upgrades, and recovery |
| [Exchange integration](docs/EXCHANGE.md) | Deposits, withdrawals, signing, nonces, fees, and finality |
| [Network status](docs/NETWORKS.md) | Current networks and information required for a v3 launch |
| [Staking roadmap](docs/STAKING-ROADMAP.md) | Proposed transition; future features, not current behavior |
| [Release process](docs/RELEASING.md) | Tests, source artifacts, and checksums |
| [Security policy](SECURITY.md) | Private vulnerability reporting and experimental-software scope |
| [Provenance](docs/PROVENANCE.md) | Source history and publication boundary |

`src/` contains the consensus engine, chain, cryptography, networking, storage, and
transaction construction. `bin/frob.mjs` is the CLI. `test/` includes protocol
vectors, recovery and synchronization regressions, a deterministic simulator,
and a localhost multi-validator integration test.

## License

MIT. See [LICENSE](LICENSE) and [dependency notices](THIRD_PARTY_NOTICES.md).
The source license does not include private wallet keys, service credentials,
or the separate Mac application.
