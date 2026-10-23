# Releasing experimental source

This repository publishes node source. Mac applications, private operations, and
wallet keys are separate. A source release is not a network launch: it contains no
official genesis, bootstrap peer list, or migration authorization.

## Review and validate

Use a clean checkout of the intended commit with Node.js 22.22.0 or newer. Review
the staged files and the complete history being published. Check both public
source paths and any removed files for secrets. If a real secret was exposed,
revoke or rotate it; deleting the current file is insufficient.

```sh
npm ci --ignore-scripts
npm test
node scripts/check-public-source.mjs
git diff --check
git status --short
docker build --tag frobenius:release-check .
docker run --rm frobenius:release-check node bin/frob.mjs help
```

The checker considers tracked files, including ones matching ignore patterns, and
untracked files not ignored by Git. It rejects paths outside the public-source
allowlist, symlinks, selected credential formats, and literal private seeds. The
two fixed, deliberately public seeds in `test/vectors.json` are allowed only in
that fixture. This is a targeted guard, not a complete secret or history audit.
Ignored local files are excluded from `git archive` unless already tracked.

Check that the package version, lockfile, node's reported software version, and
changelog agree. For this release use `0.4.0-alpha.1` and a Git tag of
`v0.4.0-alpha.1`. CI must pass on the exact release commit, including the Linux
Docker build. Review the changes to pinned GitHub Action commits when upgrading
them; current pins were resolved from the official upstream tag references.

## Package the reviewed commit

After committing the reviewed files, create an annotated tag and archive that
specific tag. Use `git archive`, not a zip of the working directory, to exclude
ignored local wallet and database files. The following commands assume the tag
does not already exist:

```sh
git tag -a v0.4.0-alpha.1 -m 'Frobenius experimental node v0.4.0-alpha.1'
mkdir -p dist
git archive --format=tar --prefix=Frobenius-v0.4.0-alpha.1/ v0.4.0-alpha.1 | gzip -n > dist/Frobenius-v0.4.0-alpha.1.tar.gz
cd dist
shasum -a 256 Frobenius-v0.4.0-alpha.1.tar.gz > SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

Inspect the archive's member list before uploading. Verify that it contains the
license, source, lockfile, documentation, and test fixtures, and no operational
data. Extract into a temporary directory, install dependencies, and run the
tests there to check the actual release artifact.

Push the reviewed branch and tag, then manually create a **pre-release** in
GitHub. Attach the archive and `SHA256SUMS`. Include the exact source commit,
test results, protocol compatibility, known limitations, and the absence of an
official network in its notes. No workflow automatically publishes a release or
deploys a service. Do not mark an experimental release as a production launch.

Checksums detect accidental corruption; they do not independently authenticate a
download. A maintained release-signing and key-distribution process remains future
work. Never put a release-signing private key in this repository.
