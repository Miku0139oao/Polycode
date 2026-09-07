# c037 followup: required gates + immutable promotion

Latest installer security correction: see [d92 JSON shape followup](#d92-json-shape-followup) below. The original 30-test record is historical.

Scope: `acceptance/package-ready`, same owned worktree. No Rust/bridge edits,
publication, remote activity, push/tag, real parent authorization or rebuild /
recompression of the 552923744-byte application was performed.

## Design

### Complete required policy

Policy `2026-09-07.2` now has **30 required gates**. The 11 added gates are:

- `session-resume-chatgpt`, `session-resume-cursor` — parent session resume,
  explicitly distinct from the retained child `task-resume-*` gates.
- `prompt-identity-native`, `prompt-identity-chatgpt`, `prompt-identity-cursor`.
- `native-reasoning-effort-capability`, `native-reasoning-effort-ui`,
  `native-reasoning-effort-wire`, `native-reasoning-effort-inheritance`,
  `native-reasoning-effort-resume`.
- `busy-queued-model-switch-safe-commit` — actual safe commit while busy, not
  merely a pending UI choice.

All require real behavioral evidence tied to candidate/native hashes. Missing,
FAIL/BLOCKED, stale or mock-only evidence still rejects readiness. Installer and
guard policies are identical by a dedicated drift test. No application gate was
marked PASS by this followup.

### No reclassification/repack at promotion

New packages use schema2 `classification:"immutable-candidate"`, with **no mutable
publication status**. The package's exact six files are accepted once:
`manifest.json`, `SHA256SUMS`, `install.ps1`, runtime ZIP, native gzip, Bun gzip.

After all actual gates and parent review pass, the guard produces a separate
`release-readiness.json`: current policy, candidate/native hashes, acceptance and
parent-review hashes, check time and per-gate verified status. It still says
`publicationAuthorized:false` and `DEFERRED_UNTIL_PUBLICATION`.

Only the parent, after separately obtaining permission, may issue a separate
`release-authorization.json` bound to that exact readiness hash, original manifest
and SHA256SUMS hashes, native hash, version, acceptance and parent-review hashes.
The sidecar authorizes distribution; **it does not claim publication occurred**.
There is no production authorization issuer script, and no actual sidecar was
created for the e8 application candidate.

Remote-mode installation requires both matching sidecars, the complete embedded
policy, PASS/verified gates, acceptable native profile, timely parent decision,
and exact original asset bytes. It verifies the executing installer file itself.
Nothing is added to ZIP/SHA256SUMS and neither manifest is relabeled. Installed
metadata retains the two sidecars outside the runtime ZIP inventory.

Local `-ArtifactDirectory` still always requires `-AllowCandidate`, even with
sidecars. That switch cannot bypass the remote branch. Legacy schema1 packages
remain local preparation only; they cannot be promoted by changing status text.

The trust boundary is the same trusted publisher/HTTPS origin as the executable
installer. JSON `role:"parent"` is **not a cryptographic signature**. No claim of
independent identity authentication, compromised-publisher protection, key
management or revocation is made. Raw/private evidence is retained locally; public
sidecars need only its hashes. See [full contract](RELEASE_READINESS.md).

## Executed tests

Final command (exit0):

```text
node --test D:/ai-harness/polycode-accept-package/integrations/tests/install-native.test.mjs D:/ai-harness/polycode-accept-package/integrations/tests/release-readiness.test.mjs
```

**30 tests PASS, 0 FAIL, 0 SKIP**: 16 installer/transport-fixture tests and
14 readiness-policy tests. These are **not 30 application acceptance PASS gates**.
No stack/resource increase, skipped tests or weakened assertions.

Transport tests replace only `Invoke-WebRequest` with strict URL-checked local
file copies. No HTTP server or actual request to GitHub/provider endpoints runs.
A small, explicitly labeled C fixture is compiled; shipped Bun and the actual
bundled bridge are retained. Fixture acceptance/parent records are synthetic,
confined to disposable test directories and deleted; never application authority.

Verified cases include:

- Existing local candidate opt-in, checksum, path, inventory, rollback and argv
  tests still PASS; user PATH and existing Windows installation unchanged.
- New parent session/prompt/effort/queued-switch gates cannot be omitted or replaced
  by mock evidence; child-task resume remains a separate requirement.
- Absent/FAIL authorization, wrong parent/version, stale candidate/native/sums /
  readiness/acceptance/review hashes and invalid/late authorization time reject.
- Missing/FAIL/unverified required gates, BLOCKED readiness and old policy reject.
- Modifying accepted gzip bytes rejects even after recomputing transport checksums
  and the authorization's checksum reference.
- Genuine matching **synthetic fixture** readiness is generated by the real guard;
  its matching fixture authorization permits installation through the production
  remote branch on **PowerShell5.1 and7**. Every accepted file, installed runtime
  inventory, uncompressed native/Bun hash and candidate manifest is identical.
  Only separate sidecars are added: no hidden recompression/repack/reclassification.
- Sidecars cannot bypass local `-AllowCandidate`.

Preserved logs:

- `D:/ai-harness/native-package-followup-c037-final-tests.log` — final 30/0/0 run.
- `D:/ai-harness/native-package-followup-c037-install-tests-1.log` — earlier 15/0/0
  installer run before the additional post-acceptance mutation test.
- `D:/ai-harness/native-package-followup-c037-immutability.log` — unchanged c037 assets.

`git diff --check` also passed.

## Existing candidate and remaining acceptance

`D:/ai-harness/native-release-candidate-18d` remains **byte-for-byte unchanged**:
all five SHA256SUMS entries rechecked, manifest identity still
`7819c5c7cffede5fd4524a3444c1acf74553dfa976c6a471912a1b526fe32e76`, six original
files and no sidecars. This is historical schema1/e8 development preparation,
not a final candidate. Existing isolated installation evidence is not rerun or
recast as current acceptance.

Parent main `211debd` adds secret-safe OAuth diagnostic stages; those JS changes
are not in this owned branch or old package. Latest user stage: **Cursor website
success, TUI login failure**, still not fixed. ChatGPT/native Grok work per user
report, not candidate-bound formal acceptance.

Final Rust/JS integration, optimized final binary, fresh package/hash, applicable
regression and all 30 behavioral/provenance gates still require actual evidence
and parent review. The README public one-command flow now executes the exact
installer file, but remains **DEFERRED_UNTIL_PUBLICATION**. No live authorization,
public download result or publication permission has been fabricated.

Changed files: `README.md`, `install.ps1`, `integrations/package-release.ps1`,
`integrations/release-readiness.mjs`, `integrations/RELEASE_READINESS.md`,
`integrations/PACKAGE_CANDIDATE_REPORT.md`, this report, and installer-specific
`install-native.test.mjs`, `release-readiness.test.mjs`, `install-candidate.mjs`.

## d92 JSON shape followup

Independent review confirmed that PowerShell `-cne`/`-ne` with a collection on
its left filters that collection instead of returning a scalar Boolean. Empty
arrays could bypass AUTHORIZED/PASS and hash rejection tests. This is fixed in
`install.ps1` by validating every consumed manifest/authorization/readiness field
before its value comparisons, not by changing an operator or coercing to string.

- Root JSON arrays are rejected before `ConvertFrom-Json` can unwrap a singleton.
  Objects, inventory/gate/error arrays, and each nested entry have explicit shape
  checks. Required strings/hashes are actual strings, booleans actual booleans.
- Schema numbers are Int32/Int64 integers in 1..2; executable sizes are positive
  Int64-range integers; inventory sizes allow zero. Null, arrays, objects,
  numeric strings, booleans, fractions, floating-point spellings and overflowing
  integers cannot substitute. Enum/schema/hash/value checks still follow.
- Rust `opt_level` retains actual serialized strings `0`..`3`/`s`/`z` and integer
  0..3. Development levels remain local-only; remote requires 2/3/s/z and false
  debug/test/transformed flags. Unattested local fixtures may retain profile:null.
  Historical schema1 stays local-only and still requires `-AllowCandidate`.
- PS7's automatic timestamp-to-DateTime conversion is suppressed with
  `-DateKind String`. For pre-DateKind PS7, the in-box Newtonsoft reader disables
  date coercion and transfers tokens through ref outputs, preserving nested,
  empty and singleton arrays. PS5.1 keeps its original string-preserving parser.
  No external JSON library, download or install is needed.

### Final verification (exit 0)

Run from `D:/ai-harness/polycode-accept-package`:

```text
node --test integrations/tests/install-authorization.test.mjs integrations/tests/install-native.test.mjs integrations/tests/release-readiness.test.mjs > integrations/tests/installer-authorization-full-results.log 2>&1
git diff --check
```

**34 tests PASS, 0 FAIL, 0 SKIP**, including:

- **780 shape/control cases each** on PS5.1.26100.9168 and PS7.6.5, plus the same
  780 through the pre-DateKind parser branch forced on installed PS7. Production
  function bodies/policy are AST-checked against the source and run unchanged.
  Real older PS7 executables were not available/run; this is branch coverage,
  not a claim of testing every historical shell version.
- Empty/singleton/multi arrays, objects, null, missing fields, wrong primitive
  types, nested/root containers, integer bounds/spellings and all consumed hash
  fields. Valid profile/schema controls plus FAIL, stale, duplicate/missing gates
  and readiness-byte hash mutation controls remain exercised.
- **40 full production remote-branch rejections** for decision, readiness status,
  gate status and readinessSha256 shape attacks across PS5.1/7. Local transport
  only replaces `Invoke-WebRequest` with strict URL-checked copies; no HTTP call.
- Existing FAIL/stale/timeline/policy/post-acceptance-gzip mutation controls now
  run on both shells. Valid synthetic authorization still installs the **exact
  same six accepted fixture files**, native/Bun bytes and runtime inventory on
  both shells in isolated Windows/WSL roots. Sidecars stay separate; local opt-in
  cannot be bypassed. Existing Windows user installation and user PATH snapshots
  match after the suite; WSL writes are confined to disposable `/tmp` test roots.

Additional commands executed: `node --test integrations/tests/install-authorization.test.mjs`
(targeted matrix), shell version probes, and a read-only Node checksum/inventory
check against the historical schema1 candidate. Retained local logs (ignored by
Git, under this worktree):

- `integrations/tests/installer-authorization-full-results.log` — final 34/0/0 run.
- `integrations/tests/install-authorization-results.log` — final targeted 3/0/0 run.
- `integrations/tests/historical-candidate-unchanged.log` — all five sums match,
  exactly six original files/no sidecars; manifest SHA256 still
  `7819c5c7cffede5fd4524a3444c1acf74553dfa976c6a471912a1b526fe32e76`.

### Scope and remaining release risks

Only `install.ps1`, `integrations/tests/install-authorization.test.mjs`,
`integrations/tests/install-native.test.mjs` and this report change in this
security followup. `release-readiness.mjs` and `package-release.ps1` were fully
reviewed but remain unchanged; this is not a general hardening pass over the
local evidence producer/build-report reader. No root-main/other-worktree edits,
Rust build, real-candidate recompression/overwrite, network, agent, publication,
push or tag occurred. Only the existing small C test fixture is compiled.

The old schema1/e8 preparation is untouched and not made promotable. This new
installer changes candidate identity: final source integration needs a **fresh**
package and real candidate-bound acceptance; no existing accepted package may be
patched/rehashed into approval. These synthetic tests confer no vendor/live
acceptance or publishing permission. All actual shipping gates and final review
remain parent-owned. The trusted publisher/HTTPS boundary remains intentional,
not a cryptographic signature or protection against a compromised publisher.
