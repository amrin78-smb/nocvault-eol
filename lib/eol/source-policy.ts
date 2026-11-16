// lib/eol/source-policy.ts
//
// THE SOURCING RULE, AS A FUNCTION RATHER THAN AS PROSE.
//
// The rule (owner's decision, 2026-11-16, replacing "official vendor sources ONLY"):
//
//     Official sources only for `high` and `medium`.
//     Aggregators are permitted at `low`, always labelled.
//
// ⛔ WHY IT CHANGED. The old rule said official-only and was quoted to refuse
// things — twice in one week, against endoflife.ai and the HPE aggregators —
// while **22.4% of the shipped corpus (1,767 of 7,902 entries) was already
// aggregator-sourced**, almost all of it correctly tagged `low`. A rule that the
// data contradicts is worse than a looser rule the data obeys: it gets enforced
// selectively, and the selection is whoever read it last.
//
// ⛔ WHY IT IS CODE AND NOT A PARAGRAPH. CLAUDE.md already carried the old rule,
// in bold, marked non-negotiable, and the corpus drifted a fifth of the way past
// it anyway with nothing to notice. This repo's own recurring finding is that a
// guard verified only by reading is a guard that cannot fire.
// `npm run verify:seed` executes this file against every entry.
//
// ⛔ CONFIDENCE AND PROVENANCE ARE TWO AXES AND MUST NOT COLLAPSE INTO ONE.
// `low` now means EITHER "official but weak" OR "aggregator-sourced", and those
// are different facts: the first cannot be improved without better vendor
// publishing, the second can be promoted to `high` by one person opening the
// vendor link an aggregator already cites. This file keeps them separable by
// classifying the SOURCE HOST, so provenance is always derivable from the data
// already in the seed and no feed-format change is needed.

export type SourceClass = 'official' | 'aggregator' | 'community' | 'none' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * ⛔ AGGREGATORS: RESELLERS, THIRD-PARTY MAINTAINERS AND EOL TRACKERS.
 *
 * Not a blocklist any more — an ALLOWLIST THAT CAPS CONFIDENCE AT `low`. These
 * are legitimate leads and often the only machine-readable record that exists
 * (HPE/Aruba publishes ~2,100 models we carry and has no server-readable
 * official listing at all), but none of them is the vendor, so none of them can
 * carry `high`.
 */
const AGGREGATOR_HOSTS = new Set([
  'www.parkplacetechnologies.com',
  'parkplacetechnologies.com',
  'www.layer23-switch.com',
  'layer23-switch.com',
  'www.router-switch.com',
  'router-switch.com',
  'serviceexpress.com',
  'www.serviceexpress.com',
  'eosl.date',
  'endoflife.date',
  'endoflife.ai',
  'www.endoflife.ai',
  'www.datalive.co.jp',
  'datalive.co.jp',
  'www.it-server-room.com',
]);

/**
 * ⛔ VENDOR COMMUNITY FORUMS ARE THEIR OWN CLASS, AND THEY ARE NOT `high`.
 *
 * `community.fortinet.com` and `community.juniper.net` are vendor-HOSTED but
 * user-WRITTEN. A forum post on the vendor's own domain reads as official to a
 * host-prefix check and is not: it carries no more authority than the person who
 * typed it. Capped at `medium` — above an aggregator, because the vendor chose
 * to host it and moderates it, below a bulletin, because nobody at the vendor
 * signed it.
 */
const COMMUNITY_HOSTS = new Set([
  'community.fortinet.com',
  'community.juniper.net',
  'community.ui.com',
  'community.cisco.com',
  'forums.juniper.net',
]);

/**
 * Official vendor hosts. A host NOT listed here and not an aggregator is
 * `unknown` — deliberately not "official by default".
 *
 * ⛔ DEFAULTING AN UNRECOGNISED HOST TO OFFICIAL IS HOW THE OLD RULE WOULD HAVE
 * ROTTED SILENTLY. The repo's standing principle is that an unrecognised
 * condition fails toward the alerting state, never toward healthy — the same
 * call lib/cve/health.ts makes with its `unknown` verdict.
 */
