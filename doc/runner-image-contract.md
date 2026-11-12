# Runner image contract

`ghcr.io/paperclipai/paperclip-runner` is the Runner, built once and published
as a plain file tree. It has no entrypoint and no operating system. Other image
builds copy paths out of it instead of compiling the Runner again.

Consumers pull the image without credentials and without a checkout of this
repository, so the package must be public. GitHub creates the package private
on the first publication. A maintainer must make it public once, in the
package settings, after that first publication.

Nothing in this repository consumes the image yet. The application image
still builds its own Runner in the `runner-build`, `build` and
`runner-provider-pack` stages.

## Tags and identity

The image is published under one tag per distinct set of inputs:

```
ghcr.io/paperclipai/paperclip-runner:inputs-<digest>
```

`<digest>` is 64 hexadecimal characters. `scripts/runner-image-identity.mjs`
computes it. It covers:

- the context tree: every file the recipe stages can copy from the build
  context, by path, executable bit and content, and every symbolic link by its
  target. The paths are `packages/paperclip-runner`,
  `packages/paperclip-eval-kernel`, `patches`, the root `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`,
  `scripts/create-provider-pack-archive.mjs`, `scripts/link-plugin-dev-sdk.mjs`,
  the two `scripts/runner-image-*.mjs` scripts the build runs, and
  `packages/shared/src/provider-failure.generated.ts`. Nothing under them is
  skipped;
- the recipe: the text of every `Dockerfile` stage the `runner-artifacts`
  target is built from, and the syntax directive;
- every base image those stages use. Each is pinned by digest. The Node base
  is part of the identity because the provider pack copies that Node binary as
  its own interpreter. The Rust compiler is the one
  `packages/paperclip-runner/rust-toolchain.toml` names, installed by a
  checksum-pinned `rustup`;
- the Runner build-inputs digest that
  `packages/paperclip-runner/scripts/build-inputs.mjs` computes
  (`paperclip.runner-build-inputs.v2`). The context tree already covers those
  files. The digest is kept because the Runner's build stamp records it;
- the two platforms.

It does not cover:

- the source revision. A commit that changes none of the above reuses the
  image an earlier commit built;
- the text of `.dockerignore`. Its rules only decide which files the build
  receives, and the context tree is hashed from the files the build received.
  A rule that removes or adds one of those files changes the digest; any other
  edit does not;
- the Dockerfile frontend image. `# syntax=docker/dockerfile:1.20` is a tag,
  not a digest, and the line is shared with the application image. Its text is
  in the recipe, so a change of the tag changes the digest; a new release
  under the same tag does not.

The target takes no provider selection argument, so one identity is always one
set of providers.

The script refuses a recipe it cannot account for, and the image build fails
with it: a base image that is not pinned by digest, a `COPY` from the build
context of a path outside the list above, a wildcard in such a `COPY`, `ADD`,
a heredoc, a mount of the build context, a cache or secret mount, a flag on
`FROM`, and a global `ARG` continued over several lines.

The digest is computed inside the build, from the files the build context
supplies after `.dockerignore`. On `master` it is therefore a function of the
commit alone: anyone can compute it again from that commit.

```sh
docker buildx build --target runner-artifacts-identity --output type=local,dest=/tmp/identity .
jq -r .digest /tmp/identity/runner-image-identity.json
```

The same script run in a checkout prints another digest, because there it
also reads the files `.dockerignore` drops and anything a local build left
under those paths.

### The tag is create-only by convention

The registry does not stop a tag from being moved. The workflow is what never
moves an `inputs-` tag: it builds only when no image has the digest, and it
looks again, strictly, before it writes the tag. A consumer is protected by
two things, not by the tag: it pins the index digest, and it verifies the
attestation with this workflow as the signer and `refs/heads/master` as the
source ref (see "Consuming the image").

`candidate-<digest>` tags are internal to the publish job and may be
overwritten. Do not consume them.

### The lockfile

On `master` the image is built from the committed `pnpm-lock.yaml`, with
`--frozen-lockfile`. Nothing resolves dependencies. That file is the one the
repository's lockfile refresh (`.github/workflows/refresh-lockfile.yml`)
commits, after it holds new package versions until they are old enough.

A contributor cannot edit the lockfile, so a commit that changes the Runner's
dependencies lands with a lockfile that is behind it, until the refresh
merges. The Runner build reads three manifests: the root one,
`packages/paperclip-runner` and `packages/paperclip-eval-kernel`. The
consequence:

- **A commit whose lockfile is behind those manifests has no published Runner
  image.** The workflow detects it before it builds, writes a notice, and
  ends green without building or publishing. The commit that merges the
  lockfile refresh publishes the image.
- A manifest elsewhere in the workspace that is ahead of the lockfile changes
  nothing: it is not in the Runner's build context.
- Every lockfile refresh changes the digest, because the whole lockfile is in
  the context tree.

Pull requests and manual runs resolve the lockfile first, so a pull request
that changes the Runner's dependencies is still built and checked. Those runs
never publish, and the lockfile they resolve is not the one `master` will
publish from.

