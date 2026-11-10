# DTEK Odesa schedule scraper

Every 15 minutes GitHub Actions opens the DTEK Odesa shutdowns page, reads the
schedule for queue 2.2 and saves it to `schedule.json`.

Change the queue in `.github/workflows/update.yml` (`QUEUE`).

## schedule.json format

```json
{
  "queue": "2.2",
  "source_update": "...",
  "days": {
    "2026-11-10": ["yes", "yes", "no", ...24 values, hour 0..23],
    "2026-11-11": [...]
  },
  "updated": "2026-11-10T11:00:00.000Z"
}
```

Values: `yes` = power on, `no` = power off, other values = possible outage.
