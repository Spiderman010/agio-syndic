#!/usr/bin/env node
/**
 * Lokale database-integratietest voor m30 — `pnpm test:db:m30`
 * ---------------------------------------------------------------------------
 *
 * Draait UITSLUITEND lokaal in Docker. Maakt geen verbinding met Supabase, met
 * productie of met enig netwerk buiten het ophalen van de gepinde Postgres-image.
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
 *   preflight 1 overlappende primaire perioden      -> m30 MOET afbreken
 *   preflight 2 dubbele perioden zelfde eigenaar    -> m30 MOET afbreken
 *   preflight 3 toekomstgedateerd eigendom          -> m30 MOET afbreken
 *   preflight 4 geldige, niet-lege dataset          -> m30 MOET slagen
 *
 * ── CONTAINERBEHEER ────────────────────────────────────────────────────────
 *
 * Elke uitvoering krijgt een EIGEN containernaam met PID en cryptografisch
 * willekeurig achtervoegsel. De runner verwijdert nooit een container die hij
 * niet zelf heeft aangemaakt, en verwijdert vooraf helemaal niets. Mislukt het
 * aanmaken, dan wordt er niets opgeruimd.
 *
 * ── DETERMINISME ───────────────────────────────────────────────────────────
 *
 * De image staat vast op tag EN immutable digest. `postgres:17` is een
 * veranderlijke tag en zou de uitkomst laten meebewegen met de registry.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');

// Gepind op de 17.6-lijn, dezelfde major/patchlijn als het productieproject.
// De digest is de multi-architecture index-digest van `postgres:17.6`, lokaal
// vastgesteld met `docker image inspect --format '{{.RepoDigests}}'`.
const IMAGE_TAG = 'postgres:17.6';
const IMAGE_DIGEST = 'sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
const IMAGE = `${IMAGE_TAG}@${IMAGE_DIGEST}`;

// Historische vaste naam. Wordt NOOIT aangemaakt of verwijderd; hij bestaat hier
// alleen om te kunnen bewijzen dat de runner er met zijn handen van afblijft.
const OUDE_VASTE_NAAM = 'agio-syndic-m30-tests';

const PAD = {
  fixture: join(REPO, 'supabase', 'tests', 'fixtures', 'pre_m30_baseline.sql'),
  cases: join(REPO, 'supabase', 'tests', 'fixtures', 'preflight_cases.sql'),
  migratie: join(REPO, 'supabase', 'migrations', '20260902192745_m30_ownership_transfer.sql'),
  suite: join(REPO, 'supabase', 'tests', 'm30_ownership_transfer.sql'),
};

// ═══════════════════════════════════════════════ EXACTE VERWACHTE LABELSET ══
//
// Volledig uitgeschreven, niet afgeleid uit de uitvoer. Alleen zo detecteert de
// runner ook een ONTBREKEND of DUBBEL label; een simpele telling van 55 regels
// doet dat niet.
export const VERWACHTE_LABELS = Object.freeze([
  'L1', 'L2', 'L3', 'L4', 'L5', 'L6',
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10',
  'T11', 'T11b', 'T12', 'T13', 'T14', 'T15', 'T16',
  'F1', 'F2', 'F3',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6',
  'I1', 'I2', 'I3', 'I4', 'I5', 'I6',
  'X1', 'X2', 'X2b', 'X3',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9',
  'G1', 'G2', 'G3', 'G4',
]);

/**
 * Fail-closed validatie van de psql-uitvoer van de SQL-suite.
 *
 * Geeft {ok, redenen[], gezien, samenvatting} terug. `ok` is alleen waar als
 * ELKE verwachte assertie precies een keer voorkomt en PASS is, er geen enkel
 * onbekend label bij zit, de samenvatting daarmee overeenstemt, en de suite via
 * de BEDOELDE rapport-exceptie is geeindigd.
 *
 * Geexporteerd zodat de parser los van Docker met fault-injecties kan worden
 * gecontroleerd.
 */
