import type { Lang } from '../lib/i18n';
import type { Me } from '../lib/session';
import { useT } from '../lib/session';

type Environment = Me['environment'] | null;

/** The hazard stripe across the top of every sandbox page (console spec 2). The chip names it, so the stripe is decorative. */
export function EnvRibbon({ environment }: { environment: Environment }) {
  return environment ? <div className={`env-ribbon ${environment}`} aria-hidden="true" /> : null;
}

/** The environment's name beside the logo: a hazard chip on the sandbox, an outlined one in production. */
export function EnvChip({ environment }: { environment: Environment }) {
  const t = useT();
  return environment ? <span className={`env-chip ${environment}`}>{t(`env.${environment}`)}</span> : null;
}

const LANGUAGES: [Lang, string][] = [['fr', 'Français'], ['en', 'English']];

/** Each language offered under its own name, so whoever cannot read the current one still finds theirs. */
export function LanguageSwitch({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-switch">
      {LANGUAGES.map(([code, name]) => (
        <button key={code} type="button" lang={code} aria-pressed={lang === code} onClick={() => onChange(code)}>{name}</button>
      ))}
    </div>
  );
}
