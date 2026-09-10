Hey Raksh,

Wanted to share a proper look-back at what I've worked on this year, and get your input on a few things.

## Summary

Most of my work has been backend and DevOps/infra. The biggest thread has been designing and rolling out a single common CI/CD + deployment platform across our microservices, with AWS Secrets Manager replacing env files on the servers. Alongside that: responding to and root-causing production incidents, hardening security and closing data-exposure gaps, optimizing database and infra cost, building out the IoT telemetry pipeline and OEM integrations, and shipping new backend capabilities on the vehicle/fleet side. A recurring part has also been reviewing others' work and catching issues before they shipped.

## Would love your input

1. How do you see my contributions overall — anything standing out, good or otherwise?
2. Any performance insights from your side I should know?
3. What should I focus on improving?

---

## Detailed work

### Common CI/CD & deployment platform

Designed one shared deployment flow that every microservice uses the same way, for Dev and Prod both — replacing the per-service, drifting setups we had. The pipeline runs GitHub OIDC → AWS SSM → on-server deploy, so there are no static AWS keys and no SSH/PEM access anywhere in the flow. Builds run in CI and push a container image to ECR; the server pulls it and does a health-checked rollout, with an automatic rollback path if the new version doesn't come up healthy. Env and secrets moved entirely into AWS Secrets Manager — nothing sensitive lives in files on the servers anymore. Wrote a deploy playbook for the team and added Slack notifications on the pipeline. Tested the whole thing end to end — build, secret injection, rollout, health check, rollback — before onboarding anything onto it.

Then migrated services onto it one by one: GMS backend + webhook (as the initial proof-of-concept), backend-toolkit, Auth, Vehicle (main + consumers), IOT Consumers, alt-s3, Collections backend and frontend, Alert service, the Python service. Each migration also meant stripping that service's committed env files and old deploy scripts.

Currently hardening it further: a tag-based flow so a brand-new service can be brought onto the pipeline quickly, secure-file / PEM / BigQuery-JSON handling through Secrets Manager, and moving on-box builds onto CI runners to stop build-time memory pressure on small prod boxes. Along the way I also found and fixed a critical bug where Secrets Manager env changes were silently overridden by a committed env file that loaded after them — so env updates simply weren't taking effect on that service.

### Production incidents found & fixed

- Prod RDS ran out of storage and started dropping connections — traced to an unbounded history table with no cleanup policy, increased storage online with zero downtime, then fixed the root cause
- Prod database running critically hot on CPU — root-caused to large unindexed tables being scanned constantly plus a bad join; added the missing indexes and brought it back to normal, sent the team a before/after report
- A load-balanced server hit full disk from an unrotated log file — cleared it live with zero downtime, added log rotation and a runbook across all of them
- Tracked down a memory leak in a shared internal logging library crashing services on a loop — shipped a fix that's held stable, filed a detailed report to the package owner for the permanent one, and built live memory-snapshot capture (wired into the deploy script) to catch this class of issue
- Fixed GMS backend EC2 overload from running concurrent canary deploys on an undersized box, compounded by an AWS "insufficient capacity" error on restart
- Rebuilt vehicle-service's queue handling after repeated crashes — fixed the crash path, added reconnect + prefetch limits, split queue consumers into their own service, made it a reusable pattern in the shared library
- Fixed vehicle-service downtime where auto-restart wasn't working; fixed a webhook-service crash loop from a config value read as the wrong type; fixed recurring memory crashes traced to a sibling service eating the host's RAM

### Security & data protection

- Found a long-standing, silently-broken history table and traced it to a schema change months earlier; in the related PR I also flagged a data-loss bug and a disabled retry system before merge
- The user-listing API was returning every user in the system with no account scoping — locked it down, closed a stale-session gap, added proper role management endpoints
- Found and locked down an S3 bucket policy leaving KYC documents (Aadhaar/PAN/DL) publicly readable
- Caught, in a colleague's cross-service login work before rollout: prod pointing at the dev signing key, and every customer token silently escalating to admin access
- Ran a full AWS security audit (exposed databases, no MFA, no audit logging) and sent leadership a cost-tiered remediation plan — waiting on a budget decision
- Removed public RDS access, moved Redis/RDS to a private network, added IP validation + WAF checks on the customer and GMS APIs, cleared a false WAF block on a live India-based partner, and closed a temporary DB-access rule left open after an incident

