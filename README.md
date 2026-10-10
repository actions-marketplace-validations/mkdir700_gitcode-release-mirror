# GitCode Release Mirror

A GitHub Action that copies release files to a [GitCode](https://gitcode.com)
Release and proves, by downloading them back anonymously, that GitCode holds
exactly the bytes you declared.

Why it exists: uploads from GitHub-hosted runners to GitCode's object storage
can be extremely slow (one 94 MiB upload did not finish in 18 minutes in the
project that this comes from; that is one observation, not a benchmark). The
Action therefore has two transports:

| `transport` | Who uploads | Use it when |
| --- | --- | --- |
| `ssh` | A host you control (for example in mainland China) that downloads the files itself, checks their SHA-256 and uploads them. The runner only sends one small request. | GitHub to GitCode is slow or blocked. This is the main path. |
| `direct` | The runner, from local files. | The runner can reach GitCode well, or for local testing. |

Both run the same file, `lib/mirror-core.mjs`. On the SSH host that exact file is
installed by an administrator, and the Action sends its SHA-256 with every
request; a host with a different core refuses to run.

## SSH transport

```yaml
name: mirror-to-gitcode
on:
  workflow_dispatch:
    inputs:
      tag:
        required: true
        type: string

permissions:
  contents: read

jobs:
  mirror:
    runs-on: ubuntu-latest
    environment: mirror            # keep the secrets in an environment limited to trusted branches
    concurrency: gitcode-mirror-${{ inputs.tag }}
    steps:
      - uses: UniClipboard/gitcode-release-mirror@<full commit SHA>  # v1.0.0
        with:
          transport: ssh
          repository: your-org/your-gitcode-mirror     # must exist and have a commit on its default branch
          tag: ${{ inputs.tag }}
          token: ${{ secrets.GITCODE_TOKEN }}
          ssh-host: mirror.example.com
          ssh-user: gitcode-mirror
          ssh-key: ${{ secrets.MIRROR_SSH_KEY }}
          ssh-known-hosts: ${{ vars.MIRROR_SSH_KNOWN_HOSTS }}
          sources: |
            [
              {"url": "https://downloads.example.com/releases/v1.2.3/app-1.2.3.apk", "sha256": "<64 hex characters>"}
            ]
```

Trigger note: a release or tag created with the workflow's own `GITHUB_TOKEN`
does not start other workflows (GitHub's documented rule), so `on: release:
published` will not fire for releases made by another workflow. Start the mirror
with `workflow_dispatch`, `workflow_call` or `repository_dispatch` from the
release workflow, as above. Never expose the secrets to pull requests from forks.

Each source is a public https URL **and** the SHA-256 it must have. The host
downloads it, refuses it if the digest differs, and only then touches GitCode.
The file name on GitCode is the last segment of the URL. Setting the host up is a
one-time job: [docs/host-setup.md](docs/host-setup.md).

The host decides what it is willing to do (allowed URL prefixes, allowed GitCode
repositories, file-name pattern, size limit). A workflow can narrow that, never
widen it.

## Direct transport

```yaml
- uses: UniClipboard/gitcode-release-mirror@<full commit SHA>  # v1.0.0
  with:
    transport: direct
    repository: your-org/your-gitcode-mirror
    tag: ${{ github.event.release.tag_name }}
    token: ${{ secrets.GITCODE_TOKEN }}
    files: |
      dist/*.apk
      dist/*.zip
```

Symbolic links are not followed and a pattern that matches nothing is an error.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `transport` | yes | `ssh` or `direct` |
| `repository` | yes | GitCode `owner/repo` |
| `tag` | yes | Release tag; the GitCode release is created if missing |
| `token` | yes | GitCode token with release write access to that repository |
| `files` | direct | Local paths or globs, one per line |
| `sources` | ssh | JSON array of `{"url", "sha256"}`; no other fields are accepted |
| `ssh-host`, `ssh-user`, `ssh-key`, `ssh-known-hosts` | ssh | Host, account, private key, host public keys. Host keys are always verified; there is no way to switch that off. |
| `ssh-port` | no | Default `22` |
| `prerelease` | no | Create a new GitCode release as `pre` (default `latest`). An existing release is never edited. |
| `target-commitish` | no | Branch for a newly created tag, default `main` |
| `api-base` | no | `https://api.gitcode.com/api/v5` (default) or `https://api.atomgit.com/api/v5` |
| `stall-timeout` | no | Seconds without data before a transfer is abandoned and retried (default 120) |
| `deadline` | no | Seconds after which the run stops by itself and reports (default 2400) |

## Outputs

* `receipt`: JSON, one entry per file: `name`, `status` (`mirrored`, `reused` or
  `failed`), `size`, `sha256`, `downloadUrl`, `redirectChain`, `attempts`, and for
  failures `stage` (`source`, `conflict`, `upload`, `register`, `verify`,
  `deadline`, `host`, `hash-binding`, `release`) and `error`.
* `failed-count`: the number of files that are not mirrored. The step fails when
  it is above zero, and `receipt` is still set.

The receipt is produced by the Action's own checks. It says nothing about whether
the GitCode service is the real one; treat it as your build log, not an attestation.

## What it guarantees

* **Hash binding.** Every file has a declared SHA-256. Sources are checked after
  download, local files before upload, GitCode's copy after upload (anonymous
  download, size and digest). On the SSH path the runner also rejects a host
  receipt whose digest differs from the declared one.
* **Idempotence without overwriting.** A release is created only if missing. An
  asset with the same name and identical bytes is `reused`; a different one is a
  `conflict` failure. Nothing is overwritten or deleted, ever.
* **No upload before verification.** A source that does not match its digest
  never reaches GitCode, and the release is not even created for it.
* **Bounded.** Retries are limited, a stalled transfer is abandoned after
  `stall-timeout`, the whole run ends by `deadline`, and every file is reported
  even when another failed.
* **Streaming.** Files are streamed, never read into memory whole (measured in
  the end-to-end suite).
* **Secrets.** The token and key are masked, kept out of the receipt, summary and
  logs, never put on a command line, and the temporary key file is removed.
  Redirects are checked hop by hop, API calls never follow a redirect, and the
  upload address is used without the token.

## Limits you should know

* Concurrent runs for the same tag cannot be made fully safe. Use
  `concurrency: group: gitcode-mirror-<tag>` in your workflow. If two runs upload
  different bytes under one name at the same moment, the file left on GitCode is
  one of them, and the run whose copy was replaced after its own check will not
  notice.
* The SSH transport only pulls. Every file needs a URL the host can reach, and
  that URL must be inside the host's allow-list.
* Only Linux/macOS-style runners with an OpenSSH client are covered; Windows
  runners are untested. `node24` is declared in `action.yml`; the suite ran the
  Action on Node v24.21.0 and the host side on Node v22.22.1.
* Not available to this Action by design: GitCode deletion, replacing assets,
  and anything specific to a product (registering the mirror elsewhere is done by
  a later step of your workflow that reads the `receipt` output).

## Not verified

These were not checked against the real service, because that needs a GitCode
test repository and token that were not available when this was written:

* a real upload and read-back against `api.gitcode.com`; the end-to-end suite
  uses a mock written from the public API pages;
* the token scope needed for release writes, and whether the token can be sent
  as `Authorization: Bearer` instead of the query parameter the Action uses
  today (the query form is the documented one);
* `api.atomgit.com` as an alternative base;
* attachment size limits above 123 MB (the largest file seen uploaded by the project this comes from);
* behaviour on GitHub-hosted runners, any Windows runner, and the real
  production SSH host.

See [docs/e2e-scenarios.md](docs/e2e-scenarios.md) for what is covered and how
to run it (`npm run e2e`).

## Versions and pinning

Releases are tagged `v1.x.y`. Pin the full commit SHA of a release and put the
version in a comment, as in the examples; that is the only reference GitHub
treats as immutable. [docs/release-and-marketplace.md](docs/release-and-marketplace.md)
describes how releases are cut and the Marketplace listing.

## Development

```sh
npm ci
npm run build        # bundles src/ into dist/ (commit the result)
npm run check-dist   # fails when dist/ is stale
npm run e2e          # the only test mechanism; needs openssl, ssh, sshd
```

MIT licensed; see [NOTICE.md](NOTICE.md) for where the code comes from.
