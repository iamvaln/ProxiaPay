/**
 * The payer's likely country, read in the browser only (spec: the page, country): no geolocation, no address lookup.
 * The time zone says most in Central and West Africa, where each capital names its own zone; the language region
 * (`fr-CM`) comes next; otherwise the link's first country.
 */
const ZONES: Record<string, string> = {
  'Africa/Douala': 'CM', 'Africa/Libreville': 'GA', 'Africa/Brazzaville': 'CG', 'Africa/Ndjamena': 'TD', 'Africa/Bangui': 'CF',
  'Africa/Malabo': 'GQ', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Bamako': 'ML', 'Africa/Ouagadougou': 'BF',
  'Africa/Lome': 'TG', 'Africa/Porto-Novo': 'BJ', 'Africa/Niamey': 'NE', 'Africa/Conakry': 'GN', 'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD',
};

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { return ''; }
}

export function detectCountry(available: string[], tz: string = browserZone(), langs: readonly string[] = navigator.languages ?? []): string {
  const zone = ZONES[tz];
  if (zone && available.includes(zone)) return zone;
  for (const tag of langs) {
    const region = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/i.exec(tag)?.[1]?.toUpperCase();
    if (region && available.includes(region)) return region;
  }
  return available[0] ?? '';
}
