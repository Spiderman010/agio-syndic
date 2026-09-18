#!/usr/bin/env node
/**
 * Lokale database-integratietest voor m32 — `pnpm test:db:m32`
 * ---------------------------------------------------------------------------
 *
 * Draait tegen een LOKALE PostgreSQL. Geen Supabase, geen productie, geen
 * netwerk. Zelfde opzet en strengheid als de m31-runner.
 *
 * WAT m32 REPAREERT, EN WAAROM DE FIXTURE MOEST VERANDEREN
 *
 * Na het toepassen van m31 op productie bleek `service_role` EXECUTE te houden
 * op beide nieuwe triggerfuncties. De lokale suite zag dat niet: Supabase kent
 * default privileges op schema `public` die dat recht automatisch toekennen,
 * en `pre_m31_baseline.sql` kent die niet. Er viel lokaal dus niets te
 * revoken en de controle stond ten onrechte op groen.
 *
 * Daarom reproduceert deze runner de afwijking expliciet, op twee manieren:
 *
 *   uitkomst    fixture -> m31 -> GRANT EXECUTE ... TO service_role -> m32
 *   mechanisme  fixture -> ALTER DEFAULT PRIVILEGES -> m31 -> m32
 *
 * De tweede is de eerlijkste: daar zet geen enkele test het recht met de hand
 * neer, het ontstaat uit hetzelfde mechanisme als op productie.
 *
 * Scenario's:
 *
 *   1  hoofdsuite        privilege vooraf aantoonbaar aanwezig, m32, 21 labels
 *   2  mechanisme        default privileges reproduceren de productiestaat
 *   3  idempotentie      m32 twee keer toepassen blijft veilig
 *   4  mutatie M1        eerste REVOKE weg  -> m32 MOET afbreken
 *   5  mutatie M2        tweede REVOKE weg  -> m32 MOET afbreken
 *   6  mutatie M3        eerste REVOKE en postcheck weg -> suite MOET falen
 *   7  mutatie M4        tweede REVOKE en postcheck weg -> suite MOET falen
 *   8  herstel           de migratie op schijf is onveranderd
 *
 * De mutaties gebeuren volledig IN HET GEHEUGEN. Het bestand op schijf wordt
 * nooit aangeraakt, en scenario 8 toetst dat ook echt.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');

const PGHOST = process.env.PGHOST || '/tmp/pg32/sock';
const PGUSER = process.env.PGUSER || 'postgres';

const PAD = {
  fixture: join(REPO, 'supabase', 'tests', 'fixtures', 'pre_m31_baseline.sql'),
  grant: join(REPO, 'supabase', 'tests', 'fixtures', 'm32_service_role_grant.sql'),
  defaults: join(REPO, 'supabase', 'tests', 'fixtures', 'm32_supabase_default_privileges.sql'),
  m31: join(REPO, 'supabase', 'migrations', '20260916220000_m31_charge_call_date_within_fiscal_year.sql'),
  m32: join(REPO, 'supabase', 'migrations', '20260918051854_m32_revoke_service_role_from_m31_triggers.sql'),
  cases: join(REPO, 'supabase', 'tests', 'fixtures', 'm31_preflight_cases.sql'),
  suite: join(REPO, 'supabase', 'tests', 'm32_revoke_service_role.sql'),
};

/** De exact verwachte labelset — ontbrekend of dubbel wordt zo ook gezien. */
export const VERWACHTE_LABELS = Object.freeze([
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
  'O1', 'O2', 'O3',
  'E1', 'E2', 'E3',
  'T1', 'T2', 'T3', 'T4',
  'G1', 'G2', 'G3', 'G4',
  'S1', 'S2', 'S3', 'S4',
]);

