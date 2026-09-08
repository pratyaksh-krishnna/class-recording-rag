/**
 * Tokens whose trailing period is part of the word, not a sentence end.
 * Stored lowercase with the period; lookups lowercase the candidate token.
 * Kept deliberately small — every entry is a boundary this segmenter will
 * never propose, so an over-long list silently welds sentences together.
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'al.', 'approx.', 'est.',
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.',
  'inc.', 'ltd.', 'co.', 'corp.', 'dept.', 'univ.',
  'fig.', 'eq.', 'no.', 'vol.', 'pp.', 'ch.',
  'min.', 'max.', 'sec.', 'hrs.',
  'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.',
]);
