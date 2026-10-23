# Reporting security issues

This is experimental protocol v3 software. It has not received an independent
security audit and is not a mainnet launch. Do not use it to hold funds of value.

Report vulnerabilities privately using this repository's **Security → Report a
vulnerability** page:

https://github.com/jsymons3/Frobenius/security/advisories/new

If private reporting is unavailable, ask the repository owner through GitHub for
a private reporting channel without disclosing the vulnerability. Do not put
exploit details or confidential data in a public issue. Never send wallet seeds,
private keys, production credentials, or customer records with a report.

Include the affected commit or release, the environment, the expected and actual
behavior, and a small reproduction using disposable test keys and a local test
network. Coordinate disclosure with the maintainer before publication. There is
no response-time or bounty commitment at this stage.

Only the latest experimental release is maintained. Protocol changes may require
explicit migration; an update must never silently replace the network's genesis
or a validator's recovery record.
