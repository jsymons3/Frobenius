# Contributing

Frobenius currently implements permissioned BFT consensus. Open staking is a
design direction, not an available feature. Discuss consensus, supply, validator
membership, and network migration changes in an issue before implementing them.
Use the private reporting process in [SECURITY.md](SECURITY.md) for vulnerabilities.

Use Node.js 22.22.0 or newer and install the pinned dependencies:

```sh
npm ci --ignore-scripts
npm test
node scripts/check-public-source.mjs
```

Submit a focused pull request explaining the observable behavior, compatibility
implications, and validation performed. Consensus changes need deterministic
regressions and agreement on their activation rules. Tests must use disposable
keys and local networks; never exercise other people's nodes without permission.

Keep operational data in `.local/` or outside the checkout. Never commit wallet
files, keys, credentials, database files, recovery records, or private deployment
configuration. The publication checker provides an allowlist and targeted secret
checks; it is not a substitute for reviewing the diff and history.

Dependencies are exact versions. Explain any dependency change and regenerate the
lockfile without unrelated upgrades. The CI workflow checks Linux and macOS and
builds an observer Docker image that contains no network genesis or signing key.

Contributions are made under the repository's [MIT license](LICENSE).
