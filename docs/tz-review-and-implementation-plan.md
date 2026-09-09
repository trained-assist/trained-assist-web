# Ревью ТЗ: trained-assist-web

## Что правильно в ТЗ

- Vanilla JS без npm — правильный выбор для простого UI, нет build-пайплайна
- httpOnly JWT cookie — корректный подход к auth
- SSE для стриминга — правильно, WebSocket избыточен
- Профильная изоляция через cookie → username → workDir — архитектурно верно
- "Reply" = новый Claude-вызов с контекстом сессии — верно, это точно то, как работает runner.js сейчас
- Статика отдаётся самим агентом — убирает лишний nginx location

---

## Решения по спорным пунктам

### 1. Folder tree — стыковка между сервисами

Путь к данным профиля, который нужно знать фронту через API:

| Что | Путь |
|-----|------|
| Рабочая директория профиля | `$AGENT_DATA_DIR/sessions/<username>/` |
| Сессии | `$AGENT_DATA_DIR/sessions/<username>/sessions/` |
| Выбор папки для новой задачи | sub-директории внутри workDir профиля |

Фронту достаточно одного эндпоинта `GET /web/files/tree` — он возвращает дерево директорий внутри workDir профиля до глубины 2. Корень жёстко привязан к профилю из JWT — пользователь физически не может вылезти за пределы своей папки.

```json
{
  "root": "/home/vova/agent-data/sessions/efi",
  "tree": [
    { "name": "my-project", "path": "my-project", "type": "dir" },
    { "name": "cv-parsing",  "path": "cv-parsing",  "type": "dir" }
  ]
}
```

Security: любой `..` в пути → 400, symlinks не следуем.

---

### 2. Путь к sessions в ТЗ

В README написано `~/users/<username>/sessions/` — неверно.
Правильно: `$AGENT_DATA_DIR/sessions/<username>/` (всегда через env var, не хардкод).
Исправить в README.md репа trained-assist-web.

---

### 3. Dual-stream: Telegram + Web

Противоречия нет. Веб показывает **все** сессии профиля — независимо от того, откуда они запущены.

Если пользователь отвечает из веба на сессию, которая началась из Telegram — это просто resume сессии с новым контекстом (как обычный `/web/run` с `sessionId`). Ответ стримится в веб. Слать ли его также в Telegram — для MVP не нужно, если это усложняет.

Реализация: `outputCallback` в `_runTask` + EventEmitter registry в web-routes.js:
```js
const taskStreams = new Map(); // taskId → EventEmitter
// runTask вызывается с outputCallback → пишет чанки в emitter
// SSE endpoint подписывается на emitter
```

---

### 4. Статус "waiting for input"

Убрать из MVP. Оставить три статуса:
- `running` — есть запись в `activeTasks` Map runner.js (экспортировать `isTaskRunning(username)`)
- `completed` — задача завершена нормально
- `failed` — ненулевой exit code

---

### 5. WEB_JWT_SECRET — только GCP

Веб-интерфейс деплоится только на GCP VM (`recruiter-assistant.ru`).
RU VM не нужен. Значит:
- `WEB_JWT_SECRET` только в GCP Secret Manager
- В deploy workflow RU VM не трогаем

---

### 6. CSRF

Проверять `Origin` header на все state-changing POST (`/web/run`, `/web/reply`, `/web/stop`).
Должен совпадать с `process.env.AGENT_PUBLIC_URL`. Одна строка в middleware web-routes.js.

---

### 7. SSE reconnect

Сервер: `event: ping\ndata: {}\n\n` каждые 15с — браузер знает что соединение живо.
Frontend: `eventsource.onerror` → показать "Переподключение..." → `setTimeout(connect, 3000)`.

---

### 8. Деплой статики

При деплое агента на GCP VM — клонировать trained-assist-web и скопировать статику:
```bash
# в deploy.sh агента:
git clone https://github.com/trained-assist/trained-assist-web /tmp/web-ui
mkdir -p src/public
cp -r /tmp/web-ui/src/* src/public/
```
Агент сам отдаёт `/web/*` как статику из `src/public/`.

---

### 9. /web/reply = /web/run с sessionId

`POST /web/reply/:id` и `POST /web/run` — одна и та же логика.
Реализовать как один внутренний хелпер `startWebTask({ username, task, sessionId? })`.
Оставить два эндпоинта для семантики, оба вызывают один хелпер.

---

### 10. Ответы Claude рендерятся как Markdown — ключевое упрощение

Claude уже выдаёт Markdown. В Telegram он рендерится через `parse_mode: Markdown` — но плохо (Telegram поддерживает только подмножество).

В вебе можно рендерить **нормальный MD**: заголовки, код с подсветкой, списки, таблицы — всё.

