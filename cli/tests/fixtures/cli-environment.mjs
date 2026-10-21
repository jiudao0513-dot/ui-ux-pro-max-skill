// Child-process-only test seams: never change the runner's home or contact GitHub.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import prompts from 'prompts';
os.homedir = () => process.env.UIPRO_TEST_HOME;
syncBuiltinESMExports();
prompts.inject([true]);
globalThis.fetch = async (url) => {
  if (String(url) !== 'https://api.github.com/repos/nextlevelbuilder/ui-ux-pro-max-skill/releases/latest') {
    throw new Error(`Unexpected network request: ${url}`);
  }
  return new Response(JSON.stringify({tag_name: `v${process.env.UIPRO_TEST_VERSION}`, assets: []}));
};
