# Windows terminal test transport

Native smoke/tool tests use node-pty 1.1.0's bundled ConPTY. This is a test
dependency; the shipped application does not require node-pty or replace the
user's terminal. Windows 10/11 clean-machine acceptance remains separate.

On Windows Server 2022 (10.0.20348), the inbox ConPTY turns an application's
alternate-screen entry/exit into redraws instead of forwarding `CSI ?1049 h/l`.
The same known-input probe on the same runner forwards both transitions with
the bundled ConPTY. Both transports display the alternate content and restore
the original content, and the probe exits with code 0. On local Windows 11
(10.0.26200), both transports forward the transitions.

Evidence: [Server 2022 transport probe, run 34195555822](https://github.com/Miku0139oao/Polycode/actions/runs/34195555822).
The preceding candidate run 34169041730 built and installed successfully but
failed its raw entry-sequence assertion using the inbox transport. This
diagnosis concerns the observation boundary, not live provider acceptance.

Run `windows-terminal-probe.mjs` with `NODE_PTY_MODULE` pointing to the pinned
node-pty installation to compare both transports. CI runs it before compiling.
The probe requires entry and restoration on the bundled transport. Installed
startup still independently requires the provider menu, no browser dispatch,
alternate-screen entry and restoration, normal exit, and no forced cleanup.
Raw signed-out startup transcripts are retained in the build evidence artifact
on failure as well as success. No OAuth credentials are used in these tests.
