# Приёмочные критерии и тесты (ACD) — trained-assist-web

Живой чеклист того, что должно работать, и как это проверяется. Помечено, что
уже покрыто автотестами/Playwright, а что — ручной прогон.

## 1. Аутентификация
- [x] `/login.html` показывает форму (username + password). — Playwright ✓
- [x] Верный вход → редирект на `/`, ставится cookie `sid`. — Playwright ✓ (10.09)
- [ ] Неверный пароль при заданном `DEMO_PASSWORD` → 401 «Wrong password». — ручной / нужен автотест
- [x] Любой `/web/*` при 401 → бросает на `login.html`. — покрыто в app.js, проверено ранее

## 2. Список сессий
- [x] `GET /web/sessions` возвращает массив с `topic`, `status`, `lastAt`, `messageCount`. — API ✓ (10.09)
- [x] Пустой список → плашка «No sessions yet» (`data-testid=sessions-empty`). — тест #1
- [x] Ошибка загрузки → `role=alert` «Failed to load» (`sessions-error`). — тест #1
- [x] Сортировка по `lastAt`/`createdAt` (свежие сверху). — API ✓
- [x] Клик по строке открывает детально сессию (`#/session/:id`). — Playwright ✓ (10.09)

## 3. Импорт истории (НОВОЕ, 10.09)
- [x] `POST /web/import` c одним объектом → `{ok, imported:1, ids}`. — API ✓
- [x] Импортированная сессия видна в `/web/sessions` с topic + messageCount. — API ✓
- [x] `GET /web/session/:id` отдаёт полную переписку. — API ✓
- [x] Кнопка **↥ Import** + выбор файла → плашка «Imported N», список обновлён. — Playwright ✓
- [x] Открытие импортированной сессии рендерит You/Claude по порядку. — Playwright ✓ (3 msg)
- [x] Идемпотентность: повторный импорт того же `id` не плодит дубли. — по конструкции (put по ключу)
- [ ] Импорт массива / `{sessions:[...]}` из PowerShell. — задокументировано, нужен прогон на реальных файлах
- [ ] Битый JSON в файле → плашка «N file(s) failed to parse», остальные грузятся. — ручной

## 4. Запуск / стрим / reconnect (серия тестов 1–3, закрыта ранее)
- [x] Новая сессия через модалку → SSE-стрим чанками → done. — тест #1
- [x] Reconnect ≤3 попыток при обрыве, `role=status` «Reconnecting…». — тест #1
- [x] Целостность контента при reconnect (сброс buffer, без дублей). — тест #3, баг зафикшен
- [x] Уход со стрима на середине не выдёргивает юзера, инпут разблокирован. — тест #3
- [x] Гонка двойной отправки → single-stream guard (abort). — тест #3
- [x] Стор: cap 50 / ring 300 / eviction, хард-килл. — chaos-loop, 3000 сессий PASS
- [ ] РИСК бэкенд-контракта: reconnect ре-POSTит немидемпотентную мутацию
      (`/web/run`, `/web/reply/:id`) → на реальном session-manager нужен
      resume-токен/идемпотентность. — открыто, для прод-бэкенда

## 5. Persistence
- [x] Сессии в Durable Object переживают cold start. — проверено curl'ом (10.09)
- [ ] Нет эндпоинта удаления сессий. — TODO: `POST /web/delete/:id`

## Как гонять
- API: `curl` против `https://trained-assist-web.skillset-apply.workers.dev`.
- UI: Playwright MCP, стабильные `data-testid` на всех интерактивных элементах.
- Chaos/стор: `test/chaos-loop.mjs`, `test/chaos-multi-backend.mjs` (в ветках #8/#9).

## Открытые задачи (следующая приборка)
1. `POST /web/delete/:id` + кнопка удаления в UI (чистка импортированного мусора).
2. Автотест на неверный пароль и на битый JSON при импорте.
3. Идемпотентность reconnect на реальном session-manager (resume-токен).
4. Прогнать импорт на реальном наборе файлов с Windows-компа.
