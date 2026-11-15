// lib/cve/notify.ts
//
// Outbound alert delivery for the CVE ingest health check.
//
// ⛔ AN HTTP EMAIL API, NOT SMTP. A Netlify function doing outbound SMTP is a bad
// bet — it needs a long-lived socket on ports that serverless egress commonly
// blocks, inside an invocation capped at roughly 30 seconds. One HTTPS POST fits
// the platform we actually run on. There is no mailer dependency in
// package.json either (nodemailer appears only transitively in the lockfile), so
// this adds no install step and nothing to keep patched.
//
// ⛔ CONFIGURATION ABSENCE IS REPORTED, NEVER SILENT. The defect being fixed here
// is a failure nobody was told about; a notifier that quietly no-ops when it is
// unconfigured reproduces that defect one layer up. Every path returns a
// structured result naming why it could not send, the caller stores it, and both
// /api/health and the dashboard show it. The health check itself must still RUN
// and still RECORD its verdict with no mailer configured at all.
//
// ⛔ THE ALERT BODY CARRIES A KEY FINGERPRINT, NEVER A KEY. probeApiKey() already
// returns first-four + last-four and nothing here ever handles the raw value.

/** Where the message got to. `sent` is the only success. */
export type NotifyResult = {
  sent: boolean;
  /** Why nothing was sent. Null when sent. */
  skipped:
    | null
    | 'no_api_key'       // ALERT_EMAIL_API_KEY unset
    | 'no_recipient'     // ALERT_EMAIL_TO unset
    | 'provider_error'   // the API answered non-2xx
    | 'transport_error'; // DNS/TLS/timeout
  /** Operator-facing detail. Safe to display. */
  detail: string;
  providerStatus?: number;
  /** Recipient count only — addresses are not echoed into logs or the UI. */
  recipients?: number;
};

const SEND_TIMEOUT_MS = 6000;

/**
 * ⛔ OVERRIDABLE BASE URL, FOR THE EXECUTION TEST. CLAUDE.md records several
 * guards in this repo that were verified by reading and then could not fire. The
 * only way to prove this one sends is to point it at a capture server and watch
 * the request arrive, which scripts/verify-cve-health.ts does. It also lets a
 * self-hosting operator aim at a compatible endpoint. It is an operator-set env
 * var, never request-derived.
 */
function apiBase(): string {
  return (process.env.ALERT_EMAIL_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
}

function recipients(): string[] {
  return (process.env.ALERT_EMAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this deployment have everything it needs to actually notify? */
export function notifyConfigured(): { ok: boolean; reason: string } {
  if (!(process.env.ALERT_EMAIL_API_KEY || '').trim()) {
    return { ok: false, reason: 'ALERT_EMAIL_API_KEY is not set — no alert email can be sent.' };
  }
  if (recipients().length === 0) {
    return { ok: false, reason: 'ALERT_EMAIL_TO is not set — no alert email can be sent.' };
  }
  return { ok: true, reason: 'email alerting is configured' };
}

/**
 * Send one alert. Returns rather than throws: a notifier that throws takes the
 * health check down with it, and then the one thing guaranteed broken during an
 * outage is the thing that reports outages.
 */
export async function sendAlertEmail(subject: string, body: string): Promise<NotifyResult> {
  const apiKey = (process.env.ALERT_EMAIL_API_KEY || '').trim();
  if (!apiKey) {
    return {
      sent: false,
      skipped: 'no_api_key',
      detail:
        'ALERT_EMAIL_API_KEY is not set. The verdict was still evaluated and recorded, '
        + 'and is visible on /api/health and the dashboard, but nothing was emailed.',
    };
  }
  const to = recipients();
  if (to.length === 0) {
    return {
      sent: false,
      skipped: 'no_recipient',
      detail:
        'ALERT_EMAIL_TO is not set. The verdict was still evaluated and recorded, '
        + 'and is visible on /api/health and the dashboard, but nothing was emailed.',
    };
  }

  const from = (process.env.ALERT_EMAIL_FROM || '').trim() || 'onboarding@resend.dev';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text: body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // ⛔ THE PROVIDER'S OWN WORDS, TRUNCATED. "Failed to send" with no status
      // is the kind of message that costs an afternoon; a verified-domain
      // rejection and a bad key read identically without it.
      let detail = `email API responded HTTP ${res.status}`;
      try {
        const txt = (await res.text()).slice(0, 300);
        if (txt) detail += `: ${txt}`;
      } catch { /* body is optional */ }
      return { sent: false, skipped: 'provider_error', detail, providerStatus: res.status, recipients: to.length };
    }
    return {
      sent: true,
      skipped: null,
      detail: `sent to ${to.length} recipient(s)`,
      providerStatus: res.status,
      recipients: to.length,
    };
  } catch (err: any) {
    const detail =
      err?.name === 'AbortError'
        ? `email API did not respond within ${SEND_TIMEOUT_MS}ms`
        : `email transport failed: ${err instanceof Error ? err.message : String(err)}`;
    return { sent: false, skipped: 'transport_error', detail, recipients: to.length };
  } finally {
    clearTimeout(timer);
  }
}
