# trained-assist-web

Веб-интерфейс для пользователей trained-assist.  
**User story не меняется** — меняется только канал доставки: вместо Telegram открываешь браузер.

---

## Контекст

Сейчас пользователи работают через Telegram-бота (`trained-assist-tg-bot`).  
Бот пересылает задачи в `trained-assist-agent` (Node.js на GCP VM), который запускает Claude Code и стримит ответ обратно в Telegram.

Этот репо добавляет **веб-интерфейс с идентичной логикой**:
- те же сессии
- та же история
- тот же формат взаимодействия
- Telegram и веб работают параллельно на одном профиле

---

## Что такое профиль

**Профиль = username** (например `efi`, `recruiter-skillset`).

- Файлы сессий: `~/users/<username>/sessions/`
- Токены сервисов: `~/agent-tokens/<username>/`
- Пароль веба: `~/agent-tokens/<username>/.webpasswd` (scrypt хэш)

Один профиль может использоваться из множества Telegram-чатов и из веба одновременно.  
История сессий **общая** — что написал в Telegram, видно в вебе, и наоборот.

---

## Архитектура

```
Browser ──HTTPS──► Nginx ──► trained-assist-agent :3001
                                 │
                         новые эндпоинты:
                         POST /web/auth      → JWT cookie
                         POST /web/run       → SSE стрим (вместо Telegram push)
                         GET  /web/sessions  → список сессий профиля
                         GET  /web/session/:id → история сессии
                         GET  /web/*         → статика (этот репо)
```

Фронтенд (этот репо) — статические файлы (`src/public/`), отдаются самим агентом.  
Никакого отдельного сервера, никакого SSR.

---

## Аутентификация

**Пароли выдаёт оператор через Telegram:**

```
Оператор: /webpass efi
Бот: Пароль для efi: xK9mP2qR
```

Флоу:
1. Пользователь открывает `/web/login`, вводит username + password
2. `POST /web/auth` → агент проверяет хэш → устанавливает JWT в httpOnly cookie (24ч)
3. Все запросы авторизованы через cookie

---

## User story (без изменений)

Пользователь открывает браузер вместо Telegram — и делает ровно то же самое:

1. Видит список своих диалогов
2. Открывает нужный или начинает новый
3. Пишет задачу
4. Видит ответ Claude в реальном времени (стрим)
5. Продолжает диалог или начинает новый

Классификация (к какой сессии относится сообщение) — на агенте, как в боте.  
Stop-команда работает так же.

---

## Эндпоинты агента (новые)

### `POST /web/auth`
```json
{ "username": "efi", "password": "xK9mP2qR" }
```
→ устанавливает `httpOnly` cookie `web_token`  
→ `{ "ok": true, "username": "efi" }`

### `POST /web/run`
Требует cookie `web_token`
```json
{ "task": "напиши пост про ...", "sessionId": "uuid-optional" }
```
→ SSE стрим:
```
data: {"type":"chunk","text":"Пишу..."}
data: {"type":"done","sessionId":"abc-123"}
```

### `GET /web/sessions`
→ список сессий профиля (из session-store), последние 20

### `GET /web/session/:id`
→ история сообщений конкретной сессии

### `POST /web/stop`
→ останавливает текущую задачу (аналог "Стоп" в боте)

### `POST /admin/webpass`
Требует `Authorization: Bearer <AGENT_SECRET>`
```json
{ "username": "efi" }
```
→ генерирует пароль, сохраняет scrypt хэш  
→ `{ "password": "xK9mP2qR" }`

---

## Изменения в trained-assist-agent

Реализуются отдельной сессией.

### Новые файлы
- `src/web-auth.js` — scrypt хэши, JWT sign/verify
- `src/web-routes.js` — все `/web/*` и `/admin/webpass` роуты

### Изменения в существующих
- `src/server.js` — подключить `web-routes.js`
- `src/runner.js` — добавить `outputCallback` опцию в `_runTask` (вместо Telegram)
- `src/secrets.js` — добавить `WEB_JWT_SECRET` в список

### Новый секрет
- `WEB_JWT_SECRET` в GCP Secret Manager

---

## Изменения в trained-assist-tg-bot

- Команда `/webpass <username>` (только оператор) → вызывает `POST /admin/webpass`, показывает пароль

---

## Фронтенд (этот репо)

Vanilla JS + HTML + CSS, без npm-зависимостей на фронте.

**Структура:**
```
src/
  index.html       — чат (список сессий + текущий диалог)
  login.html       — форма логина
  app.js           — логика: SSE, сессии, auth
  style.css        — стили
```

**Деплой:** статика лежит в `src/public/` внутри trained-assist-agent и отдаётся его же сервером.

---

## Порядок реализации

1. **Это ТЗ** (этот файл) — финализируем, отвечаем на открытые вопросы
2. **Ревью агента** — отдельная сессия читает trained-assist-agent, оценивает что именно менять
3. **План + тесты** — пишем что тестировать перед началом
4. **PR в агент** — feature ветка, `src/web-auth.js`, `src/web-routes.js`, правки `runner.js`
5. **Фронт в этот репо** — HTML/JS/CSS
6. **PR в tg-bot** — команда `/webpass`
7. **Деплой** — CI деплоит агент, статика копируется в `src/public/`

---

## Открытые вопросы

1. **Домен** — отдельный для веба или через агентовский `136-65-7-197.sslip.io`?
2. **JWT срок** — 24ч и логин снова, или дольше?
3. **Stop в вебе** — кнопка нужна в UI или достаточно написать "стоп"?
