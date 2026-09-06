#!/usr/bin/env node
/**
 * Lokale database-integratietest voor m30 — `pnpm test:db:m30`
 * ---------------------------------------------------------------------------
 *
 * Draait UITSLUITEND lokaal in Docker. Maakt geen verbinding met Supabase, met
 * productie of met enig netwerk buiten het ophalen van de `postgres:17`-image.
 *
 * De migratieketen van dit project kan een lege database niet opbouwen: m1-m5
 * en twee util-migraties zijn bewust lege plaatshouders (zie
 * docs/migration-drift.md). Daarom start deze runner vanaf de expliciete
 * testfixture `supabase/tests/fixtures/pre_m30_baseline.sql`, die alleen de
 * pre-m30-contracten modelleert die m30 en haar tests werkelijk raken. Dat is
 * nadrukkelijk GEEN reconstructie van het productieschema.
 *
 * Vijf scenario's, elk in een eigen database binnen dezelfde container:
 *
 *   hoofdsuite  fixture -> m30 -> supabase/tests/m30_ownership_transfer.sql
 *               eist letterlijk "55  geslaagd, 0  gefaald"
 *   preflight 1 overlappende primaire perioden      -> m30 MOET afbreken
 *   preflight 2 dubbele perioden zelfde eigenaar    -> m30 MOET afbreken
 *   preflight 3 toekomstgedateerd eigendom          -> m30 MOET afbreken
 *   preflight 4 geldige, niet-lege dataset          -> m30 MOET slagen
 *
 * Bij de drie negatieve gevallen wordt m30 in een expliciete transactie
 * gedraaid en daarna gecontroleerd dat er GEEN enkel m30-object is
 * achtergebleven.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');
const CONTAINER = 'agio-syndic-m30-tests';
const IMAGE = 'postgres:17';

const PAD = {
  fixture: join(REPO, 'supabase', 'tests', 'fixtures', 'pre_m30_baseline.sql'),
  cases: join(REPO, 'supabase', 'tests', 'fixtures', 'preflight_cases.sql'),
  migratie: join(REPO, 'supabase', 'migrations', '20260902192745_m30_ownership_transfer.sql'),
  suite: join(REPO, 'supabase', 'tests', 'm30_ownership_transfer.sql'),
};

// ── docker vinden ───────────────────────────────────────────────────────────
function vindDocker() {
  const kandidaten = [
    'docker',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ];
  for (const kandidaat of kandidaten) {
    if (kandidaat !== 'docker' && !existsSync(kandidaat)) continue;
    const r = spawnSync(kandidaat, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return { bin: kandidaat, server: r.stdout.trim() };
  }
  return null;
}

const docker = vindDocker();
if (!docker) {
  console.error('\nGEBLOKKEERD: geen bereikbare Docker-engine.');
  console.error('Start Docker Desktop en probeer opnieuw; `docker version` moet zowel Client als Server tonen.\n');
  process.exit(2);
}

const d = (args, opts = {}) =>
  execFileSync(docker.bin, args, { encoding: 'utf8', ...opts });

/** Draait SQL in de container. Geeft {code, uit} terug in plaats van te gooien. */
function psql(db, sql, { stopOnError = true } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db];
  if (stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
  const r = spawnSync(docker.bin, args, { input: sql, encoding: 'utf8' });
  return { code: r.status, uit: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const lees = (p) => readFileSync(p, 'utf8');

// ── containerbeheer ─────────────────────────────────────────────────────────
/** Synchroon een seconde wachten zonder externe hulpprogramma's. */
function wachtSeconde() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}

function startContainer() {
  try { d(['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* bestond niet */ }
  d(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=postgres', IMAGE], { stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    const r = spawnSync(docker.bin, ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-q']);
    if (r.status === 0) return;
    wachtSeconde();
  }
  throw new Error('lokale PostgreSQL kwam niet omhoog binnen 90 seconden');
}

function stopContainer() {
  try { d(['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* al weg */ }
}

/** Verse database met de pre-m30 fixture erin. */
function verseDb(naam, { metCases = false } = {}) {
  let r = psql('postgres', `DROP DATABASE IF EXISTS ${naam}; CREATE DATABASE ${naam};`);
  if (r.code !== 0) throw new Error(`kon database ${naam} niet aanmaken:\n${r.uit}`);
  r = psql(naam, lees(PAD.fixture));
  if (r.code !== 0) throw new Error(`fixture faalde in ${naam}:\n${r.uit}`);
  if (metCases) {
    r = psql(naam, lees(PAD.cases));
    if (r.code !== 0) throw new Error(`preflightfixture faalde in ${naam}:\n${r.uit}`);
  }
  return naam;
}

// ── controles ───────────────────────────────────────────────────────────────
const M30_RESTEN = `
SELECT
  (SELECT count(*) FROM pg_attribute
    WHERE attrelid = 'public.ownership'::regclass AND attname = 'organization_id'
      AND NOT attisdropped)
+ (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.ownership'::regclass
      AND conname IN ('ownership_primary_period_excl','ownership_owner_period_excl',
                      'ownership_owner_org_fk','ownership_org_fk'))
+ (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('link_first_owner','transfer_ownership','fn_guard_ownership_history'))
+ (SELECT count(*) FROM pg_trigger WHERE tgname = 'trig_01_ownership_history')
+ (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') AS resten;
`;

function tel(db, sql) {
  const r = psql(db, sql, { stopOnError: false });
  const m = r.uit.match(/-{3,}\s*\n\s*(-?\d+)/);
  return m ? Number(m[1]) : NaN;
}

// ── scenario's ──────────────────────────────────────────────────────────────
const resultaten = [];
const noteer = (naam, geslaagd, detail) => {
  resultaten.push({ naam, geslaagd, detail });
  console.log(`${geslaagd ? 'PASS' : 'FAIL'}  ${naam}${detail ? `  — ${detail}` : ''}`);
};

function hoofdsuite() {
  const db = verseDb('m30_main');
  let r = psql(db, lees(PAD.migratie));
  if (r.code !== 0) {
    noteer('hoofdsuite: m30 toepassen', false, 'migratie faalde');
    console.log(r.uit.split('\n').filter((l) => /ERROR|FATAL/.test(l)).join('\n'));
    return;
  }
  noteer('hoofdsuite: m30 toepassen', true, 'exitcode 0, postcheck doorstaan');

  // De suite eindigt bewust met RAISE EXCEPTION; beoordeel op het rapport.
  r = psql(db, lees(PAD.suite), { stopOnError: false });
  const labels = [...r.uit.matchAll(/^(PASS|FAIL)\s{2}(\S+)/gm)];
  const totaal = r.uit.match(/(\d+)\s+geslaagd,\s+(\d+)\s+gefaald/);

  if (!totaal) {
    noteer('hoofdsuite: 55 asserties', false, 'geen eindrapport — het DO-blok brak voortijdig af');
    console.log(r.uit.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 5).join('\n'));
    return;
  }
  const geslaagd = Number(totaal[1]);
  const gefaald = Number(totaal[2]);
  const ok = geslaagd === 55 && gefaald === 0 && labels.length === 55;
  noteer('hoofdsuite: 55 asserties', ok,
    `${geslaagd} geslaagd, ${gefaald} gefaald, ${labels.length} labels bereikt`);
  if (!ok) console.log(r.uit.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
}

function preflightNegatief(nr, functie, omschrijving) {
  const db = verseDb(`m30_pf${nr}`, { metCases: true });
  let r = psql(db, `SELECT public.${functie}();`);
  if (r.code !== 0) {
    noteer(`preflight ${nr}: ${omschrijving}`, false, 'fixture kon niet worden geladen');
    return;
  }

  // Expliciete transactie: bij een fout mag geen enkel m30-object overblijven.
  r = psql(db, `BEGIN;\n${lees(PAD.migratie)}\nCOMMIT;`);
  const brakAf = r.code !== 0;
  const juisteReden = /M30_PREFLIGHT_FAILED/.test(r.uit);
  const resten = tel(db, M30_RESTEN);

  const ok = brakAf && juisteReden && resten === 0;
  noteer(`preflight ${nr}: ${omschrijving}`, ok,
    ok ? 'migratie geweigerd met M30_PREFLIGHT_FAILED, 0 m30-objecten achtergebleven'
       : `afgebroken=${brakAf}, juiste_reden=${juisteReden}, m30-resten=${resten}`);
}

function preflightPositief() {
  const db = verseDb('m30_pf4', { metCases: true });
  let r = psql(db, 'SELECT public.preflight_case_4_geldig_nietleeg();');
  if (r.code !== 0) {
    noteer('preflight 4: geldige niet-lege dataset', false, 'fixture kon niet worden geladen');
    return;
  }
  const rijenVoor = tel(db, 'SELECT count(*) FROM public.ownership;');

  r = psql(db, lees(PAD.migratie));
  if (r.code !== 0) {
    noteer('preflight 4: geldige niet-lege dataset', false, 'm30 faalde op geldige data');
    console.log(r.uit.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 5).join('\n'));
    return;
  }

  // De backfill moet elke rij op de organisatie van haar eigenaar hebben gezet.
  const fout = tel(db, `
    SELECT count(*) FROM public.ownership o
      JOIN public.owners w ON w.id = o.owner_id
     WHERE o.organization_id IS DISTINCT FROM w.organization_id;`);
  const leeg = tel(db, 'SELECT count(*) FROM public.ownership WHERE organization_id IS NULL;');

  const ok = rijenVoor > 0 && fout === 0 && leeg === 0;
  noteer('preflight 4: geldige niet-lege dataset', ok,
    `${rijenVoor} bestaande eigendomsrijen, backfill-afwijkingen=${fout}, leeg=${leeg}`);
}

// ── uitvoeren ───────────────────────────────────────────────────────────────
console.log(`\nm30 lokale database-integratietest`);
console.log(`Docker-engine ${docker.server} · image ${IMAGE} · container ${CONTAINER}\n`);

let exitcode = 0;
try {
  startContainer();
  const versie = psql('postgres', 'SHOW server_version;', { stopOnError: false });
  console.log(`PostgreSQL ${(versie.uit.match(/\n\s*([\d.]+)/) ?? [, '?'])[1]}\n`);

  hoofdsuite();
  preflightNegatief(1, 'preflight_case_1_overlappend_primair', 'overlappende primaire perioden');
  preflightNegatief(2, 'preflight_case_2_dubbele_eigenaar', 'dubbele perioden zelfde eigenaar');
  preflightNegatief(3, 'preflight_case_3_toekomstgedateerd', 'toekomstgedateerd eigendom');
  preflightPositief();

  const gefaald = resultaten.filter((r) => !r.geslaagd).length;
  console.log(`\n${resultaten.length - gefaald} van ${resultaten.length} controles geslaagd.`);
  exitcode = gefaald === 0 ? 0 : 1;
} catch (e) {
  console.error(`\nGEBLOKKEERD: ${e.message}`);
  exitcode = 2;
} finally {
  stopContainer();
  console.log('lokale container opgeruimd.\n');
}

process.exit(exitcode);
