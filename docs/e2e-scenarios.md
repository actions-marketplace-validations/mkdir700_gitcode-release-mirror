# End-to-end failure scenarios and acceptance plan

This file was written before the implementation. The project has one test
mechanism: end-to-end runs across real process boundaries. There are no unit
tests; every behaviour below is observed from outside.

## What "end to end" means here

| Boundary | Real in the tests | Simulated |
| --- | --- | --- |
| Action entry | `node dist/index.mjs` with the GitHub runner file protocol (`INPUT_*`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, workflow commands on stdout) | The GitHub runner itself (not available locally) |
| SSH | OpenSSH client and a throw-away `sshd` on loopback, test keys, strict host-key checking, `restrict,command=` forced command | Nothing |
| Host wrapper | The installed `host.mjs` and `mirror-core.mjs`, a host config file, a host work directory | Nothing |
| Network to GitCode and to the source | Real HTTPS over loopback, certificates signed by a test CA that only the test processes trust (`NODE_EXTRA_CA_CERTS`). Production host validation, https-only and "no port" rules stay active. | The GitCode service and the source server are mock servers. A preload module that is passed only to the test child processes (`--import`) maps `*.gitcode.com`/`downloads.example.test` port 443 to the loopback mock. |

Nothing in this suite proves behaviour of the real GitCode service. Every
receipt produced by the suite says so.

## Failure scenarios (each is an executable scenario)

IDs are stable names used by the suite and the evidence index.

### Happy path and idempotency

| ID | Setup | Expected |
| --- | --- | --- |
| `ssh-happy` | Two sources (small + 24 MiB), new GitCode release, SSH transport | Release created once with the requested status; both assets stored byte-identical; receipt `mirrored`; outputs set; exit 0; the mock saw one `upload_url` + one PUT per file |
| `ssh-rerun-reuse` | Run `ssh-happy` again | Receipt `reused` for both; no `upload_url` request and no PUT; the host did not download the sources (the source server saw no second request); exit 0 |
| `direct-symlink-and-empty-glob-rejected` | A symlink and a glob that matches nothing | Both refused, zero GitCode requests |
| `direct-happy-and-rerun` | Direct transport, glob input over local files | Same results through the same core; second run reuses |
| `same-name-different-bytes` | GitCode already holds `a.bin` with other bytes, workflow ships `a.bin` and `b.bin` | `a.bin` failed (stage `conflict`), no overwrite and no delete request; `b.bin` still mirrored; exit non-zero; receipt shows both |
| `concurrent-same-tag` | Two runs start together for the same tag and files, release does not exist | Both end successful or one `reused`; no duplicate release; bytes identical; mock injects a "release already exists" answer to the loser, which re-reads and proceeds |
| `concurrent-different-bytes` | Two runs race with different bytes for one name | The stored bytes equal exactly one declared hash, at least one run succeeds, any failure is a `conflict` or `verify` failure. A run whose copy is replaced after its own check cannot notice; this residual risk is documented in the README. |

### Hash binding

| ID | Setup | Expected |
| --- | --- | --- |
| `source-hash-mismatch` | Source server delivers bytes whose SHA-256 differs from the declared one | Failed at stage `source`; zero PUTs; the GitCode release is not even created when nothing verified |
| `source-lies-about-length` | Source sends fewer bytes than `Content-Length` / connection closes early | Failed at stage `source`, temp file removed |
| `host-core-mismatch` | Installed `mirror-core.mjs` differs from the file the Action ships | Host refuses before loading the core or any network access, message says to redeploy (this scenario found that the core was loaded before the comparison) |
| `host-claims-wrong-hash` | A host that reports a receipt whose hash differs from the declared one | Runner marks the file failed and the step fails |
| `dist-integrity` | Rebuild `dist/` and compare | Byte-identical to the committed `dist/`; `lib/` core is the file the Action hashes |

### Timing and asynchronous GitCode behaviour

| ID | Setup | Expected |
| --- | --- | --- |
| `upload-stall-retry` | The first PUT stops reading mid-body | Stall watchdog aborts within the stall timeout; second attempt asks for a fresh `upload_url`; asset mirrored; receipt `attempts: 2` |
| `upload-stall-forever` | Every PUT stalls | Failed at stage `upload` after the bounded retries, within the total deadline |
| `deadline` | Registration never completes and polling is slow | Run ends at the deadline with a failed receipt (not a killed job) |
| `slow-but-steady-transfers` | The source, the upload and the read-back each trickle (pauses after every 128 KiB) so every transfer lasts far longer than the 3 s stall timeout | Success with exactly one PUT and one source download: progress is never mistaken for a stall, and no fixed per-transfer time limit exists |
| `body-sent-answer-late` | The whole body is received but the answer comes after longer than the stall timeout | One PUT only: waiting for the answer is not a stall |
| `answer-lost-after-registration` | The asset is registered and the connection is then dropped | The retry path finds the asset, verifies it and does not upload again (one PUT) |
| `callback-late` | The asset appears on the release only a few seconds after the PUT | Polling finds it; mirrored |
| `callback-never` | The asset never appears | Failed at stage `register` with a clear message |
| `retry-classification` | API answers 429/503 twice, then OK; separately 401/403/404 | Transient errors retried and succeed; permanent errors fail at once without retrying |

### Read-back verification and redirects

