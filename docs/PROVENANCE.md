# Source provenance

This repository begins with a reviewed snapshot of the standalone `frobenius-node`
directory from Frobenius's private development repository. It does not publish that
repository's full history, older hosted-service deployment, Mac application, or
runtime data.

The source snapshot is commit `ea582c0f86d6e0130418c7de06d22010052079cc`.
Earlier development commits `a3d7f87` and `d605922`, authored as Claude, introduced
the standalone node and v3 BFT design. Commit `ea582c0`, authored as jsymons3 with
Codex assistance, corrected proposal-body validation, recovery proofs, byte-bounded
sync, validator-transition certification, and validator-approval payload bounds.
That snapshot passed 77 node tests and 73 existing Mac-wallet/service tests.
Those results describe development checks, not an independent security audit.

The first public alpha adds MIT licensing, dependency notices, publication checks,
operator and exchange guidance, a release process and CI, and a proposed staking roadmap.
Its software version and deployment packaging change; the v3 consensus rules do
not gain staking, change the founder's holdings, or migrate an existing network.

The literal seeds in `test/vectors.json` and deterministic wallet generation in
test helpers are intentionally public fixtures. They must never control assets or
act as validator keys on a public network. Operational keys are generated locally
and kept outside version control.