export function controleerLabels(uit) {
  const redenen = [];

  // 1. De suite moet via haar eigen rapport-exceptie zijn geeindigd, niet door
  //    een eerdere onverwachte fout. Zonder rapportkop is elke telling zinloos.
  const heeftRapportKop = /=== m30 ownership transfer ===/.test(uit);
  if (!heeftRapportKop) {
    redenen.push('geen rapportkop — de suite brak voortijdig af');
  }

  // Precies een ERROR: het rapport zelf. Een tweede duidt op een echte fout.
  const errorRegels = (uit.match(/^(?:psql:[^\n]*?:\s*)?ERROR:/gm) ?? []).length;
  if (errorRegels !== 1) {
    redenen.push(`${errorRegels} ERROR-regels gevonden, verwacht precies 1 (de rapport-exceptie)`);
  }

  // 2. Alle labelregels verzamelen, inclusief duplicaten.
  const gezien = new Map(); // label -> statussen[]
  for (const m of uit.matchAll(/^(PASS|FAIL)\s{2}(\S+)/gm)) {
    const [, status, label] = m;
    if (!gezien.has(label)) gezien.set(label, []);
    gezien.get(label).push(status);
  }

  const verwacht = new Set(VERWACHTE_LABELS);

  // 3. Ontbrekend, dubbel of gefaald.
  for (const label of VERWACHTE_LABELS) {
    const statussen = gezien.get(label);
    if (!statussen) { redenen.push(`label ontbreekt: ${label}`); continue; }
    if (statussen.length > 1) redenen.push(`label ${statussen.length}x aanwezig: ${label}`);
    const gefaald = statussen.filter((s) => s === 'FAIL').length;
    if (gefaald > 0) redenen.push(`label gefaald: ${label}`);
  }

  // 4. Onbekende labels.
  for (const label of gezien.keys()) {
    if (!verwacht.has(label)) redenen.push(`onbekend label: ${label}`);
  }

  // 5. De samenvatting moet consistent zijn met wat we zelf telden. Een
  //    vervalste of afwijkende "55/0"-regel mag nooit doorslaggevend zijn.
  const sam = uit.match(/(\d+)\s+geslaagd,\s+(\d+)\s+gefaald/);
  let samenvatting = null;
  if (!sam) {
    redenen.push('geen samenvattingsregel gevonden');
  } else {
    samenvatting = { geslaagd: Number(sam[1]), gefaald: Number(sam[2]) };
    const totaalRegels = [...gezien.values()].reduce((a, v) => a + v.length, 0);
    const zelfGeslaagd = [...gezien.values()].flat().filter((s) => s === 'PASS').length;
    const zelfGefaald = totaalRegels - zelfGeslaagd;
    if (samenvatting.geslaagd !== zelfGeslaagd || samenvatting.gefaald !== zelfGefaald) {
      redenen.push(
        `samenvatting (${samenvatting.geslaagd}/${samenvatting.gefaald}) wijkt af van de getelde regels ` +
        `(${zelfGeslaagd}/${zelfGefaald})`);
    }
  }

  return { ok: redenen.length === 0, redenen, gezien, samenvatting };
}

// ═════════════════════════════════════════════════════════════ DOCKER ═══════
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

