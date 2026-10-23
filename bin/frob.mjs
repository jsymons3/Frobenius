#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatBeans, generateWallet, parseBeans, signPayload, validateAddress } from '../src/crypto.mjs';
import { approvalPayload, createGenesis, loadParams, quorum } from '../src/consensus.mjs';
import { FrobeniusNode } from '../src/node.mjs';
import { fetchJSON } from '../src/http.mjs';
import { createTransfer } from '../src/wallet.mjs';

const HELP = `frob - Frobenius Beans protocol v3 tools

  frob keygen [--out wallet.json]
  frob genesis --name NAME --validator FILE [--validator FILE ...] [--alloc ADDRESS:BEANS ...]
               [--block-time SECONDS] [--reward BEANS] [--supply BEANS] [--out genesis.json]
  frob node --genesis genesis.json --data DIR [--port 8800] [--host 127.0.0.1] [--peer URL ...]
            [--public-url URL] [--validator-key wallet.json] [--min-fee BEANS] [--fast-start]
  frob info [--node URL]
  frob validators [--node URL]                                show the active validator set
  frob validators new --out update.json --validator FILE ...  draft a new set (needs --node)
  frob validators sign --wallet FILE --file update.json       add your approval (offline)
  frob validators submit --file update.json [--node URL]      hand it to a validator node
  frob balance (--address ADDRESS | --wallet FILE) [--node URL]
  frob send --wallet FILE --to ADDRESS --amount BEANS [--fee BEANS] [--memo TEXT] [--node URL]
  frob tx --id ID [--node URL]

--node defaults to $FROBENIUS_NODE or http://127.0.0.1:8800. Amounts are in Beans (6 decimals).
A validator FILE is a wallet file or any JSON with "address" and "publicKey"; only the public
parts are read. The node command also reads FROBENIUS_GENESIS, FROBENIUS_DATA_DIR, PORT,
FROBENIUS_HOST, FROBENIUS_PEERS (comma-separated), FROBENIUS_PUBLIC_URL, and
FROBENIUS_VALIDATOR_SEED (64 hex characters) when the matching option is omitted.`;

const [command, ...rest] = process.argv.slice(2);
const env = process.env;
const nodeOption = { node: { type: 'string', default: env.FROBENIUS_NODE ?? 'http://127.0.0.1:8800' } };
const print = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
const fail = message => { process.stderr.write(`frob: ${message}\n`); process.exit(1); };
const args = options => parseArgs({ args: rest, options, strict: true }).values;
const api = (base, path, init) => fetchJSON(`${base.replace(/\/+$/, '')}${path}`, { maxBytes: 64 * 1024 * 1024, ...init });
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));

function readWallet(file) {
  const wallet = readJSON(file);
  if (!validateAddress(wallet.address) || !/^[0-9a-f]{64}$/.test(wallet.seed ?? '')) fail(`${file} is not a Frobenius wallet file`);
  return wallet;
}

function readPublic(file) {
  const entry = readJSON(file);
  if (!validateAddress(entry.address) || typeof entry.publicKey !== 'string') fail(`${file} does not hold an address and public key`);
  return { address: entry.address, publicKey: entry.publicKey };
}

