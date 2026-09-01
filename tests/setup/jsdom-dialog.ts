/**
 * Testomgeving: minimale emulatie van <dialog> en matchMedia.
 *
 * jsdom 25 kent `HTMLDialogElement` wel als type, maar implementeert
 * `showModal()` en `close()` NIET — beide zijn `undefined`. Zonder deze setup
 * gooit elke render van de applicatieschil met "showModal is not a function".
 *
 * WAT DIT WEL EN NIET BEWIJST — dit is belangrijk om eerlijk te houden:
 *
 *  WEL: dat onze eigen integratie klopt. Roepen we showModal() aan bij openen
 *       en close() bij sluiten? Vuurt het `close`-event ons herstelpad af?
 *       Sluit Escape? Landt de focus na openen binnen de lade?
 *
 *  NIET: dat de focus daadwerkelijk opgesloten zit. De top layer, de inerte
 *        achtergrond en de focus trap komen van de BROWSER; die kan geen enkele
 *        emulatie namaken zonder te gaan liegen. Dat is daarom niet
 *        geëmuleerd en wordt in een echte browser geverifieerd.
 *
 * De emulatie volgt het HTML-contract op de punten die we gebruiken: openen zet
 * `open` en verplaatst de focus naar het eerste focusbare element, Escape
 * annuleert, en sluiten vuurt `close`.
 */
if (typeof HTMLDialogElement !== "undefined") {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: (returnValue?: string) => void;
  };

  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      if (this.open) throw new Error("InvalidStateError: dialog is al open");
      this.setAttribute("open", "");

      // Browsers zetten de focus bij het openen in de dialoog.
      const focusable = this.querySelector<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? this).focus();

      const onKey = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        this.dispatchEvent(new Event("cancel"));
        this.close?.();
      };
      // Opgeruimd door close(); opgeslagen op het element zelf zodat er geen
      // module-scope-state tussen tests blijft hangen.
      (this as HTMLDialogElement & { __onKey?: (e: KeyboardEvent) => void }).__onKey = onKey;
      document.addEventListener("keydown", onKey);
    };
  }

  if (typeof proto.close !== "function") {
    proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
      if (!this.open) return;
      this.removeAttribute("open");
      if (returnValue !== undefined) this.returnValue = returnValue;
      const self = this as HTMLDialogElement & { __onKey?: (e: KeyboardEvent) => void };
      if (self.__onKey) {
        document.removeEventListener("keydown", self.__onKey);
        delete self.__onKey;
      }
      this.dispatchEvent(new Event("close"));
    };
  }
}

/**
 * jsdom levert geen matchMedia; de schil gebruikt hem om de lade te sluiten
 * zodra het scherm de desktopgrens passeert.
 *
 * Deze stub is BESTUURBAAR: hij onthoudt zijn luisteraars, zodat een test een
 * viewportwijziging kan simuleren met `setMatchMedia(query, true)`. Dat is hier
 * geen luxe — de browseromgeving waarin ik dit handmatig wilde natrekken
 * dispatcht bij een geëmuleerde viewportwijziging noch `resize` noch een
 * matchMedia-`change`, dus zonder deze stub is dat pad nergens te toetsen.
 *
 * Standaard: geen match, oftewel mobiel.
 */
type Luisteraar = (event: { matches: boolean; media: string }) => void;
const mediaState = new Map<string, { matches: boolean; luisteraars: Set<Luisteraar> }>();

function state(query: string) {
  let s = mediaState.get(query);
  if (!s) {
    s = { matches: false, luisteraars: new Set() };
    mediaState.set(query, s);
  }
  return s;
}

/** Simuleert dat het scherm de gegeven mediaquery gaat (of stopt te) matchen. */
export function setMatchMedia(query: string, matches: boolean): void {
  const s = state(query);
  if (s.matches === matches) return;
  s.matches = matches;
  for (const luisteraar of s.luisteraars) luisteraar({ matches, media: query });
}

/** Zet alle gesimuleerde media terug op "matcht niet". */
export function resetMatchMedia(): void {
  for (const s of mediaState.values()) {
    s.matches = false;
    s.luisteraars.clear();
  }
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => {
    const s = state(query);
    return {
      media: query,
      get matches() {
        return s.matches;
      },
      onchange: null,
      addEventListener: (_type: string, luisteraar: Luisteraar) => s.luisteraars.add(luisteraar),
      removeEventListener: (_type: string, luisteraar: Luisteraar) => s.luisteraars.delete(luisteraar),
      addListener: (luisteraar: Luisteraar) => s.luisteraars.add(luisteraar),
      removeListener: (luisteraar: Luisteraar) => s.luisteraars.delete(luisteraar),
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}
