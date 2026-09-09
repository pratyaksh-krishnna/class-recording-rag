import { expect, test, describe, beforeEach } from 'bun:test';
import type { SeedManifest } from '../../../apps/api/src/ingestion/manifest';
import { seedManifest, type SeedDeps, type SeedSummary } from '../../../apps/api/src/ingestion/seed';

/**
 * In-memory fakes for every dependency. Record calls for assertion,
 * return canned IDs to drive the workflow.
 */

describe('seedManifest', () => {
  let deps: SeedDeps;
  let calls: {
    upsertCohort: Array<{ slug: string; name: string }>;
    upsertModule: Array<{ cohortId: string; slug: string; name: string; position: number }>;
    upsertClass: Array<{ cohortId: string; moduleId: string; slug: string; name: string; position: number }>;
    upsertTranscript: Array<{
      cohortId: string;
      moduleId: string;
      classId: string;
      format: 'srt' | 'vtt';
      sourceUri: string;
      contentHash: string;
      byteSize: number;
    }>;
    readSource: Array<string>;
    emit: Array<{ transcriptId: string; classId: string; cohortId: string; sourceUri: string; requestedBy: string }>;
  };

  const idCounters = {
    cohort: 0,
    module: 0,
    class: 0,
    transcript: 0,
  };

  beforeEach(() => {
    Object.assign(idCounters, { cohort: 0, module: 0, class: 0, transcript: 0 });
    calls = {
      upsertCohort: [],
      upsertModule: [],
      upsertClass: [],
      upsertTranscript: [],
      readSource: [],
      emit: [],
    };

    deps = {
      async upsertCohort(input) {
        calls.upsertCohort.push(input);
        return { id: `cohort-${idCounters.cohort++}` };
      },
      async upsertModule(input) {
        calls.upsertModule.push(input);
        return { id: `module-${idCounters.module++}` };
      },
      async upsertClass(input) {
        calls.upsertClass.push(input);
        return { id: `class-${idCounters.class++}` };
      },
      async upsertTranscript(input) {
        calls.upsertTranscript.push(input);
        // Simulate: first call for a given (classId, contentHash) is created,
        // second is existing. We'll control this in the test.
        return { id: `transcript-${idCounters.transcript++}`, created: true };
      },
      async readSource(sourceUri) {
        calls.readSource.push(sourceUri);
        return {
          content: 'sample content',
          byteSize: 1234,
          contentHash: 'abc123def456',
        };
      },
      async emit(event) {
        calls.emit.push(event);
      },
    };
  });

  test('upserts all modules and classes with correct cohort and position', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test-cohort', name: 'Test Cohort' },
      modules: [
        {
          slug: 'module-1',
          name: 'Module 1',
          position: 1,
          classes: [
            {
              slug: 'class-1-1',
              name: 'Class 1.1',
              position: 1,
              sourceUri: 'src/1.1.srt',
              format: 'srt',
            },
            {
              slug: 'class-1-2',
              name: 'Class 1.2',
              position: 2,
              sourceUri: 'src/1.2.srt',
              format: 'srt',
            },
          ],
        },
        {
          slug: 'module-2',
          name: 'Module 2',
          position: 2,
          classes: [
            {
              slug: 'class-2-1',
              name: 'Class 2.1',
              position: 1,
              sourceUri: 'src/2.1.vtt',
              format: 'vtt',
            },
          ],
        },
      ],
    };

    const summary = await seedManifest(manifest, deps, {
      requestedBy: 'test',
      emitEvents: false,
    });

    // Assert cohort was upserted
    expect(calls.upsertCohort).toHaveLength(1);
    expect(calls.upsertCohort[0]?.slug).toBe('test-cohort');
    expect(calls.upsertCohort[0]?.name).toBe('Test Cohort');

    // Assert modules were upserted
    expect(calls.upsertModule).toHaveLength(2);
    expect(calls.upsertModule[0]?.slug).toBe('module-1');
    expect(calls.upsertModule[0]?.position).toBe(1);
    expect(calls.upsertModule[1]?.slug).toBe('module-2');
    expect(calls.upsertModule[1]?.position).toBe(2);

    // Assert classes were upserted with correct cohortId and position
    expect(calls.upsertClass).toHaveLength(3);
    expect(calls.upsertClass[0]?.slug).toBe('class-1-1');
    expect(calls.upsertClass[0]?.position).toBe(1);
    expect(calls.upsertClass[0]?.cohortId).toBe('cohort-0');
    expect(calls.upsertClass[1]?.slug).toBe('class-1-2');
    expect(calls.upsertClass[1]?.position).toBe(2);
    expect(calls.upsertClass[2]?.slug).toBe('class-2-1');
    expect(calls.upsertClass[2]?.position).toBe(1);

    // Assert summary
    expect(summary.modules).toBe(2);
    expect(summary.classes).toBe(3);
  });

  test('transcripts are created on first run', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls',
              name: 'Class',
              position: 1,
              sourceUri: 'src.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    const summary = await seedManifest(manifest, deps, {
      requestedBy: 'test',
      emitEvents: false,
    });

    expect(summary.transcriptsCreated).toBe(1);
    expect(summary.transcriptsExisting).toBe(0);
    expect(calls.upsertTranscript).toHaveLength(1);
    expect(calls.upsertTranscript[0]?.sourceUri).toBe('src.srt');
    expect(calls.upsertTranscript[0]?.format).toBe('srt');
  });

  test('second run reports existing transcripts when created is false', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls',
              name: 'Class',
              position: 1,
              sourceUri: 'src.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    // Mock upsertTranscript to return created: false
    let callCount = 0;
    deps.upsertTranscript = async (input) => {
      calls.upsertTranscript.push(input);
      callCount++;
      return { id: `transcript-${callCount}`, created: false };
    };

    const summary = await seedManifest(manifest, deps, {
      requestedBy: 'test',
      emitEvents: false,
    });

    expect(summary.transcriptsCreated).toBe(0);
    expect(summary.transcriptsExisting).toBe(1);
  });

  test('emits one event per transcript when emitEvents is true', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls-1',
              name: 'Class 1',
              position: 1,
              sourceUri: 'src1.srt',
              format: 'srt',
            },
            {
              slug: 'cls-2',
              name: 'Class 2',
              position: 2,
              sourceUri: 'src2.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    const summary = await seedManifest(manifest, deps, {
      requestedBy: 'test-user',
      emitEvents: true,
    });

    expect(summary.eventsEmitted).toBe(2);
    expect(calls.emit).toHaveLength(2);
  });

  test('emits zero events when emitEvents is false', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls',
              name: 'Class',
              position: 1,
              sourceUri: 'src.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    const summary = await seedManifest(manifest, deps, {
      requestedBy: 'test-user',
      emitEvents: false,
    });

    expect(summary.eventsEmitted).toBe(0);
    expect(calls.emit).toHaveLength(0);
  });

  test('emitted event carries transcript id, class id, cohort id and sourceUri', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls',
              name: 'Class',
              position: 1,
              sourceUri: 'recordings/test.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    await seedManifest(manifest, deps, {
      requestedBy: 'seeder',
      emitEvents: true,
    });

    expect(calls.emit).toHaveLength(1);
    const event = calls.emit[0];
    expect(event).toBeDefined();
    expect(event?.transcriptId).toBe('transcript-0');
    expect(event?.classId).toBe('class-0');
    expect(event?.cohortId).toBe('cohort-0');
    expect(event?.sourceUri).toBe('recordings/test.srt');
    expect(event?.requestedBy).toBe('seeder');
  });

  test('aborts with error if readSource fails', async () => {
    const manifest: SeedManifest = {
      cohort: { slug: 'test', name: 'Test' },
      modules: [
        {
          slug: 'mod',
          name: 'Module',
          position: 1,
          classes: [
            {
              slug: 'cls-1',
              name: 'Class 1',
              position: 1,
              sourceUri: 'good.srt',
              format: 'srt',
            },
            {
              slug: 'cls-2',
              name: 'Class 2',
              position: 2,
              sourceUri: 'bad.srt',
              format: 'srt',
            },
          ],
        },
      ],
    };

    deps.readSource = async (sourceUri) => {
      calls.readSource.push(sourceUri);
      if (sourceUri === 'bad.srt') {
        throw new Error('File not found');
      }
      return {
        content: 'sample',
        byteSize: 1234,
        contentHash: 'abc123',
      };
    };

    try {
      await seedManifest(manifest, deps, {
        requestedBy: 'test',
        emitEvents: false,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      // Verify that the error occurred after the first class was processed
      // (readSource should have been called once for the first class)
      expect(calls.readSource).toContain('good.srt');
      expect(calls.readSource).toContain('bad.srt');
    }
  });
});
