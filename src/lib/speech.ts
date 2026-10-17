// Text the voice reads aloud: phone numbers in spoken groups and addresses that don't run numbers together.
// "425-452-6800" → "4 2 5, 4 5 2, 6 8 0 0"; "450 110th Ave NE" → "450, 110th Avenue Northeast".
const digits = (s: string) => s.split("").join(" ");
const STREET = { Ave: "Avenue", St: "Street", Blvd: "Boulevard", Pl: "Place", Rd: "Road", Dr: "Drive", Pkwy: "Parkway", Ct: "Court", Ln: "Lane" } as Record<string, string>;
const DIRECTION = { NE: "Northeast", NW: "Northwest", SE: "Southeast", SW: "Southwest" } as Record<string, string>;

export function forSpeech(text: string): string {
  return text
    // Phone numbers, optionally with +1 or 1-: digit by digit, in their groups.
    .replace(/(?:\+?1[-. ]?)?\(?\b(\d{3})\)?[-. ](\d{3})[-. ](\d{4})\b/g, (m, a, b, c) => `${/^\+?1/.test(m) ? "1, " : ""}${digits(a)}, ${digits(b)}, ${digits(c)}`)
    // A house number followed by a numbered street: keep them apart.
    .replace(/\b(\d{2,6}) (\d{1,3}(?:st|nd|rd|th))\b/g, "$1, $2")
    // Street types and directions, only right after a street name or number.
    .replace(/\b(\d{1,3}(?:st|nd|rd|th)|[A-Z][a-z]+) (Ave|St|Blvd|Pl|Rd|Dr|Pkwy|Ct|Ln)\.?(?=[\s,.;]|$)/g, (_, name, type) => `${name} ${STREET[type]}`)
    .replace(/\b(NE|NW|SE|SW)\b(?= \d|[\s,.;]|$)/g, d => DIRECTION[d]);
}
