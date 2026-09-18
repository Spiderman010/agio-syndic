#!/usr/bin/env node
/**
 * m31 — ECHTE concurrentietests — `pnpm test:db:m31:concurrency`
 * ---------------------------------------------------------------------------
 *
 * Twee onafhankelijke psql-sessies met gecontroleerde barriers. Nadrukkelijk
 * GEEN transacties die na elkaar draaien: elke test houdt T1 open terwijl T2
 * begint, en meet of T2 werkelijk BLOKKEERT op een lock.
 *
 * Blokkeren wordt gedetecteerd doordat de sessie haar sentinel niet binnen de
 * deadline terugstuurt. Elke sessie draait met een begrensde `lock_timeout`,
 * zodat de suite nooit onbeperkt kan hangen. Een lock-wacht (55P03) en een
 * deadlock (40P01) worden apart herkend en apart gerapporteerd.
 *
 * Draait uitsluitend tegen een LOKALE PostgreSQL; geen netwerk, geen Supabase,
 * geen productie.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');
const PGHOST = process.env.PGHOST || '/tmp/pg31/sock';
const PGUSER = process.env.PGUSER || 'postgres';

const PAD = {
  fixture: join(REPO, 'supabase', 'tests', 'fixtures', 'pre_m31_baseline.sql'),
  migratie: join(REPO, 'supabase', 'migrations', '20260916220000_m31_charge_call_date_within_fiscal_year.sql'),
};

/** Hoe lang we wachten voordat we een uitblijvende sentinel "geblokkeerd" noemen. */
const BLOKKEER_MS = 1200;
/** Harde bovengrens per statement; voorkomt dat de suite ooit blijft hangen. */
const LOCK_TIMEOUT = '4s';

const ORG = '22222222-0000-0000-0000-0000000000c1';
const BLD = '33333333-0000-0000-0000-0000000000c1';
const FY1 = '44444444-0000-0000-0000-0000000000c1';
const FY2 = '44444444-0000-0000-0000-0000000000c2';

