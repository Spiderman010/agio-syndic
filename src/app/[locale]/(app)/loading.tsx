/**
 * Laadstaat voor alle schermen binnen de schil.
 *
 * Bewust op groepsniveau en niet per route gedupliceerd: de schil (sidebar,
 * topbar, broodkruimels) staat er al en blijft staan; alleen de contentkolom
 * wordt vervangen. Daardoor is dit skelet ook precies wat er nodig is — een
 * paar blokken op de plek waar de inhoud komt.
 *
 * Skelet in plaats van een spinner, omdat de hoogte dan al klopt voordat de
 * data er is en er geen sprong ontstaat wanneer de inhoud arriveert.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-2 h-7 w-56 max-w-full rounded-lg bg-surface-2" />
      <div className="mb-6 h-4 w-80 max-w-full rounded bg-surface-2" />
      <div className="flex flex-col gap-3">
        <div className="h-20 rounded-[14px] bg-surface-2" />
        <div className="h-20 rounded-[14px] bg-surface-2" />
        <div className="h-20 rounded-[14px] bg-surface-2" />
      </div>
    </div>
  );
}
