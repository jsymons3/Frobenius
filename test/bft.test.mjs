import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from './simulator.mjs';

describe('consensus engine in a simulated network', () => {
  it('decides every height in round zero on a quiet network', () => {
    const sim = new Simulation({ count: 4, seed: 1 });
    sim.start();
    sim.run(20_000);
    sim.check({ minHeight: 20 });
    assert.ok(sim.rounds().every(round => round === 0));
  });

  it('tolerates one crashed validator out of four (rounds advance past its turns)', () => {
    const sim = new Simulation({ count: 4, seed: 2, faults: { 3: 'crashed' } });
    sim.start();
    sim.run(30_000);
    sim.check({ minHeight: 15 });
    assert.ok(sim.rounds().some(round => round > 0), 'heights proposed by the crashed validator need a second round');
  });

  it('halts safely with two of four crashed, then resumes when one returns', () => {
    const sim = new Simulation({ count: 4, seed: 3, faults: { 2: 'crashed', 3: 'crashed' } });
    sim.start();
    sim.run(20_000);
    assert.ok(sim.honest.every(node => node.height === 1), 'no quorum, so no progress');
    assert.deepEqual(sim.violations, []);
    sim.restart(2);
    sim.run(60_000);
    sim.check({ minHeight: 10 });
  });

  it('keeps agreement under random delays and 20% message loss', () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const sim = new Simulation({ count: 4, seed, delay: [5, 300], drop: 0.2 });
      sim.start();
      sim.run(120_000);
      sim.check({ minHeight: 10 });
    }
  });

  it('keeps agreement with seven validators, two crashed, and message loss', () => {
    for (const seed of [21, 22, 23]) {
      const sim = new Simulation({ count: 7, seed, delay: [5, 200], drop: 0.15, faults: { 1: 'crashed', 5: 'crashed' } });
      sim.start();
      sim.run(120_000);
      sim.check({ minHeight: 10 });
    }
  });

  it('keeps agreement with a validator that sends conflicting votes to different peers', () => {
    for (const seed of [31, 32, 33, 34]) {
      const sim = new Simulation({ count: 4, seed, delay: [5, 150], drop: 0.05, faults: { 0: 'equivocator' } });
      sim.start();
      sim.run(90_000);
      sim.check({ minHeight: 10 });
    }
  });

  it('keeps agreement with a proposer that sends different blocks to different peers', () => {
    for (const seed of [41, 42, 43, 44]) {
      const sim = new Simulation({ count: 4, seed, delay: [5, 150], drop: 0.05, faults: { 1: 'double-proposer' } });
      sim.start();
      sim.run(90_000);
      sim.check({ minHeight: 10 });
    }
  });

  it('stalls during a partition and converges after it heals', () => {
    const sim = new Simulation({ count: 4, seed: 51, delay: [5, 100] });
    sim.start();
    sim.run(5_000);
    const before = Math.min(...sim.honest.map(node => node.height));
    assert.ok(before > 3);
    sim.partition([0, 1], [2, 3]);
    sim.run(25_000);
    const during = sim.honest.map(node => node.height);
    assert.ok(Math.max(...during) - before <= 1, 'neither side has a quorum');
    sim.heal();
    sim.run(60_000);
    sim.check({ minHeight: before + 10 });
  });

  it('restarts a validator from its write-ahead record without signing conflicting votes', () => {
    for (const seed of [61, 62, 63]) {
      const sim = new Simulation({ count: 4, seed, delay: [20, 200], drop: 0.1 });
      sim.start();
      // Crash and restart one validator repeatedly at awkward moments.
      for (let i = 0; i < 6; i += 1) {
        sim.run(sim.now + 700 + (seed % 5) * 90);
        sim.crash(i % 4);
        sim.run(sim.now + 400);
        sim.restart(i % 4);
      }
      sim.run(sim.now + 30_000);
      sim.check({ minHeight: 10 });
    }
  });

  it('recovers a quorum proof after all available validators restart and a proof signer remains offline', () => {
    let interrupted = true;
    const sim = new Simulation({
      count: 4, seed: 64, delay: [10, 10], pollInterval: 100,
      messageFilter: ({ to, message }) => !interrupted || (message.type !== 'precommit' && to !== 2),
    });
    sim.start();
    sim.run(450);
    // Validators 0, 1, and 3 saw the proposal and its quorum. Validator 2 missed
    // both and already signed nil. No precommit quorum was delivered.
    assert.ok(sim.nodes.every(node => node.height === 1));
    for (const index of [0, 1]) {
      assert.equal(sim.nodes[index].wal.valid.round, 0);
      assert.equal(sim.nodes[index].wal.validPrevotes.length, 3);
      assert.ok(sim.nodes[index].wal.validPrevotes.some(message => message.validator === 'v3'));
    }
    assert.equal(sim.nodes[2].wal.votes[0].prevote.hash, null);
    for (const index of [0, 1, 2, 3]) sim.crash(index);
    interrupted = false;
    for (const index of [0, 1, 2]) sim.restart(index);
    sim.run(20_000);
    sim.check({ minHeight: 10 });
  });

  it('a lone validator decides by itself', () => {
    const sim = new Simulation({ count: 1, seed: 71 });
    sim.start();
    sim.run(5_000);
    sim.check({ minHeight: 8 });
  });
});