/** Fail-closed validatie van de psql-uitvoer, gelijk aan de m31-runner. */
export function controleerLabels(uit) {
  const redenen = [];
  if (!/=== m32 service_role zonder EXECUTE ===/.test(uit)) {
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
      redenen.push(`samenvatting (${samenvatting.geslaagd}/${samenvatting.gefaald}) wijkt af van de getelde regels ` +
                   `(${zelfGeslaagd}/${zelfGefaald})`);
    }
  }
  return { ok: redenen.length === 0, redenen, gezien, samenvatting };
}

const REVOKE_1 = 'REVOKE ALL ON FUNCTION public.fn_guard_cc_date_in_fy()\n  FROM service_role;';
const REVOKE_2 = 'REVOKE ALL ON FUNCTION public.fn_guard_fy_period_covers_calls()\n  FROM service_role;';

/**
 * Knipt een fragment weg en EIST dat er werkelijk iets is veranderd. Een
 * mutatietoets die per ongeluk niets muteert zou anders stil "groen" melden —
 * precies de fout die mutatietoetsen horen te voorkomen.
 */
export function muteer(sql, fragmenten) {
  let uit = sql;
  for (const f of fragmenten) {
    if (!uit.includes(f)) throw new Error(`mutatie sloeg niet aan, fragment niet gevonden: ${f.slice(0, 48)}…`);
    uit = uit.replace(f, '');
  }
  if (uit === sql) throw new Error('mutatie veranderde niets');
  return uit;
}

export function zonderPostcheck(sql) {
  const start = sql.indexOf('DO $postcheck$');
  const eind = sql.indexOf('$postcheck$;');
  if (start < 0 || eind < 0) throw new Error('postcheckblok niet gevonden');
  return sql.slice(0, start) + sql.slice(eind + '$postcheck$;'.length);
}