const commands = {
  keygen() {
    const { out } = args({ out: { type: 'string', default: 'wallet.json' } });
    if (existsSync(out)) fail(`${out} already exists; refusing to overwrite a wallet`);
    const wallet = generateWallet();
    writeFileSync(out, `${JSON.stringify({ version: 1, ...wallet }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    print(`Address: ${wallet.address}`);
    print(`Wrote ${out}. It holds your private seed in plain text: back it up and keep it private.`);
  },

  genesis() {
    const o = args({
      name: { type: 'string' }, validator: { type: 'string', multiple: true, default: [] },
      alloc: { type: 'string', multiple: true, default: [] },
      'block-time': { type: 'string', default: '5' }, reward: { type: 'string', default: '2' },
      supply: { type: 'string', default: '100000000' }, out: { type: 'string', default: 'genesis.json' },
    });
    if (!o.name) fail('--name is required (lowercase letters, digits, hyphens)');
    if (!o.validator.length) fail('at least one --validator FILE is required');
    if (existsSync(o.out)) fail(`${o.out} already exists`);
    const allocations = o.alloc.map(entry => {
      const [address, beans] = entry.split(':');
      if (!validateAddress(address) || !beans) fail(`Invalid --alloc ${entry}; expected ADDRESS:BEANS`);
      return { address, amount: parseBeans(beans) };
    });
    const genesis = createGenesis({
      name: o.name, validators: o.validator.map(readPublic), allocations,
      totalSupply: parseBeans(o.supply), blockReward: parseBeans(o.reward), blockInterval: Math.round(Number(o['block-time']) * 1000),
    });
    writeFileSync(o.out, `${JSON.stringify(genesis, null, 2)}\n`, { flag: 'wx' });
    const params = loadParams(genesis);
    const n = params.validators.length;
    print(`Wrote ${o.out}\nChain id: ${params.chainId}\nValidators: ${n} (quorum ${quorum(n)}, tolerates ${n - quorum(n)} faulty)\nAllocated: ${formatBeans(params.allocated)} of ${formatBeans(params.totalSupply)} Beans`);
  },

  async node() {
    const o = args({
      genesis: { type: 'string', default: env.FROBENIUS_GENESIS }, data: { type: 'string', default: env.FROBENIUS_DATA_DIR },
      port: { type: 'string', default: env.PORT ?? '8800' }, host: { type: 'string', default: env.FROBENIUS_HOST ?? '127.0.0.1' },
      peer: { type: 'string', multiple: true, default: (env.FROBENIUS_PEERS ?? '').split(',').map(s => s.trim()).filter(Boolean) },
      'public-url': { type: 'string', default: env.FROBENIUS_PUBLIC_URL }, 'validator-key': { type: 'string' },
      'min-fee': { type: 'string', default: '0.001' }, 'fast-start': { type: 'boolean', default: false },
    });
    if (!o.genesis || !o.data) fail('--genesis and --data are required');
    const seed = o['validator-key'] ? readWallet(o['validator-key']).seed : env.FROBENIUS_VALIDATOR_SEED ?? null;
    const node = new FrobeniusNode({
      genesis: readJSON(o.genesis), dataDir: resolve(o.data), port: Number(o.port), host: o.host, peers: o.peer,
      publicUrl: o['public-url'] || null, validatorSeed: seed, minRelayFee: parseBeans(o['min-fee']),
      verifyOnLoad: !o['fast-start'], dropPrivileges: env.FROBENIUS_DROP_PRIVILEGES === '1',
    });
    await node.start();
    if (seed && !node.bft.isValidator) node.log({ event: 'warning', message: `${node.me.address} is not in the active validator set; running as an observer until it is added.` });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await node.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },

  async info() {
    const { node } = args(nodeOption);
    print(await api(node, '/api/info'));
  },

  async validators() {
    const sub = ['new', 'sign', 'submit'].includes(rest[0]) ? rest.shift() : 'show';
    if (sub === 'show') {
      const { node } = args(nodeOption);
      const set = await api(node, '/api/validators');
      print(`Sequence ${set.sequence}, ${set.validators.length} validators, quorum ${set.quorum}. Next proposer: ${set.nextProposer}`);
      for (const address of set.validators) print(`  ${address}`);
    } else if (sub === 'new') {
      const o = args({ ...nodeOption, out: { type: 'string' }, validator: { type: 'string', multiple: true, default: [] } });
      if (!o.out || !o.validator.length) fail('validators new needs --out and at least one --validator FILE');
      if (existsSync(o.out)) fail(`${o.out} already exists`);
      const [info, set] = await Promise.all([api(o.node, '/api/info'), api(o.node, '/api/validators')]);
      const update = { chainId: info.chainId, sequence: set.sequence + 1, validators: o.validator.map(readPublic), approvals: [] };
      writeFileSync(o.out, `${JSON.stringify(update, null, 2)}\n`, { flag: 'wx' });
      print(`Wrote ${o.out} proposing ${update.validators.length} validators (sequence ${update.sequence}).\nCollect ${set.quorum} approvals with "frob validators sign", then "frob validators submit".`);
    } else if (sub === 'sign') {
      const o = args({ wallet: { type: 'string' }, file: { type: 'string' } });
      if (!o.wallet || !o.file) fail('validators sign needs --wallet and --file');
      const wallet = readWallet(o.wallet);
      const update = readJSON(o.file);
      if (update.approvals.some(entry => entry.validator === wallet.address)) fail(`${wallet.address} already approved this update`);
      const { signature } = signPayload(approvalPayload(update.chainId, update.sequence, update.validators), wallet.seed);
      update.approvals.push({ validator: wallet.address, signature });
      writeFileSync(o.file, `${JSON.stringify(update, null, 2)}\n`);
      print(`Added approval from ${wallet.address} (${update.approvals.length} so far).`);
    } else {
      const o = args({ ...nodeOption, file: { type: 'string' } });
      if (!o.file) fail('validators submit needs --file');
      const { chainId, ...update } = readJSON(o.file);
      const info = await api(o.node, '/api/info');
      if (info.chainId !== chainId) fail(`${o.file} was drafted for ${chainId}, but ${o.node} runs ${info.chainId}`);
      const result = await api(o.node, '/api/validators', { method: 'POST', body: update });
      print(`Update accepted by ${result.proposer}; it will be included in that validator's next block.`);
    }
  },

  async balance() {
    const o = args({ ...nodeOption, address: { type: 'string' }, wallet: { type: 'string' } });
    const address = o.address ?? (o.wallet && readWallet(o.wallet).address);
    if (!validateAddress(address)) fail('Pass --address or --wallet');
    const account = await api(o.node, `/api/account?address=${address}`);
    print(`Balance: ${formatBeans(account.balance)} Beans (${formatBeans(account.pendingBalance)} including pending)`);
    for (const item of account.transactions.slice(0, 10)) {
      print(`  #${item.height} ${item.type.padEnd(7)} ${formatBeans(item.amount).padStart(14)}  ${item.memo}`);
    }
  },

  async send() {
    const o = args({
      ...nodeOption, wallet: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' },
      fee: { type: 'string' }, memo: { type: 'string', default: '' },
    });
    if (!o.wallet || !validateAddress(o.to) || !o.amount) fail('send needs --wallet, --to, and --amount');
    const wallet = readWallet(o.wallet);
    const info = await api(o.node, '/api/info');
    const account = await api(o.node, `/api/account?address=${wallet.address}`);
    const fee = o.fee ? parseBeans(o.fee) : BigInt(info.minRelayFee);
    const transaction = createTransfer({
      seed: wallet.seed, from: wallet.address, chainId: info.chainId, to: o.to,
      amount: parseBeans(o.amount), fee, nonce: account.nonce, memo: o.memo,
    });
    const result = await api(o.node, '/api/tx', { method: 'POST', body: transaction });
    print(`Sent ${o.amount} Beans (fee ${formatBeans(fee)}). Transaction ${result.id} is ${result.status}.`);
  },

  async tx() {
    const o = args({ ...nodeOption, id: { type: 'string' } });
    print(await api(o.node, `/api/tx?id=${o.id}`));
  },
};

if (!commands[command]) { print(HELP); process.exit(command && command !== 'help' ? 1 : 0); }
try {
  await commands[command]();
} catch (error) {
  fail(error.message);
}
