# Fast Rust verification before final regression

Do not rebuild the entire application for each small edit. Do not clear caches,
move active sources, or restart WSL to diagnose a slow build. Long work belongs
in a background worker with a completion notification.

## 1. Diagnose the existing executable first

Get the exact test executable path from the previous Cargo `Running unittests`
line. Run it directly, with the **crate directory** as cwd, not workspace root.
`native_rust_cases.py` never invokes Cargo, keeps stdout/stderr separate, uses a
fresh credential-free home for every case, records deadlines as failures, and
rejects zero matched tests as success. Run it in a loopback-only namespace:

```sh
unshare --net sh -c 'ip link set lo up && exec python3 "$@"' native-cases \
  /mnt/d/ai-harness/grok-build/integrations/tests/native_rust_cases.py \
  --binary /root/grok-build-target/debug/deps/EXACT_TEST_EXECUTABLE \
  --crate-dir /mnt/d/ai-harness/polycode-native/crates/codegen/xai-grok-shell \
  --case exact::failed::test_name \
  --artifacts /mnt/d/ai-harness/FRESH_DIAGNOSTIC_DIRECTORY
```

Multiple `--case` arguments run independently, not in one shared process.
The default 32 MiB test-thread stack is a documented diagnostic resource setting:
one debug shell case aborts with the default stack and passes with 32 MiB.
That does not establish the cause of its large frame or fix production code.
Use `--stack-mib 0` for a deliberate default-stack comparison. Core dumps are
suppressed. Add `--sha256` for acceptance records; fast diagnosis records
size/mtime without repeatedly reading a large executable.

**An old executable does not validate new source edits.** Use these results to
cluster causes, then collect fixes before the next deliberate compilation.

## 2. Compile a batch, preserving cache identity

Keep toolchain, source path, target directory, profile, features and flags stable.
Changing the selected package set can change unified dependency features; retain
that distinction in comparisons. For broader source changes, a targeted
`cargo check --tests` can catch type errors without the final application link.
Compile the affected test artifact once (`cargo test ... --lib --no-run`), then
run exact cases directly. Do not repeatedly wrap every case in Cargo commands.
Record Cargo timings and CPU/RSS/I/O for the next approved batch. Confirm reuse
with an unchanged-source freshness check, rather than assuming a large cache is
necessarily effective. Stop and investigate unexpected broad recompilation.

Current observations (not universal benchmarks):
- Prior compilation: 14m06s / 15m24s; pager execution: 47s / 39s.
- Incremental is enabled; approximately 53.77 GiB of persisted cache exists.
- Post-build WSL inspection: ~32 GiB RAM, ~30 GiB available, 8 GiB swap unused.
  This does not measure peak compilation memory or establish a bottleneck.
- Warm synthetic 512-file probe: ext4 stat/read medians 1.74/5.79 ms;
  `/mnt/d` medians 1345.06/1964.21 ms. This is not a whole-build speed ratio.
- An unchanged-source Cargo probe hit its 30s deadline before any Fresh or
  Compiling status. Cache effectiveness remains **unverified**; no cache was cleared.

## 3. Windows is a separate validation target

Native Windows Rust 1.94/MSVC tooling is installed on the current machine, and
Windows Cargo metadata passed. Use a separate target directory and a scoped
background check before considering a full Windows build. Existing Linux ELF
artifacts/cache cannot stand in for Windows executable verification. Conversely,
Windows checks cannot replace Linux sandbox tests: the current non-Unix sandbox
path does not apply enforcement.

## 4. Final acceptance still requires full regression

After focused failures are resolved, run the complete required suites with the
recorded toolchain/features/resource settings, plus native PTY/MCP/permission and
live-provider acceptance. Report failures, timeouts, crashes and upstream ignored
tests separately. Do not add ignores, weaken assertions, or treat partial runs as
successful completion.