async function main() {
  const psql = (db, sql, { stopOnError = true, tuples = false } = {}) => {
    const args = ['-h', PGHOST, '-U', PGUSER, '-d', db];
    if (stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
    if (tuples) args.push('-tA');
    const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' });
    return { code: r.status, uit: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const lees = (p) => readFileSync(p, 'utf8');

  const proef = psql('postgres', 'SELECT 1;', { stopOnError: false });
  if (proef.code !== 0) {
    console.error('\nGEBLOKKEERD: geen bereikbare lokale PostgreSQL.');
    console.error(`Geprobeerd: host=${PGHOST} user=${PGUSER}\n`);
    return 2;
  }

  const resultaten = [];
  const noteer = (naam, ok, detail) => {
    resultaten.push({ naam, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${naam}${detail ? `  — ${detail}` : ''}`);
  };

  const DBS = ['m32_main', 'm32_defaults', 'm32_idem', 'm32_mut1', 'm32_mut2', 'm32_mut3', 'm32_mut4',
               'm32_scope', 'm32_data'];

  /** Verse database met de baseline; optioneel eerst de default privileges. */
  const verseDb = (naam, { metDefaults = false, metCases = false } = {}) => {
    psql('postgres', `DROP DATABASE IF EXISTS ${naam};`, { stopOnError: false });
    let r = psql('postgres', `CREATE DATABASE ${naam};`, { stopOnError: false });
    if (r.code !== 0) throw new Error(`kon database ${naam} niet aanmaken:\n${r.uit}`);
    r = psql(naam, lees(PAD.fixture));
    if (r.code !== 0) throw new Error(`baseline faalde in ${naam}:\n${r.uit}`);
    if (metCases) {
      r = psql(naam, lees(PAD.cases));
      if (r.code !== 0) throw new Error(`preflightfixture faalde in ${naam}:\n${r.uit}`);
      r = psql(naam, 'SELECT public.m31_preflight_case_2_geldig_nietleeg();');
      if (r.code !== 0) throw new Error(`zakelijke testdata faalde in ${naam}:\n${r.uit}`);
    }
    if (metDefaults) {
      r = psql(naam, lees(PAD.defaults));
      if (r.code !== 0) throw new Error(`default-privileges-fixture faalde in ${naam}:\n${r.uit}`);
    }
    r = psql(naam, lees(PAD.m31));
    if (r.code !== 0) throw new Error(`m31 faalde in ${naam}:\n${r.uit}`);
    return naam;
  };

  /** Leest het EFFECTIEVE privilege van service_role op beide functies. */
  const privilege = (db) => {
    const r = psql(db, `SELECT has_function_privilege('service_role','public.fn_guard_cc_date_in_fy()','EXECUTE')::text
                          || ',' ||
                        has_function_privilege('service_role','public.fn_guard_fy_period_covers_calls()','EXECUTE')::text;`,
      { stopOnError: false });
    const m = r.uit.match(/\b(true|false),(true|false)\b/);
    return m ? { kind: m[1] === 'true', ouder: m[2] === 'true' } : { kind: null, ouder: null };
  };

  const tel = (db, sql) => {
    const r = psql(db, sql, { stopOnError: false });
    const m = r.uit.match(/-{3,}\s*\n\s*(-?\d+)/);
    return m ? Number(m[1]) : NaN;
  };

  const m32Sql = lees(PAD.m32);
  const hashVooraf = createHash('sha256').update(readFileSync(PAD.m32)).digest('hex');

  let exitcode = 0;
  try {
    console.log('\nm32 lokale database-integratietest');
    const v = psql('postgres', 'SHOW server_version;', { stopOnError: false });
    console.log(`server_version ${(v.uit.match(/\n\s*([\d.]+)/) ?? [, '?'])[1]}`);
    console.log(`host           ${PGHOST}`);
    console.log(`m32 sha256     ${hashVooraf}\n`);

    // ── 1. hoofdsuite ──────────────────────────────────────────────────────
    {
      const db = verseDb('m32_main');
      let r = psql(db, lees(PAD.grant));
      if (r.code !== 0) throw new Error(`grantfixture faalde:\n${r.uit}`);

      const eigenaar = (d) => psql(d, `SELECT string_agg(DISTINCT pg_get_userbyid(p.proowner), ',' ORDER BY pg_get_userbyid(p.proowner))
                                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                        WHERE n.nspname = 'public'
                                          AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls');`,
        { tuples: true }).uit.trim();
      const eigenaarVoor = eigenaar(db);

      const voor = privilege(db);
      noteer('hoofdsuite: service_role heeft VOOR m32 EXECUTE op beide functies',
        voor.kind === true && voor.ouder === true,
        `kind=${voor.kind} ouder=${voor.ouder}`);

      r = psql(db, m32Sql);
      noteer('hoofdsuite: m32 toepassen', r.code === 0,
        r.code === 0 ? 'exitcode 0, eigen postcheck doorstaan'
                     : r.uit.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 3).join(' | '));

      const na = privilege(db);
      noteer('hoofdsuite: service_role heeft NA m32 op geen van beide EXECUTE',
        na.kind === false && na.ouder === false, `kind=${na.kind} ouder=${na.ouder}`);

      // Eigenaarschap is een stille achterdeur: een eigenaar leest na de REVOKE
      // `false` maar kan zichzelf het recht met een enkel GRANT teruggeven.
      const eigenaarNa = eigenaar(db);
      noteer('hoofdsuite: de functie-eigenaar is onveranderd en niet service_role',
        eigenaarVoor === eigenaarNa && eigenaarVoor.length > 0 && eigenaarVoor !== 'service_role',
        `eigenaar ${eigenaarVoor || '(leeg)'} -> ${eigenaarNa || '(leeg)'}`);

      r = psql(db, lees(PAD.suite), { stopOnError: false });
      const c = controleerLabels(r.uit);
      noteer(`hoofdsuite: exacte labelset ${VERWACHTE_LABELS.length}/${VERWACHTE_LABELS.length}`, c.ok,
        c.ok ? `alle ${VERWACHTE_LABELS.length} labels precies eenmaal en PASS; samenvatting ${c.samenvatting.geslaagd}/${c.samenvatting.gefaald}`
             : c.redenen.slice(0, 8).join(' · '));

      const rijen = tel(db, `SELECT (SELECT count(*) FROM public.charge_calls)
                                  + (SELECT count(*) FROM public.fiscal_years)
                                  + (SELECT count(*) FROM public.organizations) AS n;`);
      noteer('hoofdsuite: transactionele rollback laat niets achter', rijen === 0,
        `${rijen} rij(en) na de suite`);
    }

    // ── 2. mechanisme: Supabase' default privileges ────────────────────────
    {
      const db = verseDb('m32_defaults', { metDefaults: true });
      const voor = privilege(db);
      noteer('mechanisme: default privileges geven service_role vanzelf EXECUTE',
        voor.kind === true && voor.ouder === true,
        voor.kind ? 'zonder enige expliciete GRANT in de test' : `kind=${voor.kind} ouder=${voor.ouder}`);

      const r = psql(db, m32Sql);
      const na = privilege(db);
      noteer('mechanisme: m32 verwijdert het ook in die opzet',
        r.code === 0 && na.kind === false && na.ouder === false,
        `exit=${r.code} kind=${na.kind} ouder=${na.ouder}`);
    }

    // ── 3. idempotentie ────────────────────────────────────────────────────
    {
      const db = verseDb('m32_idem');
      psql(db, lees(PAD.grant));
      const een = psql(db, m32Sql);
      const twee = psql(db, m32Sql);
      const na = privilege(db);
      noteer('idempotentie: m32 tweemaal toepassen blijft veilig',
        een.code === 0 && twee.code === 0 && na.kind === false && na.ouder === false,
        `eerste=${een.code} tweede=${twee.code} kind=${na.kind} ouder=${na.ouder}`);
    }

    // ── 4/5. mutatie: een REVOKE weg, postcheck intact ─────────────────────
    for (const [naam, db, fragment, functie] of [
      ['M1', 'm32_mut1', REVOKE_1, 'fn_guard_cc_date_in_fy'],
      ['M2', 'm32_mut2', REVOKE_2, 'fn_guard_fy_period_covers_calls'],
    ]) {
      const d = verseDb(db);
      psql(d, lees(PAD.grant));
      const r = psql(d, muteer(m32Sql, [fragment]));
      const brakAf = r.code !== 0;
      const juist = /M32_POSTCHECK_FAILED/.test(r.uit) && r.uit.includes(functie);
      noteer(`mutatie ${naam}: REVOKE op ${functie} weggehaald`, brakAf && juist,
        brakAf && juist ? 'm32 breekt af met M32_POSTCHECK_FAILED op de juiste functie'
                        : `afgebroken=${brakAf} juisteReden=${juist}`);
    }

    // ── 6/7. mutatie: REVOKE en postcheck weg -> de suite moet het vangen ──
    for (const [naam, db, fragment, label] of [
      ['M3', 'm32_mut3', REVOKE_1, 'P1'],
      ['M4', 'm32_mut4', REVOKE_2, 'P2'],
    ]) {
      const d = verseDb(db);
      psql(d, lees(PAD.grant));
      const kapot = zonderPostcheck(muteer(m32Sql, [fragment]));
      const r = psql(d, kapot);
      const toegepast = r.code === 0;
      const s = psql(d, lees(PAD.suite), { stopOnError: false });
      const c = controleerLabels(s.uit);
      const vangtHet = !c.ok && c.redenen.some((x) => x === `label gefaald: ${label}`);
      noteer(`mutatie ${naam}: REVOKE en postcheck weggehaald`, toegepast && vangtHet,
        toegepast && vangtHet
          ? `migratie loopt stil door, maar de suite faalt op ${label}`
          : `toegepast=${toegepast} suiteVangtHet=${vangtHet} (${c.redenen.slice(0, 3).join(' · ')})`);
    }

    // ── 8. geen bredere privilege-impact ───────────────────────────────────
    // Volledige momentopname van functie-ACL's, triggers, policies en
    // tabelrechten voor en na m32. Alles wat verschilt MOET over een van de
    // twee m31-functies gaan; verandert er iets anders, dan is de scope wijder
    // dan deze migratie mag zijn.
    {
      const db = verseDb('m32_scope');
      psql(db, lees(PAD.grant));
      const SNAPSHOT = `
SELECT 'fn|'||p.proname||'|'||coalesce(p.proacl::text,'<default>')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL
SELECT 'tg|'||c.relname||'|'||t.tgname||'|'||t.tgenabled::text
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'pol|'||tablename||'|'||policyname||'|'||coalesce(qual,'')
  FROM pg_policies WHERE schemaname = 'public'
UNION ALL
SELECT 'tbl|'||c.relname||'|'||coalesce(c.relacl::text,'<default>')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1;`;
      const voor = psql(db, SNAPSHOT, { tuples: true }).uit.trim().split('\n');
      psql(db, m32Sql);
      const na = psql(db, SNAPSHOT, { tuples: true }).uit.trim().split('\n');

      const weg = voor.filter((l) => !na.includes(l));
      const bij = na.filter((l) => !voor.includes(l));
      const raaktAlleenM31 = [...weg, ...bij].every(
        (l) => l.includes('fn_guard_cc_date_in_fy') || l.includes('fn_guard_fy_period_covers_calls'));
      const erIsIetsVeranderd = weg.length > 0 || bij.length > 0;
      noteer('scope: m32 raakt uitsluitend de twee m31-functies',
        erIsIetsVeranderd && raaktAlleenM31,
        erIsIetsVeranderd && raaktAlleenM31
          ? `${voor.length} objectregels, ${weg.length} gewijzigd, alle op de twee m31-functies`
          : `veranderd=${erIsIetsVeranderd} alleenM31=${raaktAlleenM31} · ${[...weg, ...bij].slice(0, 3).join(' | ')}`);
    }

    // ── 9. geen afhankelijkheid van zakelijke rijdata ──────────────────────
    // m32 moet zich identiek gedragen met een gevulde database, en mag geen
    // enkele rij aanraken.
    {
      const db = verseDb('m32_data', { metCases: true });
      psql(db, lees(PAD.grant));
      const rijenVoor = tel(db, `SELECT (SELECT count(*) FROM public.charge_calls)
                                      + (SELECT count(*) FROM public.fiscal_years) AS n;`);
      const r = psql(db, m32Sql);
      const rijenNa = tel(db, `SELECT (SELECT count(*) FROM public.charge_calls)
                                    + (SELECT count(*) FROM public.fiscal_years) AS n;`);
      const na = privilege(db);
      noteer('data: m32 slaagt op een gevulde database en laat elke rij ongemoeid',
        r.code === 0 && rijenVoor > 0 && rijenNa === rijenVoor && na.kind === false && na.ouder === false,
        `exit=${r.code} rijen ${rijenVoor}->${rijenNa} kind=${na.kind} ouder=${na.ouder}`);
    }

    // ── 10. herstel ────────────────────────────────────────────────────────
    {
      const hashNa = createHash('sha256').update(readFileSync(PAD.m32)).digest('hex');
      noteer('herstel: de migratie op schijf is onveranderd', hashNa === hashVooraf,
        hashNa === hashVooraf ? `sha256 ${hashNa}` : `${hashVooraf} -> ${hashNa}`);
    }

    exitcode = resultaten.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    console.error(`\nGEBLOKKEERD: ${e.message}`);
    exitcode = 2;
  } finally {
    for (const db of DBS) psql('postgres', `DROP DATABASE IF EXISTS ${db};`, { stopOnError: false });
    const gefaald = resultaten.filter((r) => !r.ok).length;
    console.log(`\n${resultaten.length - gefaald} van ${resultaten.length} controles geslaagd.\n`);
  }

  return exitcode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
