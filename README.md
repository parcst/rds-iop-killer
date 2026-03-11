# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Quick Start

```bash
npm install && npm run dev
```

Starts both server (port 3001) and client (port 5173), opens the app in your browser.

## Commands

```bash
# Development (starts both server and client, opens browser)
npm run dev

# Server only (port 3001, tsx watch mode)
npm run dev -w server

# Client only (port 5173, Vite, proxies /api to localhost:3001)
npm run dev -w client

# Build both
npm run build

# Type-check without emitting
npx -w server tsc --noEmit
npx -w client tsc --noEmit
```

No test suite or linter is configured yet.

## Architecture

npm workspaces monorepo with two packages: `server` (Express + TypeScript) and `client` (React 18 + Vite + Tailwind + Zustand).

**Purpose:** Connect to AWS RDS MySQL instances via Teleport tunnels and investigate IOPS breaches — visualize real CloudWatch IOPS with breach zones, then drill into root cause using DBA historical data with drag-to-zoom.

### Server (`server/src/`)

Express on port 3001.

**Teleport Routes (`routes/teleport.ts`):**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/teleport/status` | GET | Check if tsh binary is available |
| `/api/teleport/clusters` | GET | List clusters from `~/.tsh/*.yaml` |
| `/api/teleport/login-status?cluster=X` | GET | Check login status for cluster |
| `/api/teleport/login` | POST | Start SSO login (opens browser) |
| `/api/teleport/instances?cluster=X` | GET | List MySQL instances on cluster |
| `/api/teleport/databases` | POST | Discover databases on instance (temp tunnel) |
| `/api/teleport/connect` | POST | Connect to a database (persistent session) |
| `/api/teleport/disconnect` | POST | Disconnect active session |
| `/api/teleport/shutdown` | POST | Clean up all tunnels (sendBeacon target) |

**AWS Routes (`routes/aws.ts`):**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/aws/sso-status` | GET | Check if valid AWS SSO session exists (cached token) |
| `/api/aws/sso-login` | POST | Start AWS SSO login (opens browser via `aws sso login`), client polls sso-status |

**IOPS Routes (`routes/iops.ts`):**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/iops/top-statements` | GET | Top I/O statements (delta-based from DBA history) |
| `/api/iops/top-consumers` | GET | Top consumers (delta I/O x concurrent connections) |
| `/api/iops/cloudwatch` | GET | 9 CloudWatch metrics (IOPS, latency, CPU, memory, burst, connections) |
| `/api/iops/rds-config` | GET | RDS instance config (provisioned IOPS, storage type) via AWS API |
| `/api/iops/innodb-metrics` | GET | Buffer pool hit ratio + InnoDB physical I/O counters from `dba.global_status_history` |

IOPS routes accept `?database=X&since=ISO&until=ISO&limit=N`. CloudWatch route requires `?accountId=X&region=Y&instanceId=Z&since=ISO&until=ISO`. RDS config requires `?accountId=X&region=Y&instanceId=Z`. InnoDB metrics accepts `?since=ISO&until=ISO`.

**Services:**
- `services/teleport.ts` — Teleport CLI (`tsh`) integration. Includes tunnel registry and `cleanupAll()`.
- `services/connection-manager.ts` — Persistent MySQL session management. Exports: `openSession()`, `closeSession()`, `getConnection()`, `getActiveSession()`.
- `services/iops.ts` — DBA root cause queries using **delta computation** from `dba.events_statements_summary_by_digest_history` (DBA snapshots every ~5 min, 65M+ rows). Uses LAG() window functions with `CAST(... AS SIGNED)` to compute actual I/O deltas. Also reads `performance_schema.events_statements_current` + `threads` for live concurrent query counts. `getInnodbMetrics()` queries `dba.global_status_history` for buffer pool hit ratio and InnoDB physical I/O counters (same delta pattern). `MAX_EXECUTION_TIME(30000)` safety hint. Includes DB time offset correction for `datetime` columns. Cross-schema joins use `BINARY` comparison to avoid collation conflicts.
- `services/cloudwatch.ts` — Fetches 9 CloudWatch metrics in parallel via AWS CLI: ReadIOPS, WriteIOPS, DiskQueueDepth, ReadLatency, WriteLatency, CPUUtilization, FreeableMemory, DatabaseConnections, BurstBalance. Dynamic period (60s/300s/900s based on time range). BurstBalance gracefully handles io1/io2 (not available). Merges all metrics by timestamp.
- `services/aws-rds.ts` — AWS SSO integration: finds cached access token, discovers roles (prefers DBALimited), creates CLI profiles. SSO URL and region configurable via `AWS_SSO_START_URL` and `AWS_SSO_REGION` env vars. Exports `getSsoAccessToken()`, `getAwsProfile()` and `getRdsInstanceConfig()`.

**Key data flow in `services/iops.ts`:**
1. `getDbTimeOffset()` — computes millisecond offset between JS `Date` and MySQL `NOW()` (needed because `AsOfDate` is `datetime` without timezone)
2. Query functions extend the time range by -10 minutes for LAG() baseline
3. Delta pattern: `CAST(h.SUM_ROWS_EXAMINED AS SIGNED) - CAST(LAG(h.SUM_ROWS_EXAMINED) OVER w AS SIGNED)`

### Client (`client/src/`)

- **State** — Zustand store (`store/app-store.ts`) manages Teleport state, connection state, CloudWatch data, DBA data, time range, UTC toggle, RDS config, IOPS threshold, RCA highlighting (`highlightedStmt`), and AWS SSO state (`awsSsoLoggedIn`, `awsSsoLoggingIn`, `awsSsoNeeded`).
- **API client** (`api/client.ts`) — Typed fetch wrappers for all endpoints.
- **Hooks:**
  - `hooks/useTeleport.ts` — Teleport lifecycle: cluster loading, login polling, auto-connect on instance selection (no database selector — IOPS are instance-level, connects with `__ALL__`). Auto-cleanup via `sendBeacon`.
  - `hooks/useIops.ts` — In overview mode: fetches CloudWatch IOPS only. In investigation mode (drag-zoom/custom range): fetches CloudWatch + DBA data (statements, consumers) in parallel. Auto-fetches provisioned IOPS from AWS RDS API on connect. Request ID guard prevents stale responses.
- **Components:**
  - `TeleportControls` — Sidebar: cluster/login/instance selectors. No database selector (auto `__ALL__`). Shows connecting indicator and connected status. Includes AWS SSO login flow: detects when SSO is needed (amber prompt), initiates `aws sso login` (opens browser), polls until authenticated, then auto-re-fetches CloudWatch/RDS data.
  - `RootCauseAnalysis` — Sidebar: holistic RCA using statements, consumers, 9 CloudWatch metrics, InnoDB buffer pool hit ratio, and RDS config. Executive summary one-liner at top. Infrastructure analysis (storage saturation, burst exhaustion, memory pressure, CPU, connection surges, IOPS headroom, read/write profile, storage type upgrade advice). Buffer pool hit ratio analysis. Cross-statement systemic patterns (P99 spikes, indexing gaps, suboptimal indexes, lock contention, temp spills, scan-heavy workloads, new query detection). Per-statement scoring with scan efficiency ratio, write amplification, index column suggestions parsed from sample SQL, and estimated IOPS savings. Fix priority list with detailed modals. Only shown when investigating a custom time range.
  - `IopsView` — Main area: time picker + resizable/collapsible chart + statements table. Shows "Drag across a spike..." prompt when not investigating. Highlighted statement rows from RCA clickable refs.
  - `IopsChart` — SVG chart showing **real CloudWatch IOPS** (ReadIOPS blue, WriteIOPS orange, Total white). Provisioned IOPS threshold line (red dashed, auto-fetched from AWS). Breach zones highlighted red above threshold. Drag-to-zoom. Loading spinner overlay. No DBA data in chart.
  - `TimeRangePicker` — Preset buttons (5min, 30min, 1h, 6h, 12h, 24h) + Custom range with datetime-local inputs and "Investigate" button. UTC/Local toggle.
- **Layout** — Dark theme with red accent. Left sidebar (w-80): connection controls + RCA narrative. Right main area: collapsible chart + data tables.

### IOPS Investigation Workflow

1. Select an RDS instance — auto-connects with `__ALL__`, provisioned IOPS and CloudWatch data auto-fetched from AWS
2. Overview mode: chart shows real CloudWatch ReadIOPS + WriteIOPS with breach zones highlighted red
3. Drag-to-zoom into a breach spike → enters investigation mode
4. Investigation mode: RCA narrative appears in sidebar with clickable statement references; statements/consumers tables show root cause queries
5. Click `[#N]` refs in RCA to highlight corresponding table rows
6. Toggle chart visibility to maximize table space
7. Hover any query to see full text, click to copy for further analysis

**Statements table columns:** #, Impact %, Database, Query (click to copy), Total Rows Examined, Avg Rows/Exec, Executions, Avg Time, P99, Lock, No Index, Full Join, Tmp Disk, Sort Spill, Last Seen

Consumers tab removed — consumer data (concurrency, effective IOPS) is still fetched and used internally by the holistic RCA engine.

### Teleport Integration

Connects to RDS MySQL via Teleport tunnels. Requires `tsh` binary (Teleport CLI or Teleport Connect app).

**Flow:**
1. List clusters from `~/.tsh/*.yaml` profiles
2. SSO login via `tsh login <cluster>` (opens browser)
3. Poll `tsh status --format=json` until logged in
4. List MySQL instances via `tsh db ls --proxy=<cluster> --format=json`
5. Select instance → auto-connect with `__ALL__` (no database discovery step)
6. Connect: tunnel -> `mysql2` connection -> verify with `SELECT VERSION()`

**Key details:**
- `tsh status` returns exit code 1 even when logged in — never use `check=true`
- Uses `--proxy=<cluster>` flag for non-active profiles
- Port allocation: `--port 0` lets tsh pick random port, parsed from stdout
- SSO email from `tsh status` used as `--db-user` automatically
- Auto-cleanup: tunnels tracked in registry, cleaned on page close via `sendBeacon`

### Key Types

Server types in `server/src/types.ts`. Client mirrors in `client/src/api/types.ts`.

- `TeleportTunnel` — Running tunnel process with host/port/dbName/dbUser
- `TeleportInstance` — RDS instance metadata (name, uri, accountId, region, instanceId)
- `TeleportStatus` — Login state with loggedIn flag, username, cluster
- `ConnectionResult` — Database connection verification result
- `TopStatement` — Query digest stats: rows examined, execution count, timing, index usage, tmpDiskTables, sortMergePasses, first/last seen
- `TopConsumer` — Same as statement + concurrent connection count and effective IOPS (rows x concurrency)
- `CloudWatchIopsPoint` — 9 CloudWatch metrics: timestamp, readIops, writeIops, totalIops, diskQueueDepth, readLatencyMs, writeLatencyMs, cpuUtilization, freeableMemoryMb, databaseConnections, burstBalance
- `RdsInstanceConfig` — AWS RDS config: provisionedIops, storageType, allocatedStorageGb, instanceClass, engine, engineVersion
- `InnodbMetrics` — Buffer pool hit ratio (avg/min/dataPoints) + InnoDB physical I/O counters (reads/writes/ratio/dataPoints)
- `TimeRange` — since/until ISO strings + label
- `IopsTab` — `'statements' | 'consumers'`

### Safety Design

All IOPS queries are **zero production impact**:
- Read from `dba.events_statements_summary_by_digest_history` (read-only DBA snapshots) and `performance_schema` in-memory tables (lock-free, no MDL)
- `MAX_EXECUTION_TIME(30000)` hint auto-kills queries as safety net (tripled to 90s for large delta queries)
- Uses `performance_schema.threads` instead of `information_schema.PROCESSLIST` (avoids LOCK_thd_list mutex)
- No user table access, no row locks
- DB time offset correction ensures accurate time-range filtering

### Environment Variables

- `AWS_SSO_START_URL` — AWS SSO portal URL (required for CloudWatch/RDS config)
- `AWS_SSO_REGION` — AWS SSO region (defaults to `us-east-1`)

### Git Hooks

`.githooks/pre-push` runs 3 checks before every push:
1. README.md synced from CLAUDE.md
2. PII/secrets scan (passwords, tokens, credentials)
3. TypeScript type-check (server + client)

Configured via `npm prepare` → `git config core.hooksPath .githooks`
