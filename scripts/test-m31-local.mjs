#!/usr/bin/env node
/**
 * Lokale database-integratietest voor m31 — `pnpm test:db:m31`
 * ---------------------------------------------------------------------------
 *
 * Draait tegen een LOKALE PostgreSQL en maakt geen verbinding met Supabase,
 * met productie of met enig netwerk. De m30-runner gebruikt Docker; deze niet,
 * omdat de uitvoeromgeving van dit project geen images kan ophalen. Gedrag en
 * strengheid zijn wel bewust gelijk gehouden.
 *
 * De migratieketen kan een lege database niet opbouwen (m1-m5 zijn lege
 * plaatshouders, zie docs/migration-drift.md), dus elke scenario start vanaf
 * `supabase/tests/fixtures/pre_m31_baseline.sql`. Dat is nadrukkelijk GEEN
 * reconstructie van het productieschema.
 *
 * Vier scenario's, elk in een eigen database:
 *
 *   hoofdsuite   fixture -> m31 -> m31_charge_call_date_within_fy.sql
 *   residu       na de suite mag er geen enkele testrij zijn achtergebleven
 *   preflight 1  bestaande oproep buiten zijn boekjaar -> m31 MOET afbreken
 *   preflight 2  geldige, niet-lege bestaande data     -> m31 MOET slagen
 *
 * Verbinding: PGHOST uit het environment, standaard de socketmap die
 * `scripts/pg-local.sh` gebruikt. Er wordt nooit via TCP naar buiten verbonden.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');

const PGHOST = process.env.PGHOST || '/tmp/pg31/sock';
const PGUSER = process.env.PGUSER || 'postgres';

const PAD = {
  fixture: join(REPO, 'supabase', 'tests', 'fixtures', 'pre_m31_baseline.sql'),
  cases: join(REPO, 'supabase', 'tests', 'fixtures', 'm31_preflight_cases.sql'),
  migratie: join(REPO, 'supabase', 'migrations', '20260916220000_m31_charge_call_date_within_fiscal_year.sql'),
  suite: join(REPO, 'supabase', 'tests', 'm31_charge_call_date_within_fy.sql'),
};

/**
 * De exact verwachte labelset, volledig uitgeschreven. Zo detecteert de runner
 * ook een ONTBREKEND of DUBBEL label; een telling van 23 regels doet dat niet.
 */
export const VERWACHTE_LABELS = Object.freeze([
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7',
  'U1', 'U2', 'U3',
  'P1', 'P2', 'P3', 'P4',
  'R1', 'R2', 'R3', 'R4',
  'S1', 'S2', 'S3',
  'G1', 'G2',
  'N1', 'N2',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
]);

/**
 * Fail-closed validatie van de psql-uitvoer. `ok` is alleen waar als elke
 * verwachte assertie precies een keer voorkomt en PASS is, er geen onbekend
 * label bij zit, de samenvatting daarmee overeenstemt, en de suite via de
 * BEDOELDE rapport-exceptie is geeindigd.
 */
export function controleerLabels(uit) {
  const redenen = [];

  if (!/=== m31 call_date binnen boekjaar ===/.test(uit)) {
    redenen.push('geen rapportkop — de suite brak voortijdig af');
  }

  const gezien = new Map();
  for (const m of uit.matchAll(/(PASS|FAIL)\s{2}([A-Z]\d+[a-z]?)\s/g)) {
    const [, status, label] = m;
    if (!gezien.has(label)) gezien.set(label, []);
    gezien.get(label).push(status);
  }

  const verwacht = new Set(VERWACHTE_LABELS);
  for (const label of VERWACHTE_LABELS) {
    const statussen = gezien.get(label);
    if (!statussen) { redenen.push(`label ontbreekt: ${label}`); continue; }
    if (statussen.length > 1) redenen.push(`label ${statussen.length}x aanwezig: ${label}`);
    if (statussen.includes('FAIL')) redenen.push(`label gefaald: ${label}`);
  }
  for (const label of gezien.keys()) {
    if (!verwacht.has(label)) redenen.push(`onbekend label: ${label}`);
  }

  const sam = uit.match(/(\d+)\s+geslaagd,\s+(\d+)\s+gefaald/);
  let samenvatting = null;
  if (!sam) {
    redenen.push('geen samenvattingsregel gevonden');
  } else {
    samenvatting = { geslaagd: Number(sam[1]), gefaald: Number(sam[2]) };
    const alles = [...gezien.values()].flat();
    const zelfGeslaagd = alles.filter((s) => s === 'PASS').length;
    const zelfGefaald = alles.length - zelfGeslaagd;
    if (samenvatting.geslaagd !== zelfGeslaagd || samenvatting.gefaald !== zelfGefaald) {
      redenen.push(
        `samenvatting (${samenvatting.geslaagd}/${samenvatting.gefaald}) wijkt af van de getelde regels ` +
        `(${zelfGeslaagd}/${zelfGefaald})`);
    }
  }

  return { ok: redenen.length === 0, redenen, gezien, samenvatting };
}

