import { useState } from 'react';
import { get, post, put } from '../lib/api';
import { useT } from '../lib/session';
import { ErrorLine, SubmitForm, useLoad } from '../components/common';

/** What the server takes: the same ceiling, so a larger file is refused here before it is read, and the server checks again. */
export const MAX_LOGO_BYTES = 200 * 1024;

export type BrandColors = { primary_color: string; secondary_color: string | null };
type Brand = BrandColors & { logo_asset_id: string | null };

/** The file as base64, without the data-URL prefix. */
function readBase64(file: File): Promise<{ base64: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.onload = () => { const url = String(reader.result); resolve({ base64: url.slice(url.indexOf(',') + 1), url }); };
    reader.readAsDataURL(file);
  });
}

/** The two colour pickers; the secondary one is optional, so it has its own switch. */
export function ColorFields({ value, onChange }: { value: BrandColors; onChange: (next: BrandColors) => void }) {
  const t = useT();
  return (
    <div className="row">
      <label>{t('brand.primary')} <input type="color" value={value.primary_color} onChange={(e) => onChange({ ...value, primary_color: e.target.value })} /></label>
      <label className="row">
        <input type="checkbox" checked={value.secondary_color !== null} onChange={(e) => onChange({ ...value, secondary_color: e.target.checked ? value.primary_color : null })} /> {t('brand.use_secondary')}
      </label>
      {value.secondary_color !== null && <label>{t('brand.secondary')} <input type="color" value={value.secondary_color} onChange={(e) => onChange({ ...value, secondary_color: e.target.value })} /></label>}
    </div>
  );
}

/** The header of the payment page as the payer will see it: the primary colour behind white text, the secondary as an edge. */
export function HeaderPreview({ colors, logo, name }: { colors: BrandColors; logo: string | null; name: string }) {
  const t = useT();
  return (
    <div aria-label={t('brand.preview')} style={{ background: colors.primary_color, color: '#fff', padding: '14px 18px', borderRadius: 8, borderBottom: `6px solid ${colors.secondary_color ?? colors.primary_color}`, display: 'flex', alignItems: 'center', gap: 12 }}>
      {logo && <img src={logo} alt={t('brand.logo_alt')} style={{ height: 36, maxWidth: 120, objectFit: 'contain' }} />}
      <b>{name}</b>
    </div>
  );
}

/** Owner only: the project's logo and colours, with a live preview. Each new link starts from them. */
export function BrandSection({ id, name }: { id: string; name: string }) {
  const t = useT();
  const brand = useLoad(() => get<Brand>(`/projects/${id}/brand`), [id]);
  const [colors, setColors] = useState<BrandColors | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  if (brand.error) return <ErrorLine error={brand.error} />;
  if (!brand.data) return null;
  const shown = colors ?? { primary_color: brand.data.primary_color, secondary_color: brand.data.secondary_color };
  const upload = async () => {
    if (!file) throw new Error(t('brand.logo_choose'));
    if (file.size > MAX_LOGO_BYTES) throw new Error(t('brand.logo_too_big'));
    const { base64, url } = await readBase64(file);
    await post(`/projects/${id}/brand/logo`, { data_base64: base64 });
    setPreview(url); setFile(null); brand.reload();
    return t('brand.logo_saved');
  };
  return (
    <div className="card" id="brand">
      <h2>{t('brand.title')}</h2>
      <p className="small muted">{t('brand.intro')}</p>
      <HeaderPreview colors={shown} logo={preview} name={name || t('brand.preview_name')} />
      <p className="small muted">{brand.data.logo_asset_id || preview ? t('brand.logo_set') : t('brand.logo_none')}</p>
      <SubmitForm className="row" submitLabel={t('brand.logo_upload')} onSubmit={upload}>
        <label>{t('brand.logo')} <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </SubmitForm>
      <SubmitForm submitLabel={t('brand.save_colors')} onSubmit={async () => { await put(`/projects/${id}/brand`, shown); setColors(null); brand.reload(); return t('brand.colors_saved'); }}>
        <ColorFields value={shown} onChange={setColors} />
      </SubmitForm>
    </div>
  );
}
