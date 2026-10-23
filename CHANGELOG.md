# Changelog

## 0.4.0-alpha.1

Initial standalone experimental source release, extracted from the corrected
`frobenius-node` source in `jsymons3/frobenius-network` at commit
`ea582c0f86d6e0130418c7de06d22010052079cc`.

- Permissioned BFT node, observer mode, command-line wallet, ML-DSA-65 signatures,
  SQLite persistence, transaction pool, peer synchronization, and protocol vectors.
- Bind proposal validation to its actual body and revalidate at commit time.
- Preserve and recover the quorum prevotes supporting validator locks.
- Bound synchronization responses, retain usable certificate checkpoints, and
  preserve validator-transition evidence.
- Support the full 100-validator approval payload limit.
- Correct buffered proposal handling and add regression coverage.
- Separate public source from application and deployment repositories; add
  publication checks, CI, operator documentation, and a staged staking roadmap.
- Build the Docker image without a genesis file; supply the chosen network's
  public genesis through a read-only runtime mount.

This release does not launch a network, implement staking or slashing, migrate the
existing friends testnet, or update the Mac app. No official v3 genesis or mainnet
configuration is included. The intended 60% founder allocation is a launch policy
to be made explicit in a future genesis, not an allocation created by this release.
