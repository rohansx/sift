# Releasing

Nothing has been published yet. `.github/workflows/release.yml` will publish on
a `v*` tag, and it is deliberately the *only* thing that publishes — a local
`npm publish` cannot produce provenance, so an artifact from a laptop is not
the same artifact.

## Blocking, before the first publish

These are decisions, not steps. Each one is a thing only you can answer.

**1. Settle the npm name.** `package.json` says `@siftlabs/sift` and the README
marks it a placeholder. `npm view @siftlabs/sift` is a 404, and it is not
established anywhere that this project owns the `@siftlabs` org. The bare name
`sift` is taken (v17.1.3), so that is not the fallback. Pick one:

- claim `@siftlabs` on npm, or
- move to a scope you already own (`@yourname/sift`), or
- find a free unscoped name.

Then change it in three places, because nothing checks them against each other:
`package.json` `name`, the README's `npm install -g` line (and drop the
"placeholder scope" note), and the quickstart in `docs/OVERVIEW.md` if it
repeats the install command. The workflow publishes whatever `package.json`
says and will not warn you that the README disagrees.

**2. Set the `NPM_TOKEN` secret.** An npm **automation** token — a
publish-scoped classic token or a granular token with write access to the
package — added as an Actions repository secret named `NPM_TOKEN`. Not a
personal token with 2FA prompts on publish: CI has nobody to prompt.

**3. Confirm the repo is public.** npm provenance is signed against the GitHub
Actions OIDC identity and the attestation is only issued for public
repositories. `npm publish --provenance` from a private repo fails; drop the
flag or make the repo public, and prefer the second.

**4. Decide 0.1.0 is really 0.1.0.** The first publish burns the version
number forever — npm will not let you re-publish it, and unpublish is a
24-hour window and a bad look. Run the quickstart end to end against the
packed tarball first (see below).

## Cutting a release

```bash
# 1. version + changelog agree
npm version 0.1.0 --no-git-tag-version     # edits package.json
$EDITOR CHANGELOG.md                       # "unreleased" -> the date

# 2. prove it locally
npm run check                              # typecheck + full suite
npm pack                                   # inspect the tarball contents

# 3. tag; the workflow does the rest
git commit -am "release: v0.1.0"
git tag v0.1.0
git push origin main --follow-tags
```

The workflow re-runs `npm run check` on the tagged commit rather than trusting
the branch build, because `ci.yml` is filtered to `branches: ["**"]` and a tag
push does not match it — without that step a tag would publish through no gate
at all. It also refuses to publish when the tag and `package.json` disagree,
which is the failure that otherwise surfaces as "you published 0.1.0 twice"
long after the tag went out.

## What ships

`files` in `package.json` is an allowlist: `dist`, `README.md`, `LICENSE`, plus
`package.json`, which npm always includes. No `src`, no `test`, no `.github`.
`npm pack --dry-run` prints the manifest — read it, do not assume it.

`dist/cli.js` is the `bin` target and carries a `#!/usr/bin/env node` shebang,
which `tsc` preserves. The build then chmods it to 0755. npm's own bin-linking
would do that on install anyway, so this is not what makes `npm i -g` work — it
makes the *tarball* correct for anyone who unpacks it and runs the binary
without an installer in the path.
