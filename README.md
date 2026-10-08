# trained-assist-web

Пользовательский Web UI Trained Assist: проекты, разговоры/задачи, история, текущие события, запуск, stop, supplementary input и Awaiting user input. Пользователь не должен знать SSH или CLI движка.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Runtime и ownership

`worker.mjs` — Cloudflare Worker; `SessionHub` Durable Object обслуживает `/web/*` и хранит локальное состояние UI. `wrangler.toml` задаёт Worker, assets из `src/` и DO binding. `src/app.js`, HTML/CSS — клиент. Старый план «Nginx/GCP раздаёт статику из ядра» не является deployment инструкцией этого репозитория.

Целевая task/run identity и execution state приходят из control plane/Runner через явный backend adapter. Локальная UI-проекция не создаёт второго orchestration owner. Наличие адаптера не доказывает завершение cutover; bindings и evidence проверяются в issue.

## Пользовательский контракт

- Sessions list слева, conversation в центре, создание задачи справа.
- Profile/project scope проверяется на host; пользователь не выбирает произвольный абсолютный путь сервера.
- Несколько задач/вкладок допустимы; запись в одну сессию сериализуется. Reconnect не теряет и не дублирует сообщения.
- Receipt, engine state, сохранение файлов и доставка различаются. Pending/unknown не отображаются как успешное завершение.
- Form/choice и подтверждение credentials продолжают конкретное ожидание. Клик формы сам по себе не запускает агента.
- Auth secrets и одноразовые tickets не логируются; чужой профиль и session недоступны.

## Observability — Error Watcher

Этот репозиторий публикует error-события в [trained-assist-error-watcher](https://github.com/trained-assist/trained-assist-error-watcher) — общую точку сбора ошибок платформы.

- [Error Watcher](https://github.com/trained-assist/trained-assist-error-watcher)
- [Архитектура](https://github.com/trained-assist/trained-agent-architecture)
- [SYSTEM-ERROR-WATCHER.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SYSTEM-ERROR-WATCHER.md) — спека
- [OBSERVABILITY-AND-ERROR-CONTRACT.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md) — контракт observability/error

## Проверка

```bash
npm ci
npm test
npm run dev
```

Команды и Node requirement — в `package.json`. [Acceptance scenarios](docs/ACCEPTANCE-TESTS.md), [reconnect integrity](test/ui-reconnect-integrity.md) и [session import](docs/IMPORT-SESSIONS-WINDOWS.md) задают локальные проверки; не заменяют cloud cutover acceptance.

Все изменения через feature branch + PR. Runtime/UX изменения не входят в documentation cleanup. Источник актуальных работ — [issues](https://github.com/trained-assist/trained-assist-web/issues) и [Integrator](https://github.com/trained-assist/trained-agent-architecture/issues/140); [целевая модель](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md).

This Web UI runs on the Cloudflare Worker defined by this repository. Do not add new workloads to retiring GCP VM `alesa-personal-assistent/us-central1-a/alesa-vm`; use the Agent Run API and the owning host contracts. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.

## Isolated sandbox deployment

A separate manual workflow deploys a Worker named
`trained-assist-web-sandbox` to its workers.dev URL. Its Durable Object
namespace is separate from production. The config contains no production
route, agent endpoint, credentials, or storage binding. This is a deployment
and UI/auth smoke target; it does not exercise agent-backed create/reply flows.

Set up the GitHub `web-sandbox` Environment with variable `CF_ACCOUNT_ID` and
secrets `SANDBOX_CF_API_TOKEN` (a Cloudflare token scoped to this account and Worker
script/asset/secret deployment) and `DEMO_PASSWORD` (sandbox-only). Then run
**Deploy sandbox** manually and type `SANDBOX`. The workflow runs `npm test`
before deploying the selected commit, sets the sandbox password, deploys with
its exact SHA, and checks `/healthz`, the UI, and rejection of an invalid login.

The current `test:staging` command is local Playwright/test execution; it does
not deploy a remote environment. Production remains on the existing protected
workflow and production Worker config.

Sandbox deployment evidence (2026-10-08): source SHA
`5d9031608b88494c6992db753e86a9edb71c385b` is serving at
https://trained-assist-web-sandbox.skillset-apply.workers.dev as Worker version
`7779ea57-0964-4c99-b90b-757b2330fd53`. `/healthz` returned HTTP 200 with the
exact SHA, `/` returned HTTP 200 and the New Session UI marker, and an invalid
`/web/auth` password returned HTTP 401. Agent-backed create/reply was not run:
the sandbox intentionally has no agent endpoint or credentials.
