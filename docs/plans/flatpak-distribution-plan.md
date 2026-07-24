# Flatpak Distribution Plan

This document is a later-work plan for shipping `collab` as a Flatpak.

It covers two distribution paths:

- host a self-managed Flatpak repository
- submit the app to Flathub

The current repository state supports local Flatpak builds and local bundle testing. It does not yet represent a Flathub-ready package.

## Current State

What is already true:

- the app can be built and launched as a Flatpak
- Flatpak builds disable the in-app updater
- the in-repo manifest and scripts are good enough for local testing and CI artifacts

What is not done yet:

- no public hosted Flatpak repository
- no `.flatpakrepo` or `.flatpakref` distribution flow
- no Flathub submission repo or Flathub review work
- no packaging pass focused on least-privilege sandbox permissions
- build still depends on live dependency resolution during packaging, which is acceptable for local iteration but not for Flathub

## Decision Summary

Short-term easiest path:

- host a self-managed Flatpak repository

Best long-term public Linux distribution path:

- publish on Flathub

Recommended sequence:

1. keep the current local Flatpak flow for testing
2. if Linux users need Flatpak soon, stand up a self-hosted Flatpak repository first
3. tighten permissions, remove build-time network dependency, and prepare a Flathub-ready manifest
4. submit to Flathub once the package is clean enough to review

## Option A: Self-Hosted Flatpak Repository

### Why choose this

This is the fastest route to making Flatpak installs available without waiting on external review.

Benefits:

- no review queue
- no Flathub policy gate
- full control over release timing
- works well for early adopters and direct downloads from the project site or GitHub

Costs:

- users must add a custom repository
- lower trust and discoverability than Flathub
- update infrastructure, signing, and hosting become project responsibilities

### Work Plan

#### Phase 1: Repository Infrastructure

Goals:

- produce a hosted Flatpak repo in addition to a standalone `.flatpak` bundle
- sign the repo with a dedicated GPG key
- provide a user-friendly install entry point

Tasks:

1. choose hosting
2. create a Flatpak signing key used only for the repository
3. update build automation to export a repository suitable for publishing
4. generate and publish:
   - repository contents
   - a `.flatpakrepo` file
   - optionally a `.flatpakref` file
5. document install and update commands

Reasonable hosting options:

- GitHub Pages for static hosting
- a normal web server or VPS
- object storage plus CDN if downloads grow

#### Phase 2: Release Flow

Goals:

- make releases repeatable
- keep artifacts aligned with app versions

Tasks:

1. decide whether releases are built in CI or locally
2. on each release:
   - build the Flatpak
   - export/update the repo
   - sign the repo metadata
   - publish updated repo contents
3. publish install instructions in the README or website

Suggested release shape:

- keep standalone `.flatpak` bundles for direct/manual installs
- also publish the repo for proper `flatpak update` support

#### Phase 3: Permission Cleanup

Goals:

- stop treating broad developer test permissions as production requirements
- verify what the app actually needs at runtime

Tasks:

1. test the app without extra Flatseal overrides
2. reduce runtime permissions in the manifest where possible
3. verify these user flows:
   - launch app
   - open existing vault
   - create vault
   - export vault
   - open recent vault
   - collaboration metadata reads/writes in `.collab/`

Likely review target:

- keep only the minimum filesystem and desktop integration permissions needed for the app model

### When this path is the right choice

Use this path when:

- you want distribution soon
- you are fine with a smaller Linux audience at first
- you do not want to stop and do Flathub cleanup yet

## Option B: Flathub

### Why choose this

This is the better public distribution endpoint if `collab` is intended for broad Linux usage.

Benefits:

- much easier installs for users
- better discoverability in software centers
- centralized update flow
- stronger trust signal than a custom repo

Costs:

- review and iteration with Flathub maintainers
- stricter packaging expectations
- more up-front cleanup work before submission

### Main Gaps To Close First

The current package should be treated as not Flathub-ready yet.

Known gaps:

- build relies on live dependency downloads during packaging
- runtime sandbox permissions have not been minimized and validated as a production set
- packaging and metadata have only been tested in a local-build workflow

### Work Plan

#### Phase 1: Make The Build Flathub-Compatible

Goals:

- produce a reproducible build that does not fetch undeclared dependencies during the Flathub build

Tasks:

1. replace network-dependent build steps with declared sources/vendor inputs
2. vendor or pin Rust dependencies in a Flathub-appropriate way
3. vendor or lock Node dependencies in a Flathub-appropriate way
4. ensure the build can run in a stricter environment than the current local builder flow
5. separate local-testing conveniences from Flathub packaging requirements if needed

Practical note:

- it is acceptable to maintain a Flathub-specific manifest or helper files if that keeps the local build workflow simple

#### Phase 2: Sandbox Review

Goals:

- justify every permission in the manifest
- avoid broad filesystem access unless the app genuinely requires it

Tasks:

1. document why each `finish-args` entry exists
2. test whether portal-based file selection can replace or reduce broad filesystem access in some flows
3. verify collaboration and vault workflows under a tighter sandbox
4. refine permissions until they match the app’s actual needs

Areas that need special thought:

- vaults are user-chosen directories rather than app-private files
- the app intentionally works with shared folders
- export flows may require different access than normal editing flows

#### Phase 3: Submission Preparation

Goals:

- make the package reviewable and maintainable

Tasks:

1. prepare final app metadata and screenshots if needed
2. verify desktop file, metainfo, icons, app ID, and release versioning
3. create the Flathub submission repository
4. submit for review
5. address reviewer feedback

### When this path is the right choice

Use this path when:

- Linux distribution quality matters more than shipping fastest
- you want software-center installs
- you are willing to do a packaging-hardening pass once instead of maintaining a custom repo forever

## Recommended Path For `collab`

If Linux Flatpak distribution becomes a near-term priority:

1. ship a self-hosted Flatpak repo first
2. keep learning from real user installs
3. use that feedback to tighten permissions and simplify the package story
4. move to Flathub after the manifest and build process are cleaner

If Linux Flatpak distribution is important but not urgent:

1. skip the self-hosted repo
2. spend the time making the package Flathub-ready
3. publish directly on Flathub

## Concrete Later TODOs

These are the next concrete tasks to pick up when Flatpak distribution work resumes:

1. Audit the current manifest in
   [flatpak/com.azazel.collab.yml](../../flatpak/com.azazel.collab.yml) for
   production permissions rather than local convenience.
2. Decide whether `collab` should support a custom hosted repo as an interim channel or go straight to Flathub.
3. If self-hosting:
   - add signing-key management notes
   - generate `.flatpakrepo` metadata
   - add CI publishing for repo contents
4. If targeting Flathub:
   - split local-build concerns from Flathub packaging concerns
   - remove build-time network dependency from the packaging flow
   - document and justify every runtime permission
5. Add end-user installation/update documentation once one public channel actually exists.

## Notes

- The current Flatpak implementation should be considered a working packaging baseline, not the final public distribution setup.
- Broad Flatseal overrides used during debugging should not be treated as required production permissions.
- The built-in updater must remain disabled for Flatpak builds because updates belong to the Flatpak distribution channel.
