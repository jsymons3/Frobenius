# Running a Frobenius v3 node

This guide is for experimental protocol v3. There is no official public v3 genesis
or bootstrap peer list yet; see [Networks](NETWORKS.md). The currently released
Mac app and the older friends service do not use these endpoints.

An **observer** independently verifies the chain and serves the wallet API. A
**validator** also proposes and votes. Anyone can run an observer. Becoming a
validator currently requires approval from a quorum of existing validators;
owning Beans or starting a node does not grant voting rights. Votes have equal
weight per validator. Bonding, delegation, unbonding, and slashing are not implemented.

## Install and verify the source

Use Node.js 22.22.0 or newer, with support for `node:sqlite`.

```bash
git clone https://github.com/jsymons3/Frobenius.git
cd Frobenius
npm ci --ignore-scripts
npm test
node bin/frob.mjs help
```

For a shared network, all operators should agree on an exact reviewed commit or
release, the same genesis file, and its chain ID before starting. A repository's
default branch is not an automatic upgrade channel.

## Four-validator development network on one computer

These commands create a disposable local network. Four keys on one computer are
one operator and one failure domain; this is a development fixture, not a
decentralized deployment. Run commands from the repository root. `.local/` is
ignored by Git, but its contents still need protection and backups if retained.

Generate new local development keys and a genesis:

```bash
umask 077
mkdir -p .local/keys
for i in 1 2 3 4; do
  node bin/frob.mjs keygen --out ".local/keys/v${i}.json"
done
node bin/frob.mjs genesis --name local-dev --out .local/genesis.json \
  --validator .local/keys/v1.json --validator .local/keys/v2.json \
  --validator .local/keys/v3.json --validator .local/keys/v4.json
```

Key files contain plaintext private seeds. The genesis contains only public keys,
addresses, and network rules. This example has no initial allocation: validators
earn block rewards after blocks start. It does not apply a founder allocation.
The CLI refuses to overwrite existing key and genesis files.

Open four terminals in the repository root and run one command in each:

```bash
# Terminal 1
node bin/frob.mjs node --genesis .local/genesis.json --data .local/v1-data \
  --port 8800 --public-url http://127.0.0.1:8800 \
  --peer http://127.0.0.1:8801 --validator-key .local/keys/v1.json

# Terminal 2
node bin/frob.mjs node --genesis .local/genesis.json --data .local/v2-data \
  --port 8801 --public-url http://127.0.0.1:8801 \
  --peer http://127.0.0.1:8800 --validator-key .local/keys/v2.json

# Terminal 3
node bin/frob.mjs node --genesis .local/genesis.json --data .local/v3-data \
  --port 8802 --public-url http://127.0.0.1:8802 \
  --peer http://127.0.0.1:8800 --validator-key .local/keys/v3.json

# Terminal 4
node bin/frob.mjs node --genesis .local/genesis.json --data .local/v4-data \
  --port 8803 --public-url http://127.0.0.1:8803 \
  --peer http://127.0.0.1:8800 --validator-key .local/keys/v4.json
```

The default bind address is `127.0.0.1`. A four-validator set needs three votes to
commit a block. With sufficient connectivity and responsive validators, the
height begins increasing. Check from another terminal:

```bash
node bin/frob.mjs info --node http://127.0.0.1:8800
node bin/frob.mjs validators --node http://127.0.0.1:8800
node bin/frob.mjs balance --wallet .local/keys/v1.json --node http://127.0.0.1:8800
curl --fail http://127.0.0.1:8800/healthz
```

Start an observer in another terminal by omitting the validator key:

```bash
node bin/frob.mjs node --genesis .local/genesis.json --data .local/observer-data \
  --port 8810 --peer http://127.0.0.1:8800
```

Stop each process with Ctrl-C. Restart with the same key, genesis, and data
directory; do not generate replacement keys for an ordinary restart.

## Separate operators and internet connections

Each operator should create and retain their own key. To share a public validator
record, export only the address and public key:

```bash
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const { address, publicKey } = JSON.parse(readFileSync(".local/keys/v1.json", "utf8"));
  writeFileSync(".local/v1-public.json", JSON.stringify({ address, publicKey }, null, 2) + "\n");
'
```

The `genesis --validator` and `validators new --validator` options accept these
public records. Share public records, never the source key files. One coordinator
creates genesis from the agreed records and shares that exact file with everyone.
Creating separate genesis files with the same name produces different chains.

