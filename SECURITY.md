# Security Policy

`collab` handles vault contents, encryption keys, hosted credentials, and a
self-hosted multi-user server. Vulnerability reports are welcome and taken
seriously.

## Supported versions

Only the latest release is supported. Fixes are published as a new release
rather than backported.

| Version | Supported |
| ------- | --------- |
| 0.7.x   | Yes       |
| < 0.7   | No        |

Server deployments should pin an exact image tag in `.env` and upgrade
deliberately; see [Deployment topology and upgrade compatibility](./docs/server/deployment-topology.md).

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Public issues disclose
the flaw to everyone running an unpatched server before a fix exists.

Report privately, in this order of preference:

1. **GitHub private vulnerability reporting** (preferred) — open a report at
   <https://github.com/Azazel55605/collab/security/advisories/new>. This keeps
   the report, the discussion, and the resulting advisory in one place.
2. **Direct contact with the maintainer** via the contact details on
   [the maintainer's GitHub profile](https://github.com/Azazel55605), if the
   page above is unavailable to you.

Please include as much of the following as you can:

- Affected component: desktop app, Android app, collaboration server, or admin
  web interface.
- Affected version, plus the server image tag and deployment topology if the
  server is involved.
- A description of the issue and the impact you believe it has.
- Step-by-step reproduction, ideally with a minimal proof of concept.
- Any mitigation you have already identified.

Please redact secrets — tokens, passwords, vault contents — from anything you
attach.

## What to expect

- **Acknowledgement** of your report within **5 working days**.
- An **initial assessment** — severity and intended plan — within
  **10 working days**.
- For **high and critical** issues, a fix and coordinated disclosure are aimed
  for within **30 days**.
- Lower-severity issues are scheduled into the next regular release.

Server-affecting fixes ship as a new release and a new published image tag;
there are no backports to older lines. Please allow the fix to be released
before disclosing publicly.

## Scope

In scope:

- The collaboration server, its REST and WebSocket protocol, and CalDAV access
- Authentication, sessions, invitations, app passwords, and permission checks
- Vault encryption and credential storage on desktop and Android
- The admin web interface
- Hosted vault content isolation between users and vaults

Out of scope — these are documented, deliberate behaviors rather than defects:

- **Allow untrusted TLS certificates**: an explicit opt-in in Server Settings
  for private servers using self-signed certificates. Certificates are verified
  by default. See [TLS, security headers, and secret rotation](./docs/server/tls-and-secrets.md).
- **Accepted dependency advisories**: every advisory that cannot yet be fixed by
  an upgrade is recorded with a reachability argument and a removal condition in
  [`.cargo/audit.toml`](./.cargo/audit.toml) and
  [Security advisory tracking](./docs/build/security-advisories.md). Reports
  about an already-listed advisory should say what makes it reachable in
  practice.
- Findings that require an attacker to already have filesystem access to a
  user's unlocked vault or the server host.
- Vulnerabilities in upstream dependencies as such — report those upstream, and
  mention them here if `collab` is affected in a way the upstream advisory does
  not already cover.
- Social engineering against maintainers or users.

## Safe harbor

Good-faith security research is welcome. No legal action will be pursued against
researchers who:

- Make a reasonable effort to avoid privacy violations, data destruction, and
  disruption of other people's servers.
- Test only against their own installation or an installation they are
  authorized to test.
- Give a reasonable opportunity to address the issue before disclosing it
  publicly.
- Do not exploit the issue beyond what is necessary to demonstrate it.

## Hardening and operations

Deployment, secret rotation, backup, and upgrade procedures relevant to a secure
installation:

- [Security, operations, and compatibility](./docs/server/security-operations.md)
- [TLS, security headers, and secret rotation](./docs/server/tls-and-secrets.md)
- [Release security review](./docs/server/security-review.md)
- [Dependency and container vulnerability scanning](./docs/server/vulnerability-scanning.md)
- [Upgrade and failed-migration recovery](./docs/server/upgrade-recovery.md)

Dependencies and server images are scanned in CI by the `Security Scan`
workflow (`cargo audit`, `pnpm audit`, and Trivy).
