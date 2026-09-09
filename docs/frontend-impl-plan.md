# Frontend Implementation Plan

## Что реализовано

Минимальный ванильный SPA без build-пайплайна.

### Файлы

| Файл | Назначение |
|------|-----------|
| `src/login.html` | Страница входа — форма пароля → POST /web/auth |
| `src/index.html` | SPA-шаблон — две вьюхи (список сессий + детальная) + модал |
| `src/app.js` | Вся логика: роутинг по hash, API calls, SSE стриминг |
| `src/style.css` | Стили — light/dark theme, responsive, MD-контент |

### Архитектура

**Hash-роутинг:**
- `#/` → список сессий
- `#/session/:id` → детальная вьюха сессии

**Auth:**  
- Токен из `POST /web/auth { password }` сохраняется в `localStorage['wa_token']`
- Все запросы: `Authorization: Bearer <token>` + `credentials: 'include'` для cookie-based fallback
- 401 → редирект на `login.html`

**SSE стриминг (POST → ReadableStream):**  
Поскольку `EventSource` не поддерживает POST, используем `fetch` + `res.body.getReader()`.
Парсинг SSE вручную: ищем строки `data: {...}`.

Типы событий от сервера:
- `{ type: 'chunk', text: '...' }` — аккумулируем в буфер, ренедрим как MD
- `{ type: 'done', sessionId: '...' }` — перезагружаем сессию
- `{ type: 'error', message: '...' }` — показываем ошибку

SSE reconnect: `onerror` / обрыв стрима → 3s задержка → повтор, до 3 попыток.

**Просмотр running-сессии (из списка):**  
Если сессия уже `running` (запущена не из этого браузера), приаттачиться к её SSE нельзя (POST уже ушёл).
Fallback: `setInterval(2500ms)` → `GET /web/session/:id` → обновляем `lastMessage`.

**Markdown:**  
`marked.js 12` из cdn.jsdelivr.net. Все ответы Claude рендерятся как MD.
User-сообщения — `escHtml()`, не MD (пользователь пишет plain text).

### API mapping

| UI action | API endpoint | Тело |
|-----------|-------------|------|
| Login | `POST /web/auth` | `{ password }` |
| Список сессий | `GET /web/sessions` | — |
| Создать сессию | `POST /web/sessions` | `{ path }` |
| Открыть сессию | `GET /web/session/:id` | — |
| Запустить задачу | `POST /web/run` | `{ session, message }` |
| Ответить | `POST /web/reply` | `{ session, message }` |
| Стоп | `POST /web/stop` | `{ session }` |
| Дерево папок | `GET /web/files/tree` | — |

### Ограничения MVP

- Нет real-time обновления списка сессий (нужен refresh вручную)
- Для running-сессий (запущенных из Telegram) — polling, не настоящий стриминг
- Нет поиска/фильтрации сессий
- Нет inline file viewer (`GET /web/files/tree` используется только для выбора папки при создании)

## Деплой

По плану из ТЗ (Этап 8): копировать `src/*` в `src/public/` агента:

```bash
cp -r /tmp/web-ui/src/* src/public/
```

Агент отдаёт `/web/login` → `src/public/login.html`, etc.
