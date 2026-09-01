/**
 * Bedragweergave — één plek voor de hele applicatie.
 *
 * De bestaande schermen doen elk hun eigen `toLocaleString("fr-MA", …)` gevolgd
 * door een handgeschreven " MAD". Dat levert per scherm een net iets andere
 * opmaak op en negeert de actieve taal volledig. Deze module vervangt dat voor
 * nieuwe code; de oude schermen worden niet aangeraakt (buiten scope).
 *
 * DRIE KEUZES DIE UITLEG VERDIENEN
 *
 * 1. `style: "currency"` met `MAD`, niet een handmatig achtervoegsel. Daardoor
 *    staat het symbool op de plek die de taal voorschrijft — vóór het bedrag in
 *    het Frans, erachter in het Nederlands — zonder dat er ergens een string
 *    wordt samengeplakt.
 *
 * 2. Voor Arabisch forceren we LATIJNSE CIJFERS (`-u-nu-latn`). Zonder die
 *    aanwijzing rendert Intl Arabisch-Indische cijfers (٣٠٠٠). In de Marokkaanse
 *    praktijk worden bedragen in Latijnse cijfers geschreven, ook in Arabische
 *    teksten, en een boekhouder moet kolommen kunnen vergelijken. De richting
 *    van de tekst blijft gewoon RTL; alleen het cijferschrift ligt vast.
 *
 * 3. Een `Intl.NumberFormat` bouwen is relatief duur en het dashboard formatteert
 *    tientallen bedragen per render. De formatters worden daarom per taal
 *    gecachet.
 */

const LOCALE_TAGS: Record<string, string> = {
  fr: "fr-MA",
  nl: "nl-NL",
  ar: "ar-MA-u-nu-latn",
};

const currencyCache = new Map<string, Intl.NumberFormat>();
const percentCache = new Map<string, Intl.NumberFormat>();

function tagFor(locale: string): string {
  return LOCALE_TAGS[locale] ?? LOCALE_TAGS.fr;
}

function currencyFormatter(locale: string): Intl.NumberFormat {
  const tag = tagFor(locale);
  let formatter = currencyCache.get(tag);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tag, {
      style: "currency",
      currency: "MAD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyCache.set(tag, formatter);
  }
  return formatter;
}

/** Bedrag in dirham, opgemaakt volgens de actieve taal. */
export function formatMoney(amount: number, locale: string): string {
  return currencyFormatter(locale).format(amount);
}

/**
 * Bedrag zonder decimalen, voor plekken waar de centen alleen ruis zijn
 * (kaartkoppen). Bewust een aparte functie: waar centen ertoe doen mogen ze
 * niet stilzwijgend verdwijnen, dus dit moet een expliciete keuze zijn.
 */
export function formatMoneyRounded(amount: number, locale: string): string {
  const tag = tagFor(locale);
  const key = `${tag}:rounded`;
  let formatter = currencyCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tag, {
      style: "currency",
      currency: "MAD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    currencyCache.set(key, formatter);
  }
  return formatter.format(amount);
}

/**
 * Percentage. `null` levert een gedachtestreepje op in plaats van "0%".
 * Nul procent en "niet te berekenen" zijn verschillende uitspraken, en de
 * tweede als de eerste tonen is precies het soort schijnnauwkeurigheid dat een
 * financieel dashboard onbruikbaar maakt.
 */
export function formatPercent(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const tag = tagFor(locale);
  let formatter = percentCache.get(tag);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tag, {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    percentCache.set(tag, formatter);
  }
  return formatter.format(value / 100);
}

/** Datum in de actieve taal; ISO-strings uit de database worden nooit rauw getoond. */
export function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(tagFor(locale), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}