| ID | Setup | Expected |
| --- | --- | --- |
| `readback-corrupt` | Anonymous download returns different bytes | Failed at stage `verify`; the asset is left alone; no `downloadUrl` in the receipt |
| `readback-redirect-http` | Anonymous download redirects to `http://` | Rejected |
| `readback-redirect-loop` | Endless redirects | Rejected after the redirect limit |
| `readback-cdn-ok` | Download redirects once through a `file-cdn.gitcode.com` style host | Accepted, redirect chain recorded without query strings |
| `source-redirect-rules` | Source URL redirects: inside the allow-list; outside it; to another host; to http; endless | Only the first is followed; the others fail at stage `source` with zero PUTs |

### Request validation on the host

All of these must be rejected before any outbound network request. The suite
asserts that the mock servers saw zero requests.

| ID | Input |
| --- | --- |
| `host-bad-names` | File names `../x`, `a/b`, `a\b`, `%2e%2e`, `%2f`, leading dot, NUL, over-long, non-matching the pattern |
| `host-bad-urls` | Not https, outside the allow-listed prefixes, user-info, explicit port, fragment, `..` segments, `%2f` in the path |
| `host-bad-target` | Repository not in the allow-list, malformed repository, bad tag, bad branch, API base not `api.gitcode.com`/`api.atomgit.com` |
| `host-bad-request` | Not JSON, two lines, trailing data, unknown fields, wrong types, oversized body, duplicate names, bad digests, unsupported version |
| `host-request-timeout` | A client authenticates and never finishes its request line | The host gives up after 30 s with a rejection and no network access |
| `host-injection` | Shell metacharacters and `$(...)` in tag, names, URLs and SSH settings; canary file must never appear |
| `ssh-option-injection` | `ssh-host`/`ssh-user`/`ssh-port` shaped like ssh options or shell text | Rejected before `ssh` starts (the PATH shim records no invocation) and a canary file never appears |
| `forced-command-only` | Client asks for a shell, another command, a pty, port forwarding, agent forwarding | Only the wrapper runs; a non-empty `SSH_ORIGINAL_COMMAND` is rejected; nothing else executes |
| `ssh-identity` | Wrong client key; wrong host key in `known_hosts`; missing `known_hosts` | Connection refused; a marker-writing forced command proves the host command never started; the mock servers saw nothing; the token is not in any output |
| `port-forwarding-refused` | `ssh -L` through the forced-command key | The server answers "administratively prohibited"; the forwarded target is never reached |

### Secrets

| ID | Check |
| --- | --- |
| `secret-hygiene` | A unique token sentinel and a unique private-key sentinel are used in a full run including failures. They must not appear in: runner stdout/stderr, outputs, step summary, receipt, host logs, ssh argv (recorded by a PATH shim that execs the real `ssh`), the key file after the step (it must be deleted), or temp directories. The mock echoes the token inside its error bodies to prove redaction. |

### Resource behaviour

| ID | Check |
| --- | --- |
| `large-file-streaming` | A 64 MiB and a 400 MiB file go through the direct transport and through the host (`/usr/bin/time -l` around the processes). The bytes arrive intact and peak RSS grows by less than 64 MiB between the two sizes. (Absolute RSS includes the runtime, about 200 MiB under `time -l`, so it is not a useful limit.) This scenario found that `fetch` buffers a streamed upload body: 223/350/540 MiB for 100/200/400 MiB files; the upload now uses `node:https`. |
| `cleanup` | After success and after failure the host work directory and the runner temp directory contain nothing of ours; all test processes are gone |

### Partial failure and outputs

| ID | Check |
| --- | --- |
| `partial-failure` | Mixed results across files: step outcome failure, `failed-count`, `receipt` JSON complete and parseable, other files unaffected |
| `ssh-transport-failure` | `sshd` unreachable or killed mid-run: the step fails; the receipt says the host outcome is unknown and the run is safe to repeat |

## Evidence the suite produces

`npm run e2e` writes into `artifacts/<utc-run-id>/` (kept out of git, copied to
a directory of your choice):

* `manifest.json`: source commit, `git status` cleanliness, Node versions,
  OpenSSH version, OS, command line, protocol and scope statement
  (`"gitcode": "mock", "realGitCodeProof": false`), scenario list with
  pass/fail and duration;
* one `receipt-<scenario>.json` per scenario that produces one;
* `SHA256SUMS` over everything above and over `dist/` and `lib/`;
* captured, redacted stdout/stderr per scenario.

A run is repeatable: fixed seeds for generated files, fresh temp directories,
dynamic loopback ports, and teardown of every process the suite started
(`sshd` is started from a private config and pid file and is only ever
signalled through that pid).

## Cleanup checks applied to every scenario

After each scenario the suite fails it if the host work directory or a runner
temp directory still holds anything, and at the end it stops the `sshd` it
started through its own process handle and removes its temp tree.

## Known gaps in the suite

* Node 22 as the host and Node 24 as the runner were exercised; Node 22 as the
  runner and Node 24 as the host were not.
* The older `no-pty,...` form of `authorized_keys` options is not tested.
* `restrict` was tested with the OpenSSH shipped with macOS; a production
  host's OpenSSH build was not.

## Not covered, on purpose

Real GitCode behaviour (token scopes, `Authorization: Bearer`, `atomgit.com`
equivalence, attachment limits, the real callback), the real GitHub runner
environment, Windows runners, throughput from GitHub-hosted runners to China,
and a production host. Each of these is listed as pending in the
README and in the review report.
