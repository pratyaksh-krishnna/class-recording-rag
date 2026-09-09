import { test, expect, describe } from 'bun:test';
import {
  extractCitationMarkers,
  validateCitations,
  stripInvalidMarkers,
} from '../../../apps/api/src/rag/generation/citationValidator';
import type { EvidenceEntry, EvidenceMap } from '../../../apps/api/src/rag/context/contextBuilder';

function entry(sourceId: string): EvidenceEntry {
  return {
    sourceId,
    chunkId: `chunk-${sourceId}`,
    transcriptId: 't-1',
    moduleId: 'm-1',
    moduleName: 'Module 1',
    classId: 'c-1',
    className: 'Class 1',
    startMs: 0,
    endMs: 1000,
    startTime: '00:00:00',
    endTime: '00:00:01',
    text: 'text',
  };
}

function mapOf(...ids: string[]): EvidenceMap {
  return new Map(ids.map((id) => [id, entry(id)]));
}

describe('extractCitationMarkers', () => {
  test('extracts markers in first-appearance order, deduped', () => {
    const answer = 'A claim [SOURCE_3]. Another [SOURCE_1]. Repeat [SOURCE_3] again [SOURCE_2].';

    expect(extractCitationMarkers(answer)).toEqual(['SOURCE_3', 'SOURCE_1', 'SOURCE_2']);
  });

  test('no markers -> empty array', () => {
    expect(extractCitationMarkers('No citations in this answer at all.')).toEqual([]);
  });

  test('repeated marker only counted once, at its first position', () => {
    const answer = '[SOURCE_5] first mention, [SOURCE_5] again, then [SOURCE_1].';

    expect(extractCitationMarkers(answer)).toEqual(['SOURCE_5', 'SOURCE_1']);
  });
});

describe('validateCitations', () => {
  test('splits markers into valid and invalid against the evidence map', () => {
    const evidence = mapOf('SOURCE_1', 'SOURCE_2');
    const answer = 'Claim one [SOURCE_1]. Claim two [SOURCE_9]. Claim three [SOURCE_2].';

    const result = validateCitations(answer, evidence);

    expect(result.validIds).toEqual(['SOURCE_1', 'SOURCE_2']);
    expect(result.invalidIds).toEqual(['SOURCE_9']);
  });

  test('all valid -> empty invalidIds', () => {
    const evidence = mapOf('SOURCE_1');

    const result = validateCitations('Claim [SOURCE_1].', evidence);

    expect(result.validIds).toEqual(['SOURCE_1']);
    expect(result.invalidIds).toEqual([]);
  });

  test('all invalid -> empty validIds', () => {
    const evidence = mapOf('SOURCE_1');

    const result = validateCitations('Claim [SOURCE_9].', evidence);

    expect(result.validIds).toEqual([]);
    expect(result.invalidIds).toEqual(['SOURCE_9']);
  });

  test('no markers at all -> both empty', () => {
    const evidence = mapOf('SOURCE_1');

    const result = validateCitations('No citations here.', evidence);

    expect(result.validIds).toEqual([]);
    expect(result.invalidIds).toEqual([]);
  });
});

describe('stripInvalidMarkers', () => {
  test('removes only the offending markers and tidies spacing/punctuation', () => {
    const answer = 'Claim one [SOURCE_1]. Fabricated claim [SOURCE_9]. Final claim [SOURCE_2].';

    const result = stripInvalidMarkers(answer, ['SOURCE_9']);

    expect(result).toBe('Claim one [SOURCE_1]. Fabricated claim. Final claim [SOURCE_2].');
  });

  test('a marker at the very start of the answer is removed cleanly', () => {
    const answer = '[SOURCE_9] Some fabricated info to open with. Real claim [SOURCE_1].';

    const result = stripInvalidMarkers(answer, ['SOURCE_9']);

    expect(result).toBe('Some fabricated info to open with. Real claim [SOURCE_1].');
  });

  test('no invalid ids -> returns the answer unchanged', () => {
    const answer = 'Claim [SOURCE_1].';

    expect(stripInvalidMarkers(answer, [])).toBe(answer);
  });

  test('multiple invalid markers are all removed', () => {
    const answer = 'One [SOURCE_9]. Two [SOURCE_8]. Three [SOURCE_1].';

    const result = stripInvalidMarkers(answer, ['SOURCE_9', 'SOURCE_8']);

    expect(result).toBe('One. Two. Three [SOURCE_1].');
  });
});