function psqlEenmalig(db, sql, { stop = true } = {}) {
  const args = ['-h', PGHOST, '-U', PGUSER, '-d', db, '-q', '-A', '-t'];
  if (stop) args.push('-v', 'ON_ERROR_STOP=1');
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' });
  return { code: r.status, uit: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Een open psql-sessie die statement voor statement wordt aangestuurd. */
function sessie(db, naam) {
  const p = spawn('psql', ['-h', PGHOST, '-U', PGUSER, '-d', db, '-q', '-A', '-t'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  p.stdout.on('data', (d) => { buffer += d; });
  p.stderr.on('data', (d) => { buffer += d; });
  let teller = 0;
  /** Het laatst verstuurde statement, zodat `oogst()` exact hetzelfde venster leest. */
  let lopend = null;

  /** De uitvoer die HOORT bij dit statement: alles tussen de startpositie en de sentinel. */
  const venster = ({ merk, start }) => {
    const idx = buffer.indexOf(merk, start);
    return idx === -1 ? null : buffer.slice(start, idx).trim();
  };

  /**
   * Stuurt SQL en wacht op de sentinel.
   * Komt die niet binnen `wachtMs`, dan geldt het statement als GEBLOKKEERD.
   */
  const stuur = async (sql, wachtMs = 8000) => {
    const merk = `__KLAAR_${naam}_${++teller}__`;
    const start = buffer.length;
    lopend = { merk, start };
    p.stdin.write(`${sql}\n\\echo ${merk}\n`);
    const deadline = Date.now() + wachtMs;
    for (;;) {
      const v = venster(lopend);
      if (v !== null) return { geblokkeerd: false, uit: v };
      if (Date.now() >= deadline) return { geblokkeerd: true, uit: buffer.slice(start).trim() };
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  /**
   * Leest alsnog het resultaat van een eerder geblokkeerd statement.
   *
   * Leest bewust HETZELFDE venster als `stuur()` — dus de tekst VOOR de
   * sentinel. Alles na de sentinel hoort bij een volgend statement, en die
   * verwarring maakte een geweigerde transactie eerder onzichtbaar.
   */
  const oogst = async (wachtMs = 8000) => {
    const deadline = Date.now() + wachtMs;
    for (;;) {
      const v = venster(lopend);
      if (v !== null) return { geblokkeerd: false, uit: v };
      if (Date.now() >= deadline) return { geblokkeerd: true, uit: buffer.slice(lopend.start).trim() };
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  const sluit = () => { try { p.stdin.end(); } catch { /* al dicht */ } p.kill(); };
  const alles = () => buffer;
  return { stuur, oogst, sluit, alles };
}

/** Wat er in een psql-uitvoer staat, teruggebracht tot een stabiel etiket. */
function duiding(tekst) {
  if (/ALLOC_CALL_DATE_OUTSIDE_FY/.test(tekst)) return 'OUTSIDE_FY';
  if (/ALLOC_CALL_IMMUTABLE/.test(tekst)) return 'IMMUTABLE';
  if (/55P03|lock timeout|canceling statement due to lock timeout/i.test(tekst)) return 'LOCK_TIMEOUT';
  if (/40P01|deadlock detected/i.test(tekst)) return 'DEADLOCK';
  if (/^ERROR|\nERROR/.test(tekst)) return 'ANDERE_FOUT';
  return 'OK';
}

const OPROEP = (id, datum, fy = FY1) => `
INSERT INTO public.charge_calls
  (id, organization_id, building_id, fiscal_year_id, type, total_amount, call_date,
   alloc_method, alloc_scope, alloc_weight_source, alloc_total_cents,
   alloc_denominator, alloc_unit_count, alloc_remainder_cents, alloc_tie_breaker, alloc_algo_version)
VALUES ('${id}', '${ORG}', '${BLD}', '${fy}', 'regulier', 1200.00, '${datum}',
   'tantieme', 'whole_building', 'unit_tantiemes', 120000, 100, 2, 0,
   'remainder_desc_unit_id_asc', 1);`;

async function main() {
  if (psqlEenmalig('postgres', 'SELECT 1;', { stop: false }).code !== 0) {
    console.error(`\nGEBLOKKEERD: geen bereikbare lokale PostgreSQL op ${PGHOST}.\n`);
    return 2;
  }

  const DB = 'm31_conc';
  const resultaten = [];
  const noteer = (naam, ok, detail) => {
    resultaten.push({ naam, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${naam}${detail ? `  — ${detail}` : ''}`);
  };

  /** Verse database met fixture, m31 en de vaste testdata. */
  const bouw = () => {
    psqlEenmalig('postgres', `DROP DATABASE IF EXISTS ${DB};`, { stop: false });
    let r = psqlEenmalig('postgres', `CREATE DATABASE ${DB};`);
    if (r.code !== 0) throw new Error(`database aanmaken faalde:\n${r.uit}`);
    r = psqlEenmalig(DB, readFileSync(PAD.fixture, 'utf8'));
    if (r.code !== 0) throw new Error(`fixture faalde:\n${r.uit}`);
    r = psqlEenmalig(DB, readFileSync(PAD.migratie, 'utf8'));
    if (r.code !== 0) throw new Error(`m31 faalde:\n${r.uit}`);
    r = psqlEenmalig(DB, `
      INSERT INTO public.organizations (id, name) VALUES ('${ORG}', 'Org C');
      INSERT INTO public.buildings (id, organization_id, name) VALUES ('${BLD}', '${ORG}', 'Gebouw C');
      INSERT INTO public.fiscal_years (id, organization_id, building_id, year, start_date, end_date, status)
      VALUES ('${FY1}', '${ORG}', '${BLD}', 2026, '2026-04-01', '2026-09-30', 'open'),
             ('${FY2}', '${ORG}', '${BLD}', 2027, '2027-04-01', '2027-09-30', 'open');`);
    if (r.code !== 0) throw new Error(`testdata faalde:\n${r.uit}`);
  };

  /** Telt oproepen die buiten hun boekjaar liggen. 0 is de invariant. */
  const schendingen = () => {
    const r = psqlEenmalig(DB, `SELECT count(*) FROM public.charge_calls cc
      JOIN public.fiscal_years fy ON fy.id = cc.fiscal_year_id
      WHERE cc.call_date < fy.start_date OR cc.call_date > fy.end_date;`, { stop: false });
    return Number(r.uit.trim());
  };

  const opening = `BEGIN; SET lock_timeout = '${LOCK_TIMEOUT}'; SET statement_timeout = '15s';`;

  let exitcode = 0;
  try {
    console.log('\nm31 concurrentietests (twee gelijktijdige sessies)');
    console.log(`host ${PGHOST}   lock_timeout ${LOCK_TIMEOUT}\n`);

    // ── C1: INSERT begint eerst ────────────────────────────────────────────
    const c1 = async (ronde) => {
      bouw();
      const T1 = sessie(DB, 't1'), T2 = sessie(DB, 't2');
      try {
        await T1.stuur(opening);
        await T2.stuur(opening);

        // T1 legt een oproep vast die BINNEN de huidige periode valt.
        const r1 = await T1.stuur(OPROEP('55555555-0000-0000-0000-0000000000c1', '2026-06-15'));
        if (duiding(r1.uit) !== 'OK') return { ok: false, detail: `T1-insert faalde: ${duiding(r1.uit)}` };

        // T2 versmalt ONDERTUSSEN het boekjaar zo dat die oproep erbuiten valt.
        const r2 = await T2.stuur(
          `UPDATE public.fiscal_years SET start_date = '2026-07-01' WHERE id = '${FY1}';`,
          BLOKKEER_MS);
        const t2Blokkeerde = r2.geblokkeerd;

        await T1.stuur('COMMIT;');
        const r2b = t2Blokkeerde ? await T2.oogst() : r2;
        const t2Uitkomst = duiding(r2b.uit);
        const r2c = await T2.stuur('COMMIT;');
        const t2Gecommit = t2Uitkomst === 'OK' && duiding(r2c.uit) === 'OK';

        const fout = schendingen();
        // De eis: niet BEIDE mogen slagen, en de invariant moet daarna gelden.
        const ok = !t2Gecommit && fout === 0;
        return {
          ok,
          detail: `ronde ${ronde}: T2 ${t2Blokkeerde ? 'BLOKKEERDE' : 'blokkeerde NIET'}, ` +
                  `uitkomst ${t2Uitkomst}, beide-gecommit=${t2Gecommit}, schendingen=${fout}`,
        };
      } finally { T1.sluit(); T2.sluit(); }
    };

    // ── C2: boekjaar-UPDATE begint eerst ───────────────────────────────────
    const c2 = async (ronde) => {
      bouw();
      const T1 = sessie(DB, 't1'), T2 = sessie(DB, 't2');
      try {
        await T1.stuur(opening);
        await T2.stuur(opening);

        const r1 = await T1.stuur(
          `UPDATE public.fiscal_years SET start_date = '2026-07-01' WHERE id = '${FY1}';`);
        if (duiding(r1.uit) !== 'OK') return { ok: false, detail: `T1-update faalde: ${duiding(r1.uit)}` };

        // T2 voegt ONDERTUSSEN een oproep toe die alleen in de OUDE periode gold.
        const r2 = await T2.stuur(OPROEP('55555555-0000-0000-0000-0000000000c2', '2026-06-15'), BLOKKEER_MS);
        const t2Blokkeerde = r2.geblokkeerd;

        await T1.stuur('COMMIT;');
        const r2b = t2Blokkeerde ? await T2.oogst() : r2;
        const t2Uitkomst = duiding(r2b.uit);
        const r2c = await T2.stuur('COMMIT;');
        const t2Gecommit = t2Uitkomst === 'OK' && duiding(r2c.uit) === 'OK';

        const fout = schendingen();
        const ok = !t2Gecommit && fout === 0;
        return {
          ok,
          detail: `ronde ${ronde}: T2 ${t2Blokkeerde ? 'BLOKKEERDE' : 'blokkeerde NIET'}, ` +
                  `uitkomst ${t2Uitkomst}, beide-gecommit=${t2Gecommit}, schendingen=${fout}`,
        };
      } finally { T1.sluit(); T2.sluit(); }
    };

    // C1 en C2 meerdere keren, om timingtoeval uit te sluiten.
    const RONDEN = 5;
    for (const [naam, fn] of [['C1 — INSERT eerst', c1], ['C2 — boekjaar-UPDATE eerst', c2]]) {
      let allesOk = true; const details = [];
      for (let i = 1; i <= RONDEN; i++) {
        const r = await fn(i);
        if (!r.ok) allesOk = false;
        details.push(r.detail);
      }
      noteer(`${naam} (${RONDEN} ronden)`, allesOk, details[0] + (allesOk ? ` · ${RONDEN}x identiek` : ` · AFWIJKEND: ${details.join(' | ')}`));
    }

    // ── C3: gelijktijdig geldig — beide mogen slagen ───────────────────────
    {
      bouw();
      const T1 = sessie(DB, 't1'), T2 = sessie(DB, 't2');
      try {
        await T1.stuur(opening); await T2.stuur(opening);
        // Verruimen: alle bestaande en nieuwe oproepen blijven geldig.
        const r1 = await T1.stuur(
          `UPDATE public.fiscal_years SET start_date = '2026-01-01', end_date = '2026-12-31' WHERE id = '${FY1}';`);
        const r2 = await T2.stuur(OPROEP('55555555-0000-0000-0000-0000000000c3', '2026-06-15'), BLOKKEER_MS);
        const blok = r2.geblokkeerd;
        await T1.stuur('COMMIT;');
        const r2b = blok ? await T2.oogst() : r2;
        const u2 = duiding(r2b.uit);
        const c = await T2.stuur('COMMIT;');
        const beide = duiding(r1.uit) === 'OK' && u2 === 'OK' && duiding(c.uit) === 'OK';
        const fout = schendingen();
        noteer('C3 — gelijktijdig geldig, beide slagen', beide && fout === 0,
          `T2 ${blok ? 'wachtte kort' : 'wachtte niet'}, uitkomst ${u2}, geen deadlock, schendingen=${fout}`);
      } finally { T1.sluit(); T2.sluit(); }
    }

    // ── C4: verschillende boekjaren blokkeren elkaar niet ──────────────────
    {
      bouw();
      const T1 = sessie(DB, 't1'), T2 = sessie(DB, 't2');
      try {
        await T1.stuur(opening); await T2.stuur(opening);
        await T1.stuur(`UPDATE public.fiscal_years SET start_date = '2026-05-01' WHERE id = '${FY1}';`);
        // Andere fiscal_year_id: mag NIET wachten.
        const r2 = await T2.stuur(OPROEP('55555555-0000-0000-0000-0000000000c4', '2027-06-15', FY2), BLOKKEER_MS);
        const ok = !r2.geblokkeerd && duiding(r2.uit) === 'OK';
        await T1.stuur('COMMIT;'); await T2.stuur('COMMIT;');
        noteer('C4 — ander boekjaar blokkeert niet onnodig', ok && schendingen() === 0,
          r2.geblokkeerd ? 'T2 wachtte ten onrechte' : 'T2 liep meteen door');
      } finally { T1.sluit(); T2.sluit(); }
    }

    // ── C5: begrensde wachttijd, en deadlock apart herkenbaar ──────────────
    {
      bouw();
      const T1 = sessie(DB, 't1'), T2 = sessie(DB, 't2');
      try {
        await T1.stuur(opening); await T2.stuur(opening);
        await T1.stuur(OPROEP('55555555-0000-0000-0000-0000000000c5', '2026-06-15'));
        // T1 blijft open; T2 loopt gegarandeerd in zijn lock_timeout.
        const begin = Date.now();
        const r2 = await T2.stuur(
          `UPDATE public.fiscal_years SET start_date = '2026-07-01' WHERE id = '${FY1}';`, 12000);
        const duur = Date.now() - begin;
        const u = duiding(r2.uit);
        const ok = u === 'LOCK_TIMEOUT' && duur < 11000;
        noteer('C5 — begrensde lock-wacht, geen oneindig hangen', ok,
          `uitkomst ${u} na ${duur} ms (lock_timeout ${LOCK_TIMEOUT}); deadlock zou 40P01 geven`);
        await T1.stuur('ROLLBACK;'); await T2.stuur('ROLLBACK;');
      } finally { T1.sluit(); T2.sluit(); }
    }

    exitcode = resultaten.some((r) => !r.ok) ? 1 : 0;
  } catch (e) {
    console.error(`\nGEBLOKKEERD: ${e.message}`);
    exitcode = 2;
  } finally {
    psqlEenmalig('postgres', `DROP DATABASE IF EXISTS ${DB};`, { stop: false });
    const gefaald = resultaten.filter((r) => !r.ok).length;
    console.log(`\n${resultaten.length - gefaald} van ${resultaten.length} concurrentietests geslaagd.\n`);
  }
  return exitcode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
