# Ревью ТЗ: trained-assist-web

## Что правильно в ТЗ

- Vanilla JS без npm — правильный выбор для простого UI, нет build-пайплайна
- httpOnly JWT cookie — корректный подход к auth
- SSE для стриминга — правильно, WebSocket избыточен
- Профильная изоляция через cookie → username → workDir — архитектурно верно
- "Reply" = новый Claude-вызов с контекстом сессии — верно, это точно то, как работает runner.js сейчас
- Статика отдаётся самим агентом — убирает лишний nginx location

---

## Дыры и незакрытые вопросы

### 1. Folder tree — самое важное, почти не описано

ТЗ: "выбор папки/проекта" упомянут вскользь, открытый вопрос #2 без ответа.
Требование: **строго своё дерево папок**.

Нужно уточнить:
- **Корень дерева** — `$AGENT_DATA_DIR/sessions/<username>/` — только папки профиля
- **Глубина** — до 2-3 уровней, не рекурсивно
- **Что выбирает пользователь** — sub-папку внутри своего workDir, которая станет рабочей директорией для новой задачи

Нужен новый эндпоинт: `GET /web/files/tree` — возвращает дерево директорий профиля.

```json
{ "tree": [
  { "name": "my-project", "path": "my-project", "type": "dir", "children": [...] },
  { "name": "report.md",  "path": "report.md",  "type": "file" }
]}
```

**Security rule**: путь резолвится внутри workDir профиля. Path traversal (`../`) → 400.

---

### 2. Typing inconsistency в ТЗ

В разделе "Что такое профиль" написано:
```
~/users/<username>/sessions/
```
Везде в коде — `$AGENT_DATA_DIR/sessions/<username>/`. Нужно исправить в README.

---

### 3. Dual-stream: Telegram + Web одновременно

Сейчас `_runTask` пушит в Telegram через `tgEdit`. ТЗ предлагает добавить `outputCallback`.

Проблема: если задача запущена из Telegram, а пользователь открывает веб — нужно ли отдать live stream?

Нужно решить явно:
- **Вариант A (MVP)**: задачи из веба — только в веб, задачи из Telegram — только в Telegram
- **Вариант B**: любая задача стримится в оба канала одновременно

Рекомендую **Вариант A** — проще, нет race conditions.

Реализация: `outputCallback` в `_runTask` + EventEmitter registry:
```js
// в web-routes.js
const taskStreams = new Map(); // taskId → EventEmitter
// _runTask получает outputCallback который кладёт чанки в emitter
// SSE-endpoint подписывается на emitter
```

---

### 4. Status "waiting for input" — не детектируется

Session-store не хранит этот статус. Для MVP: убрать `waiting for input` из статусов.
Оставить `running` / `completed` / `failed`.

Статус `running` = есть запись в `activeTasks` Map в runner.js (нужно экспортировать функцию `isTaskRunning(username)`).

---

### 5. WEB_JWT_SECRET — нужен на обоих VM

ТЗ упоминает только GCP Secret Manager. RU VM использует `~/secrets.env`.

Нужно явно прописать в deploy-секции:
- GCP: добавить в GCP Secret Manager + в `.github/workflows/ci.yml` → `printf` блок
- RU VM: добавить в `/home/vova/secrets.env` вручную + в deploy workflow

---

### 6. CSRF

httpOnly cookie защищает от XSS, но state-changing POST (`/web/run`, `/web/reply`, `/web/stop`) без CSRF-токена уязвимы к cross-site form submit.

Минимальная защита: проверять `Origin` header на все POST — должен совпадать с `AGENT_PUBLIC_URL`. Одна строка в web-routes.js.

---

### 7. Reconnect при обрыве SSE

ТЗ не описывает поведение при дропе соединения.

Сервер: отдавать `event: ping` каждые 15с чтобы браузер знал что соединение живо.
Frontend: `eventsource.onerror` → показать "Переподключение..." → retry через 3с.

---

### 8. Деплой статики — механизм не описан

ТЗ: "статика лежит в `src/public/` внутри trained-assist-agent".

