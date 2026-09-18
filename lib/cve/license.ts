// lib/cve/license.ts
//
// Who may pull the CVE feed.
//
// ⛔ THIS GATE IS COMMERCIAL, NOT SECURITY, AND IT THEREFORE FAILS OPEN WHEN
// UNCONFIGURED. That is the same call the rest of this product range makes and
// it is deliberate: SecVault's own rule is "the licence guard fails open; the
// RBAC guard fails closed", because a configuration gap must never cut a paying
// customer off from the data their security posture depends on. With
// CVE_FEED_KEYS unset every non-empty key is accepted, exactly as before this
// file existed — and the response says so in a header, so an operator can see
// that enforcement is off rather than assume it is on.
//
// ⛔ IT IS NOT A SECRET-BEARING AUTHENTICATION SYSTEM AND MUST NOT BE MISTAKEN
// FOR ONE. The keys are bearer strings in an env var; anyone holding one can
// pull the corpus. What the corpus contains is PUBLIC vulnerability data —
// NVD's own records — so the gate exists to meter distribution, not to protect
// content. Do not add device data to this feed and then rely on this gate.
//
// ⛔ NOT TOUCHED: /api/v1/feed, the EOL feed. NetVault consumes it in production
// with an unvalidated key today, and tightening that endpoint from here would
// risk a live outage in a different product for no gain in this one. If the EOL
// feed should be metered too, that is its own change, made with NetVault in view.

import { timingSafeEqual } from 'node:crypto';

export type LicenseVerdict =
  | { ok: true; enforced: false; label: 'unenforced' | 'unenforced-unparseable' }
  | { ok: true; enforced: true; label: string }
  | { ok: false; enforced: boolean; reason: string };

/**
 * CVE_FEED_KEYS is a comma-separated list of `key` or `key:label` entries. The
 * label is for the log line only — it says WHICH customer pulled, which is the
 * point of metering.
 */
function configuredKeys(): Array<{ key: string; label: string }> {
  const raw = (process.env.CVE_FEED_KEYS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return { key: entry, label: 'unlabelled' };
      return { key: entry.slice(0, idx).trim(), label: entry.slice(idx + 1).trim() || 'unlabelled' };
    })
    .filter((e) => e.key.length > 0);
}

/**
 * ⛔ CONSTANT TIME, AND LENGTH IS COMPARED SEPARATELY. timingSafeEqual THROWS on
 * a length mismatch rather than returning false, so a bare call leaks length
 * through an exception and crashes the route on the first wrong-sized key.
 */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * ⛔ "NOT CONFIGURED" AND "CONFIGURED BUT UNREADABLE" ARE OPPOSITE INSTRUCTIONS.
 * configuredKeys() returns [] for an unset variable AND for one that is set but
 * yields nothing usable — `","`, `" "`, `":label"`, or a semicolon-separated
 * paste. Both landed on enforced:false, accepting every key. The fail-open on
 * UNSET is deliberate; silently failing open on a value the operator believes is
 * metering the feed is not. This is the same distinction the vendor-PSIRT gate
 * draws between an empty inventory and an unreadable one.
 */
function keysConfiguredButUnusable(): boolean {
  const raw = (process.env.CVE_FEED_KEYS || '').trim();
  return raw.length > 0 && configuredKeys().length === 0;
}

/**
 * Constant-time comparison for a shared secret, for callers outside this file.
 *
 * ⛔ AN ABSENT OR EMPTY EXPECTED SECRET NEVER MATCHES. Returning true when
 * CRON_SECRET is unset would turn a missing configuration into open access to
 * the admin routes — the opposite call from the licence gate one function below,
 * which is a COMMERCIAL boundary and fails open on purpose. This one is
 * authorisation and fails closed.
 */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  return keyMatches(provided, expected);
}

export function checkLicense(provided: string | null): LicenseVerdict {
  const key = (provided || '').trim();
  if (!key) {
    // Unchanged from before this file: a missing key is refused in every mode.
    return { ok: false, enforced: configuredKeys().length > 0, reason: 'license key required' };
  }

  const allowed = configuredKeys();
  if (allowed.length === 0) {
    // ⛔ UNCONFIGURED. See the header — open, loudly, never silently.
    return {
      ok: true,
      enforced: false,
      label: keysConfiguredButUnusable() ? 'unenforced-unparseable' : 'unenforced',
    };
  }

  for (const entry of allowed) {
    if (keyMatches(key, entry.key)) {
      return { ok: true, enforced: true, label: entry.label };
    }
  }
  return { ok: false, enforced: true, reason: 'license key not recognised' };
}