Это меняет подход к фронтенду:
- Ответы Claude в истории сессии хранятся как plain text (уже так в session-store)
- При отображении пропускаем через лёгкий MD-рендерер (например [marked.js](https://marked.js.org/) — 50кб, без зависимостей)
- Live stream: чанки накапливаются в буфере → перерендер после каждого чанка
- Не нужно разбирать tool calls, thinking blocks — Claude пишет их в читаемом виде

**Результат**: пользователь видит красиво отформатированный ответ вместо сырого текста с `**` и `` ` ``. Это главное отличие веба от Telegram и главный UX-выигрыш.

Реализация:
```html
<!-- в index.html -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```
```js
// в app.js — рендер сообщения
function renderMessage(text) {
  el.innerHTML = marked.parse(text);
}

// live stream — накапливать буфер и ререндерить
let buffer = '';
eventsource.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === 'chunk') {
    buffer += msg.text;
    renderMessage(buffer);
  }
};
```

---

## Этапы реализации

### Этап 1: Backend — Auth
**Файлы в агенте:** `src/web-auth.js`, правки `src/secrets.js`, `src/server.js`

Реализовать:
- `hashPassword(plain)` → scrypt hash → сохранить в `~/agent-tokens/<username>/.webpasswd` с mode 0o600
- `verifyPassword(plain, hash)` → boolean
- `signJwt(username)` → JWT exp 24h, подписан `WEB_JWT_SECRET`
- `verifyJwt(token)` → username или null
- `POST /web/auth` → verify → set httpOnly cookie `web_token`
- `POST /admin/webpass` → Bearer `AGENT_SECRET` → hash → save → return plain password
- Middleware `webAuth(req)` → username или 401

**Тест план:**
```bash
# Создать пароль для профиля
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

# /admin/webpass без AGENT_SECRET → 401
curl -X POST http://localhost:3001/admin/webpass \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser"}'
# → 401
```

---

### Этап 2: Backend — Sessions API
**Файлы в агенте:** `src/web-routes.js`

Реализовать:
- `GET /web/sessions` → sessions.json профиля, последние 20, + поле `status` (running/completed/failed)
- `GET /web/session/:id` → `sessions/<id>.json` с messages + status
- Изоляция: id сессии проверяется через sessions.json профиля — нельзя открыть чужую

**Тест план:**
```bash
# Список
curl -b cookies.txt http://localhost:3001/web/sessions
# → [{id, topic, lastAt, messageCount, status:"completed"}...]

# Сессия с историей
curl -b cookies.txt http://localhost:3001/web/session/s-1234567890
# → {id, topic, messages:[{role,content,at}...], status:"completed"}

# Чужая сессия — 404 (не в sessions.json профиля)
curl -b cookies.txt http://localhost:3001/web/session/s-other-user
# → 404

# Несуществующая — 404
curl -b cookies.txt http://localhost:3001/web/session/s-fake
# → 404
```

---

### Этап 3: Backend — outputCallback в runner.js + isTaskRunning
**Файлы в агенте:** `src/runner.js`

Реализовать:
- Параметр `outputCallback` в `_runTask(opts)` — если передан, вызывается на каждый stdout chunk
- Вызывается параллельно с Telegram push (не вместо)
- `module.exports.isTaskRunning = (username) => ...` — проверяет activeTasks Map

**Тест план:**
```bash
# Запустить задачу, проверить isTaskRunning через /stats или временный эндпоинт
curl -b cookies.txt -X POST http://localhost:3001/web/run \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3001" \
  -d '{"task":"подожди 10 секунд потом скажи привет"}'
# Пока идёт:
curl -b cookies.txt http://localhost:3001/web/sessions
# → [{..., status:"running"}]
```

---

### Этап 4: Backend — POST /web/run с SSE
**Файлы в агенте:** `src/web-routes.js`

Реализовать:
- `POST /web/run` + `POST /web/reply/:sessionId` → один хелпер `startWebTask`
- Хелпер: создаёт EventEmitter → вызывает `runTask` с `outputCallback` → возвращает emitter
- SSE endpoint: подписывается на emitter → пишет `data: {...}\n\n`
- Ping каждые 15с: `event: ping\ndata: {}\n\n`
- Origin check на все POST
- `POST /web/stop/:sessionId` → `stopUserTask(username)`

**Тест план:**
```bash
# Запуск задачи + SSE
curl -b cookies.txt -N -X POST http://localhost:3001/web/run \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3001" \
  -d '{"task":"скажи одно слово: привет"}'
# → data: {"type":"chunk","text":"привет\n"}
# → data: {"type":"done","sessionId":"s-xxx"}

# Resume существующей сессии
curl -b cookies.txt -N -X POST http://localhost:3001/web/reply/s-xxx \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3001" \
  -d '{"message":"теперь скажи пока"}'
