# Instagram/Threads token-refresh systemd timer (KZ production)

Reference unit files for the per-account Instagram/Threads token refresh sweep's production
trigger — see `OLNOO_PROJECT_MAP.md` → "Automatic Instagram/Threads token refresh". Not wired
into `.github/workflows/deploy.yml` — install once by hand on KZ
(`/opt/olnoo/projects/olnoo-admin`), same convention as `deploy/social-scheduler/`.
`git reset --hard origin/main` in the deploy workflow does not touch `/etc/systemd/system/`, so
these files being present in the repo is documentation, not something the deploy step copies
anywhere automatically.

## One-time install (run on KZ, as root)

```bash
# 1. No new secret needed — this reuses the existing SOCIAL_SCHEDULER_TOKEN the Social scheduler
#    timer already set up (see deploy/social-scheduler/README.md). If that token isn't set yet,
#    set it first exactly as that README describes, then restart olnoo-admin.

# 2. Install the unit files:
cp /opt/olnoo/projects/olnoo-admin/deploy/social-token-refresh/olnoo-social-token-refresh.service /etc/systemd/system/
cp /opt/olnoo/projects/olnoo-admin/deploy/social-token-refresh/olnoo-social-token-refresh.timer /etc/systemd/system/
systemctl daemon-reload

# 3. Sanity-check one manual run before trusting the timer:
systemctl start olnoo-social-token-refresh.service
journalctl -u olnoo-social-token-refresh.service -n 20 --no-pager

# 4. Enable the recurring timer:
systemctl enable --now olnoo-social-token-refresh.timer
systemctl list-timers olnoo-social-token-refresh.timer
```

## Operating notes

- Runs once a day (`OnCalendar=*-*-* 03:17:00`, server local time), `Type=oneshot` — each run is a
  single `curl -X POST` to `http://127.0.0.1:3140/api/social-token-refresh/run` on this same
  server, never through nginx or the public domain.
- The route checks `X-Scheduler-Token` against `SOCIAL_SCHEDULER_TOKEN` — the SAME env var the
  Social scheduler's own timer uses. This is a second, independent trigger, not a second secret:
  the trust boundary (this same server, localhost-only) is identical, and the two sweeps touch
  completely different tables (`social_accounts` here vs `social_publications` there) with no
  shared lock, so they can run concurrently without interfering.
- Scans every project's `instagram`/`threads` accounts for a per-account token expiring within
  `REFRESH_WINDOW_DAYS` (7) days and refreshes each independently; one account's Meta-side error
  never blocks another's, and never flips a still-working connection to `error` — see
  `lib/social-meta-token-refresh-sweep.ts`'s own comment. Concurrent writes (this sweep racing a
  human's manual "Recheck connection") are resolved by an optimistic-concurrency check — whichever
  write lands second finds the token column has already changed and discards its own result
  rather than overwriting a newer one.
- Logs: `journalctl -u olnoo-social-token-refresh.service` for each `curl` run/exit code;
  `journalctl -u olnoo-admin` (the app's own log) for what the sweep actually did each run — one
  line per run with how many accounts were checked/refreshed/errored/raced.
- To pause: `systemctl disable --now olnoo-social-token-refresh.timer`. Existing connections keep
  working exactly as before — until a token actually expires, publishing is unaffected; refreshing
  simply goes back to being manual (open the account, click "Recheck connection") until the timer
  is re-enabled.
