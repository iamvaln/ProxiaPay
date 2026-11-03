/** The page numbers to show: the ends and the neighbours of the current page, a gap of one page filled rather than elided. */
export function pageItems(current: number, last: number): (number | '…')[] {
  const wanted = new Set([1, last, current - 1, current, current + 1].filter((n) => n >= 1 && n <= last));
  if (last <= 7) for (let n = 1; n <= last; n++) wanted.add(n);
  const nums = [...wanted].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  nums.forEach((n, i) => {
    const prev = nums[i - 1];
    if (prev !== undefined && n - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && n - prev > 2) out.push('…');
    out.push(n);
  });
  return out;
}
