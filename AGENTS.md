# Repository instructions


## Sandbox-Driven Engineering

Останавливаться до безопасной dev/test-проверки или отказываться от неё из-за вероятности ошибки — вредно для инженерной работы. Не завершайте задачу одним чтением кода, если Environment Contract даёт безопасный путь исполнения. В заявленных изолированных local/dev/test/staging ресурсах самостоятельно запускайте/развёртывайте, подавайте реалистичный input, проверяйте output/logs/state, исправляйте ошибки и повторяйте сценарий. Ошибка в sandbox — evidence, а не повод закончить работу или попросить лишнее подтверждение. Production — отдельная защищённая граница; работайте с ним только по Promotion to Production path этого репозитория.


## Environment Contract

### Development / Test / Staging
**Resources:** local Worker+assets via `npm run dev`; tests use local Miniflare/Playwright (`npm test`). `npm run test:staging` currently aliases `npm test`; it does not deploy a staging Worker or exercise a remote environment. No separate web staging URL/resource is declared. There is no deployed preview workflow.
**Realistic test:** browser interaction suite against locally started Worker; outputs are browser assertions and local Worker responses. Observe test/Playwright logs and local process output. Reset by restarting local Worker and using disposable local state.
**Agent permissions:** local run/tests unrestricted. There is no web staging deployment to use. Do not deploy the candidate to `app.trainedassist.store` for testing.

### Production / Promotion
Production is Cloudflare Worker/static assets at `https://app.trainedassist.store`; `/healthz` reports build SHA. CI runs on PR, then `auto-merge` merges every non-draft PR when `check` and `staging-gate` pass, and deploys production for that merge. The GitHub `production` Environment currently has zero protection rules. Thus the current path is automated and does not provide a protected promotion boundary.

### Testability Contract / Sandbox Gaps
Local Playwright is the only current repeatable web path. It cannot prove deployed browser → Worker → backend behavior. Existing issue [#35](https://github.com/trained-assist/trained-assist-web/issues/35) tracks real E2E/deploy gate. Issue [#71](https://github.com/trained-assist/trained-assist-web/issues/71) tracks separate production protection. Architecture rollout: trained-agent-architecture#185. Until fixed, keep proposed PR draft; a non-draft PR can auto-merge and deploy production. No PR promotion is being authorized by this contract.

