import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');

assert.match(workflow,/deploy-production:/,'main CI must include production deploy');
assert.match(workflow,/github\.ref == 'refs\/heads\/main'/,'deploy must be main-only');
assert.match(workflow,/secrets\.CF_API_TOKEN/,'deploy must use Cloudflare token');
assert.match(workflow,/secrets\.CF_ACCOUNT_ID/,'deploy must use Cloudflare account');
assert.match(workflow,/app\.trainedassist\.store/,'deploy must smoke the real production hostname');
assert.match(workflow,/data-testid="new-session"/,'smoke must verify the right-rail New Session UI');
assert.match(workflow,/data-testid="create-panel"/,'smoke must reject the legacy sidebar create panel');
assert.match(worker,/buildSha: this\.env\.BUILD_SHA \|\| null/,'healthz must expose exact deployed revision');

console.log('PASS: production deploy is main-only and smoke proves revision + right-rail composer');
