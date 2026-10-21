import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAIType } from '../../src/utils/detect.js';
import { listBundledSubSkills, loadPlatformConfig, renderSkillFile } from '../../src/utils/template.js';
import { legacyCopilotFiles } from '../../src/utils/copilot-legacy.js';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = join(cli, 'assets');
const fixtures = join(cli, 'tests/fixtures');
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

async function setup(testInfo: { outputPath: (path: string) => string }) {
  const project = testInfo.outputPath('project');
  const home = testInfo.outputPath('home');
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  return { project, home };
}

async function run(args: string[], project: string, home: string, status = 0) {
  const pkg = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'));
  const result = spawnSync(process.execPath, [
    '--import', join(fixtures, 'cli-environment.mjs'), join(cli, 'dist/index.js'), ...args,
  ], {
    cwd: project, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, UIPRO_TEST_HOME: home, UIPRO_TEST_VERSION: pkg.version, PYTHONDONTWRITEBYTECODE: '1' },
  });
  await test.info().attach(`cli-${args.join('-')}`, { body: result.stdout + result.stderr, contentType: 'text/plain' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(status);
  return result.stdout + result.stderr;
}

async function put(base: string, relative: string, content = '# user owned\n') {
  const path = join(base, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function legacy(base: string, global = false) {
  const parent = join(base, '.github/prompts');
  const config = JSON.parse(await readFile(join(fixtures, 'legacy-copilot.json'), 'utf8'));
  // Render the pre-port configuration without the Copilot-only rooted-path fix.
  config.platform = 'legacy-copilot';
  await put(base, '.github/prompts/ui-ux-pro-max.prompt.md', await renderSkillFile(config, global));
  for (const dir of ['data', 'scripts']) {
    await cp(join(assets, dir), join(parent, 'ui-ux-pro-max', dir), { recursive: true });
  }
  for (const name of await listBundledSubSkills()) {
    await cp(join(assets, 'skills', name), join(parent, name), { recursive: true });
  }
  // Verify the fixture really reproduces the old installer, not just its names.
  for (const [path, hashes] of Object.entries(legacyCopilotFiles)) {
    expect(hashes, path).toContain(sha(await readFile(join(parent, path))));
  }
}

async function verifyInstall(base: string, root: string, global: boolean) {
  const skill = join(base, root, 'skills/ui-ux-pro-max');
  const text = await readFile(join(skill, 'SKILL.md'), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  expect(frontmatter).toMatch(/^name: ui-ux-pro-max$/m);
  expect(frontmatter).toMatch(/^description: .+/m);
  expect(frontmatter).not.toMatch(/^mode:/m);
  expect((await loadPlatformConfig('copilot')).frontmatter!.description.length).toBeLessThanOrEqual(1024);
  expect(text).not.toContain('{{');
  const paths = Array.from(text.matchAll(/python3 (\S*scripts\/search\.py)/g), match => match[1]);
  expect(paths.length).toBeGreaterThan(5);
  expect(new Set(paths)).toEqual(new Set([`${global ? '~/' : ''}${root}/skills/ui-ux-pro-max/scripts/search.py`]));
  expect(existsSync(join(skill, 'data/styles.csv'))).toBe(true);
  for (const name of await listBundledSubSkills()) expect(existsSync(join(base, root, 'skills', name, 'SKILL.md')), `${root}/skills/${name}/SKILL.md`).toBe(true);
  const search = spawnSync('python3', [join(skill, 'scripts/search.py'), 'accessible button', '--domain', 'ux'], {
    cwd: base, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(search.status, search.stderr).toBe(0);
  expect(search.stdout).toContain('Search Results');
}

for (const global of [false, true]) {
  const mode = global ? 'personal' : 'project';
  test(`${mode}: CLI init, executable search, and confirmed uninstall`, async ({}, info) => {
    const {project, home} = await setup(info);
    const base = global ? home : project;
    const root = global ? '.copilot' : '.github';
    const flags = ['--ai', 'copilot', ...(global ? ['--global'] : [])];
    await run(['init', ...flags], project, home);
    await verifyInstall(base, root, global);
    expect(await readdir(global ? project : home)).toEqual([]);
    expect(existsSync(join(base, '.github/prompts'))).toBe(false);
    if (global) expect(existsSync(join(home, '.github'))).toBe(false);
    await run(['uninstall', ...flags], project, home);
    expect(await readdir(join(base, root, 'skills'))).toEqual([]);
  });

  for (const command of ['init', 'update', 'uninstall']) {
    test(`${mode}: ${command} migrates/removes only recognized legacy files`, async ({}, info) => {
      const {project, home} = await setup(info);
      const base = global ? home : project;
      await legacy(base, global);
      const keep = [
        '.github/copilot-instructions.md', '.github/instructions/team.instructions.md',
        '.github/agents/team.agent.md', '.github/hooks/hooks.json', '.github/workflows/ci.yml',
        '.github/prompts/release-notes.prompt.md', '.github/prompts/design/my-notes.md',
        '.github/prompts/slides/SKILL.md', '.github/prompts/ui-ux-pro-max/scripts/custom.py',
        '.github/prompts/ui-ux-pro-max/data/styles.csv',
      ];
      for (const path of keep) await put(base, path);
      await run([command, '--ai', 'copilot', ...(global ? ['--global'] : [])], project, home);
      for (const path of keep) expect(await readFile(join(base, path), 'utf8'), path).toBe('# user owned\n');
      for (const path of Object.keys(legacyCopilotFiles).filter(path => !keep.includes(`.github/prompts/${path}`))) {
        expect(existsSync(join(base, '.github/prompts', path)), path).toBe(false);
      }
      if (command !== 'uninstall') await verifyInstall(base, global ? '.copilot' : '.github', global);
    });
  }

  test(`${mode}: update refreshes managed files and preserves edits and custom skills`, async ({}, info) => {
    const {project, home} = await setup(info);
    const base = global ? home : project;
    const root = global ? '.copilot' : '.github';
    const flags = ['--ai', 'copilot', ...(global ? ['--global'] : [])];
    await put(base, `${root}/skills/design/SKILL.md`);
    await run(['init', ...flags], project, home);
    const keep = [`${root}/skills/design/SKILL.md`, `${root}/skills/brand/SKILL.md`, `${root}/skills/ui-ux-pro-max/notes.md`];
    for (const path of keep) await put(base, path);
    const search = join(base, root, 'skills/ui-ux-pro-max/scripts/search.py');
    await rm(search);
    await legacy(base, global); // Mixed installs must also be migrated on refresh.
    await run(['update', ...flags], project, home);
    expect(existsSync(search)).toBe(true);
    expect(existsSync(join(base, '.github/prompts/ui-ux-pro-max.prompt.md'))).toBe(false);
    for (const path of keep) expect(await readFile(join(base, path), 'utf8')).toBe('# user owned\n');
    await run(['uninstall', ...flags], project, home);
    for (const path of keep) expect(await readFile(join(base, path), 'utf8')).toBe('# user owned\n');
    expect(existsSync(search)).toBe(false);
    await run(['uninstall', ...flags], project, home); // idempotent
  });
}

test('init without --force leaves an existing managed install and legacy files untouched', async ({}, info) => {
  const {project, home} = await setup(info);
  await run(['init', '--ai', 'copilot'], project, home);
  await legacy(project);
  expect(await run(['init', '--ai', 'copilot'], project, home)).toContain('use --force');
  expect(existsSync(join(project, '.github/prompts/ui-ux-pro-max.prompt.md'))).toBe(true);
});

test('custom prompt/orchestrator and same-name skills are not treated as tool ownership', async ({}, info) => {
  const {project, home} = await setup(info);
  const paths = ['.github/prompts/ui-ux-pro-max.prompt.md', '.github/prompts/ui-ux-pro-max/SKILL.md', '.github/prompts/design/SKILL.md'];
  for (const path of paths) await put(project, path);
  await run(['init', '--ai', 'copilot', '--force'], project, home);
  await run(['uninstall', '--ai', 'copilot'], project, home);
  for (const path of paths) expect(await readFile(join(project, path), 'utf8')).toBe('# user owned\n');
});

for (const relative of ['.github/prompts', '.github/prompts/design', '.github/prompts/ui-ux-pro-max/scripts']) {
  test(`legacy cleanup does not traverse a symlink at ${relative}`, async ({}, info) => {
    test.skip(process.platform === 'win32', 'Creating symlinks requires Windows developer mode');
    const {project, home} = await setup(info);
    await legacy(home);
    const external = join(home, relative);
    await mkdir(dirname(join(project, relative)), { recursive: true });
    await symlink(external, join(project, relative), 'dir');
    const protectedFile = relative.endsWith('prompts') ? 'ui-ux-pro-max.prompt.md' : relative.endsWith('design') ? 'SKILL.md' : 'search.py';
    const before = await readFile(join(external, protectedFile));
    await run(['init', '--ai', 'copilot'], project, home);
    await run(['uninstall', '--ai', 'copilot'], project, home);
    expect(await readFile(join(external, protectedFile))).toEqual(before);
  });
}

test('ordinary .github workflows do not select Copilot', async ({}, info) => {
  const {project} = await setup(info);
  await put(project, '.github/workflows/ci.yml');
  await put(project, '.github/dependabot.yml');
  expect(detectAIType(project)).toEqual({detected: [], suggested: null});
  await mkdir(join(project, '.cursor'));
  expect(detectAIType(project)).toEqual({detected: ['cursor'], suggested: 'cursor'});
});

for (const marker of ['.github/copilot-instructions.md', '.github/instructions', '.github/prompts', '.github/agents', '.github/skills', '.github/hooks', '.copilot/skills']) {
  test(`detects Copilot from ${marker}`, async ({}, info) => {
    const {project} = await setup(info);
    if (marker.endsWith('.md')) await put(project, marker);
    else await mkdir(join(project, marker), { recursive: true });
    expect(detectAIType(project)).toEqual({detected: ['copilot'], suggested: 'copilot'});
  });
}

test('other platform templates remain byte-for-byte identical in both modes', async () => {
  const baseline = JSON.parse(await readFile(join(fixtures, 'platform-baseline.json'), 'utf8'));
  for (const [platform, expected] of Object.entries(baseline) as [string, any][]) {
    const config = await loadPlatformConfig(platform);
    expect(config.folderStructure, platform).toEqual(expected.folderStructure);
    expect(sha(await renderSkillFile(config)), platform).toBe(expected.local);
    expect(sha(await renderSkillFile(config, true)), platform).toBe(expected.global);
  }
});

for (const global of [false, true]) {
  test(`--ai all keeps all existing platform layouts (${global ? 'personal' : 'project'})`, async ({}, info) => {
    const {project, home} = await setup(info);
    const base = global ? home : project;
    await run(['init', '--ai', 'all', ...(global ? ['--global'] : [])], project, home);
    const baseline = JSON.parse(await readFile(join(fixtures, 'platform-baseline.json'), 'utf8'));
    for (const expected of Object.values(baseline) as any[]) {
      const folder = expected.folderStructure;
      expect(existsSync(join(base, folder.root, folder.skillPath, folder.filename))).toBe(true);
      expect(existsSync(join(base, folder.root, folder.dataPath ?? folder.skillPath, 'scripts/search.py'))).toBe(true);
    }
    await verifyInstall(base, global ? '.copilot' : '.github', global);
  });
}

test('a failed install through a symlink keeps the legacy installation', async ({}, info) => {
  test.skip(process.platform === 'win32', 'Creating symlinks requires Windows developer mode');
  const {project, home} = await setup(info);
  await legacy(project);
  await symlink(home, join(project, '.github/skills'), 'dir');
  await run(['init', '--ai', 'copilot'], project, home, 1);
  expect(existsSync(join(project, '.github/prompts/ui-ux-pro-max.prompt.md'))).toBe(true);
  expect(await readdir(home)).toEqual([]);
});

test('uninstall rejects manifest traversal paths and preserves linked installed files', async ({}, info) => {
  test.skip(process.platform === 'win32', 'Creating symlinks requires Windows developer mode');
  const {project, home} = await setup(info);
  await run(['init', '--ai', 'copilot'], project, home);
  const skill = join(project, '.github/skills/ui-ux-pro-max');
  await put(project, '.github/copilot-instructions.md');
  await cp(join(skill, 'scripts/search.py'), join(home, 'search.py'));
  await rm(join(skill, 'scripts/search.py'));
  await symlink(join(home, 'search.py'), join(skill, 'scripts/search.py'));
  const manifest = JSON.parse(await readFile(join(skill, '.uipro-files.json'), 'utf8'));
  manifest.files['../../copilot-instructions.md'] = [sha('# user owned\n')];
  await writeFile(join(skill, '.uipro-files.json'), JSON.stringify(manifest));
  await run(['uninstall', '--ai', 'copilot'], project, home);
  expect(await readFile(join(project, '.github/copilot-instructions.md'), 'utf8')).toBe('# user owned\n');
  expect(existsSync(join(home, 'search.py'))).toBe(true);
  expect(existsSync(join(skill, 'scripts/search.py'))).toBe(true);
});

test('--global uninstall --ai all detects personal Copilot without touching the project', async ({}, info) => {
  const {project, home} = await setup(info);
  await run(['init', '--ai', 'copilot'], project, home);
  await run(['init', '--ai', 'copilot', '--global'], project, home);
  await run(['uninstall', '--ai', 'all', '--global'], project, home);
  expect(await readdir(join(home, '.copilot/skills'))).toEqual([]);
  expect(existsSync(join(project, '.github/skills/ui-ux-pro-max/SKILL.md'))).toBe(true);
});
