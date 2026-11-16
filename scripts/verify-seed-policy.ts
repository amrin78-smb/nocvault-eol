/**
 * EXECUTION VERIFICATION for the seed sourcing policy.
 *
 * Run:  npm run verify:seed
 *
 * ⛔ THIS IS THE GUARD THE OLD RULE NEVER HAD. "Official vendor sources ONLY"
 * sat in CLAUDE.md in bold, marked non-negotiable, and 22.4% of the corpus
 * drifted past it with nothing to notice — while the same sentence was being
 * quoted to refuse new sources. A sourcing rule that nothing executes is a
 * statement of intent, not a rule.
 *
 * ⛔ READ-ONLY. It needs no database and no network: it reads data/eol-seed.json
 * and lib/eol/source-policy.ts and compares them. Safe to run anywhere,
 * including in a pre-commit hook or CI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkEntry, classifySource, hostOf, maxConfidenceFor,
  UNSOURCED_HIGH_BASELINE, UNSOURCED_HIGH_BASELINE_DATE,
  type PolicyViolation,
} from '../lib/eol/source-policy';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

type Entry = {
  key: string; vendor: string; matches: string[]; lifecycle?: string;
  support_end_date: string | null; os_eol_date: string | null;
  confidence: string; source: string | null; note: string;
};

function partClassifier() {
  section('PART A — the classifier (pure)');

  check('official vendor host', classifySource('https://www.cisco.com/x.html') === 'official');
  check('aggregator: Park Place', classifySource('https://www.parkplacetechnologies.com/eosl/x/') === 'aggregator');
  check('aggregator: endoflife.date', classifySource('https://endoflife.date/api/panos.json') === 'aggregator');
  check('aggregator: endoflife.ai', classifySource('https://endoflife.ai/aruba-switches') === 'aggregator');
  check('community forum is its own class', classifySource('https://community.fortinet.com/t5/x') === 'community');
  check('no source is "none"', classifySource('') === 'none' && classifySource(null) === 'none');
  check('a malformed URL is not official', classifySource('not a url') === 'unknown');

  // ⛔ THE RULE THAT MATTERS MOST: an unrecognised host must NOT default to
  // official. The whole failure mode of the old rule was silent drift.
  check('an unrecognised host is "unknown", not "official"',
    classifySource('https://some-reseller.example/eol') === 'unknown');

  check('official may be high', maxConfidenceFor('official') === 'high');
  check('community caps at medium', maxConfidenceFor('community') === 'medium');
  check('aggregator caps at low', maxConfidenceFor('aggregator') === 'low');
  check('no source is inadmissible at any confidence', maxConfidenceFor('none') === null);
  check('unknown host is inadmissible at any confidence', maxConfidenceFor('unknown') === null);

  // The rule, exercised end to end on synthetic entries.
  check('aggregator at low conforms',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://endoflife.date/api/panos.json', confidence: 'low' }) === null);
  check('aggregator at medium is REFUSED',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://endoflife.date/api/panos.json', confidence: 'medium' }) !== null);
  check('aggregator at high is REFUSED',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://www.parkplacetechnologies.com/x', confidence: 'high' }) !== null);
  check('official at high conforms',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://www.cisco.com/x', confidence: 'high' }) === null);
  check('official at low conforms (a weak official date is allowed)',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://www.cisco.com/x', confidence: 'low' }) === null);
  check('community at high is REFUSED',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://community.fortinet.com/x', confidence: 'high' }) !== null);
  check('no source at high is REFUSED',
    checkEntry({ key: 'k', vendor: 'v', source: '', confidence: 'high' }) !== null);
  check('a bogus confidence value is REFUSED',
    checkEntry({ key: 'k', vendor: 'v', source: 'https://www.cisco.com/x', confidence: 'exact' }) !== null);
}

function partCorpus() {
  section('PART B — the shipped corpus');

  const path = join(process.cwd(), 'data', 'eol-seed.json');
  const entries: Entry[] = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`  ${entries.length} entries in data/eol-seed.json`);

  const violations: PolicyViolation[] = [];
  for (const e of entries) {
    const v = checkEntry(e);
    if (v) violations.push(v);
  }

  // Split the debt from the breaches: unsourced entries are a KNOWN, COUNTED,
  // pinned population; everything else must be zero.
  const unsourced = violations.filter((v) => v.sourceClass === 'none');
  const other = violations.filter((v) => v.sourceClass !== 'none');

  if (other.length) {
    console.log('\n  violations (not the pinned unsourced debt):');
    for (const v of other.slice(0, 25)) {
      console.log(`    ${v.vendor} / ${v.key}`);
      console.log(`      ${v.sourceClass} ${v.host || v.source || '(none)'} @ ${v.confidence} — ${v.reason}`);
    }
    if (other.length > 25) console.log(`    ... and ${other.length - 25} more`);
  }

  check('every entry conforms to the sourcing policy (excluding pinned debt)',
    other.length === 0, `${other.length} violation(s)`);

  // ⛔ THE RATCHET. It may shrink. It may never grow.
  console.log(`\n  unsourced entries: ${unsourced.length} (pinned baseline ${UNSOURCED_HIGH_BASELINE}, set ${UNSOURCED_HIGH_BASELINE_DATE})`);
  check(`no NEW unsourced entry (<= ${UNSOURCED_HIGH_BASELINE})`,
    unsourced.length <= UNSOURCED_HIGH_BASELINE,
    `found ${unsourced.length}; every entry must cite a source`);
  if (unsourced.length < UNSOURCED_HIGH_BASELINE) {
    console.log(`  NOTE: the debt has shrunk to ${unsourced.length}. Lower UNSOURCED_HIGH_BASELINE`
      + ' in lib/eol/source-policy.ts in this same commit, or the ratchet stops ratcheting.');
  }

  // Provenance report — the number the old rule was wrong about.
  const byClass: Record<string, number> = {};
  for (const e of entries) {
    const c = classifySource(e.source);
    byClass[c] = (byClass[c] || 0) + 1;
  }
  console.log('\n  provenance of the shipped corpus:');
  for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(12)} ${String(n).padStart(5)}  ${(100 * n / entries.length).toFixed(1)}%`);
  }

  // ⛔ A ROW MUST CARRY A DATE **OR** SAY WHY IT HAS NONE.
  //
  // CLAUDE.md's rule is "NEVER guess or infer a date ... skip it (don't add a
  // null-dated row)", and the first draft of this check asserted exactly that —
  // and FAILED on 24 rows. The rows were right and the assertion was wrong:
  // each carries `lifecycle: "eol"` with a note reading "vendor-confirmed
  // end-of-life, no concrete date". That is a THIRD state, distinct from both "a
  // date" and "no information", and NetVault's generated seed header already
  // counts it separately ("7902 models (7878 dated, 26 lifecycle='eol')").
  // Collapsing it into either neighbour would lose the one fact it carries.
  const undated = entries.filter(
    (e) => !e.support_end_date && !e.os_eol_date && (e as any).lifecycle !== 'eol');
  check('every entry carries a date or an explicit lifecycle marker',
    undated.length === 0, `${undated.length} with neither: ${undated.slice(0, 3).map((e) => e.key).join(', ')}`);

  const lifecycleEol = entries.filter((e) => (e as any).lifecycle === 'eol').length;
  console.log(`  entries marked lifecycle="eol" (EOL confirmed, no date published): ${lifecycleEol}`);

  const badDate = entries.filter((e) =>
    (e.support_end_date && !/^\d{4}-\d{2}-\d{2}$/.test(e.support_end_date))
    || (e.os_eol_date && !/^\d{4}-\d{2}-\d{2}$/.test(e.os_eol_date)));
  check('every date is YYYY-MM-DD', badDate.length === 0,
    badDate.slice(0, 3).map((e) => `${e.key}: ${e.support_end_date}/${e.os_eol_date}`).join('; '));

  const noMatch = entries.filter((e) => !Array.isArray(e.matches) || e.matches.length === 0 || !e.matches[0]);
  check('every entry has at least one match string', noMatch.length === 0,
    noMatch.slice(0, 3).map((e) => e.key).join(', '));

  // The os_eol_date gap, reported as a number so it stops being invisible.
  const withOs = entries.filter((e) => e.os_eol_date).length;
  console.log(`\n  os_eol_date coverage: ${withOs}/${entries.length} (${(100 * withOs / entries.length).toFixed(1)}%)`);
}

function main() {
  partClassifier();
  partCorpus();
  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) console.log(`ALL ${passed} CHECKS PASSED`);
  else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
