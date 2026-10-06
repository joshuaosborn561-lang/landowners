/**
 * Church flag from owner name or use description.
 * Word boundaries keep names like Churchill from matching "church".
 */
const CHURCH_RE =
  /\b(?:churches?|baptists?|methodists?|ministries|ministry|fellowships?|chapels?|catholics?|parishes|parish|lutherans?|presbyterians?|bible|assembly of god)\b/i;

export function isChurchName(ownerName: string | null | undefined, useDesc: string | null | undefined): boolean {
  const hay = `${ownerName ?? ''} ${useDesc ?? ''}`;
  return CHURCH_RE.test(hay);
}
