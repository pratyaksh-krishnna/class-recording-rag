import { test, expect, describe } from 'bun:test';
import { PIPELINE_STAGES, stageIndexForElapsed } from '../../../apps/web/src/components/PipelineProgress';

describe('stageIndexForElapsed', () => {
  test('starts at Reading your question', () => {
    expect(PIPELINE_STAGES[stageIndexForElapsed(0)]?.label).toBe('Reading your question…');
  });

  test('advances through the four backend stages on elapsed-time thresholds', () => {
    expect(PIPELINE_STAGES[stageIndexForElapsed(1_399)]?.label).toBe('Reading your question…');
    expect(PIPELINE_STAGES[stageIndexForElapsed(1_400)]?.label).toBe('Searching the transcripts…');
    expect(PIPELINE_STAGES[stageIndexForElapsed(3_799)]?.label).toBe('Searching the transcripts…');
    expect(PIPELINE_STAGES[stageIndexForElapsed(3_800)]?.label).toBe('Weighing the evidence…');
    expect(PIPELINE_STAGES[stageIndexForElapsed(6_799)]?.label).toBe('Weighing the evidence…');
    expect(PIPELINE_STAGES[stageIndexForElapsed(6_800)]?.label).toBe('Writing the answer…');
  });

  test('the last stage holds for any later elapsed time', () => {
    expect(stageIndexForElapsed(60_000)).toBe(PIPELINE_STAGES.length - 1);
    expect(PIPELINE_STAGES.at(-1)?.label).toBe('Writing the answer…');
  });

  test('every stage label ends with an ellipsis, not three dots', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stage.label.endsWith('…')).toBe(true);
      expect(stage.label.includes('...')).toBe(false);
    }
  });
});
