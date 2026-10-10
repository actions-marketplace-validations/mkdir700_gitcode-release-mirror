# Moving the Uni workflows to this Action (example, not applied)

This is a plan and a sketch. No Uni workflow, host or FlareRelease setting has
been changed.

## What changes

| Today (Mobile; Desktop is the same idea) | With the Action |
| --- | --- |
| `scripts/mirror-android-apk-to-gitcode.mjs`, a Python wrapper and two deploy scripts on the Shanghai host | `lib/mirror-core.mjs` and `lib/host.mjs`, installed once with `host/install.sh` |
| Request fields `tag, filename, expectSha256, scriptSha256, env{...}` | `sources` (URL + SHA-256) and the `token` input |
| R2 base URL and the file-name regexes hard-coded in the wrapper | `allowedSourcePrefixes` and `fileNamePattern` in the host config |
| FlareRelease / Cloudflare Access credentials sent to the host | Not sent. Registration runs on the runner after the Action. |
| Provenance JSON uploaded as an artifact | The `receipt` output; the workflow can upload it as it does today |

## Host

Install the release on the Shanghai host next to the old wrapper (different
prefix and user), set `allowedSourcePrefixes` to
`https://release.uniclipboard.app/artifacts/` and
`https://release.uniclipboard.app/android/artifacts/`, `allowedRepositories` to
the GitCode mirror repository, and authorise a new key. Switch Mobile first (one
file), then Desktop. Whether the old host's Node (an unofficial glibc-2.17 build
of Node 22) satisfies `lib/*.mjs` is not verified; the suite used Node v22.22.1
on macOS.

## Workflow sketch (Mobile)

```yaml
- id: mirror
  uses: UniClipboard/gitcode-release-mirror@<full commit SHA>
  continue-on-error: ${{ inputs.non_blocking }}
  with:
    transport: ssh
    repository: ${{ vars.GITCODE_OWNER }}/${{ vars.GITCODE_REPO }}
    tag: ${{ inputs.tag_name }}
    token: ${{ secrets.GITCODE_RELEASE_TOKEN }}
    ssh-host: ${{ vars.MIRROR_SSH_HOST }}
    ssh-user: ${{ vars.MIRROR_SSH_USER }}
    ssh-key: ${{ secrets.MIRROR_SSH_KEY }}
    ssh-known-hosts: ${{ vars.MIRROR_SSH_KNOWN_HOSTS }}
    prerelease: ${{ steps.release.outputs.prerelease }}
    sources: |
      [{"url": "https://release.uniclipboard.app/android/artifacts/${{ inputs.tag_name }}/${{ steps.apk.outputs.filename }}",
        "sha256": "${{ steps.apk.outputs.sha256 }}"}]

- name: Register the verified mirror with FlareRelease   # Uni-specific, stays in the workflow
  if: steps.mirror.outputs.receipt != ''
  env:
    RECEIPT: ${{ steps.mirror.outputs.receipt }}
    FLARE_RELEASE_ACCESS_CLIENT_ID: ${{ secrets.FLARE_RELEASE_ACCESS_CLIENT_ID }}
    FLARE_RELEASE_ACCESS_CLIENT_SECRET: ${{ secrets.FLARE_RELEASE_ACCESS_CLIENT_SECRET }}
  run: |
    echo "$RECEIPT" | jq -c '.files[] | select(.status != "failed")' | while read -r file; do
      jq -n --argjson f "$file" --arg version "${RELEASE_TAG#v}" \
        '{product: "android", version: $version, filename: $f.name, provider: "gitcode",
          downloadUrl: $f.downloadUrl, size: $f.size, sha256: $f.sha256, source: "github-actions"}' |
      curl --fail-with-body -sS -X PUT "$FLARE_RELEASE_ADMIN_URL/api/mirrors" \
        -H 'content-type: application/json' \
        -H "CF-Access-Client-Id: $FLARE_RELEASE_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $FLARE_RELEASE_ACCESS_CLIENT_SECRET" --data @-
    done
```

`RELEASE_TAG` and `FLARE_RELEASE_ADMIN_URL` come from the existing workflow. The
FlareRelease checks (artifact sha256 present and equal, `state: ready`) stay
where they are.

## Things to do before switching

* The 2026-10-03 Desktop run failed at registration with HTTP 422 "Mirror sha256
  does not match the artifact"; that is a FlareRelease/registration problem, not
  fixed by this Action.
* Keep the old wrapper until one pre-release has been mirrored end to end.
* The old workflow's `MIRROR_*` variables map one to one onto the inputs above.
