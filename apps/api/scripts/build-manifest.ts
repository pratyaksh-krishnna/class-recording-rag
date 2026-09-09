import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, type ManifestEntry } from '../src/ingestion/manifest';

/**
 * CLI to walk the corpus directory tree and build the seed manifest JSON.
 * Usage: bun run apps/api/scripts/build-manifest.ts [rootDir] [outputPath] [cohortSlug] [cohortName]
 */

const rootDir = process.argv[2] ?? 'recordings/class-subtitle';
const outputPath = process.argv[3] ?? 'seed.manifest.json';
const cohortSlug = process.argv[4] ?? 'react-native';
const cohortName = process.argv[5] ?? 'React Native Class Recordings';

const entries: ManifestEntry[] = [];
let vttFallbackCount = 0;

try {
  const moduleDirs = readdirSync(rootDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const moduleDir of moduleDirs) {
    const modulePath = moduleDir.name;
    const moduleFullPath = join(rootDir, modulePath);

    const classDirs = readdirSync(moduleFullPath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const classDir of classDirs) {
      const classPath = classDir.name;
      const classFullPath = join(moduleFullPath, classPath);

      // Look for .srt or .vtt file with the same base name as the directory
      const files = readdirSync(classFullPath);
      const srtFile = files.find((f) => f.endsWith('.srt'));
      const vttFile = files.find((f) => f.endsWith('.vtt'));

      let sourceFile: string | null = null;
      let format: 'srt' | 'vtt' | null = null;

      if (srtFile) {
        sourceFile = srtFile;
        format = 'srt';
      } else if (vttFile) {
        sourceFile = vttFile;
        format = 'vtt';
        vttFallbackCount++;
      }

      if (sourceFile && format) {
        const sourceUri = join(classFullPath, sourceFile);
        entries.push({
          modulePath,
          classPath,
          sourceUri,
          format,
        });
      }
    }
  }

  // Build the manifest
  const manifest = buildManifest({
    cohort: { slug: cohortSlug, name: cohortName },
    entries,
  });

  // Write the manifest with 2-space indentation and trailing newline
  const json = JSON.stringify(manifest, null, 2) + '\n';
  await Bun.write(outputPath, json);

  // Print summary
  const moduleCount = manifest.modules.length;
  const classCount = manifest.modules.reduce((sum, m) => sum + m.classes.length, 0);
  console.log(`modules: ${moduleCount}`);
  console.log(`classes: ${classCount}`);
  console.log(`vtt fallbacks: ${vttFallbackCount}`);
} catch (error) {
  console.error('Error building manifest:', error);
  process.exit(1);
}
