#!/usr/bin/env npx tsx
/**
 * Archive Old Progress Entries
 * ============================
 *
 * Automatically archives older iterations from .ralph/progress.md to keep
 * the main file under the token limit (~25,000 tokens / ~850 lines).
 *
 * USAGE:
 *   npx tsx scripts/archive-progress.ts              # Dry run (preview)
 *   npx tsx scripts/archive-progress.ts --execute    # Actually archive
 *   npx tsx scripts/archive-progress.ts --keep=10    # Keep last 10 iterations
 *
 * BEHAVIOR:
 *   - Keeps the most recent N iterations (default: 15)
 *   - Archives older iterations to .ralph/progress-archive-iterations-X-Y.md
 *   - Adds a reference section at the bottom of progress.md
 *   - Won't archive if file is already under threshold
 *
 * THRESHOLDS:
 *   - Max lines before archiving: 800
 *   - Target lines after archiving: ~500
 */

import * as fs from 'fs';
import * as path from 'path';

const RALPH_DIR = path.join(process.cwd(), '.ralph');
const PROGRESS_FILE = path.join(RALPH_DIR, 'progress.md');
const MAX_LINES = 800;
const DEFAULT_KEEP_ITERATIONS = 15;

interface ParsedProgress {
  header: string;           // Everything before first iteration
  iterations: Iteration[];  // Parsed iterations
  footer: string;           // Archive reference section (if exists)
}

interface Iteration {
  number: number;
  title: string;
  content: string;
  lineCount: number;
}

function parseProgressFile(content: string): ParsedProgress {
  const lines = content.split('\n');
  const iterations: Iteration[] = [];

  let headerEnd = -1;
  let footerStart = lines.length;
  let currentIteration: Iteration | null = null;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for archive reference section
    if (line.includes('## Older Iterations (Archived)')) {
      footerStart = i - 1; // Include the --- before it
      if (currentIteration) {
        currentIteration.content = currentContent.join('\n');
        currentIteration.lineCount = currentContent.length;
        iterations.push(currentIteration);
      }
      break;
    }

    // Check for iteration header
    const iterMatch = line.match(/^### Iteration (\d+)/);
    if (iterMatch) {
      // Save previous iteration
      if (currentIteration) {
        currentIteration.content = currentContent.join('\n');
        currentIteration.lineCount = currentContent.length;
        iterations.push(currentIteration);
      } else if (headerEnd === -1) {
        // First iteration found - everything before is header
        headerEnd = i;
      }

      // Start new iteration
      currentIteration = {
        number: parseInt(iterMatch[1]),
        title: line,
        content: '',
        lineCount: 0
      };
      currentContent = [line];
    } else if (currentIteration) {
      currentContent.push(line);
    }
  }

  // Handle last iteration if no footer
  if (currentIteration && footerStart === lines.length) {
    currentIteration.content = currentContent.join('\n');
    currentIteration.lineCount = currentContent.length;
    iterations.push(currentIteration);
  }

  // Sort iterations by number (descending - newest first)
  iterations.sort((a, b) => b.number - a.number);

  return {
    header: lines.slice(0, headerEnd).join('\n'),
    iterations,
    footer: footerStart < lines.length ? lines.slice(footerStart).join('\n') : ''
  };
}

function generateArchiveFilename(minIter: number, maxIter: number): string {
  return `progress-archive-iterations-${minIter}-${maxIter}.md`;
}

function findExistingArchives(): { min: number; max: number; filename: string }[] {
  const archives: { min: number; max: number; filename: string }[] = [];

  if (!fs.existsSync(RALPH_DIR)) return archives;

  const files = fs.readdirSync(RALPH_DIR);
  for (const file of files) {
    const match = file.match(/^progress-archive-iterations-(\d+)-(\d+)\.md$/);
    if (match) {
      archives.push({
        min: parseInt(match[1]),
        max: parseInt(match[2]),
        filename: file
      });
    }
  }

  return archives.sort((a, b) => a.min - b.min);
}

function generateArchiveReference(archives: { min: number; max: number; filename: string }[]): string {
  if (archives.length === 0) return '';

  const minIter = Math.min(...archives.map(a => a.min));
  const maxIter = Math.max(...archives.map(a => a.max));

  let ref = `
---

## Older Iterations (Archived)

Iterations ${minIter}-${maxIter} have been archived to:
`;

  for (const archive of archives) {
    ref += `- **\`.ralph/${archive.filename}\`** (iterations ${archive.min}-${archive.max})\n`;
  }

  ref += `
To view archived iterations, read the archive files directly.
`;

  return ref;
}

