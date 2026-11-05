# Cloud Pi V1 — container release and safe cutover

**Target:** existing Mira organization Ubuntu host; a *separate* Compose project
with one Pi process, two IM channels, one scheduler and one loopback admin API.
This does not migrate, restart or reconfigure Cloud Auth, New API or Caddy.

## Build on CI, not on the 1.6 GiB server

Run the manually dispatched `Cloud Pi Container Image` workflow on a reviewed
`dev` commit. It runs the deterministic test suite, builds a Linux/amd64 image
and creates a prerelease with a Docker archive and SHA-256 checksum. No real
credentials or model calls are needed. The public prerelease contains **code
only**; `/run/secrets/agent.env` and all runtime data are absent from the image.

Use the full release commit SHA as the release tag `cloud-pi-<12-char-sha>`.
The loaded image tag is `mira-cloud-pi:<full-commit-sha>`.
Compare the SHA and artifact checksum before loading. Avoid building on this
small shared production server.

## Direct GitHub Actions production deployment (no Infra dependency)

Cloud Pi owns its deployment workflow: `.github/workflows/deploy-direct.yml`.
The workflow is manually dispatched **on Cloud Pi's `prod` branch**, using
a full immutable release commit SHA (for example, a reviewed `dev` image
already built and published by `release-image.yml`). It requires that
commit to be an ancestor of `prod`, enforcing promotion first through
`dev → test → prod`.

The job uses these **organization-level GitHub Actions secrets**, if the
Cloud Pi repository has been granted access: `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_PASSWORD`, and
`DEPLOY_KNOWN_HOSTS`. It checks the five names for nonempty values before
contacting the server; no secret values are committed or logged. The remote
SSH host key is pinned, never automatically accepted.

The job verifies the release archive SHA-256, uploads only the image,
the matching Compose file, its commit SHA, and Cloud Pi's own
`deploy/ci-release.sh` script. Remote preparation preserves persistent
state and previous configuration; the script loads the image before
cutover, backs up state, restarts only the Cloud Pi Compose project, probes
loopback Agent health plus the owner gateway's unauthenticated 401, and
attempts to restore the last loaded image if post-release health fails.
Cloud Pi does **not** need `mira-cloud-infra`, a local DC session or an
external deployment variable to run this workflow.

**Limit:** HTTP/container health does not establish real Feishu group @,
WeCom delivery, private Guanlan delegation, or model behavior. Require a
separate real IM @ acceptance after production deployment.

## First-time target preparation

1. Provision a private configuration file from `deploy/agent.env.example`
   **outside the repository**, readable only by the container's numeric
   UID 1000. Write real bot/model credentials only there, on the host. The
   compose file must not contain secret values. Do not print its content to logs.
2. Provision a persistent directory (UID 1000) for state, run records and any
   future Guanlan token file. Back it up outside the container before upgrades.
3. Download the release archive and matching .sha256, verify with
   `sha256sum -c`, then `docker load -i` the archive.
4. Set the following **nonsecret** host-side environment variables for Compose:

   ```sh
   export CLOUD_PI_IMAGE=mira-cloud-pi:<full-release-commit-sha>
   export CLOUD_PI_DATA_DIR=/opt/cloud-pi/data
   export CLOUD_PI_SECRETS_FILE=/opt/cloud-pi/secrets/agent.env
   docker compose -f deploy/compose.yaml config --quiet
   ```

5. **Stop the old WeCom bot process before starting Cloud Pi on the server.**
   One WeCom bot ID must have only one concurrent WebSocket owner; Feishu must
   likewise not be double-owned during the cutover.
6. Run `docker compose -f deploy/compose.yaml up -d --no-build`.
   Inspect `docker ps --filter name=mira-cloud-pi`, container health,
   `curl --fail http://127.0.0.1:8787/v1/health` and sanitized service logs.
   Confirm BOTH channel started events and no repeated reconnect / restart loop.
   A 200 health response alone **does not** prove bot authentication, model,
   Guanlan, or message delivery.
7. Observe real chat after cutover in the normal course of using the bot. Do
   not repeat expensive full end-to-end research by default.

## Guanlan is an independent security gate

The current Pi MCP adapter accepts a **300-second Cloud Auth Guanlan JWT** via
`GUANLAN_MCP_TOKEN_FILE`, reads it at request time, and fails closed after
expiry. This deployment package does not magically issue or renew that JWT.
Do **not** use a long-lived Cloud Session, another audience's token, a fake
JWT or an owner token copied into a public chat.

Until a revocable Cloud Auth **single-tenant background delegation broker**
is implemented and verified, Guanlan cannot be claimed unattended-ready.
Authorized background research and owner-private tool access require separate
permissions. Regular IM chat does not inherit owner-private Guanlan access.

## Security and operations

- The container uses host networking **only** because existing New API
  listens on host `127.0.0.1:3000`. Cloud Pi's admin API still binds only
  `127.0.0.1:8787`. Never proxy `8787` from Caddy.
- `/tmp` is ephemeral; `/var/lib/cloud-pi` is persistent and separate from
  both existing service volumes. Root filesystem is read-only; the process
  runs as UID 1000 without Linux capabilities.
- Start with 640 MiB RAM / 1.5 CPU / 256 MiB Node old space; check RSS,
  host `MemAvailable`, swap, failures and run size during normal usage.
- `docker compose -f deploy/compose.yaml down` stops **only Cloud Pi**,
  not the other services. Do not add `-v`; volumes contain task evidence.
- A rollback loads the prior image and changes only
  `CLOUD_PI_IMAGE`, then `up -d --no-build`. Keep prior image and data backup.
- No API key, Cloud Session, token contents or full chat IDs in logs/PRs.
- The Cloud Auth portal is a **later management facade**. Do not expose
  the loopback management API as a shortcut to get a dashboard working.

## Owner-only Cloud Auth portal bridge

A second *small HTTP gateway* container runs on host loopback 127.0.0.1:8793.
It is **not** another Agent runtime. Every request verifies a live Cloud Auth
Session at host 127.0.0.1:8788 and compares the returned account id to the
explicit `CLOUD_AGENT_OWNER_ACCOUNT_ID`. Rejected or offline auth fails
closed. It never forwards the Cloud Session bearer to Cloud Pi.

Only this gateway may be exposed by Caddy at the existing Cloud Auth origin
under `/agent-control/*`. A same-origin request from the Cloud Auth Portal
must supply its own Cloud Session bearer header. Writes require an exact
Origin match and the gateway forwards only enumerated Agent API routes.
The internal unauthenticated port 8787 stays strictly loopback and must
**never** be proxied directly.

For the existing `cloud-auth.tomzlab.cn` Caddy site, place this handler
**before** the SPA fallback (replace no other site handler):

```caddy
handle_path /agent-control/* {
  header Cache-Control "no-store"
  header X-Frame-Options "DENY"
  header X-Content-Type-Options "nosniff"
  reverse_proxy 127.0.0.1:8793
}
```

Use `caddy validate --config /etc/caddy/Caddyfile` before reloading.
401 when unauthenticated, 403 for another Cloud Account or wrong mutation
Origin, and 503 when Cloud Auth/Agent is down are correct results; 200 alone
is not proof of a whole research job.
