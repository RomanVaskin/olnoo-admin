# Social scheduler systemd timer (KZ production)

Reference unit files for the Social scheduler's production trigger. Not wired into
`.github/workflows/deploy.yml` — install once by hand on KZ (`/opt/olnoo/projects/olnoo-admin`),
per `OLNOO_PROJECT_MAP.md` → "Social scheduler". `git reset --hard origin/main` in the deploy
workflow does not touch `/etc/systemd/system/`, so these files being present in the repo is
documentation, not something the deploy step copies anywhere automatically.

## One-time install (run on KZ, as root)

```bash
# 1. Add a real secret to the app's own env file (used by both the Next.js process and this timer):
echo "SOCIAL_SCHEDULER_TOKEN=$(openssl rand -hex 32)" >> /opt/olnoo/projects/olnoo-admin/.env.local
systemctl restart olnoo-admin   # so the running app picks up the new env var

# 2. Install the unit files:
cp /opt/olnoo/projects/olnoo-admin/deploy/social-scheduler/olnoo-social-scheduler.service /etc/systemd/system/
cp /opt/olnoo/projects/olnoo-admin/deploy/social-scheduler/olnoo-social-scheduler.timer /etc/systemd/system/
systemctl daemon-reload

# 3. Sanity-check one manual run before trusting the timer:
systemctl start olnoo-social-scheduler.service
journalctl -u olnoo-social-scheduler.service -n 20 --no-pager

# 4. Enable the recurring timer:
systemctl enable --now olnoo-social-scheduler.timer
systemctl list-timers olnoo-social-scheduler.timer
```

## Operating notes

- Runs once a minute (`OnCalendar=minutely`), `Type=oneshot` — each run is a single `curl -X POST`
  to `http://127.0.0.1:3140/api/social-scheduler/run` on this same server, never through nginx or
  the public domain.
- The route checks `X-Scheduler-Token` against `SOCIAL_SCHEDULER_TOKEN`; without that env var set,
  the route refuses every request with 500 rather than running unprotected.
- If a sweep is still running when the next minute's timer fires, the new run's
  `pg_try_advisory_lock` call finds the lock held and exits immediately — no overlap, no queueing.
- Logs: `journalctl -u olnoo-social-scheduler.service` for each `curl` run/exit code;
  `journalctl -u olnoo-admin` (the app's own log) for what the scheduler actually did each run —
  every sweep logs one line with the due posts it processed and their outcomes, whether or not it
  was skipped for an already-in-progress run.
- To pause: `systemctl disable --now olnoo-social-scheduler.timer`. Ready posts keep working
  exactly as before — publish stays manual (via the existing per-channel or "Publish selected
  channels" buttons) until the timer is re-enabled.