A local build of a commit whose lockfile is behind fails at the install step.
For a local build only, run
`pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile` first.

The lockfile the image was installed from is in the image at
`/pnpm-lock.yaml`.

## Platforms

The tag is one multi-platform index with exactly two images, `linux/amd64` and
`linux/arm64`. Each is built on a runner of its own architecture. Consumers
pin the index digest; the builder selects the platform. `runner-image.json`
describes one platform.

## Layout

Every path a consumer may copy. `RUNNER_IMAGE_PATHS` in
`scripts/runner-image-layout.mjs` is the same list, and `runner-image.json`
repeats it under `paths`.

| Path | Content |
| --- | --- |
| `/runner-image.json` | Identity and description of this image. See below. |
| `/paperclip-runnerd` | The daemon. A stripped release binary, mode `0755`. |
| `/provider-pack/` | The remote provider pack, with `provider-pack.json`. Readable by every user. |
| `/provider-pack.archive.json` | Receipt of the pack's transport archives. |
| `/provider-pack.archives/` | The transport archives the receipt lists. |
| `/runner-package/` | Files of `packages/paperclip-runner`, at their paths inside that package. |
| `/runner-package/package.json` | The Runner package manifest. |
| `/runner-package/dist/` | The Runner's complete build output. `dist/bin/paperclip-runnerd` is the same file as `/paperclip-runnerd`. |
| `/runner-package/node_modules/.cache/paperclip-runner-build-inputs.json` | The build stamp the Runner's build recorded for that output. |
| `/runner-package/scripts/provision-grok.mjs` | Provisions the native Grok executable. It reads `platforms.json` by relative path. |
| `/runner-package/src/providers/grok/platforms.json` | The Grok release pins. |
| `/runner-package/src/live/runnerd-codex-transport.ts` | The transport source, as a contract file. It defines `RUNNER_CLIENT_VERSION`. |
| `/bundles/runnerd-codex-transport.mjs` | `dist/live/runnerd-codex-transport.js` from the pack as one ECMAScript module. It imports without `node_modules`. |
| `/pnpm-lock.yaml` | The lockfile the image was installed from. The pack's `productionLock` artifact is the same file. |

Every file is readable by every user, and every directory can be listed by
every user. The build grants this in the layer that writes the files, so a
consumer's `COPY` keeps the modes and needs no `chmod`.

A consumer that vendors the Runner can lay `/runner-package/` over
`packages/paperclip-runner`. `server/scripts/prepare-runner-vendor.mjs` then
finds the build stamp and reuses `dist`, on one condition: the consumer's own
Runner build-inputs digest equals the one in the stamp, on the same platform.
The image computes that digest in its `.dockerignore`-filtered build context.
A consumer that computes it in the same kind of context, from the same
commit and lockfile, gets the same value. One that computes it in a checkout,
where the files `.dockerignore` drops are present, gets another value and
rebuilds the Runner.

### `runner-image.json`

```json
{
  "schema": "paperclip.runner-image.v1",
  "inputsDigest": { "schema": "paperclip.runner-image-inputs.v1", "digest": "<64 hex>" },
  "buildInputsDigest": { "schema": "paperclip.runner-build-inputs.v2", "digest": "<64 hex>" },
  "sourceRevision": "<40 hex>",
  "platform": { "os": "linux", "architecture": "amd64" },
  "libc": { "family": "glibc", "baseline": "debian-bookworm", "buildVersion": "2.36", "runnerdRequires": "2.34" },
  "providerPack": { "digest": "sha256:<64 hex>", "target": { "platform": "linux", "architecture": "x64" } },
  "paths": { "runnerd": "paperclip-runnerd", "...": "..." },
  "sha256": { "runnerd": "sha256:<64 hex>", "...": "..." }
}
```

- `inputsDigest.digest` is the `<digest>` of the tag.
- `buildInputsDigest.digest` is the digest in the Runner build stamp.
- `platform.architecture` uses the image names `amd64` and `arm64`. The pack's
  `target.architecture` uses the Node names `x64` and `arm64`.
- `sha256` has the digest of every single file in `paths`.

The pack manifest `provider-pack.json` records the image identity in
`payload.runnerInputsDigest`. No check reads that field.

### Source revision

`sourceRevision`, and `payload.runnerSourceRevision` in the pack, name the
commit whose workflow run published the image. When several commits have the
same inputs, that is the commit whose publish job wrote the tag first, which
is not always the oldest of them. Later commits with the same inputs reuse
the image and keep that revision. The index carries the same value in the
annotation `org.opencontainers.image.revision`, and the inputs digest in
`io.paperclip.runner.inputs-digest`.

`runnerSourceRevision` is therefore not the commit of the application that
uses the pack. Code that treats it as that commit must change before it
consumes this image. Today these places compare or look up by it:

- `server/src/services/native-runtime/remote-pi-companion.ts` requires it to
  equal the companion's source revision;
- `server/src/services/native-runtime/native-provider-artifacts.ts` requires
  the admission receipt to carry the same value;
