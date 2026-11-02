/** ProxiaPay's mark: a disc holding a level equals sign, drawn as in brand/mark.svg. */
export function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="currentColor" />
      <rect x="10" y="12.5" width="20" height="5" rx="1" fill="var(--surface)" />
      <rect x="10" y="22.5" width="20" height="5" rx="1" fill="var(--surface)" />
    </svg>
  );
}

/** The mark and the name, read as one image. The name is live Manrope, which the console bundles. */
export function Lockup({ size }: { size: number }) {
  return (
    <span className="lockup" role="img" aria-label="ProxiaPay" style={{ fontSize: size * 0.82 }}>
      <Mark size={size} />
      <span aria-hidden="true">ProxiaPay</span>
    </span>
  );
}
