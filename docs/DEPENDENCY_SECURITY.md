# Dependency security maintenance (DEV-16646)

## Scope and result

This PR is based on the deployed fork branch `patch/adc-credentials` at
`382831f229e5b75d80f610ed180999a1e42e21e6`, not upstream `main`. It does not
change the relayer submodule pin or deploy an Engine image.

Audit records deduplicated by advisory ID (not by repeated dependency path),
2026-10-27:

| Scope | Before critical/high/moderate/low | After critical/high/moderate/low |
| --- | --- | --- |
| Production dependencies | 10 / 106 / 75 / 23 | 0 / 14 / 13 / 7 |
| All dependencies | 18 / 134 / 101 / 27 | 0 / 14 / 13 / 7 |

**Not audit-clean.** Remaining records are retained and reported, not suppressed.
The older Fastify/thirdweb/wallet stack includes advisories whose fixes require
major upgrades, plus packages with no published fix (for example old web3
components and elliptic). Framework/API migrations and removal of unused
adapters need separate review; do not equate zero criticals with exploit safety.
Audit dependency classification does not establish runtime reachability. Embedded
Bull Board frontend bundles and the Node/OS image need separate scanning.

## Compatibility choices

- Refresh runtime patches and scoped resolutions for protobuf, KMS, parsers,
  multipart, proxy handling and tracing. No stubs and no ignore-advisory list.
- Consolidate Google KMS to 4.5.0 and protobufjs to 7.6.6. **This deliberately
  crosses nested Google KMS 3.x/protobuf 6.x constraints** from the legacy signer.
  Yarn warns about that override; it is not a semver-compatible patch claim.
  The existing signer package's generated-client API, public-key parsing,
  signature recovery, checksum rejection, and KMS protobuf signing-request wire
  encoding are regression-tested with the real installed libraries. RPC replies
  are test vectors; no live KMS call is claimed. Dev KMS signing still requires
  operator acceptance before production.
- Retain Fastify 4.x, thirdweb, viem and ethers major versions. Existing viem/ox
  override warnings predate this PR. Tracing stays on its Node-18-compatible 5.x
  line; the production Docker base remains unchanged.
- Vitest/coverage move to 4.1.12 to remove vulnerable worker-pool dependencies.
  CI build/lint/testing use Node 22 (prool already requires Node 22). This is a
  development-tool migration, not a production Node upgrade. The production
  Node 18 base is a separate, important runtime-maintenance follow-up.
- Refresh compatible transitive lock entries (JWT, URI/glob parsers, crypto and
  HTTP helpers), and raise stale scoped axios/grpc/ws resolution floors.
- `prool`'s pinned tar 7.2.0 is resolved to patched 7.5.21; no major tar jump.

## Checks and rollout

- Frozen Yarn install, TypeScript build, and dependency-regression workflow.
- `dependency-regression.yml` runs KMS codec/signer compatibility and nonce/guard
  regressions with an isolated Redis service, without cloud secrets.
- Existing full KMS integration tests require explicit test credentials and a
  local chain; they are not replaced by these offline checks.
- Build the production Docker target, then verify dev health, KMS signing,
  transaction submission and webhook recovery before digest promotion.
- After this PR merges, update universal-relayer's Engine gitlink to the reviewed
  merge commit. Its migration-baseline gate includes package.json, so review that
  diff and update the baseline only after confirming no Prisma/startup migration
  change. Do not bypass that gate or activate this PR by a mutable image tag.

## GitHub settings after merge

1. In repository **Settings → General → Default branch**, make
   `patch/adc-credentials` the default if that remains the maintained/deployed
   fork branch. This PR targets that branch. Until it is the default, the config
   merged there will NOT activate default-branch Dependabot security coverage.
   Alternative: deliberately migrate the patched fork to main first; do not
   silently monitor unpatched upstream main instead.
2. Under **Settings → Advanced Security / Code security**, enable **Dependency
   graph**, **Dependabot alerts**, and **Dependabot security updates**. Enable
   grouped security updates if desired; no auto-merge is configured.
3. For this fork, explicitly enable **Dependabot version updates** (forks can
   leave them disabled even with a config). Confirm jobs under **Insights →
   Dependency graph → Dependabot**. The config must be on the default branch.
4. Require normal build/regression checks through branch protection/rulesets.
   Dependabot alerts/config alone do not block merges. Do not enable a blanket
   audit-zero gate while known unresolved findings remain.

`.github/dependabot.yml` monitors npm/Yarn at `/` and `/sdk` and GitHub Actions,
weekly with bounded open PR counts. Exact Yarn resolutions still need manual
security review and patch maintenance; do not assume Dependabot updates them. It does not cover the separate Bun e2e
lockfile; that is not part of the runtime image dependency audit. Security updates
are event-driven, not limited to the weekly version-update schedule. See
[GitHub version-update setup](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates).