function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const keepArg = args.find(a => a.startsWith('--keep='));
  const keepIterations = keepArg ? parseInt(keepArg.split('=')[1]) : DEFAULT_KEEP_ITERATIONS;

  console.log('=== Progress Archive Tool ===\n');

  // Check if progress file exists
  if (!fs.existsSync(PROGRESS_FILE)) {
    console.error('Error: .ralph/progress.md not found');
    process.exit(1);
  }

  const content = fs.readFileSync(PROGRESS_FILE, 'utf-8');
  const lineCount = content.split('\n').length;

  console.log(`Current progress.md: ${lineCount} lines`);
  console.log(`Threshold: ${MAX_LINES} lines`);
  console.log(`Keep iterations: ${keepIterations}`);
  console.log();

  // Check if archiving is needed
  if (lineCount <= MAX_LINES) {
    console.log('✓ File is under threshold, no archiving needed');
    return;
  }

  // Parse the file
  const parsed = parseProgressFile(content);
  console.log(`Found ${parsed.iterations.length} iterations`);

  if (parsed.iterations.length <= keepIterations) {
    console.log(`✓ Only ${parsed.iterations.length} iterations, keeping all`);
    return;
  }

  // Determine what to archive
  const toKeep = parsed.iterations.slice(0, keepIterations);
  const toArchive = parsed.iterations.slice(keepIterations);

  const keptNumbers = toKeep.map(i => i.number);
  const archivedNumbers = toArchive.map(i => i.number);

  console.log(`\nWill keep iterations: ${Math.min(...keptNumbers)}-${Math.max(...keptNumbers)}`);
  console.log(`Will archive iterations: ${Math.min(...archivedNumbers)}-${Math.max(...archivedNumbers)}`);

  // Find existing archives
  const existingArchives = findExistingArchives();

  // Check for overlap with existing archives
  const minArchive = Math.min(...archivedNumbers);
  const maxArchive = Math.max(...archivedNumbers);

  for (const existing of existingArchives) {
    if (minArchive <= existing.max && maxArchive >= existing.min) {
      console.log(`\n⚠️  Warning: Iterations ${minArchive}-${maxArchive} overlap with existing archive ${existing.filename}`);
      console.log('   Will append to existing archive content');
    }
  }

  // Generate new archive content
  const archiveFilename = generateArchiveFilename(minArchive, maxArchive);
  const archivePath = path.join(RALPH_DIR, archiveFilename);

  // Sort archived iterations by number (ascending for archive)
  toArchive.sort((a, b) => a.number - b.number);

  let archiveContent = `# Progress Archive - Iterations ${minArchive}-${maxArchive}

> Archived on ${new Date().toISOString().split('T')[0]}

`;

  for (const iter of toArchive) {
    archiveContent += iter.content + '\n\n---\n\n';
  }

  // Generate new progress.md content
  // Sort kept iterations by number (descending - newest first)
  toKeep.sort((a, b) => b.number - a.number);

  // Rebuild header with updated iteration count
  let newHeader = parsed.header;
  const iterCountMatch = newHeader.match(/- Iterations completed: \d+/);
  if (iterCountMatch) {
    const maxKept = Math.max(...keptNumbers);
    newHeader = newHeader.replace(/- Iterations completed: \d+/, `- Iterations completed: ${maxKept}`);
  }

  let newContent = newHeader + '\n';

  for (const iter of toKeep) {
    newContent += '\n' + iter.content;
  }

  // Add archive reference
  const allArchives = [...existingArchives];
  const newArchiveEntry = { min: minArchive, max: maxArchive, filename: archiveFilename };

  // Check if this archive already exists in the list
  const existingIndex = allArchives.findIndex(a => a.filename === archiveFilename);
  if (existingIndex >= 0) {
    allArchives[existingIndex] = newArchiveEntry;
  } else {
    allArchives.push(newArchiveEntry);
  }

  allArchives.sort((a, b) => a.min - b.min);
  newContent += generateArchiveReference(allArchives);

  const newLineCount = newContent.split('\n').length;
  const archiveLineCount = archiveContent.split('\n').length;

  console.log(`\nNew progress.md: ${newLineCount} lines (was ${lineCount})`);
  console.log(`Archive file: ${archiveLineCount} lines`);

  if (!execute) {
    console.log('\n📋 DRY RUN - No changes made');
    console.log('   Run with --execute to apply changes');
    return;
  }

  // Write files
  console.log('\n✍️  Writing files...');

  // Check if archive file exists and merge if needed
  if (fs.existsSync(archivePath)) {
    const existingArchive = fs.readFileSync(archivePath, 'utf-8');
    // Append new content to existing
    archiveContent = existingArchive + '\n' + archiveContent;
    console.log(`   Merged with existing ${archiveFilename}`);
  }

  fs.writeFileSync(archivePath, archiveContent);
  console.log(`   Created/Updated: .ralph/${archiveFilename}`);

  fs.writeFileSync(PROGRESS_FILE, newContent);
  console.log(`   Updated: .ralph/progress.md`);

  console.log('\n✅ Archive complete!');
}

main();