Два репо, один должен попасть в другой. Рекомендую **Вариант C** — клонировать при деплое агента:
```bash
# в deploy.sh агента:
git clone https://github.com/trained-assist/trained-assist-web /tmp/web-ui
mkdir -p ~/trained-assist-agent/src/public
cp -r /tmp/web-ui/src/* ~/trained-assist-agent/src/public/
```

---

### 9. /web/reply/:id = /web/run с sessionId

ТЗ описывает два отдельных эндпоинта, но механизм одинаковый — новый Claude-вызов с контекстом сессии.

`POST /web/reply/:id` = `POST /web/run` с `sessionId` указанным в теле. Можно объединить или оставить два с одной логикой. Нужно прописать явно в ТЗ.

---

## Этапы реализации

### Этап 1: Backend — Auth
**Файлы в агенте:** `src/web-auth.js`, правки `src/secrets.js`, `src/server.js`

Реализовать:
- `hashPassword(plain)` → scrypt hash, сохранить в `~/agent-tokens/<username>/.webpasswd`
- `verifyPassword(plain, hash)` → boolean
- `signJwt(username)` → JWT с exp 24h
- `verifyJwt(token)` → username или null
- `POST /web/auth` → verify → set cookie
- `POST /admin/webpass` → hash → save → return plain password
- Middleware: `webAuth(req)` → username или 401

**Тест план:**
```bash
# Создать пароль
curl -X POST http://localhost:3001/admin/webpass \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser"}'
# → {"password":"xK9mP2qR"}

# Логин — Set-Cookie
curl -c cookies.txt -X POST http://localhost:3001/web/auth \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"xK9mP2qR"}'
# → {"ok":true,"username":"testuser"}

# Без cookie — 401
curl http://localhost:3001/web/sessions
# → 401

# С cookie — 200
curl -b cookies.txt http://localhost:3001/web/sessions
# → []

# Неверный пароль — 401
curl -X POST http://localhost:3001/web/auth \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"wrong"}'
# → 401
```

---

### Этап 2: Backend — Sessions API
**Файлы в агенте:** `src/web-routes.js` (начало)

Реализовать:
- `GET /web/sessions` → читает sessions.json профиля, последние 20, добавляет поле `status`
- `GET /web/session/:id` → читает `sessions/<id>.json`, messages + status

**Тест план:**
```bash
# Список сессий
curl -b cookies.txt http://localhost:3001/web/sessions
# → [{id, topic, lastAt, messageCount, status:"completed"}...]

# Конкретная сессия
curl -b cookies.txt http://localhost:3001/web/session/s-1234567890
# → {id, topic, messages:[...], status:"completed"}

# Чужая сессия — 404
curl -b cookies.txt http://localhost:3001/web/session/s-other-profile-session
# → 404

# Несуществующая — 404
curl -b cookies.txt http://localhost:3001/web/session/s-nonexistent
# → 404
```

---

### Этап 3: Backend — outputCallback в runner.js
**Файлы в агенте:** `src/runner.js`

Реализовать:
- `outputCallback` опция в `_runTask` — если передана, вызывается на каждый stdout chunk
- Вызывается параллельно с Telegram push (не вместо)
- EventEmitter registry в `web-routes.js`: `taskStreams = new Map(taskId → EventEmitter)`
- Экспортировать `isTaskRunning(username)` из runner.js для статуса сессий

**Тест план:**
```js
// unit: запустить runTask с outputCallback, проверить что chunks приходят
const chunks = [];
await runTask({ ..., outputCallback: chunk => chunks.push(chunk) });
assert(chunks.length > 0);
```

---

### Этап 4: Backend — POST /web/run с SSE
**Файлы в агенте:** `src/web-routes.js`

Реализовать:
- `POST /web/run` → taskId → emitter → `runTask` с outputCallback → SSE stream
- Origin check на все POST
- SSE ping каждые 15с
- `POST /web/stop/:sessionId` → `stopUserTask(username)`
- `POST /web/reply/:sessionId` → как /web/run но с sessionId

