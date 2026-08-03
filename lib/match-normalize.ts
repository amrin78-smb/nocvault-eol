// Model normalization + vendor derivation — the matching contract shared with the
// consuming apps (NetVault et al.). Ported VERBATIM from NetVault's lib/eolEnrich.ts
// so the central dedupe key and the apps' match key are computed identically.
//
// NOTE: the published feed carries RAW model strings; each consuming app re-normalizes
// locally with its own copy of this logic. Centrally we use it only for dedupe/QA and
// to compute the stored model_normalized. Keep this file in lockstep with NetVault's
// normalizeForMatch / deriveVendor. Bump NORMALIZER_VERSION on any behavioural change.

// 4 (2026-08): the Cisco PID strip now requires a digit after the prefix, so it no
// longer mangles non-Cisco models that merely start with 'air-' / 'ws-c'. Behaviour
// on every real Cisco PID is unchanged, so no consumer needs to resync for this.
export const NORMALIZER_VERSION = 4;

/**
 * Normalize a device/seed model into a flat matching key.
 *  - lowercase
 *  - strip a leading vendor prefix (also drops a redundant vendor baked into the model)
 *  - strip curated product-line "noise" words (e.g. "Catalyst", "NGFW", "Series")
 *  - strip common Cisco product-ID prefixes (WS-C / AIR-AP / AIR- ...)
 *  - strip region/series suffixes (-us/-ww/-row/series)
 *  - remove all punctuation & whitespace
 */
export function normalizeForMatch(
  vendor: string | null | undefined,
  model: string | null | undefined
): string {
  let s = (model ?? '').toLowerCase().trim();
  if (!s) return '';

  // Strip leading vendor words (also drops a redundant vendor baked into model).
  const vendorWords = [
    'hpe aruba networking', 'aruba', 'hpe', 'hp', 'cisco', 'grandstream',
    'ruckus', 'meraki', 'sonicwall', 'palo alto', 'paloalto', 'netgear',
    'tp-link', 'tplink', 'fortinet', 'juniper', 'forcepoint', 'dell',
  ];
  const v = (vendor ?? '').toLowerCase().trim();
  if (v) vendorWords.unshift(v);
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of vendorWords) {
      if (w && (s === w || s.startsWith(w + ' ') || s.startsWith(w + '-'))) {
        s = s.slice(w.length).trim().replace(/^[-\s]+/, '');
        changed = true;
        break;
      }
    }
  }

  // Strip product-LINE "noise" words anywhere — marketing/line words that appear
  // inconsistently between an inventory and a curated seed (e.g. "Catalyst",
  // "NGFW"); the model number identifies the device. This list EXCLUDES
  // model-DEFINING lines (SonicWave, AirEngine, Aironet, etc.), which are kept.
  const noiseWords = ['catalyst', 'flexnetwork', 'procurve', 'powerconnect', 'ngfw', 'series', 'appliance'];
  for (const w of noiseWords) {
    s = s.replace(new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)', 'g'), '$1 $2');
  }
  // Strip common Cisco product-ID prefixes so a PID matches the friendly name
  // (WS-C3750X / AIR-AP1242 -> 3750X / 1242).
  //
  // The lookahead is load-bearing: it requires a DIGIT within the next few
  // characters, which is what distinguishes a Cisco PID from an ordinary product
  // name that happens to start with the same letters. Cisco PIDs are always
  // <prefix><short letter code><digits> — AIR-AP3802I, AIR-CAP1702I, AIR-CT2504,
  // AIR-ANT2544, WS-C2960X — so all of those still strip exactly as before.
  // Without the guard the rule was unanchored to vendor and would also eat the
  // prefix of any non-Cisco model spelled with a hyphen ('air-fiber-5XHD',
  // 'air-max-M5', 'air-cube', 'ws-comm-…'), collapsing it to a key that can
  // false-match a genuine Cisco seed row. No live device or feed row hits that
  // path today (checked: 82 devices / 317 feed strings, all Cisco) — this closes
  // it before a Ubiquiti-style inventory arrives.
  s = s.replace(/\b(?:ws-c|air-cap|air-ap|air-)(?=[a-z]{0,4}\d)/g, '');

  // Strip trailing region/series suffixes.
  let suffixChanged = true;
  while (suffixChanged) {
    suffixChanged = false;
    const next = s.replace(/(?:[-_\s]?(?:us|ww|row|series))$/i, '');
    if (next !== s) {
      s = next.trim();
      suffixChanged = true;
    }
  }

  // Remove all remaining punctuation/whitespace.
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

/**
 * Derive a vendor name from a seed entry key + raw model. Ported from NetVault.
 * Returns a NEUTRAL 'Unknown' for unrecognized vendors (never the model string,
 * which would collapse the normalized key to empty).
 */
export function deriveVendor(key: string, rawModel: string): string {
  const k = (key || '').toUpperCase();
  if (k.startsWith('MERAKI')) return 'Meraki';
  if (k.startsWith('CISCO')) return 'Cisco';
  if (k.startsWith('ARUBA') || k.startsWith('HPE') || k.startsWith('HP')) return 'Aruba';
  if (k.startsWith('RUCKUS')) return 'Ruckus';
  if (k.startsWith('GRANDSTREAM') || /^GWN/i.test(rawModel)) return 'Grandstream';
  if (k.startsWith('AT-') || k.startsWith('ALLIED')) return 'Allied Telesis';
  if (k.startsWith('TPLINK') || k.startsWith('TP-LINK') || /^TP-?LINK/i.test(rawModel)) return 'TP-Link';
  if (k.startsWith('NETGEAR')) return 'Netgear';
  if (k.startsWith('HUAWEI')) return 'Huawei';
  if (k.startsWith('FORCEPOINT')) return 'Forcepoint';
  if (k.startsWith('PALO') || /^PA-/i.test(rawModel)) return 'Palo Alto';
  if (k.startsWith('DLINK') || k.startsWith('D-LINK') || k.startsWith('D LINK')) return 'D-Link';
  if (k.startsWith('UBIQUITI') || k.startsWith('UBNT') || k.startsWith('UNIFI')) return 'Ubiquiti';
  if (k.startsWith('SONICWALL') || k.startsWith('SONICPOINT') || k.startsWith('SONICWAVE') || /^(NSA|TZ)[\s-]|^SONIC/i.test(rawModel)) return 'SonicWall';
  if (k.startsWith('FORTINET') || /^FG/i.test(rawModel)) return 'Fortinet';
  return 'Unknown';
}
