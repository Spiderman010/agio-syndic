import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import SubmitButton from "@/components/SubmitButton";
import Card, { CardHeader } from "@/components/ui/Card";
import { Link } from "@/navigation";
import type { BlockRow } from "@/lib/layout";
import { createBlock, setBlockArchived, updateBlock } from "./actions";

/**
 * Blokken aanmaken en bewerken.
 *
 * ── WAAROM ARCHIVEREN EN NIET VERWIJDEREN ──────────────────────────────────
 *
 * Een blok kan voorkomen in `charge_calls.alloc_block_id` en
 * `allocation_rules.scope_block_id` — het zit dus in de financiële structuur.
 * Weggooien zou die verwijzingen breken of blokkeren. Archiveren haalt het uit
 * de keuzelijst zonder iets te vernietigen, en is daarmee de enige mutatie die
 * hier hoort.
 *
 * Archiveren laat `units.block_id` bewust staan. De lots van een gearchiveerd
 * blok komen op het indelingsscherm in de groep "onbereikbaar" — zichtbaar,
 * niet verstopt. Dat is de reden dat die groep bestaat.
 *
 * ── DE HOOFDLETTERONGEVOELIGE CODE ─────────────────────────────────────────
 *
 * `blocks_building_code_ci_idx` is uniek op `lower(btrim(code))` per gebouw:
 * "A" naast "a" bestaat niet. Dat kan alleen de database weten, dus het
 * formulier belooft het niet — de melding komt via `blockErrorKey` terug als
 * een vertaalde zin, nooit als databasetekst.
 */

export async function BlokAanmaken({ buildingId }: { buildingId: string }) {
  const t = await getTranslations("indeling.manage");

  return (
    <Card>
      <CardHeader title={<span id="blok-nieuw-kop">{t("newBlock")}</span>} />
      <ActionForm action={createBlock} className="grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="building_id" value={buildingId} />

        <Field id="blok-code" label={t("code")} hint={t("codeHint")} required>
          <input
            id="blok-code"
            name="code"
            type="text"
            required
            maxLength={40}
            className="input w-full"
          />
        </Field>

        <Field id="blok-naam" label={t("name")}>
          <input id="blok-naam" name="name" type="text" maxLength={80} className="input w-full" />
        </Field>

        <Field id="blok-volgorde" label={t("sortOrder")} hint={t("sortOrderHint")}>
          <input
            id="blok-volgorde"
            name="sort_order"
            type="number"
            min="0"
            step="1"
            defaultValue={0}
            className="input w-full"
          />
        </Field>

        <div className="sm:col-span-3">
          <SubmitButton label={t("createBlock")} pendingLabel={t("pending")} />
        </div>
      </ActionForm>
    </Card>
  );
}

export async function BlokBewerken({
  buildingId,
  blok,
}: {
  buildingId: string;
  blok: BlockRow;
}) {
  const t = await getTranslations("indeling.manage");
  const gearchiveerd = blok.archived_at !== null;

  return (
    <Card data-testid="blok-paneel">
      <CardHeader
        title={<span>{t("editBlock", { code: blok.code })}</span>}
        actions={
          <Link href={`/buildings/${buildingId}/indeling`} className="text-[0.8rem] text-primary">
            {t("close")}
          </Link>
        }
      />

      <ActionForm action={updateBlock} className="grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="building_id" value={buildingId} />
        <input type="hidden" name="block_id" value={blok.id} />

        <Field id="blok-edit-code" label={t("code")} hint={t("codeHint")} required>
          <input
            id="blok-edit-code"
            name="code"
            type="text"
            required
            maxLength={40}
            defaultValue={blok.code}
            className="input w-full"
          />
        </Field>

        <Field id="blok-edit-naam" label={t("name")}>
          <input
            id="blok-edit-naam"
            name="name"
            type="text"
            maxLength={80}
            defaultValue={blok.name ?? ""}
            className="input w-full"
          />
        </Field>

        <Field id="blok-edit-volgorde" label={t("sortOrder")}>
          <input
            id="blok-edit-volgorde"
            name="sort_order"
            type="number"
            min="0"
            step="1"
            defaultValue={blok.sort_order}
            className="input w-full"
          />
        </Field>

        <div className="sm:col-span-3">
          <SubmitButton label={t("save")} pendingLabel={t("pending")} />
        </div>
      </ActionForm>

      {/*
        Archiveren staat in een EIGEN formulier, niet als extra knop in het
        bewerkformulier. Anders zou een druk op "archiveren" ook de ingetikte
        code meesturen, en zou één klik twee dingen doen.
      */}
      <div className="mt-4 border-t border-line pt-4">
        <p className="mt-0 mb-2 text-[0.8rem] text-ink-soft">
          {gearchiveerd ? t("archivedHint") : t("archiveHint")}
        </p>
        <ActionForm action={setBlockArchived}>
          <input type="hidden" name="building_id" value={buildingId} />
          <input type="hidden" name="block_id" value={blok.id} />
          <input type="hidden" name="archived" value={gearchiveerd ? "false" : "true"} />
          <SubmitButton
            label={gearchiveerd ? t("unarchive") : t("archive")}
            pendingLabel={t("pending")}
            variant={gearchiveerd ? undefined : "danger"}
          />
        </ActionForm>
      </div>
    </Card>
  );
}