- `server/src/services/native-runtime/retained-provider-pack-oci.ts` fetches
  the application image tagged `sha-<runnerSourceRevision>` to find a pack.

Pack reuse itself does not depend on it: that goes by the compatibility
revision and the contract digest.

### libc baseline

The daemon is compiled on Debian bookworm, the oldest glibc a consumer runs.
`libc.buildVersion` is that glibc, and `libc.runnerdRequires` is the newest
glibc symbol version the binary needs. The pack's Node is the official Node
binary of the pinned base image.

Each build runs `paperclip-runnerd --build-metadata` on every base a consumer
puts the daemon on: `debian:bookworm-slim`, `debian:trixie-slim`,
`node:24-trixie-slim`, `python:3.13-slim-trixie` and `daytonaio/sandbox:0.8.0`.
`docker/runner-image/Dockerfile.smoke` holds the list. Add a base there before
a consumer starts to use it.

## What the build checks

The image build fails, and nothing is published, unless:

- the install with the frozen lockfile succeeds;
- the Runner's build records its stamp, for the inputs the identity names;
- the pack is whole: every artifact in `provider-pack.json` is present with
  its digest, the `dist` tree and every provider asset tree match the tree
  digests the manifest records, the manifest digest matches its payload, and
  the pack names this image's revision, inputs digest and platform;
- every transport archive, and every file a transport archive carries,
  matches the receipt;
- every documented path exists and matches `runner-image.json`;
- none of those paths resolves outside the tree, by `..` or through a
  symbolic link;
- the daemon runs on every base in the smoke matrix.

`node scripts/runner-image-layout.mjs check <tree>` runs all but the first
and the last of these on a built tree.

The build runs the steps of the Runner package's `build` script that write
output: `build:typescript` and `build:binary`, between the two
`record-build-inputs.mjs` steps. It does not run the script's other steps.
Those are drift checks on committed files, they need files outside the
Runner's inputs, and repository CI runs them on every pull request.

A build without `PAPERCLIP_RUNNER_SOURCE_REVISION` or `PAPERCLIP_BUILD_COMMIT`
has the daemon and the Runner build but no pack, no archives and no bundle,
and `sourceRevision` is `null`. Such a tree is for local use. The workflow
never publishes one.

## Consuming the image

Pin the index by digest and verify its provenance before you build from it.
The tag is only a way to find the digest.

```sh
gh attestation verify oci://ghcr.io/paperclipai/paperclip-runner@sha256:<digest> \
  --repo paperclipai/paperclip \
  --signer-workflow paperclipai/paperclip/.github/workflows/runner-image.yml \
  --source-ref refs/heads/master \
  --deny-self-hosted-runners
```

Only a `master` push in `paperclipai/paperclip` can publish and sign. The
signer is `.github/workflows/runner-image.yml`, not the application image's
`docker.yml`. An image without this attestation is not a Runner image,
whatever its tag says.

Read the image only with `COPY --from`:

```dockerfile
FROM ghcr.io/paperclipai/paperclip-runner@sha256:<digest> AS runner-artifacts
FROM debian:trixie-slim
COPY --from=runner-artifacts /paperclip-runnerd /usr/local/bin/paperclip-runnerd
COPY --from=runner-artifacts /provider-pack /opt/paperclip-runner/provider-pack
```

A Dockerfile with a `runner-artifacts` stage of its own, as in this
repository, can take the published image in its place. The stage is then not
built:

```sh
docker buildx build \
  --build-context runner-artifacts=docker-image://ghcr.io/paperclipai/paperclip-runner@sha256:<digest> .
```

## Building and checking locally

```sh
docker buildx build --target runner-artifacts \
  --build-arg PAPERCLIP_RUNNER_SOURCE_REVISION="$(git rev-parse HEAD)" \
  --output type=local,dest=/tmp/runner-image .
node scripts/runner-image-layout.mjs check /tmp/runner-image
docker buildx build --file docker/runner-image/Dockerfile.smoke \
  --build-context runner-artifacts=/tmp/runner-image docker/runner-image
```

The tests are `server/src/__tests__/runner-image-identity.test.ts`,
`runner-image-layout.test.ts` and `runner-image-publish.test.ts`.

## Publication

`.github/workflows/runner-image.yml` runs on every `master` push, on pull
requests that change an input or the pipeline, and on manual dispatch.

On a `master` push it checks the committed lockfile against the Runner's
manifests, computes the identity, and stops when the image exists. Each build
leg, and the publish job twice, ask the registry again before they do their
work, so a run that another run overtook builds and pushes as little as it
can. Two runs that start before either has published can still both build;
only one of them writes the tag.

A pull request and a manual run always build and check, also when the image
exists, and publish nothing.

The build legs cannot write to the registry on any event and use no registry
build cache. The install runs dependency lifecycle scripts; the only token in
a build leg can read packages, and only the step that asks the registry
receives it. Each leg exports the image as an archive after its checks pass.
On a `master` push, a separate job pushes those archives by digest without
re-encoding them, joins them under a candidate tag, attests the index digest,
and only then writes the `inputs-<digest>` tag.