const OFFICIAL_HOSTS = new Set([
  'www.cisco.com', 'cisco.com', 'sec.cloudapps.cisco.com',
  'documentation.meraki.com', 'meraki.cisco.com',
  'www.netgear.com', 'downloads1.netgear.com', 'kb.netgear.com',
  'www.arubanetworks.com', 'asp-documents.arubanetworks.com',
  'support.hpe.com', 'www.hpe.com', 'networkingsupport.hpe.com',
  'www.tp-link.com', 'static.tp-link.com',
  'docs.fortinet.com', 'www.fortinet.com', 'support.fortinet.com', 'filestore.fortinet.com',
  'www.paloaltonetworks.com', 'docs.paloaltonetworks.com', 'security.paloaltonetworks.com',
  'www.alliedtelesis.com',
  'www.sonicwall.com', 'www.sonicwall.com.cn',
  'support.ruckuswireless.com', 'docs.ruckuswireless.com', 'www.ruckusnetworks.com',
  'www.juniper.net', 'support.juniper.net', 'supportportal.juniper.net', 'kb.juniper.net',
  'support.dlink.com', 'www.dlink.com',
  'www.broadcom.com', 'techdocs.broadcom.com',
  'www.checkpoint.com', 'support.checkpoint.com', 'advisories.checkpoint.com',
  'www.ibm.com', 'www.dell.com', 'www.lenovo.com', 'support.lenovo.com',
  'www.h3c.com', 'www.arista.com', 'www.huawei.com', 'support.huawei.com',
  'www.forcepoint.com', 'support.forcepoint.com',
  'www.grandstream.com', 'www.ui.com', 'help.ui.com',
  'www.asus.com', 'www.linksys.com', 'www.totolink.net',
]);

export function hostOf(source: string | null | undefined): string {
  const s = (source || '').trim();
  if (!s) return '';
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function classifySource(source: string | null | undefined): SourceClass {
  const s = (source || '').trim();
  if (!s) return 'none';
  const host = hostOf(s);
  if (!host) return 'unknown';
  if (AGGREGATOR_HOSTS.has(host)) return 'aggregator';
  if (COMMUNITY_HOSTS.has(host)) return 'community';
  if (OFFICIAL_HOSTS.has(host)) return 'official';
  return 'unknown';
}

/** The highest confidence a given source class may carry. */
export function maxConfidenceFor(cls: SourceClass): Confidence | null {
  switch (cls) {
    case 'official': return 'high';
    case 'community': return 'medium';
    case 'aggregator': return 'low';
    // ⛔ `none` and `unknown` get NO ceiling, i.e. they are not admissible at
    // any confidence. A date with no citation is not a weak fact, it is an
    // unverifiable one.
    default: return null;
  }
}

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

export type PolicyViolation = {
  key: string;
  vendor: string;
  source: string;
  host: string;
  sourceClass: SourceClass;
  confidence: string;
  reason: string;
};

/** Check one entry. Returns null when it conforms. */
export function checkEntry(e: {
  key?: string; vendor?: string; source?: string | null; confidence?: string;
}): PolicyViolation | null {
  const cls = classifySource(e.source);
  const conf = (e.confidence || '') as Confidence;
  const base = {
    key: e.key || '(no key)', vendor: e.vendor || '(no vendor)',
    source: (e.source || '').trim(), host: hostOf(e.source), sourceClass: cls, confidence: conf,
  };
  if (!['high', 'medium', 'low'].includes(conf)) {
    return { ...base, reason: `confidence must be high|medium|low, got ${JSON.stringify(e.confidence)}` };
  }
  const ceiling = maxConfidenceFor(cls);
  if (ceiling === null) {
    return {
      ...base,
      reason: cls === 'none'
        ? 'no source URL — a date with no citation is unverifiable at any confidence'
        : `source host "${base.host || base.source}" is not a recognised official, community or aggregator host`,
    };
  }
  if (RANK[conf] > RANK[ceiling]) {
    return { ...base, reason: `${cls} source may carry at most "${ceiling}", found "${conf}"` };
  }
  return null;
}

/**
 * ⛔ A DATED, COUNTED RATCHET FOR PRE-EXISTING DEBT — NOT A WAIVER.
 *
 * 70 entries carry `high` with NO source URL at all. They violate the new rule
 * and violated the old one just as plainly; their notes name real documents
 * ("Aruba Central Managed Hardware Lifecycle Bulletin"), so a human did read a
 * source and simply did not record the link.
 *
 * ⛔ THE TWO TEMPTING FIXES ARE BOTH WRONG. Silently downgrading 70 published
 * dates changes what consumers already match devices against, on no new
 * evidence. Silently waiving them makes the rule decorative on its first day.
 * So the count is PINNED: the verifier fails if it ever rises, which means no
 * new unsourced entry can be added, while the existing debt stays visible with a
 * number on it and can only shrink. Lower this constant in the same commit as
 * any batch that gets its citations back.
 */
export const UNSOURCED_HIGH_BASELINE = 70;
export const UNSOURCED_HIGH_BASELINE_DATE = '2026-11-16';
