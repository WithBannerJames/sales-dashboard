// Password-gated roadmap. Everything the 2026-09 reset shelved is listed under
// "Previous Features" so nothing is lost, plus what is queued and what is known-broken.
// Content comes from /api/roadmap-auth on a correct password — it is never in the bundle.

import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

export default function Roadmap() {
  const [password, setPassword] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/roadmap-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Incorrect password');
      setData(j);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head><title>Roadmap — Banner</title></Head>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h1 className="text-[15px] font-semibold tracking-tight">Roadmap</h1>
          <Link href="/deals" className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            Back to deals
          </Link>
        </header>

        {!data ? (
          <div className="flex items-center justify-center px-5 py-24">
            <form onSubmit={submit} className="w-full max-w-sm rounded-lg bg-white p-5 ring-1 ring-slate-200">
              <label htmlFor="pw" className="block text-[13px] font-medium">Password</label>
              <p className="mt-1 text-[11px] text-slate-500">
                Everything parked during the reset is listed here.
              </p>
              <input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="mt-3 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-slate-400"
              />
              {err && <p className="mt-2 text-[11px] text-rose-600">{err}</p>}
              <button
                type="submit"
                disabled={busy || !password}
                className="mt-3 w-full rounded-md bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-40"
              >
                {busy ? 'Checking…' : 'Open roadmap'}
              </button>
            </form>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-8 px-5 py-8">
            <section>
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500">Previous features</h2>
              <p className="mt-1 text-[12px] text-slate-600">
                Shelved {data.shelvedOn}. All of this code is still in the repo and nothing was deleted —
                reviving a module means removing its redirect in <code className="text-[11px]">next.config.js</code> and
                putting it back in the nav.
              </p>
              <div className="mt-4 space-y-5">
                {data.previousFeatures.map((g) => (
                  <div key={g.group}>
                    <h3 className="text-[12px] font-semibold text-slate-700">
                      {g.group} <span className="font-normal text-slate-400">{g.items.length}</span>
                    </h3>
                    <ul className="mt-1.5 space-y-1.5">
                      {g.items.map((it) => (
                        <li key={it.name} className="rounded-md bg-white px-3 py-2 ring-1 ring-slate-200">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-[12.5px] font-medium">{it.name}</span>
                            <code className="text-[10.5px] text-slate-400">{it.route}</code>
                          </div>
                          <p className="mt-0.5 text-[11.5px] leading-snug text-slate-600">{it.note}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>

            <Section title="Next up" items={data.nextUp} />
            <Section title="Known issues" items={data.knownIssues} />
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, items }) {
  if (!items?.length) return null;
  return (
    <section>
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <ul className="mt-3 space-y-1.5">
        {items.map((it) => (
          <li key={it.name} className="rounded-md bg-white px-3 py-2 ring-1 ring-slate-200">
            <span className="text-[12.5px] font-medium">{it.name}</span>
            <p className="mt-0.5 text-[11.5px] leading-snug text-slate-600">{it.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
