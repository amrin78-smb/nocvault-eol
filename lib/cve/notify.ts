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
    | 'no_sender'        // ALERT_EMAIL_FROM unset on a provider that requires it
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
 * ⛔ TWO PROVIDERS, BECAUSE THE DIFFERENCES ARE NOT A BASE URL. An earlier draft
 * had only Resend's shape and offered ALERT_EMAIL_API_BASE as the way to point
 * elsewhere — which cannot work. Brevo differs in all three parts of the
 * request: the PATH (/v3/smtp/email vs /emails), the AUTH HEADER (`api-key:` vs
 * `Authorization: Bearer`) and the BODY (sender.email / to[].email /
 * textContent vs from / to[] strings / text). A host swap would have produced a
 * 401 or a 404 from a feature whose entire job is to work during an incident.
 */
export type EmailProvider = 'brevo' | 'resend';

/** Default BREVO: it is what this deployment actually has an account with. */
export function emailProvider(): EmailProvider {
  const p = (process.env.ALERT_EMAIL_PROVIDER || 'brevo').trim().toLowerCase();
  return p === 'resend' ? 'resend' : 'brevo';
}

const PROVIDER_DEFAULT_BASE: Record<EmailProvider, string> = {
  brevo: 'https://api.brevo.com',
  resend: 'https://api.resend.com',
};

/**
 * ⛔ OVERRIDABLE BASE URL, FOR THE EXECUTION TEST. CLAUDE.md records several
 * guards in this repo that were verified by reading and then could not fire. The
 * only way to prove this one sends is to point it at a capture server and watch
 * the request arrive, which scripts/verify-cve-health.ts does. It also lets a
 * self-hosting operator aim at a compatible endpoint. It is an operator-set env
 * var, never request-derived.
 */
function apiBase(): string {
  return (process.env.ALERT_EMAIL_API_BASE || PROVIDER_DEFAULT_BASE[emailProvider()])
    .replace(/\/+$/, '');
}

function recipients(): string[] {
  return (process.env.ALERT_EMAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sender(): string {
  // ⛔ THE RESEND-ONLY FALLBACK IS NOT A GLOBAL DEFAULT. `onboarding@resend.dev`
  // is Resend's shared test sender; handing it to Brevo produces a hard rejection
  // ("sender not valid"), because Brevo sends only from a sender or domain
  // validated in the account. So Brevo has NO default — see notifyConfigured().
  const explicit = (process.env.ALERT_EMAIL_FROM || '').trim();
  if (explicit) return explicit;
  return emailProvider() === 'resend' ? 'onboarding@resend.dev' : '';
}

/**
 * Does this deployment have everything it needs to actually notify?
 *
 * ⛔ IT CHECKS WHAT THE CHOSEN PROVIDER ACTUALLY REQUIRES. Reporting "configured"
 * on a Brevo deployment with no validated sender would mean the first real
 * incident is also the first time anyone discovers the mailer cannot send — the
 * exact shape of the defect this whole feature exists to remove.
 */
export function notifyConfigured(): { ok: boolean; reason: string } {
  const provider = emailProvider();
  if (!(process.env.ALERT_EMAIL_API_KEY || '').trim()) {
    return { ok: false, reason: `ALERT_EMAIL_API_KEY is not set (provider: ${provider}) — no alert email can be sent.` };
  }
  if (recipients().length === 0) {
    return { ok: false, reason: 'ALERT_EMAIL_TO is not set — no alert email can be sent.' };
  }
  if (!sender()) {
    return {
      ok: false,
      reason:
        'ALERT_EMAIL_FROM is not set, and Brevo has no shared test sender — it sends only '
        + 'from an address or domain validated in the account. Set it to a validated sender.',
    };
  }
  return { ok: true, reason: `email alerting is configured (provider: ${provider})` };
}

/** The provider-specific request. One place, so the three differences cannot drift. */
function buildRequest(subject: string, body: string, apiKey: string, to: string[]): {
  url: string;
  headers: Record<string, string>;
  payload: unknown;
} {
  const from = sender();
  if (emailProvider() === 'resend') {
    return {
      url: `${apiBase()}/emails`,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      payload: { from, to, subject, text: body },
    };
  }
  // Brevo transactional email (v3). Success is 201, which res.ok covers.
  return {
    url: `${apiBase()}/v3/smtp/email`,
    headers: {
      // ⛔ A BARE `api-key` HEADER, NOT A BEARER TOKEN. Brevo rejects
      // Authorization: Bearer with a 401 that says nothing about the header name.
      'api-key': apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    payload: {
      sender: { email: from, name: 'NocVault EOL hub' },
      to: to.map((email) => ({ email })),
      subject,
      textContent: body,
    },
  };
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

  if (!sender()) {
    return {
      sent: false,
      skipped: 'no_sender',
      detail:
        'ALERT_EMAIL_FROM is not set and Brevo has no shared test sender — it sends only from '
        + 'an address or domain validated in the account. The verdict was still evaluated and '
        + 'recorded, and is visible on /api/health and the dashboard, but nothing was emailed.',
    };
  }

  const { url, headers, payload } = buildRequest(subject, body, apiKey, to);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
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
      detail: `sent to ${to.length} recipient(s) via ${emailProvider()}`,
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