# → data: {"type":"chunk","text":"пока\n"}

# Стоп
curl -b cookies.txt -X POST http://localhost:3001/web/stop/s-xxx
# → {"ok":true}

# Origin check — 403
curl -b cookies.txt -X POST http://localhost:3001/web/run \
  -H "Content-Type: application/json" \
  -d '{"task":"test"}'
# → 403
```

---

### Этап 5: Backend — Folder tree
**Файлы в агенте:** `src/web-routes.js`

Реализовать:
- `GET /web/files/tree` → walk workDir профиля до глубины 2, только директории
- Path резолвится строго внутри workDir через `path.resolve` + проверка prefix
- Symlinks не следуем (`fs.lstatSync` вместо `fs.statSync`)

**Тест план:**
```bash
# Базовый — возвращает дерево
curl -b cookies.txt http://localhost:3001/web/files/tree
# → {"root":"/home/vova/agent-data/sessions/testuser","tree":[{"name":"proj","path":"proj","type":"dir"}]}

# Path traversal — 400
curl -b cookies.txt "http://localhost:3001/web/files/tree?path=../../etc"
# → 400

# Пустой профиль — пустой массив, не 404
# → {"root":"...","tree":[]}
```

---

### Этап 6: Frontend — Markdown-first
**Файлы в этом репо:** `src/login.html`, `src/index.html`, `src/app.js`, `src/style.css`

Ключевое решение: **все ответы Claude рендерятся как Markdown** через marked.js.

Реализовать:
- `login.html` — форма username/password → POST /web/auth → redirect
- `index.html` — список сессий (topic, время, статус-бейдж) + кнопка "Новая задача"
- Новая задача: folder picker из `/web/files/tree` + textarea задачи
- Экран сессии: история (MD-рендер) + live stream (накопление буфера → перерендер)
- Кнопка Stop
- SSE reconnect: `onerror` → "Переподключение..." → retry через 3с

**Тест план (ручной):**
- `/web/login` без cookie → форма
- Неверный пароль → сообщение об ошибке
- Верный → список сессий
- Открыть старую сессию → история с MD-рендером (жирный, код, списки отображаются нормально)
- Новая задача → выбрать папку из дерева → ввести → Submit → live stream с MD
- Stop → стрим обрывается
- Refresh → сессия в списке, история сохранена
- Имитировать обрыв сети (DevTools → Offline) → появляется "Переподключение..." → сеть восстановлена → поток возобновляется

---

### Этап 7: tg-bot — команда /webpass
**Файлы в trained-assist-tg-bot**

Реализовать:
- `/webpass <username>` — только operator chat ID
- `POST /admin/webpass` на агент → пароль в ЛС оператору (не в группу)

**Тест план:**
```
/webpass testuser
→ Пароль для testuser: xK9mP2qR

# Не оператор → игнорируем
```

---

### Этап 8: Деплой
**Файлы:** `deploy.sh` в агенте

Добавить шаг в deploy.sh:
```bash
git clone https://github.com/trained-assist/trained-assist-web /tmp/web-ui
mkdir -p src/public
rm -rf src/public/*
cp -r /tmp/web-ui/src/* src/public/
```

Агент уже умеет отдавать статику — добавить роут `GET /web/*` → serve из `src/public/`.

**Тест план:**
```bash
curl https://recruiter-assistant.ru/web/login -o /dev/null -w "%{http_code}"
# → 200

curl https://recruiter-assistant.ru/web/sessions \
  -H "Cookie: web_token=invalid"
# → 401

# End-to-end: логин из браузера → список сессий → запустить задачу → увидеть MD-рендер
```

---

## Решения по открытым вопросам из ТЗ

| Вопрос | Решение |
|--------|---------|
| Домен? | `recruiter-assistant.ru/web/` — отдельный домен не нужен для MVP |
| Выбор проекта? | `GET /web/files/tree`, корень = workDir профиля, select-список на фронте |
| JWT срок? | 24ч |
| Dual-stream? | Раздельно для MVP: web-задачи → только в веб. Resume Telegram-сессий из веба — без обратного push в Telegram |
| WEB_JWT_SECRET на RU VM? | Не нужен — веб только на GCP |

---

## Что брать из claude-session-manager, что не брать

**Брать:**
- Паттерн SSE (EventEmitter → `res.write('data: ...\n\n')`)
- Паттерн reconnect в frontend (`eventsource.onerror` + setTimeout)

**Не брать:**
- SQLite — в агенте уже session-store с JSON-файлами
- scanner/process-detector — у агента своя activeTasks Map
- Next.js — vanilla JS достаточно
- title-generator, analytics, archiver — лишнее для MVP
- macos-terminal-control — на Linux VM не нужно