async function main() {
  const docker = vindDocker();
  if (!docker) {
    console.error('\nGEBLOKKEERD: geen bereikbare Docker-engine.');
    console.error('Start Docker Desktop; `docker version` moet zowel Client als Server tonen.\n');
    return 2;
  }

  // Unieke naam per uitvoering: PID plus 12 hex uit een cryptografische bron.
  const CONTAINER = `agio-m30-${process.pid}-${randomBytes(6).toString('hex')}`;

  const dz = (args) => spawnSync(docker.bin, args, { encoding: 'utf8' });

  const psql = (db, sql, { stopOnError = true } = {}) => {
    const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db];
    if (stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
    const r = spawnSync(docker.bin, args, { input: sql, encoding: 'utf8' });
    return { code: r.status, uit: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const lees = (p) => readFileSync(p, 'utf8');
  const wachtSeconde = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

  /** Identiteit van een container, of null als hij niet bestaat. */
  const inspecteer = (naam) => {
    const r = dz(['inspect', naam, '--format', '{{.Id}}|{{.Created}}|{{.State.Status}}']);
    return r.status === 0 ? r.stdout.trim() : null;
  };

  const resultaten = [];
  const noteer = (naam, geslaagd, detail) => {
    resultaten.push({ naam, geslaagd });
    console.log(`${geslaagd ? 'PASS' : 'FAIL'}  ${naam}${detail ? `  — ${detail}` : ''}`);
  };

  // ── negatieve controle: bestaande container met de oude vaste naam ────────
  // Bestond hij al, dan blijft hij van iemand anders en raken we hem niet aan.
  // Bestond hij niet, dan zetten we er zelf een neer als schildwacht en ruimen
  // die aan het eind op — het is er een die deze uitvoering aantoonbaar maakte.
  const oudeVoor = inspecteer(OUDE_VASTE_NAAM);
  let schildwachtIsVanOns = false;
  if (!oudeVoor) {
    const r = dz(['create', '--name', OUDE_VASTE_NAAM, IMAGE, 'true']);
    schildwachtIsVanOns = r.status === 0;
  }
  const schildwachtVoor = inspecteer(OUDE_VASTE_NAAM);

  let containerAangemaakt = false;
  let exitcode = 0;

  try {
    console.log(`\nm30 lokale database-integratietest`);
    console.log(`Docker-engine ${docker.server}`);
    console.log(`image        ${IMAGE_TAG}`);
    console.log(`digest       ${IMAGE_DIGEST}`);
    console.log(`container    ${CONTAINER}  (uniek per uitvoering)\n`);

    // Container aanmaken. Pas NA succes mag hij ooit worden opgeruimd.
    const start = dz(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
    if (start.status !== 0) {
      console.error(`GEBLOKKEERD: container aanmaken faalde.\n${start.stderr}`);
      console.error('Er is niets opgeruimd; deze uitvoering heeft geen container gemaakt.');
      return 2;
    }
    containerAangemaakt = true;

    let klaar = false;
    for (let i = 0; i < 90 && !klaar; i++) {
      if (dz(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-q']).status === 0) klaar = true;
      else wachtSeconde();
    }
    if (!klaar) throw new Error('lokale PostgreSQL kwam niet omhoog binnen 90 seconden');

    const v = psql('postgres', 'SHOW server_version;', { stopOnError: false });
    const serverVersie = (v.uit.match(/\n\s*([\d.]+)/) ?? [, '?'])[1];
    console.log(`server_version ${serverVersie}\n`);

    const verseDb = (naam, { metCases = false } = {}) => {
      let r = psql('postgres', `DROP DATABASE IF EXISTS ${naam}; CREATE DATABASE ${naam};`);
      if (r.code !== 0) throw new Error(`kon database ${naam} niet aanmaken:\n${r.uit}`);
      r = psql(naam, lees(PAD.fixture));
      if (r.code !== 0) throw new Error(`fixture faalde in ${naam}:\n${r.uit}`);
      if (metCases) {
        r = psql(naam, lees(PAD.cases));
        if (r.code !== 0) throw new Error(`preflightfixture faalde in ${naam}:\n${r.uit}`);
      }
      return naam;
    };

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
+ (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') AS resten;`;

    const tel = (db, sql) => {
      const r = psql(db, sql, { stopOnError: false });
      const m = r.uit.match(/-{3,}\s*\n\s*(-?\d+)/);
      return m ? Number(m[1]) : NaN;
    };

    // ── hoofdsuite ─────────────────────────────────────────────────────────
    {
      const db = verseDb('m30_main');
      let r = psql(db, lees(PAD.migratie));
      if (r.code !== 0) {
        noteer('hoofdsuite: m30 toepassen', false, 'migratie faalde');
        console.log(r.uit.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 5).join('\n'));
      } else {
        noteer('hoofdsuite: m30 toepassen', true, 'exitcode 0, postcheck doorstaan');

        r = psql(db, lees(PAD.suite), { stopOnError: false });
        const c = controleerLabels(r.uit);
        noteer('hoofdsuite: exacte labelset 55/55', c.ok,
          c.ok
            ? `alle 55 verwachte labels precies eenmaal en PASS; samenvatting ${c.samenvatting.geslaagd}/${c.samenvatting.gefaald}`
            : c.redenen.slice(0, 8).join(' · '));
      }
    }

    // ── preflight negatief ─────────────────────────────────────────────────
    const preflightNegatief = (nr, functie, omschrijving) => {
      const db = verseDb(`m30_pf${nr}`, { metCases: true });
      let r = psql(db, `SELECT public.${functie}();`);
      if (r.code !== 0) { noteer(`preflight ${nr}: ${omschrijving}`, false, 'fixture kon niet worden geladen'); return; }

      r = psql(db, `BEGIN;\n${lees(PAD.migratie)}\nCOMMIT;`);
      const brakAf = r.code !== 0;
      const juisteReden = /M30_PREFLIGHT_FAILED/.test(r.uit);
      const resten = tel(db, M30_RESTEN);
      const ok = brakAf && juisteReden && resten === 0;
      noteer(`preflight ${nr}: ${omschrijving}`, ok,
        ok ? 'migratie geweigerd met M30_PREFLIGHT_FAILED, 0 m30-objecten achtergebleven'
           : `afgebroken=${brakAf}, juiste_reden=${juisteReden}, m30-resten=${resten}`);
    };

    preflightNegatief(1, 'preflight_case_1_overlappend_primair', 'overlappende primaire perioden');
    preflightNegatief(2, 'preflight_case_2_dubbele_eigenaar', 'dubbele perioden zelfde eigenaar');
    preflightNegatief(3, 'preflight_case_3_toekomstgedateerd', 'toekomstgedateerd eigendom');

    // ── preflight positief ─────────────────────────────────────────────────
    {
      const db = verseDb('m30_pf4', { metCases: true });
      let r = psql(db, 'SELECT public.preflight_case_4_geldig_nietleeg();');
      if (r.code !== 0) {
        noteer('preflight 4: geldige niet-lege dataset', false, 'fixture kon niet worden geladen');
      } else {
        const rijenVoor = tel(db, 'SELECT count(*) FROM public.ownership;');
        r = psql(db, lees(PAD.migratie));
        if (r.code !== 0) {
          noteer('preflight 4: geldige niet-lege dataset', false, 'm30 faalde op geldige data');
          console.log(r.uit.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 5).join('\n'));
        } else {
          const fout = tel(db, `
            SELECT count(*) FROM public.ownership o
              JOIN public.owners w ON w.id = o.owner_id
             WHERE o.organization_id IS DISTINCT FROM w.organization_id;`);
          const leeg = tel(db, 'SELECT count(*) FROM public.ownership WHERE organization_id IS NULL;');
          const ok = rijenVoor > 0 && fout === 0 && leeg === 0;
          noteer('preflight 4: geldige niet-lege dataset', ok,
            `${rijenVoor} bestaande eigendomsrijen, backfill-afwijkingen=${fout}, leeg=${leeg}`);
        }
      }
    }

    const gefaald = resultaten.filter((r) => !r.geslaagd).length;
    exitcode = gefaald === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\nGEBLOKKEERD: ${e.message}`);
    exitcode = 2;
  } finally {
    // Alleen onze eigen container, en alleen als we hem echt hebben gemaakt.
    if (containerAangemaakt) {
      dz(['rm', '-f', CONTAINER]);
      console.log(`\nlokale container ${CONTAINER} opgeruimd.`);
    } else {
      console.log('\ngeen container aangemaakt; niets opgeruimd.');
    }

    // Negatieve controle afronden: de container met de oude vaste naam mag niet
    // zijn aangeraakt.
    const schildwachtNa = inspecteer(OUDE_VASTE_NAAM);
    const onaangeroerd = schildwachtVoor !== null && schildwachtVoor === schildwachtNa;
    console.log(`${onaangeroerd ? 'PASS' : 'FAIL'}  container "${OUDE_VASTE_NAAM}" onaangeroerd` +
      (onaangeroerd ? '  — zelfde id, aanmaaktijd en status' : `  — voor=${schildwachtVoor} na=${schildwachtNa}`));
    if (!onaangeroerd && exitcode === 0) exitcode = 1;

    // De schildwacht opruimen is alleen toegestaan als DEZE uitvoering hem maakte.
    if (schildwachtIsVanOns) {
      dz(['rm', '-f', OUDE_VASTE_NAAM]);
      console.log(`schildwacht "${OUDE_VASTE_NAAM}" (door deze run aangemaakt) opgeruimd.`);
    } else if (oudeVoor) {
      console.log(`bestaande container "${OUDE_VASTE_NAAM}" was er al en is met rust gelaten.`);
    }

    const gefaald = resultaten.filter((r) => !r.geslaagd).length;
    console.log(`\n${resultaten.length - gefaald} van ${resultaten.length} scenario's geslaagd.\n`);
  }

  return exitcode;
}

// Alleen uitvoeren wanneer dit bestand direct wordt gestart; bij `import` blijft
// `controleerLabels` los testbaar zonder dat er een container wordt gemaakt.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
