'use client';

import { useCallback, useEffect, useState } from 'react';

// ⛔ ONE CLICK, MANY CALLS — and that is not a workaround, it is the shape the
// constraint forces. NVD allows one request per six seconds without an API key,
// and the six supported vendors span 32 verified CPE strings: ~192 seconds of
// waiting at minimum, against a 10s function budget. So the server does ONE
// bounded step per call and this loops until it reports nothing left.
//
// ⛔ The loop is capped and stops on repeated failure. A sweep that retried for
// ever would look like progress while hammering a refusing API.

const btn: React.CSSProperties = {
  padding: '0.55rem 0.95rem',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  background: '#fff',
  fontSize: '0.9rem',
  cursor: 'pointer',
};

type Status = {
  targets: number;
  neverRun: number;
  staleOver24h: number;
  failing: number;
  advisories: number;
  byVendor: Array<{ vendor: string; advisories: number }>;
  rateLimitMs: number;
  hasApiKey: boolean;
  build: string;
  failures: Array<{
    vendor: string;
    cpeString: string;
    consecutiveFailures: number;
    lastError: string | null;
    lastAttemptAt: string | null;
  }>;
};

// ⛔ SIZED FOR VENDOR ROUND-ROBIN, NOT FOR 32 FLAT TARGETS. This was 200, set
// when a sweep meant "32 targets, a few pages each". Selection now rotates
// across vendors, and checkpoint owns 22 of the 32 strings — so each of its
// strings gets a turn roughly every 132 steps, and the vendor needs well over
// 200 steps to converge on its own. Measured 2026-09-18 against NVD:
// cisco_asa 392 CVEs, fortinet 279, paloalto 238, checkpoint 107, forcepoint 6,
// sangfor 5 — about 1,027 records at up to 100 per page, on top of the rotation
// cost. 200 would have stopped a healthy sweep short and read as a stall.
const MAX_STEPS = 1200;
const MAX_CONSECUTIVE_FAILS = 5; // stop sweeping if NVD is simply REFUSING
// ⛔ ITS OWN, MUCH LARGER BUDGET. A timeout is not a refusal: NVD answers
// identical requests between 1.5s and 14.4s, and one request can exceed the
// whole 10s function budget, so a slow response is EXPECTED and clears on
// retry. Counting it against MAX_CONSECUTIVE_FAILS stopped a working sweep
// five slow responses in — at 350 advisories with every vendor still paging.
// Kept separate rather than merged so a genuine refusal (a 404 wall, an NVD
// outage) still stops the run after five, which is the case that budget is for.
const MAX_RETRYABLE_FAILS = 60;
// ⛔ Its own budget, separate from MAX_STEPS. A throttled call does not consume
// a step (nothing was done), so without this the loop is unbounded — and it
// would wait ~6s per iteration rather than spinning hot, which is exactly what
// would stop anyone noticing. 400 x ~6.2s is generously past a full unkeyed
// sweep, so hitting it means the window genuinely is not advancing.
const MAX_THROTTLE_WAITS = 400;

