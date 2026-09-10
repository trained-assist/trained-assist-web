# Импорт истории сессий с Windows-компа в session-менеджер

Цель: перенести файлы сессий со второго (Windows) компьютера и увидеть их
как историю в веб-интерфейсе `https://trained-assist-web.skillset-apply.workers.dev`.

## Что импортируется

Файл сессии агента — это `.json` такого вида:

```json
{
  "id": "s-1234567890-...",
  "topic": "Короткое название беседы",
  "createdAt": 1788989902901,
  "lastAt": 1789000430432,
  "messageCount": 65,
  "messages": [
    { "role": "user", "content": "...", "at": 1788989902901 },
    { "role": "assistant", "content": "...", "at": 1788989950000 }
  ]
}
```

Импорт идемпотентен: повторная загрузка файла с тем же `id` перезапишет сессию,
дубликатов не будет. Можно грузить один объект, массив объектов или `{ "sessions": [...] }`.

## Где лежат файлы сессий на Windows

Обычно в рабочей папке ассистента, подпапка `sessions\`. Найти все файлы:

```powershell
# PowerShell — найти все файлы сессий в профиле
Get-ChildItem -Path $HOME -Recurse -Filter "s-*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.DirectoryName -like "*sessions*" } |
  Select-Object FullName, Length, LastWriteTime
```

## Способ 1 — через интерфейс (проще всего)

1. Открой `https://trained-assist-web.skillset-apply.workers.dev`, залогинься.
2. На экране «Sessions» нажми кнопку **↥ Import**.
3. Выбери один или несколько `.json`-файлов сессий (Ctrl-клик — множественный выбор).
4. Появится плашка «Imported N session(s)», сессии сразу видны в списке как история.
5. Клик по сессии открывает всю переписку (You / Claude).

## Способ 2 — из PowerShell (пакетно, без открытия браузера)

Загрузить одну сессию:

```powershell
$base = "https://trained-assist-web.skillset-apply.workers.dev"
Invoke-RestMethod -Uri "$base/web/import" -Method Post `
  -ContentType "application/json" `
  -InFile "C:\path\to\sessions\s-1234567890.json"
```

Загрузить сразу все сессии из папки:

```powershell
$base = "https://trained-assist-web.skillset-apply.workers.dev"
$files = Get-ChildItem "C:\path\to\sessions" -Filter "s-*.json"
$sessions = $files | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json }
$body = @{ sessions = $sessions } | ConvertTo-Json -Depth 20
Invoke-RestMethod -Uri "$base/web/import" -Method Post -ContentType "application/json" -Body $body
```

Ответ: `{ "ok": true, "imported": N, "ids": [...] }`.

## Проверка

Открой список сессий (или `GET /web/sessions`) — импортированные сессии
отсортированы по `lastAt` и помечены `imported: true`. Открой любую — история
сообщений на месте.

## Важно про хранилище

Сессии хранятся в Durable Object (persistent), переживают перезапуски воркера.
Отдельного эндпоинта удаления пока нет — если нужно чистить историю, добавим
`POST /web/delete/:id`. Аутентификация на `/web/import` сейчас такая же, как на
остальных `/web/*` (демо-гейт по паролю на входе) — для приватного использования
поставь секрет: `npx wrangler secret put DEMO_PASSWORD`.
