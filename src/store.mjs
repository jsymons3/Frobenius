import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, chmodSync } from 'node:fs';

// Stores hold the committed chain in height order, the indexes the wallet API
// needs, and a validator's consensus write-ahead record. Ledger state is rebuilt
// on load by replaying the blocks.
//
// Each block row is { hash, block, certificate }. `index` passed to putBlock is
// { transactions: [{ id, index }], addresses: [{ address, kind, index, amount }] }.

export class MemoryStore {
  #blocks = [];
  #byHash = new Map();
  #transactions = new Map();
  #addresses = new Map();
  #genesis = null;
  #consensus = null;

  checkGenesis(genesisHash) {
    if (this.#genesis !== null && this.#genesis !== genesisHash) throw new Error('This store belongs to a different network.');
    this.#genesis = genesisHash;
  }

  get height() { return this.#blocks.length; }

  putBlock(hash, block, certificate, index) {
    if (block.header.height !== this.#blocks.length + 1) throw new Error('Blocks must be stored in height order.');
    const row = { hash, block: structuredClone(block), certificate: certificate === null ? null : structuredClone(certificate) };
    this.#blocks.push(row);
    this.#byHash.set(hash, row);
    for (const entry of index.transactions) this.#transactions.set(entry.id, { height: block.header.height, index: entry.index });
    for (const entry of index.addresses) {
      const list = this.#addresses.get(entry.address) ?? [];
      list.push({ height: block.header.height, kind: entry.kind, index: entry.index, amount: entry.amount });
      this.#addresses.set(entry.address, list);
    }
  }

  getBlock(height) { return this.#blocks[height - 1] ?? null; }
  getBlockByHash(hash) { return this.#byHash.get(hash) ?? null; }
  *blocks() { yield* this.#blocks; }
  findTransaction(id) { return this.#transactions.get(id) ?? null; }
  history(address, limit) { return (this.#addresses.get(address) ?? []).slice(-limit).reverse(); }

  pruneCertificates(keepFrom, interval) {
    for (const row of this.#blocks) {
      const height = row.block.header.height;
      if (height < keepFrom && height % interval !== 0 && row.block.validatorUpdate === null) row.certificate = null;
    }
  }

  saveConsensus(state) { this.#consensus = structuredClone(state); }
  loadConsensus() { return this.#consensus === null ? null : structuredClone(this.#consensus); }
  close() {}
}

export class SQLiteStore {
  #db;
  #cache = new Map();

  constructor(filename) {
    if (existsSync(filename) && !lstatSync(filename).isFile()) throw new Error('The chain database must be a regular file.');
    const db = new DatabaseSync(filename);
    try {
      // The exclusive lock lasts for the connection, so two nodes cannot share a data directory.
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 3) throw new Error('This database was created by an incompatible Frobenius node.');
      db.exec(`
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS blocks (
          height INTEGER PRIMARY KEY CHECK (height > 0), hash TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL, certificate TEXT
        );
        CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, height INTEGER NOT NULL, idx INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS history (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, height INTEGER NOT NULL,
          kind TEXT NOT NULL, idx INTEGER, amount TEXT
        );
        CREATE INDEX IF NOT EXISTS history_by_address ON history (address, seq);
        CREATE TABLE IF NOT EXISTS consensus (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL);
        PRAGMA user_version = 3;
        COMMIT;
      `);
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The chain database failed its integrity check.');
      chmodSync(filename, 0o600);
    } catch (error) {
      db.close();
      if (/locked|busy/i.test(error.message)) throw new Error('This chain database is already open in another process.');
      throw error;
    }
    this.#db = db;
  }

  checkGenesis(genesisHash) {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'genesis'").get();
    if (row && row.value !== genesisHash) throw new Error('This data directory belongs to a different network.');
    if (!row) this.#db.prepare("INSERT INTO meta (key, value) VALUES ('genesis', ?)").run(genesisHash);
  }

  get height() { return this.#db.prepare('SELECT COALESCE(MAX(height), 0) AS height FROM blocks').get().height; }

  putBlock(hash, block, certificate, index) {
    const height = block.header.height;
    if (height !== this.height + 1) throw new Error('Blocks must be stored in height order.');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO blocks (height, hash, body, certificate) VALUES (?, ?, ?, ?)')
        .run(height, hash, JSON.stringify(block), certificate === null ? null : JSON.stringify(certificate));
      const insertTransaction = this.#db.prepare('INSERT INTO transactions (id, height, idx) VALUES (?, ?, ?)');
      for (const entry of index.transactions) insertTransaction.run(entry.id, height, entry.index);
      const insertHistory = this.#db.prepare('INSERT INTO history (address, height, kind, idx, amount) VALUES (?, ?, ?, ?, ?)');
      for (const entry of index.addresses) insertHistory.run(entry.address, height, entry.kind, entry.index, entry.amount);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#remember(hash, { hash, block, certificate });
  }

  #remember(hash, row) {
    this.#cache.set(hash, row);
    if (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value);
  }

  #row(record) {
    if (!record) return null;
    const cached = this.#cache.get(record.hash);
    if (cached) return cached;
    const row = { hash: record.hash, block: JSON.parse(record.body), certificate: record.certificate === null ? null : JSON.parse(record.certificate) };
    this.#remember(record.hash, row);
    return row;
  }

  getBlock(height) { return this.#row(this.#db.prepare('SELECT hash, body, certificate FROM blocks WHERE height = ?').get(height)); }
  getBlockByHash(hash) { return this.#row(this.#db.prepare('SELECT hash, body, certificate FROM blocks WHERE hash = ?').get(hash)); }

  *blocks() {
    for (const record of this.#db.prepare('SELECT hash, body, certificate FROM blocks ORDER BY height').iterate()) yield this.#row(record);
  }

  findTransaction(id) {
    const row = this.#db.prepare('SELECT height, idx FROM transactions WHERE id = ?').get(id);
    return row ? { height: row.height, index: row.idx } : null;
  }

  history(address, limit) {
    return this.#db.prepare('SELECT height, kind, idx AS "index", amount FROM history WHERE address = ? ORDER BY seq DESC LIMIT ?').all(address, limit);
  }

  pruneCertificates(keepFrom, interval) {
    this.#db.prepare("UPDATE blocks SET certificate = NULL WHERE height < ? AND certificate IS NOT NULL AND height % ? != 0 AND json_extract(body, '$.validatorUpdate') IS NULL").run(keepFrom, interval);
    this.#cache.clear();
  }

  saveConsensus(state) {
    this.#db.prepare('INSERT OR REPLACE INTO consensus (id, state) VALUES (1, ?)').run(JSON.stringify(state));
  }

  loadConsensus() {
    const row = this.#db.prepare('SELECT state FROM consensus WHERE id = 1').get();
    return row ? JSON.parse(row.state) : null;
  }

  close() {
    if (!this.#db.isOpen) return;
    try { this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { this.#db.close(); }
  }
}
