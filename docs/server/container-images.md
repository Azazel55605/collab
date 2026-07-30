# Multi-Architecture Server Images

The collaboration server image supports Linux AMD64 and ARM64 hosts. The same
`Dockerfile.server` is used for both architectures; its Rust, Node.js, and
PostgreSQL base images provide architecture-matched layers.

## Local Build

Build both architectures into one OCI archive:

```bash
pnpm server:image:build
```

The default output is `dist-builds/collab-server-multiarch.tar`. An OCI archive
contains a multi-platform image index and is intended for inspection, transfer,
or later registry publication. Docker cannot load a multi-platform archive into
its classic local image store as one runnable image.

Override the image name, platforms, or output location when needed:

```bash
COLLAB_IMAGE_NAME=example/collab-server:test \
COLLAB_IMAGE_PLATFORMS=linux/amd64,linux/arm64 \
COLLAB_IMAGE_OUTPUT=/tmp/collab-server.tar \
pnpm server:image:build
```

For a quick image that runs on the current machine, continue using Compose:

```bash
docker compose build collab-server
```

The server Dockerfile uses the Docker/BuildKit bundled frontend, so a cached
local build does not first need to pull a separate `docker/dockerfile` image.
Fresh builds still need working registry DNS to pull the Rust, Node.js, and
PostgreSQL base images. A `Temporary failure in name resolution` for
`registry-1.docker.io` is a host or Docker-daemon DNS problem rather than a
Dockerfile failure; verify it with `docker pull rust:1.96-bookworm` before
retrying the Compose build.

Cargo downloads inside the image use the sparse registry over non-multiplexed
HTTP, extended network retries, and persistent BuildKit registry caches. This
avoids restarting every crate download after a transient VPN/proxy TLS failure.
TLS certificate verification remains enabled. If repeated builds still report
`SSL_read`, `bad record mac`, or connection resets, test once without the VPN or
correct the VPN MTU/proxy path; those errors occur below Cargo and cannot be
fully repaired by the Dockerfile.

Buildx requires QEMU/binfmt support when the host is not native to every target
architecture. Docker Desktop normally configures this automatically. On Linux,
install the Buildx plugin and register the required binfmt handlers before a
cross-architecture build.

## CI Artifacts

Manual runs of `.github/workflows/server-container-build.yml` build
`linux/amd64` and `linux/arm64` independently. Each matrix job uploads a
short-lived OCI archive:

- `collab-server-amd64`
- `collab-server-arm64`

Keeping architecture builds separate gives each architecture an independent
BuildKit cache and makes failures easy to identify. Manual builds do not log in
to a registry or publish an image. Automatic runs occur only for version tags
and publish the release image described below.

AMD64 runs on `ubuntu-latest`; ARM64 runs on GitHub's native
`ubuntu-24.04-arm` runner. Both jobs use plain BuildKit progress and run in
parallel, avoiding the much slower and occasionally quiet QEMU compilation path.

## Published Releases

Pushing a server version tag such as `server-v0.4.8` publishes a multi-platform image
to GitHub Container Registry:

```text
ghcr.io/azazel55605/collab-server:0.4.8
ghcr.io/azazel55605/collab-server:0.4
ghcr.io/azazel55605/collab-server:latest
```

The exact version tag identifies one release. The minor and `latest` tags are
operator conveniences and can move to a newer compatible release. Production
deployments should pin the exact version, or an image digest when immutable
identity is required.

Before publishing, the workflow verifies that the Git tag matches the server
version in `versions.json` and the Cargo workspace version synced from it.
Native AMD64 and ARM64 jobs each build once and push an untagged image by digest,
then scan that digest for high/critical known vulnerabilities. Only after both
jobs pass does a small final job assign the release tags to a combined manifest.
Failed scans therefore leave no deployable release tag. Each platform image
includes OCI source/version metadata, a BuildKit provenance attestation, and an
SBOM.

Run the version gate locally before creating a release tag:

```bash
pnpm server:release:check server-v0.4.8
```

Deploy a published image with the normal Compose stack:

```bash
COLLAB_SERVER_IMAGE=ghcr.io/azazel55605/collab-server:0.4.8 \
docker compose up -d --no-build
```

The GHCR package may need to be made public once in the repository/package
settings. Private installations can instead authenticate Docker to `ghcr.io`.
