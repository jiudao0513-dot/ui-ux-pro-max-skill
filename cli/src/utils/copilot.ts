import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { legacyCopilotFiles } from './copilot-legacy.js';

const MANIFEST = '.uipro-files.json';
type Fingerprints = Record<string, string[]>;
const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Never traverse links, including links in .github, prompts, skills or a nested
// data folder. Manifest paths are relative files, never arbitrary filesystem paths.
async function safePath(base: string, relative: string): Promise<boolean> {
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) return false;
  let path = base;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const entry = await stat(path);
    if (entry?.isSymbolicLink()) return false;
    if (entry && index < parts.length - 1 && !entry.isDirectory()) return false;
  }
  return true;
}

async function fileDigest(base: string, relative: string): Promise<string | undefined> {
  if (!(await safePath(base, relative))) return undefined;
  const path = join(base, relative);
  return (await stat(path))?.isFile() ? digest(await readFile(path)) : undefined;
}

async function readManifest(base: string, directory: string): Promise<Fingerprints | undefined> {
  const relative = `${directory}/${MANIFEST}`;
  if (!(await safePath(base, relative)) || !(await stat(join(base, relative)))?.isFile()) return undefined;
  let value;
  try { value = JSON.parse(await readFile(join(base, relative), 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (value?.owner !== 'ui-ux-pro-max-cli' || value.version !== 1 ||
      !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return undefined;
  for (const [path, hashes] of Object.entries(value.files)) {
    if (path === MANIFEST || !(await safePath(base, `${directory}/${path}`)) ||
        !Array.isArray(hashes) || !hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
      // An unsafe entry is ignored individually; it never authorizes removal.
      delete value.files[path];
    }
  }
  return value.files as Fingerprints;
}

/** Collect only real bundled files; never follow a source symlink. */
export async function collectCopilotFiles(source: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [path, bytes] of await collectCopilotFiles(join(source, entry.name), `${relative}/`)) files.set(path, bytes);
    } else if (entry.isFile()) {
      files.set(relative, await readFile(join(source, entry.name)));
    }
  }
  return files;
}

/** Install one Copilot skill, recording only files we actually wrote. */
export async function installCopilotSkill(
  base: string, directory: string, files: Map<string, Buffer>, force: boolean
): Promise<boolean> {
  if (!(await safePath(base, `${directory}/${MANIFEST}`))) {
    throw new Error(`Refusing to install through a symlink or non-directory: ${join(base, directory)}`);
  }
  const previous = await readManifest(base, directory);
  const entry = await stat(join(base, directory));
  // A generic name such as "design" is not proof this tool owns the skill.
  if (entry && (!force || !previous)) {
    console.log(`  Preserved existing skill: ${join(base, directory)}${previous ? ' — use --force to refresh' : ' (not managed by uipro)'}`);
    return false;
  }
  const owned: Fingerprints = { ...previous };
  if (previous) {
    const stale = Object.fromEntries(Object.entries(previous).filter(([path]) => !files.has(path)));
    await removeMatchingFiles(base, directory, stale);
    for (const path of Object.keys(stale)) delete owned[path];
  }
  for (const [path, content] of files) {
    const relative = `${directory}/${path}`;
    const target = join(base, relative);
    const current = await fileDigest(base, relative);
    if (!(await safePath(base, relative)) ||
        ((await stat(target)) && (!current || !previous?.[path]?.includes(current)))) {
      console.log(`  Preserved modified or unowned file: ${target}`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    owned[path] = [digest(content)];
  }
  await mkdir(join(base, directory), { recursive: true });
  await writeFile(join(base, directory, MANIFEST), JSON.stringify({ owner: 'ui-ux-pro-max-cli', version: 1, files: owned }, null, 2) + '\n');
  return true;
}

async function pruneEmptyParents(base: string, file: string, boundary: string): Promise<void> {
  for (let parent = dirname(file).replaceAll('\\', '/'); parent !== boundary && parent !== '.';
    parent = dirname(parent).replaceAll('\\', '/')) {
    try { await rmdir(join(base, parent)); }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) break;
      throw error;
    }
  }
}

/** Delete only byte-for-byte owned files; added/edited files and links survive. */
async function removeMatchingFiles(base: string, directory: string, files: Fingerprints): Promise<string[]> {
  const removed: string[] = [];
  for (const [file, hashes] of Object.entries(files)) {
    const relative = `${directory}/${file}`;
    const current = await fileDigest(base, relative);
    if (current && hashes.includes(current)) {
      await unlink(join(base, relative));
      removed.push(relative);
      await pruneEmptyParents(base, relative, directory);
    }
  }
  return removed;
}

export async function removeLegacyCopilotInstall(base: string): Promise<string[]> {
  // Frozen fingerprints cover both project and personal installs of the old CLI.
  // Unknown versions or user edits are deliberately retained, never guessed.
  const removed = await removeMatchingFiles(base, '.github/prompts', legacyCopilotFiles);
  if (await stat(join(base, '.github/prompts/ui-ux-pro-max.prompt.md')) ||
      await stat(join(base, '.github/prompts/ui-ux-pro-max'))) {
    console.log(`  Preserved unrecognized or modified legacy files in ${join(base, '.github/prompts')}`);
  }
  return removed;
}

export async function removeCopilotInstall(base: string, root: string, names: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const name of names) {
    const directory = `${root}/skills/${name}`;
    const files = await readManifest(base, directory);
    if (!files) continue;
    removed.push(...await removeMatchingFiles(base, directory, files));
    const manifest = `${directory}/${MANIFEST}`;
    await unlink(join(base, manifest));
    removed.push(manifest);
    await pruneEmptyParents(base, manifest, `${root}/skills`);
  }
  removed.push(...await removeLegacyCopilotInstall(base));
  return removed;
}