async function main() {
  const psql = (db, sql, { stopOnError = true } = {}) => {
    const args = ['-h', PGHOST, '-U', PGUSER, '-d', db];
    if (stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
    const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' });
    return { code: r.status, uit: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const lees = (p) => readFileSync(p, 'utf8');

  const proef = psql('postgres', 'SELECT 1;', { stopOnError: false });
  if (proef.code !== 0) {
    console.error('\nGEBLOKKEERD: geen bereikbare lokale PostgreSQL.');
    console.error(`Geprobeerd: host=${PGHOST} user=${PGUSER}`);
    console.error('Start een lokaal cluster en zet PGHOST naar de socketmap.\n');
    return 2;
  }

  const resultaten = [];
  const noteer = (naam, ok, detail) => {
    resultaten.push({ naam, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${naam}${detail ? `  — ${detail}` : ''}`);
  };

  const verseDb = (naam, { metCases = false } = {}) => {
    let r = psql('postgres', `DROP DATABASE IF EXISTS ${naam};`, { stopOnError: false });
    r = psql('postgres', `CREATE DATABASE ${naam};`, { stopOnError: false });
    if (r.code !== 0) throw new Error(`kon database ${naam} niet aanmaken:\n${r.uit}`);
    r = psql(naam, lees(PAD.fixture));
    if (r.code !== 0) throw new Error(`fixture faalde in ${naam}:\n${r.uit}`);
    if (metCases) {
      r = psql(naam, lees(PAD.cases));
      if (r.code !== 0) throw new Error(`preflightfixture faalde in ${naam}:\n${r.uit}`);
    }
    return naam;
  };

  const tel = (db, sql) => {
    const r = psql(db, sql, { stopOnError: false });
    const m = r.uit.match(/-{3,}\s*\n\s*(-?\d+)/);
    return m ? Number(m[1]) : NaN;
  };

  // Telt de objecten die m31 aanmaakt. Na een afgebroken migratie moet dit 0 zijn.
  const M31_RESTEN = `
SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls'))
+ (SELECT count(*) FROM pg_trigger
    WHERE tgname IN ('trig_01_cc_date_in_fy','trig_01_fy_period_covers_calls')) AS resten;`;

  let exitcode = 0;
  try {
    console.log('\nm31 lokale database-integratietest');
    const v = psql('postgres', 'SHOW server_version;', { stopOnError: false });
    console.log(`server_version ${(v.uit.match(/\n\s*([\d.]+)/) ?? [, '?'])[1]}`);
    console.log(`host           ${PGHOST}\n`);

    // ── hoofdsuite + residu ────────────────────────────────────────────────
    {
      const db = verseDb('m31_main');
      let r = psql(db, lees(PAD.migratie));
      if (r.code !== 0) {
        noteer('hoofdsuite: m31 toepassen', false, 'migratie faalde');
        console.log(r.uit.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 5).join('\n'));
      } else {
        noteer('hoofdsuite: m31 toepassen', true, 'exitcode 0, postcheck doorstaan');

        r = psql(db, lees(PAD.suite), { stopOnError: false });
        const c = controleerLabels(r.uit);
        noteer(`hoofdsuite: exacte labelset ${VERWACHTE_LABELS.length}/${VERWACHTE_LABELS.length}`, c.ok,
          c.ok
            ? `alle ${VERWACHTE_LABELS.length} labels precies eenmaal en PASS; samenvatting ${c.samenvatting.geslaagd}/${c.samenvatting.gefaald}`
            : c.redenen.slice(0, 8).join(' · '));

        // De suite eindigt op een rapport-exceptie, dus alles hoort te zijn
        // teruggedraaid. Nul rijen in elke door de test gevulde tabel.
        const rijen = tel(db, `
          SELECT (SELECT count(*) FROM public.charge_calls)
               + (SELECT count(*) FROM public.fiscal_years)
               + (SELECT count(*) FROM public.organizations) AS n;`);
        noteer('residu: transactionele rollback laat niets achter', rijen === 0,
          `${rijen} rij(en) gevonden na de suite`);
      }
    }

    // ── preflight negatief ─────────────────────────────────────────────────
    {
      const db = verseDb('m31_pf1', { metCases: true });
      let r = psql(db, 'SELECT public.m31_preflight_case_1_ongeldig();');
      if (r.code !== 0) {
        noteer('preflight 1: bestaande oproep buiten zijn boekjaar', false, 'fixture kon niet worden geladen');
      } else {
        const voor = tel(db, 'SELECT count(*) FROM public.charge_calls;');
        r = psql(db, `BEGIN;\n${lees(PAD.migratie)}\nCOMMIT;`);
        const brakAf = r.code !== 0;
        const juisteReden = /M31_PREFLIGHT_FAILED/.test(r.uit);
        const noemtAantal = /M31_PREFLIGHT_FAILED: 1 lastenoproep/.test(r.uit);
        const resten = tel(db, M31_RESTEN);
        const na = tel(db, 'SELECT count(*) FROM public.charge_calls;');
        const ok = brakAf && juisteReden && noemtAantal && resten === 0 && na === voor;
        noteer('preflight 1: bestaande oproep buiten zijn boekjaar', ok,
          ok ? 'geweigerd met M31_PREFLIGHT_FAILED en een aantal, 0 m31-objecten, data ongewijzigd'
             : `afgebroken=${brakAf} reden=${juisteReden} aantal=${noemtAantal} resten=${resten} rijen ${voor}->${na}`);
      }
    }

    // ── preflight negatief: ontbrekende datum ──────────────────────────────
    {
      const db = verseDb('m31_pf3', { metCases: true });
      let r = psql(db, 'SELECT public.m31_preflight_case_3_null_datum();');
      if (r.code !== 0) {
        noteer('preflight 3: bestaande oproep zonder datum', false, 'fixture kon niet worden geladen');
      } else {
        r = psql(db, `BEGIN;\n${lees(PAD.migratie)}\nCOMMIT;`);
        const brakAf = r.code !== 0;
        const juisteReden = /M31_PREFLIGHT_FAILED/.test(r.uit);
        const resten = tel(db, M31_RESTEN);
        const ok = brakAf && juisteReden && resten === 0;
        noteer('preflight 3: bestaande oproep zonder datum', ok,
          ok ? 'NULL telt als schending, migratie geweigerd, 0 m31-objecten'
             : `afgebroken=${brakAf} reden=${juisteReden} resten=${resten}`);
      }
    }

    // ── preflight positief ─────────────────────────────────────────────────
    {
      const db = verseDb('m31_pf2', { metCases: true });
      let r = psql(db, 'SELECT public.m31_preflight_case_2_geldig_nietleeg();');
      if (r.code !== 0) {
        noteer('preflight 2: geldige niet-lege dataset', false, 'fixture kon niet worden geladen');
      } else {
        const voor = tel(db, 'SELECT count(*) FROM public.charge_calls;');
        r = psql(db, lees(PAD.migratie));
        const resten = tel(db, M31_RESTEN);
        const ok = r.code === 0 && voor > 0 && resten === 4;
        noteer('preflight 2: geldige niet-lege dataset', ok,
          ok ? `${voor} bestaande oproepen, m31 toegepast, 4 m31-objecten aanwezig`
             : `exit=${r.code} rijen=${voor} objecten=${resten}`);
      }
    }

    const gefaald = resultaten.filter((r) => !r.ok).length;
    exitcode = gefaald === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\nGEBLOKKEERD: ${e.message}`);
    exitcode = 2;
  } finally {
    for (const db of ['m31_main', 'm31_pf1', 'm31_pf2', 'm31_pf3']) {
      psql('postgres', `DROP DATABASE IF EXISTS ${db};`, { stopOnError: false });
    }
    const gefaald = resultaten.filter((r) => !r.ok).length;
    console.log(`\n${resultaten.length - gefaald} van ${resultaten.length} scenario's geslaagd.\n`);
  }

  return exitcode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
