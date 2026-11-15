import { describe, expect, it } from 'vitest';
import { detectCountry } from './country';
import { detectLanguage, money, parseAmount } from './i18n';

describe('the payer’s country', () => {
  it('detects CM from Africa/Douala, falls back to the first country', () => {
    expect(detectCountry(['GA', 'CM'], 'Africa/Douala', ['en-US'])).toBe('CM');
    expect(detectCountry(['GA', 'CM'], 'Europe/Paris', ['en-US'])).toBe('GA');
  });

  it('maps each capital’s zone to its country', () => {
    const zones: [string, string][] = [
      ['Africa/Libreville', 'GA'], ['Africa/Brazzaville', 'CG'], ['Africa/Ndjamena', 'TD'], ['Africa/Bangui', 'CF'], ['Africa/Malabo', 'GQ'],
      ['Africa/Abidjan', 'CI'], ['Africa/Dakar', 'SN'], ['Africa/Bamako', 'ML'], ['Africa/Ouagadougou', 'BF'], ['Africa/Lome', 'TG'],
      ['Africa/Porto-Novo', 'BJ'], ['Africa/Niamey', 'NE'],
    ];
    for (const [zone, country] of zones) expect(detectCountry(['CM', country], zone, [])).toBe(country);
  });

  it('reads the language region when the zone says nothing the link covers', () => {
    expect(detectCountry(['GA', 'CM'], 'Europe/Paris', ['fr-CM', 'fr'])).toBe('CM');
    expect(detectCountry(['GA', 'CI'], 'Africa/Douala', ['fr-FR', 'fr-CI'])).toBe('CI');
  });

  it('answers nothing for a link with no country', () => {
    expect(detectCountry([], 'Africa/Douala', ['fr-CM'])).toBe('');
  });
});

describe('the page’s language and figures', () => {
  it('speaks French to a browser that asks for French first, English otherwise', () => {
    expect(detectLanguage(['fr-CM', 'en'])).toBe('fr');
    expect(detectLanguage(['en-GB', 'fr'])).toBe('en');
    expect(detectLanguage(['de-DE', 'fr'])).toBe('fr');
    expect(detectLanguage(['de-DE'])).toBe('en');
  });

  it('reads a typed amount in minor units, refusing more decimals than the currency has', () => {
    expect(parseAmount('5 000', 0)).toBe(5000);
    expect(parseAmount('12,50', 2)).toBe(1250);
    expect(parseAmount('12.5', 2)).toBe(1250);
    expect(parseAmount('12.5', 0)).toBeNull();
    expect(parseAmount('0', 0)).toBeNull();
    expect(parseAmount('-5', 0)).toBeNull();
    expect(parseAmount('abc', 0)).toBeNull();
  });

  it('writes money in the link’s exponent', () => {
    expect(money(5125, 'XAF', 0, 'en')).toBe('5,125 XAF');
    expect(money(1250, 'USD', 2, 'en')).toBe('12.50 USD');
  });
});
