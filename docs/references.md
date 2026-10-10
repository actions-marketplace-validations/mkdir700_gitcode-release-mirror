# Official documentation checked

Read on 2026-10-09 (UTC+8). Statements below are what the pages said then;
anything not listed here is not verified.

## GitHub

* Action metadata syntax, <https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax>:
  `runs.using` accepts `node20` and `node24` for JavaScript actions; `runs.main`
  is required; input and output ids follow `[A-Za-z_][A-Za-z0-9_-]*`; outputs are limited to 1 MB per job;
  `branding.color` and `branding.icon` (Feather set, no brand icons).
* Publishing to the Marketplace, <https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace>:
  public repository; one `action.yml` at the root; the metadata `name` must be
  unique and must not collide with a Marketplace action, a user or organisation
  (unless the owner publishes), a category or a GitHub feature; two-factor
  authentication; accept the terms; the owner accepts the Marketplace Developer
  Agreement; choose a category on the release.
* Secure use, <https://docs.github.com/en/actions/reference/security/secure-use>:
  a full commit SHA is the only immutable way to pin an action.
* Workflow commands / secrets, from earlier work: values registered as
  secrets are masked; a masked value cannot be set as an output.

## GitCode (docs.gitcode.com)

* `POST /api/v5/repos/:owner/:repo/releases`
  (<https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases>):
  body `tag_name`, `name`, `body` required; `target_commitish` optional (branch or
  commit SHA, used when the tag does not exist); `release_status` `pre` or
  `latest`; the page documents the token only as the `access_token` query
  parameter. Response lists `assets[]` with `name`, `type`, `browser_download_url`.
* `GET /api/v5/repos/:owner/:repo/releases/:tag/upload_url?file_name=`
  (<https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url>):
  returns `url` (use with PUT) and `headers` with exactly `x-obs-meta-project-id`,
  `x-obs-acl`, `x-obs-callback`, `Content-Type`. The code forwards only `x-obs-*`
  and `Content-Type` from that object.
* Not re-read on that date: attachment download endpoint
  `GET .../releases/:tag/attach_files/:file_name/download`; attachment delete
  (never used here); rate limit 400 per minute and 4000 per hour.

## Not documented anywhere I could find

Release-write token scopes and whether a fine-grained token exists;
`Authorization: Bearer` on the release endpoints; whether `api.atomgit.com` is
equivalent to `api.gitcode.com`; attachment size and count limits; the lifetime
of upload URLs; what `x-obs-callback` does exactly and how long the registration
can take; whether `release_status: latest` demotes another release.

## Design notes that follow from the above

* The token is sent as the documented `access_token` query parameter; API calls
  never follow redirects, so it cannot be forwarded to another host. Header
  authentication is an open experiment (see README, "Not verified").
* The file-name policy lives in the host config, not in Action inputs, because it
  is a security decision of the host owner rather than of the workflow author.
