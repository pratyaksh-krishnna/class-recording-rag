import { test, expect } from 'bun:test';
import {
  TranscriptIngestRequestedSchema,
  TranscriptReindexRequestedSchema,
} from '../../../apps/api/src/inngest/events';
import { inngest } from '../../../apps/api/src/inngest/client';

test('transcript.ingest.requested: valid payload parses', () => {
  const payload = {
    transcriptId: '123e4567-e89b-12d3-a456-426614174000',
    classId: '123e4567-e89b-12d3-a456-426614174001',
    cohortId: '123e4567-e89b-12d3-a456-426614174002',
    sourceUri: 'https://example.com/transcript.vtt',
    requestedBy: 'user@example.com',
  };
  const result = TranscriptIngestRequestedSchema.safeParse(payload);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.transcriptId).toBe(payload.transcriptId);
  }
});

test('transcript.ingest.requested: non-uuid transcriptId is rejected', () => {
  const payload = {
    transcriptId: 'not-a-uuid',
    classId: '123e4567-e89b-12d3-a456-426614174001',
    cohortId: '123e4567-e89b-12d3-a456-426614174002',
    sourceUri: 'https://example.com/transcript.vtt',
    requestedBy: 'user@example.com',
  };
  const result = TranscriptIngestRequestedSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

test('transcript.ingest.requested: missing requestedBy is rejected', () => {
  const payload = {
    transcriptId: '123e4567-e89b-12d3-a456-426614174000',
    classId: '123e4567-e89b-12d3-a456-426614174001',
    cohortId: '123e4567-e89b-12d3-a456-426614174002',
    sourceUri: 'https://example.com/transcript.vtt',
  };
  const result = TranscriptIngestRequestedSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

test('transcript.ingest.requested: empty sourceUri is rejected', () => {
  const payload = {
    transcriptId: '123e4567-e89b-12d3-a456-426614174000',
    classId: '123e4567-e89b-12d3-a456-426614174001',
    cohortId: '123e4567-e89b-12d3-a456-426614174002',
    sourceUri: '',
    requestedBy: 'user@example.com',
  };
  const result = TranscriptIngestRequestedSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

test('transcript.reindex.requested: valid payload parses', () => {
  const payload = {
    transcriptId: '123e4567-e89b-12d3-a456-426614174000',
    chunkingVersion: 'v1',
    embeddingModel: 'text-embedding-3-small',
  };
  const result = TranscriptReindexRequestedSchema.safeParse(payload);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.transcriptId).toBe(payload.transcriptId);
  }
});

test('transcript.ingest.requested: extra unknown fields do not crash parsing', () => {
  const payload = {
    transcriptId: '123e4567-e89b-12d3-a456-426614174000',
    classId: '123e4567-e89b-12d3-a456-426614174001',
    cohortId: '123e4567-e89b-12d3-a456-426614174002',
    sourceUri: 'https://example.com/transcript.vtt',
    requestedBy: 'user@example.com',
    extraField: 'should be ignored',
    anotherExtra: 123,
  };
  const result = TranscriptIngestRequestedSchema.safeParse(payload);
  expect(result.success).toBe(true);
});

test('inngest client id is rag-class-recordings', () => {
  expect(inngest.id).toBe('rag-class-recordings');
});