### Database & cost optimization

- Switched the runaway history table to daily partitioning, then migrated both prod and dev databases onto right-sized instances with zero downtime and zero data loss
- Later downsized the DB instance again after confirming headroom, verified stable
- Built a Lambda-based partition-maintenance job (maintains a rolling buffer of future daily partitions, drops old ones once confirmed archived to S3) and an automated nightly archival flow so old data leaves Postgres but stays in S3
- Cut idle DB load: connection pooling, per-PM2-process connection limits in backend-toolkit, reduced connection counts across iot-webhooks and other services
- Reduced high-frequency alert-condition DB queries with caching/batching; excluded raw/parsed IoT entries from the main historical table; deleted an unused ECS cluster

### IoT telemetry pipeline & OEM integrations

- Built a new IoT telemetry platform from scratch (control service + decoder worker, device presence tracking, provisioning with one-time secrets), load-tested before rollout
- Moved raw CAN-bus signal decoding out of firmware into the backend — reverse-engineered the real device wire format mid-build and migrated the parser to match
- Debugged and fixed vehicle-telemetry connectivity across multiple OEM integrations — TVS, Motovolt, Bajaj, Loconav, Montra, Intellicar/Quantum, Sixsense — including an urgent new Motovolt DBC integration and the device mapping/remapping flow at the consumers
- Fixed device-onboarding gaps where new devices were silently dropped before registration (older data-format support, a device-matching fix, a fallback for unrecognized packets)
- Fixed missing cell-voltage/temperature telemetry across multiple device types after an earlier refactor, and switched long-term storage from an allowlist to a denylist so it fails safe next time
- Root-caused a month-long telemetry freeze on the Evify integration, deployed the fix and a verified backfill
- Built a chunked device log-upload pipeline (checksums, tracking dashboard) and a device command channel (immobilize / status / firmware push with acknowledgement tracking)
- Added firmware-version and motion-sensor unit decoding that devices were already sending but the pipeline wasn't surfacing

### New backend capabilities

- Fleet status / vehicle-count (running / not running / faulty) / faulty-vehicle summary APIs, and a full vehicle-faults tracking backend
- Self-serve requeue APIs so failed webhook events can be reprocessed without manual work
- Shared cross-service login in both directions, ported into the shared library so services pick it up with no code changes; plus ticket-listing APIs and role-based access that didn't exist before
- Admin API usage tracking (per-user, per-feature, with history) where there was no visibility before
- Queue-based vehicle immobilization with duplicate-request handling and full logging
- An invoices lookup API supporting both API-key and JWT auth so external partners and internal tools share one endpoint
- Driver-app support tickets with attachments, flowing into Zoho and picked up by the GMS ticket service; automated ticket routing + email notifications by type
- Vehicle-detail-page work: service-card history, GMS ticket history from Zoho, DM detail
- A live GPS feed integration for a logistics partner (Intugine/Flipkart), fixing a batch-logging gap affecting every customer integration in the process
- A reusable vehicle location-history reporting tool — delivered reports to teams on request, then proposed making it self-service instead of ad hoc

### Reliability, correctness & error handling

- Fixed error handling once in the shared integration adapter so every downstream integration, current and future, stops surfacing upstream outages as hard failures
- Fixed a caching bug where permission changes weren't taking effect reliably (several separate caching issues)
- Fixed repeated cron executions firing once per server instead of once total across the IoT-webhooks fleet
- Fixed a tranche exact-match bug that silently broke a Head-of-Collections daily offline report — and the same root cause in other alert crons — after a bulk tranche rename
- Fixed a redirect-loop on myfleet from a reverted TLS change plus cached redirects, and documented the correct rollout order

### Dev tooling & cross-team

- Built a prod→dev data sync tool because stale dev data was hiding real bugs
- Fixed a broken scheduled BigQuery sync job; fixed a broken CI/CD pipeline caused by a dropped build step
- Cleaned up a badly-tangled PR (a large amount of unrelated commits mixed in) by extracting the real changes onto a clean base
- Reviewed infra/metrics PRs, catching bundled changes that needed a different owner's sign-off before merge
- Automated service-card status updates in the gate-pass flow (backfilled old records, fixed silent-update bugs)