Use reachable HTTP(S) peer origins with `--peer`, and advertise a reachable origin
with `--public-url` when accepting connections. Public deployments should put TLS
and resource controls in front of the node. For a local reverse proxy, the node
can keep its loopback bind address; `--host 0.0.0.0` exposes the listener on all
interfaces. A NATed node can push and long-poll outbound peers without advertising
a public URL. Configure several independently operated peers for resilience.

The service has no built-in API authentication or private-key RPC. Its wallet and
peer endpoints share a listener. Transfers and validator updates require their
protocol signatures, but connection limits alone are not adequate public-service
abuse protection. Review [known gaps](SPEC.md#15-known-gaps-before-a-mainnet)
before exposing an instance.

## Observer container

The image contains executable source and pinned dependencies. It builds without a
genesis or wallet; select the network when starting the container. From the
repository root, build the image and create persistent observer storage:

```bash
docker build --tag frobenius:0.4.0-alpha.1 .
docker volume create frobenius-observer-data
```

After placing the agreed public genesis at `.local/genesis.json`, replace the
example peer below with an actual reachable **v3 peer on that same network**:

```bash
docker run --rm --name frobenius-observer \
  --publish 127.0.0.1:8810:8800 \
  --mount "type=bind,src=$(pwd)/.local/genesis.json,dst=/etc/frobenius/genesis.json,readonly" \
  --mount type=volume,src=frobenius-observer-data,dst=/var/data/frobenius \
  --env FROBENIUS_PEERS=https://your-v3-peer.example \
  frobenius:0.4.0-alpha.1
```

The placeholder is not a live service. A container's `127.0.0.1` refers to the
container itself; use a host or container-network address reachable from Docker
when connecting to a local development peer. This command exposes the observer
API only on the host's loopback port 8810 and supplies no validator key. Stop it
with `docker stop frobenius-observer`; the named data volume remains for restart.
Use a distinct volume for a different network.

The default genesis path is `/etc/frobenius/genesis.json`, mounted read-only above.
The process prepares its data directory as root, then drops to UID 1000 before
opening the database. Do not bake a private key into an image or reuse an active
validator's key and data in this observer container.

## Adding or removing validators

A validator update replaces the **entire** set, with 1–100 entries. Preserve every
validator that should remain. Draft it using public records and the target node's
current sequence:

```bash
node bin/frob.mjs validators new --node http://127.0.0.1:8800 \
  --out .local/update.json \
  --validator .local/v1-public.json --validator .local/v2-public.json \
  --validator .local/v3-public.json --validator .local/v4-public.json \
  --validator .local/v5-public.json
```

The example requires all five public files to have been exported by their owners.
Each current validator independently checks the chain ID, sequence, and complete
replacement list before signing the same update file offline:

```bash
node bin/frob.mjs validators sign --wallet .local/keys/v1.json --file .local/update.json
```

Collect distinct approvals from more than two thirds of the current set (three
of four), then submit to an active validator:

```bash
node bin/frob.mjs validators submit --file .local/update.json --node http://127.0.0.1:8800
```

Submission is pending until included in a committed block. The replacement set
applies from the following block. Verify `/api/validators` afterward. A newly
configured key runs as an observer until admitted; it should be synchronized and
ready before admission. This process does not create or lock a stake.

## Persistence, monitoring, and recovery

The data directory holds `chain.sqlite`, SQLite journal files, indexes, and the
validator's consensus recovery record. Use persistent storage. Keep the exact
genesis and a protected key backup separately. For a simple consistent database
backup, stop the node cleanly and copy the entire data directory.

Run only **one live signer per validator key**. Separate copies of a database do
not coordinate signing. Do not start a failover copy until the previous process
is certainly stopped. Do not delete the consensus record, restore a stale
validator backup, or start a validator on a fresh database as an improvised
recovery: these can discard locks and earlier votes. If state is lost or uncertain,
stop signing, preserve evidence, and arrange a reviewed recovery or key
replacement with the other validators. An observer can be rebuilt from genesis
and peers without signing.

`GET /healthz` reports that the process is running and its current height. It does
not prove that the network is progressing. Monitor height and tip timestamp over
time, peer connectivity, disk usage, consensus rounds, and agreement with an
independent observer. `GET /api/info` supplies these protocol and consensus fields.

Startup verifies stored blocks by default. `--fast-start` skips earlier signature
and certificate verification and should not be used to validate an untrusted
database. Older stores with already-pruned certificates may need missing proofs
from an archive; the current retention policy cannot recreate deleted signatures.

Coordinate upgrades across operators. Stop, back up, install the agreed source,
run tests, and restart with the same data and identity. Upgrade validators in a
sequence that keeps a quorum online when versions are compatible. Changes to
consensus rules require a separately specified coordinated activation or a new
network; the software does not implement an automatic staking transition.