export default function CveActions() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/ingest-cve');
      const d = await r.json();
      if (r.ok) setStatus(d);
    } catch {
      // A failed status read is not worth an alarm — the buttons still work.
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function sweep() {
    setBusy(true);
    setMsg(null);
    let steps = 0;
    let fails = 0;
    let retryables = 0;
    let throttleWaits = 0;
    let inserted = 0;
    let updated = 0;
    try {
      for (; steps < MAX_STEPS; steps++) {
        // ⛔ A TRANSPORT FAILURE IS A STEP FAILURE, NOT THE END OF THE SWEEP.
        // `fetch` REJECTS (rather than resolving non-ok) when the server never
        // answers — which is what a killed serverless invocation looks like
        // from here, reported as a bare "Failed to fetch". Letting that throw
        // out of the loop ended the whole sweep on one bad target, and because
        // the server died before its own catch, nothing was recorded anywhere
        // either. It now counts against MAX_CONSECUTIVE_FAILS like any other
        // failure, so one unreachable target costs a step, not the run.
        let d: any;
        try {
          const r = await fetch('/api/admin/ingest-cve', { method: 'POST' });
          d = await r.json();
          if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        } catch (err) {
          fails++;
          const why = err instanceof Error ? err.message : 'request failed';
          setProgress(`step failed (${why}) — continuing`);
          if (fails >= MAX_CONSECUTIVE_FAILS) {
            throw new Error(
              `${fails} consecutive failures — stopping. Last: ${why}. `
              + 'A "Failed to fetch" here means the server never answered, so the '
              + 'step was not recorded server-side either.'
            );
          }
          // Give a struggling backend a moment rather than retrying instantly.
          await new Promise((res) => setTimeout(res, 1500));
          continue;
        }

        // ⛔ HONOUR THE SERVER'S THROTTLE. It refused to call NVD because the
        // rate-limit window has not elapsed; hammering through that earns 403s
        // from NVD that look like an outage. The step is not counted, because
        // nothing was done.
        if (d.throttled) {
          const waitMs = Math.max(250, Math.min(30000, d.waitMs || 1000));
          setProgress(`rate limit — waiting ${(waitMs / 1000).toFixed(1)}s (${d.targetsRemaining} target(s) left)`);
          await new Promise((res) => setTimeout(res, waitMs));
          // ⛔ A refused call is not progress, so it does not consume a step —
          // but it MUST consume something, or the loop is unbounded. `steps--`
          // exactly cancels the `steps++` in the for-header, so without this
          // separate budget a server that always throttles would sweep for
          // ever. It would not spin hot (it waits ~6s each time), which is
          // precisely what would make it hard to notice.
          throttleWaits++;
          if (throttleWaits > MAX_THROTTLE_WAITS) {
            throw new Error(
              `still rate-limited after ${MAX_THROTTLE_WAITS} waits — stopping. `
              + 'Another sweep may be running, or the window is not advancing.'
            );
          }
          steps--;
          continue;
        }

        inserted += d.inserted || 0;
        updated += d.updated || 0;

        if (d.ok === false) {
          // ⛔ A TIMEOUT AND A REFUSAL ARE DIFFERENT OUTCOMES AND ARE COUNTED
          // SEPARATELY. The server says which. Merging them meant five slow NVD
          // responses ended a sweep that was working — and slow is the NORMAL
          // state of the largest, most valuable targets.
          if (d.retryable) {
            retryables++;
            fails = 0;
            setProgress(
              `${d.vendor ?? '?'} / ${d.cpeString ?? '?'} timed out (ours, not theirs) — `
              + `retrying later (${retryables}/${MAX_RETRYABLE_FAILS})`
            );
            if (retryables >= MAX_RETRYABLE_FAILS) {
              throw new Error(
                `${retryables} timeouts — stopping. NVD is consistently slower than one `
                + 'invocation allows. Progress is kept; run the sweep again.'
              );
            }
          } else {
            fails++;
            setProgress(`${d.vendor ?? '?'} / ${d.cpeString ?? '?'} failed (${d.error ?? 'unknown'}) — continuing`);
            // ⛔ Keep going: the server has already deprioritised that target, and
            // one unreachable CPE string must not stop the sweep.
            if (fails >= MAX_CONSECUTIVE_FAILS) {
              throw new Error(`${fails} consecutive failures — stopping. Last: ${d.error ?? 'unknown'}`);
            }
          }
        } else {
          fails = 0;
          setProgress(
            `${d.vendor} / ${String(d.cpeString).split(':').slice(3, 5).join(':')} — `
            + `${d.fetched} records, ${d.targetsRemaining} target(s) left`
          );
        }

        // ⛔ REFRESH THE COUNTERS MID-SWEEP. They used to update only on mount
        // and in the finally block, so for the length of a long run the panel
        // showed the PRE-SWEEP totals directly above a live progress line —
        // which reads as "it is storing nothing" while it is working fine.
        if (steps > 0 && steps % 10 === 0) refresh();

        if (d.targetsRemaining === 0 && !d.moreForThisTarget) break;
      }
      setMsg({ kind: 'ok', text: `Sweep finished after ${steps + 1} step(s): ${inserted} new, ${updated} updated.` });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Sweep failed.' });
    } finally {
      setProgress('');
      setBusy(false);
      refresh();
    }
  }

  // ⛔ ASKS THE FUNCTION WHAT KEY IT HAS, not what Netlify shows. A Netlify env
  // edit is baked in at BUILD time and does not reach an already-deployed
  // function, so the dashboard can display a working key while the running code
  // uses the previous one — which is exactly the state that produced a full
  // sweep of 404s on 2026-09-17. The fingerprint is masked; comparing it against
  // the first and last four characters in Netlify settles it in one look.
  async function testKey() {
    setBusy(true);
    setMsg(null);
    setProgress('probing NVD with and without the key (~7s)…');
    try {
      const r = await fetch('/api/admin/ingest-cve?probe=1');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const p = d.probe;
      const ok = p.keyed.status === 200 || (!p.hasApiKey && p.unkeyed.status === 200);
      setMsg({
        kind: ok ? 'ok' : 'err',
        text:
          `${p.verdict} `
          + `[key ${p.fingerprint ?? 'none'}, ${p.trimmedLength} chars`
          + `${p.rawLength !== p.trimmedLength ? `, ${p.rawLength - p.trimmedLength} trimmed` : ''}; `
          + `keyed ${p.keyed.status ?? p.keyed.error}, unkeyed ${p.unkeyed.status ?? p.unkeyed.error}]`,
      });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Probe failed.' });
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  async function oneStep() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/ingest-cve', { method: 'POST' });
      const d = await r.json();
      setMsg(
        d.ok === false
          ? { kind: 'err', text: `${d.vendor ?? '?'}: ${d.error ?? 'failed'}` }
          : { kind: 'ok', text: `${d.vendor} — ${d.fetched} records, ${d.inserted} new, ${d.updated} updated, ${d.targetsRemaining} target(s) left.` }
      );
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Step failed.' });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <div
      style={{
        marginTop: '1.5rem',
        padding: '1.25rem',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        background: '#fff',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Vulnerability feed (CVE)</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        Pulls NVD for every supported firewall vendor into the central CVE corpus. Separate from the
        EOL feed — nothing here touches the model catalogue.
      </div>

      {status && (
        <div style={{ fontSize: '0.85rem', marginBottom: '0.9rem', lineHeight: 1.7 }}>
          <div>
            <strong>{status.advisories.toLocaleString()}</strong> advisories ·{' '}
            {status.targets} targets · {status.neverRun} never run · {status.staleOver24h} stale
            {status.failing > 0 && <> · <span style={{ color: '#b42318' }}>{status.failing} failing</span></>}
          </div>
          <div style={{ opacity: 0.55, fontSize: '0.78rem' }}>
            build {status.build}
          </div>
          {status.byVendor.length > 0 && (
            <div style={{ opacity: 0.75 }}>
              {status.byVendor.map((v) => `${v.vendor} ${v.advisories}`).join(' · ')}
            </div>
          )}
          {/* ⛔ The API key is the single biggest reason to centralise: NVD
              allows 5 requests per rolling 30s without one and 50 with — a 10x
              difference, not the 2x an earlier draft of this comment implied.
              Unkeyed, a full sweep is ~200s of pure waiting. Say so where it is
              actioned, not only in a config file nobody opens. */}
          {!status.hasApiKey && (
            <div style={{ color: '#b54708' }}>
              No NVD_API_KEY set — rate limited to one request per {Math.round(status.rateLimitMs / 1000)}s.
              A key makes a full sweep roughly nine times faster.
            </div>
          )}
        </div>
      )}

      {/* ⛔ THE RECORDED REASON, ON SCREEN. A failing COUNT with no reason beside
          it is what turned every stall in this feature into guesswork — a killed
          invocation (which records nothing) and a caught error (which records a
          reason) are opposite problems and looked identical here. */}
      {status && status.failures.length > 0 && (
        <details style={{ marginBottom: '0.9rem', fontSize: '0.82rem' }}>
          <summary style={{ cursor: 'pointer', color: '#b42318' }}>
            Why {status.failing} target(s) are failing
          </summary>
          <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.5rem' }}>
            {status.failures.map((f) => (
              <div
                key={`${f.vendor}:${f.cpeString}`}
                style={{ padding: '0.5rem 0.6rem', background: '#fef3f2', borderRadius: 6 }}
              >
                <div style={{ fontWeight: 600 }}>
                  {f.vendor} / {f.cpeString.split(':').slice(3, 5).join(':')}{' '}
                  <span style={{ fontWeight: 400, opacity: 0.7 }}>
                    × {f.consecutiveFailures}
                  </span>
                </div>
                {/* ⛔ NULL IS NOT "no error" — it means the invocation DIED before
                    it could record one. Those are the two cases that must never
                    read the same, so they are worded differently. */}
                <div style={{ opacity: 0.85 }}>
                  {f.lastError ?? 'no reason recorded — the invocation was killed before it could write one'}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          style={{ ...btn, background: '#0b5fff', color: '#fff', borderColor: '#0b5fff' }}
          disabled={busy}
          onClick={sweep}
        >
          {busy ? 'Ingesting…' : 'Ingest CVEs (full sweep)'}
        </button>
        <button style={btn} disabled={busy} onClick={oneStep}>
          One step
        </button>
        <button style={btn} disabled={busy} onClick={testKey}>
          Test NVD key
        </button>
        <button style={btn} disabled={busy} onClick={refresh}>
          Refresh
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: '0.9rem', fontSize: '0.85rem', opacity: 0.8 }}>{progress}</div>
      )}
      {msg && (
        <div
          style={{
            marginTop: '0.9rem',
            fontSize: '0.85rem',
            color: msg.kind === 'ok' ? '#067647' : '#b42318',
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