**Тест план:**
```bash
# Запустить и получить SSE
curl -b cookies.txt -N -X POST http://localhost:3001/web/run \
  -H "Content-Type: application/json" \
  -H "Origin: https://recruiter-assistant.ru" \
  -d '{"task":"скажи одно слово: привет"}'
# → data: {"type":"chunk","text":"привет"}
# → data: {"type":"done","sessionId":"s-xxx"}

# Стоп
curl -b cookies.txt -X POST http://localhost:3001/web/stop/s-xxx
# → {"ok":true}

# Origin check: без Origin → 403
curl -b cookies.txt -X POST http://localhost:3001/web/run \
  -H "Content-Type: application/json" \
  -d '{"task":"test"}'
# → 403
```

---

### Этап 5: Backend — Folder tree
**Файлы в агенте:** `src/web-routes.js`

Реализовать:
- `GET /web/files/tree` → walk workDir профиля до глубины 2
- Запрещены `..` в пути, symlinks за пределы workDir
- Возвращает директории (для выбора workDir новой задачи)

**Тест план:**
```bash
# Базовый
curl -b cookies.txt http://localhost:3001/web/files/tree
# → {"root":"/home/vova/agent-data/sessions/testuser","tree":[...dirs...]}

# Path traversal — 400
curl -b cookies.txt "http://localhost:3001/web/files/tree?path=../../etc"
# → 400

# Профиль без sub-папок — пустой tree, не 404
# → {"root":"...","tree":[]}
```

---

### Этап 6: Frontend
**Файлы в этом репо:** `src/login.html`, `src/index.html`, `src/app.js`, `src/style.css`

Реализовать:
- `login.html` — форма username/password → POST /web/auth → redirect на /web/
- `index.html` — список сессий + кнопка "Новая задача"
- Сессия: история + SSE стрим → live обновление
- Folder picker: дерево из GET /web/files/tree → select-список
- Кнопка Stop
- SSE reconnect: onerror → "Переподключение..." → retry через 3с

**Тест план (ручной browser flow):**
- `/web/login` без cookie → форма
- Неверный пароль → "Неверный пароль"
- Верный → redirect на `/web/`
- Видим список сессий профиля
- "Новая задача" → folder picker + поле задачи
- Выбрать папку → ввести задачу → Submit → live stream появляется
- Refresh → сессия в списке, история сохранена
- Вторая вкладка → тоже видит текущий stream
- Stop → стрим обрывается, кнопка меняется

---

### Этап 7: tg-bot — команда /webpass
**Файлы в trained-assist-tg-bot**

Реализовать:
- `/webpass <username>` — только operator chat ID
- POST /admin/webpass на агент → пароль в ЛС оператору

**Тест план:**
```
/webpass testuser
→ Пароль для testuser: xK9mP2qR
# (в ЛС, не в группе)

# Не оператор → молчим или "нет прав"
```

---

### Этап 8: Деплой
**Файлы:** `deploy.sh` или CI в агенте

Реализовать:
- При деплое агента: клонировать trained-assist-web → скопировать в `src/public/`
- nginx: `/web/` → proxy_pass на агент порт 3001 (или агент сам отдаёт статику)

**Тест план:**
```bash
curl https://recruiter-assistant.ru/web/login -o /dev/null -w "%{http_code}"
# → 200

curl https://recruiter-assistant.ru/web/sessions \
  -H "Cookie: web_token=invalid"
# → 401
```

---

## Приоритеты открытых вопросов из ТЗ

| Вопрос | Решение |
|--------|---------|
| Домен? | `recruiter-assistant.ru/web/` — отдельный домен не нужен для MVP |
| Выбор проекта? | `GET /web/files/tree` + select из своего дерева. Корень = workDir профиля |
| JWT срок? | 24ч достаточно для MVP |

---

## Что брать из claude-session-manager, что не брать

**Брать:**
- Паттерн SSE стриминга (EventEmitter → response.write)
- Паттерн reconnect в frontend (onerror + setTimeout retry)

**Не брать:**
- SQLite DB — в агенте уже есть session-store с JSON
- scanner/process-detector — у агента своя activeTasks Map
- Next.js — ТЗ правильно говорит vanilla JS
- title-generator, analytics, archiver — лишнее для MVP
- macos-terminal-control — на VM не нужно
