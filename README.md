# animelib-backend

Прямой proxy backend к `https://hapi.hentaicdn.org/api`.

## Что изменено

- Прямые маршруты: backend принимает те же пути, что и upstream API.
- Никаких обязательных префиксов `/api`.
- Swagger UI в корне: `GET /`
- OpenAPI JSON: `GET /openapi.json`

## Установка

```bash
npm install
```

## Запуск

```bash
npm run dev
# или
npm start
```

По умолчанию сервер поднимается на `http://localhost:4000`.

## Деплой на Vercel

Проект совместим с zero-config деплоем Express на Vercel: основной entrypoint находится в `src/server.js`, экспортирует `app` и при локальном запуске отдельно поднимает `listen`.

Минимальный сценарий:

```bash
npm i -g vercel
vercel
```

Для локальной проверки именно Vercel-окружения:

```bash
vercel dev
```

## Переменные окружения

Скопируй `.env.example` в `.env`.

- `PORT` — порт сервера
- `API_BASE_URL` — upstream API
- `SITE_ID` — `Site-Id` для upstream (для AnimeLib: `5`)
- `REQUEST_TIMEOUT_MS` — timeout в мс
- `PLAYER_RESOLVE_TTL_MS` — TTL кэша для уже зарезолвленных video links
- `ORPHAN_INDEX_PATH` — путь до локального JSON с восстановленными orphan-карточками
- `ORPHAN_INDEX_REFRESH_MS` — как часто сервер перепроверяет orphan-индекс на изменение
- `ORPHAN_SEARCH_MAX_RESULTS` — сколько orphan-результатов максимум подмешивать в поиск

## Восстановление потерянных карточек

Для orphan-тайтлов, у которых `/anime/:slug` уже умер, но `episodes` ещё живы, есть discovery-скрипт:

```bash
npm run discover:orphans
```

Что он делает:

- обходит живой каталог `AnimeLib`
- забирает `relations` у живых тайтлов
- ищет связанные `TV Сериалы`, у которых `/anime/:slug` уже `404`
- проверяет, что по их `anime_id` всё ещё есть `episodes`
- сохраняет восстановленные карточки в `data/orphan-tv-anime.json`

Примеры:

```bash
# точечная проверка по конкретным живым тайтлам-источникам
npm run discover:orphans -- --source-slugs=26540--witch-watch-2nd-season-anime,26956--oshi-no-ko-final-season-anime --out=data/orphan-sample.json

# полный проход по каталогу TV-сериалов
npm run discover:orphans -- --max-pages=250 --out=data/orphan-tv-anime.json
```

В JSON попадают:

- `card.data` — восстановленная карточка тайтла
- `episodes` — список эпизодов
- `source_manga` — первоисточник, если он есть в `relations`
- `related_anime` — продолжения/предыстории
- `discovered_from` — из какого живого тайтла orphan был найден

## Доступные маршруты

```bash
curl "http://localhost:4000/latest-updates?page=1"
curl "http://localhost:4000/anime?q=naruto"
curl "http://localhost:4000/anime/26956--oshi-no-ko-final-season-anime"
curl "http://localhost:4000/anime/26956--oshi-no-ko-final-season-anime/similar"
curl "http://localhost:4000/episodes?anime_id=24326"
curl "http://localhost:4000/episodes/455"
curl "http://localhost:4000/episodes/455?player_id=12345"
curl "http://localhost:4000/episodes/455?resolve=all"
```

`/anime` возвращает обычный upstream-поиск и на первой странице подмешивает локально восстановленные orphan-карточки.

`/anime/:slug` сначала идёт в upstream, а если там `404`, пытается восстановить карточку из локального orphan-индекса.

`/anime/:slug/similar` возвращает похожие/связанные тайтлы.

`/episodes?anime_id=...` возвращает список эпизодов тайтла.

`/episodes/:id` возвращает полный объект эпизода и дополнительно пытается зарезолвить прямые `m3u8`-ссылки для `Kodik` players.

Режимы резолва у `/episodes/:id`:

- по умолчанию резолвится только один player
- `?player_id=...` — резолвится только выбранный player
- `?resolve=all` — резолвятся все players
- `?resolve=none` — список players без резолва прямых ссылок

Новые поля в `players[]` у `/episodes/:id`:

- `src_resolved` — прямая HLS ссылка на поток по умолчанию
- `quality_default` — качество по умолчанию, которое вернул player
- `quality_links` — object с прямыми ссылками по качествам (`360`, `480`, `720` и т.д.)

Дополнительно в `meta`:

- `resolved_player_ids` — какие `player.id` были зарезолвлены в этом ответе
- `resolve_mode` — какой режим резолва был применён
