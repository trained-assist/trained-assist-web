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
