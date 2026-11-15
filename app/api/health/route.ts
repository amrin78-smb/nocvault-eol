import { NextResponse } from 'next/server';
import { readHealthStatus } from '@/lib/cve/health-alerts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Service liveness, plus the LAST RECORDED CVE ingest verdict.
 *
 * ⛔ A SECOND SURFACE FOR THE VERDICT, BECAUSE EMAIL IS THE COMPONENT MOST
 * LIKELY TO BE BROKEN AT THE MOMENT YOU NEED IT. An unset ALERT_EMAIL_API_KEY, a
 * provider outage or an unverified sender domain all end with the operator
 * learning nothing — so the verdict must also be readable somewhere that needs
 * no mail path at all. `notify` below reports whether alerting could actually
 * deliver, which is the one fact an email can never carry.
 *
 * ⛔ IT READS THE RECORDED VERDICT; IT NEVER EVALUATES. This route is public and
 * uncached-by-nothing, so evaluating here would let anyone trigger NVD requests
 * and database writes. `checked_at` going stale is itself the signal that the
 * scheduled check has stopped.
 *
 * ⛔ IT MUST NEVER FAIL BECAUSE THE DATABASE IS DOWN. The route existed to
 * answer "is this service up" and that has to keep working when Neon does not;
 * a liveness probe that 500s on a dependency outage takes the deployment down
 * with it. The CVE block degrades to an error string and `status` stays 'ok'.
 *
 * ⛔ REDUCED FOR AN UNAUTHENTICATED CALLER. No remedy prose, no recorded
 * last_error strings, no key fingerprint — those are on the session-gated
 * /api/admin/cve-health. What is here is enough to monitor, not enough to map.
 */
export async function GET() {
  const base = { status: 'ok' as const, service: 'nocvault-eol-api' };

  try {
    const s = await readHealthStatus();
    if (!s) {
      return NextResponse.json({
        ...base,
        cve_ingest: {
          state: 'unknown',
          severity: 'alert',
          // ⛔ "NEVER CHECKED" IS NOT "HEALTHY", AND SAYING SO IS THE POINT.
          // An absent verdict reads as fine to anything that only looks for a
          // bad one, which is how 23 days passed.
          summary: 'No health check has ever recorded a verdict.',
          checked_at: null,
        },
      });
    }
    return NextResponse.json({
      ...base,
      cve_ingest: {
        state: s.state,
        severity: s.severity,
        summary: s.summary,
        checked_at: s.checkedAt,
        last_success_at: s.facts?.fleetLastSuccessAt ?? null,
        hours_since_success: s.facts?.hoursSinceSuccess ?? null,
        newest_published_at: s.facts?.newestPublishedAt ?? null,
        days_behind_corpus: s.facts?.daysBehindCorpus ?? null,
        targets: s.facts?.targets ?? null,
        thresholds: s.facts?.thresholds ?? null,
        open_since: s.openEpisode?.firstSeenAt ?? null,
        notify: { status: s.notifyStatus, detail: s.notifyDetail },
      },
    });
  } catch (err) {
    return NextResponse.json({
      ...base,
      cve_ingest: {
        state: 'unknown',
        severity: 'alert',
        summary: 'Could not read the recorded CVE ingest verdict.',
        error: err instanceof Error ? err.message : 'unavailable',
        checked_at: null,
      },
    });
  }
}
