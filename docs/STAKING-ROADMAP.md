# Staking and validator admission: proposed direction

**Status: design proposal, not implemented or activated.** Protocol v3 uses an
approved validator set with equal votes. It has no bonded stake, delegation,
unbonding, slashing, or automatic switch to open admission. This document does not
establish mainnet economics, a launch date, or restrictions on anyone's holdings.

The recommended path is an approved bootstrap network, a tested bonded-stake
network, then open validator candidacy. Opening should depend on demonstrated
readiness and an announced protocol upgrade, rather than a raw node count.

## Approval and staking answer different questions

Approval determines who may validate. Proof of stake determines how collateral,
voting power, rewards, and penalties work. A network can require both approval and
stake during its bootstrap period. An observer node checks the chain without
participating in consensus; anyone can already run one.

Open candidacy means anyone meeting the protocol's rules can register and bond
Beans without an operator's permission. It need not mean that every candidate
votes at every block: a bounded active set can be selected from those candidates.
The Cosmos SDK staking module provides an example of token bonding and a bounded
active validator set. Its design is a reference, not a dependency of Frobenius.
[Cosmos SDK staking specification](https://github.com/cosmos/cosmos-sdk/blob/main/x/staking/README.md).

## Proposed stages

| Stage | Admission and voting | Evidence needed to move forward |
| --- | --- | --- |
| 1. Approved bootstrap testnet | Current v3: current-validator quorum approves changes; each validator has one vote | Independent operators, reproducible releases, documented recovery, stable operation and measured bandwidth |
| 2. Bonded staking testnet | A new protocol adds bonded stake and stake-weighted votes; admission remains approved while the rules are exercised | Reviewed staking specification, tested economic accounting, fault/recovery exercises, independent security review |
| 3. Open candidacy | Candidates register and bond through on-chain transactions; deterministic rules choose the active set at epoch boundaries | Adequate independently controlled active stake, completed operational tests, public activation notice and coordinated upgrade |

For illustration, seven independently controlled v3 validators allow a quorum of
five and tolerate up to two faulty validators. Seven nodes owned by one person do
not provide that independence. No participants or target count are committed by
this example. The current v3 cap is 100 validators; large ML-DSA signatures make
committee size a bandwidth and verification-cost decision. Benchmark any future
active-set cap before selecting it.

Do not implement “the 20th node makes the chain open.” One party can create many
nodes or addresses, and counts do not establish stake distribution or operational
independence. A count can be one readiness milestone; it cannot replace those
checks. Publish readiness criteria and results, then select a future activation
height for a specified release. v3 does not yet provide that upgrade mechanism.

## Reduced founder staking capacity: preferred research direction

The intended founder allocation is 60% of supply. Economic ownership need not
confer 60% of consensus votes. Today v3 gives each approved validator one vote;
under proposed stake-weighted rules, voting power would depend on **active bonded
stake**, not total supply or wallet count.

If the founder bonds 60 units and everyone else bonds 40, the founder has 60% of
active voting power. That is enough to prevent a greater-than-two-thirds quorum
by withholding votes. If others bond only 20, the founder has 75%, enough to form
that quorum alone and defeat the intended independent-consensus guarantee.
These examples apply the proposed weighted quorum rule; they do not describe
current v3. The greater-than-two-thirds voting threshold follows the
[CometBFT consensus model](https://github.com/cometbft/cometbft/blob/main/spec/consensus/consensus.md).

Explore allowing only part of the founder allocation to participate in staking.
Two different limits need analysis:

- **Eligible-coin budget:** limit how many founder-allocation Beans can be bonded.
  For example, 10% of a hypothetical 60 million allocation is 6 million Beans.
  With only 1 million other active Beans, those 6 million represent about 85.7%
  of voting power; with 40 million others, about 13%. A 10% eligibility budget is
  therefore not a 10% voting-power limit.
- **Aggregate voting-power cap:** limit the effective votes attributable to that
  allocation, across all its validator and delegated positions. A hypothetical
  10% cap would require at least nine units of other effective voting power for
  each founder unit counted. It would need explicit rules for changing active
  stake, committee selection, rewards, and rounding. With no other stake, a capped
  founder cannot bootstrap consensus alone; readiness requires a minimum amount
  of independently controlled active stake.

These percentages are examples only; no budget, cap, or release schedule is chosen.
The remaining 40% is intended as future issuance, not 40 million Beans already
owned and bonded by independent participants. A staking transition must first
establish how other operators obtain independently controlled, eligible stake
through disclosed transfers, allocations, or earned rewards within the supply cap.
Unissued reserves cannot be counted as counterweight to founder votes.

A meaningful implementation would attach a shared eligibility budget to a
restricted genesis position, preserving it when positions split or delegate.
The noneligible portion would need escrow or vesting restrictions: it must remain
nontransferable until release, or its restrictions must follow the funds. Ordinary
unrestricted transfers erase the distinction; tracking origin through fungible
balances adds substantial protocol complexity. A simple founder-address weight
discount or per-address cap can be bypassed by moving coins to another address.

Even a correctly enforced allocation cap is not a global cap on a person's
control. The founder could acquire other unrestricted coins or control anonymous
operators. Delegating across several validators does not establish independent
economic control. Assess actual concentration alongside any allocation rule.

The next design step is to compare these mechanisms and specify their costs and
enforcement before choosing parameters. This proposal changes no existing wallet
or ownership, locks no funds, and adopts no future mainnet genesis.

## Work required before staking can be offered

1. Specify new transaction types and deterministic state transitions for validator
   registration, bonding, delegation if supported, withdrawal, and delayed
   unbonding. Define minimum bonds, integer rounding, and supply conservation.
2. Replace count-based votes and certificates with stake-weighted quorum checks;
   specify proposer selection, stake snapshots, epoch timing, active-set selection,
   deterministic ties, and safe transitions between committees.
3. Specify objective misconduct evidence, its verification and retention, penalties,
   and protection against duplicate penalties. Define downtime handling separately
   from equivocation. Keep relevant exiting stake accountable until the evidence
   window closes; specify redelegation behavior if delegation is implemented.
4. Specify rewards, fees, any validator commission, inactive-candidate behavior,
   and issuance limits. Do not infer a promised yield from testnet block rewards.
5. Design long-range recovery and trusted checkpoint procedures for new or
   long-offline clients, including trust expiration and conflicting checkpoints.
   A signature alone cannot establish which historical validator set to trust;
   see the [CometBFT light-client trust model](https://github.com/cometbft/cometbft/blob/main/spec/light-client/README.md).
6. Preserve and review post-quantum signing for new transaction, validator, and
   evidence messages. Existing Cosmos/CometBFT components are design references;
   replacing Frobenius with stock components does not automatically preserve its
   ML-DSA signature scheme or compatibility.
7. Add protocol vectors, independent review, tests for accounting and committee
   transitions, restart/partition exercises, and load measurements. Upgrade node,
   CLI, wallet, explorer, and exchange integration together.

The Cosmos SDK specification describes established bonding, unbonding and
validator-set mechanics, including delayed accountability for exiting stake.
Frobenius needs its own explicit rules and tests for those mechanics before release.
[Cosmos SDK staking specification](https://github.com/cosmos/cosmos-sdk/blob/main/x/staking/README.md).

## Activation and migration

Publish the completed specification, reviewed implementation, release hashes,
network identity, transition state, and activation procedure before operators
upgrade. State whether the trial starts a fresh chain or migrates an existing
chain, and how balances and outstanding transactions are treated. Provide a
rehearsed recovery procedure; consensus changes must not silently activate on a
different schedule at different nodes.

Publishing this repository neither upgrades the existing friends network nor
migrates its balances. Opening validator admission, enabling staking, and launching
a mainnet remain separate, explicit network decisions.
