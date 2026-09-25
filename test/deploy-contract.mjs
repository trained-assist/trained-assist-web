import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');

assert.match(workflow,/deploy-production:/,'main CI must include production deploy');
assert.match(workflow,/github\.ref == 'refs\/heads\/main'/,'deploy must be main-only');
// GITHUB_TOKEN merges never trigger push runs: a push-only deploy never ran after
// auto-merge (#46 shipped nothing to prod). Deploy must chain off the merge job
// and ship the exact merged commit.
const deployJob = workflow.split(/\n  deploy-production:\n/)[1].split(/\n  [a-z-]+:\n/)[0];
assert.match(deployJob,/needs: \[[^\]]*auto-merge[^\]]*\]/,'deploy must run after auto-merge in the PR run');
assert.match(deployJob,/needs\.auto-merge\.outputs\.merged_sha != ''/,'deploy must trigger on a real merge');
assert.match(deployJob,/ref: \$\{\{ needs\.auto-merge\.outputs\.merged_sha \|\| github\.sha \}\}/,'deploy must check out the merged main commit');
assert.match(workflow,/merged_sha=\$SHA" >> "\$GITHUB_OUTPUT"/,'auto-merge must export the merge commit');
assert.match(workflow,/secrets\.CF_API_TOKEN/,'deploy must use Cloudflare token');
assert.match(workflow,/secrets\.CF_ACCOUNT_ID/,'deploy must use Cloudflare account');
assert.match(workflow,/app\.trainedassist\.store/,'deploy must smoke the real production hostname');
assert.match(workflow,/data-testid="new-session"/,'smoke must verify the right-rail New Session UI');
assert.match(workflow,/data-testid="create-panel"/,'smoke must reject the legacy sidebar create panel');
assert.match(worker,/buildSha: this\.env\.BUILD_SHA \|\| null/,'healthz must expose exact deployed revision');

console.log('PASS: production deploy is main-only and smoke proves revision + right-rail composer');
