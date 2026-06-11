# animelib-backend

Прямой proxy backend к `https://hapi.hentaicdn.org/api`.


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

## Blob и runtime-save

Если задан `BLOB_READ_WRITE_TOKEN`, сервер работает с orphan-индексом через Vercel Blob.

Логика такая:

- `ORPHAN_INDEX_STORAGE=auto` — Blob, если token есть, иначе локальный файл
- `ORPHAN_INDEX_STORAGE=blob` — всегда Blob
- `ORPHAN_INDEX_STORAGE=file` — всегда локальный JSON

При включённом `ORPHAN_RUNTIME_DISCOVERY_ENABLED=true` сервер может:

- получить `404` на `/anime/:slug`
- просканировать ограниченное число страниц живого каталога
- найти orphan через `relations`
- сохранить найденную карточку в Blob
- сразу начать отдавать её как обычную восстановленную страницу

Это intentionally тяжёлая операция, поэтому по умолчанию она выключена.

## Internal rebuild

Есть два внутренних маршрута:

```bash
GET  /internal/orphans/status
GET  /internal/orphans/rebuild
POST /internal/orphans/rebuild
```

Авторизация:

- `Authorization: Bearer <ORPHAN_ADMIN_TOKEN>` — manual вызовы
- `Authorization: Bearer <CRON_SECRET>` — cron вызовы

Примеры:

```bash
# статус индекса
curl -H "Authorization: Bearer $ORPHAN_ADMIN_TOKEN" "http://localhost:4000/internal/orphans/status"

# manual merge-rebuild по конкретным source-тайтлам
curl -X POST "http://localhost:4000/internal/orphans/rebuild" \
  -H "Authorization: Bearer $ORPHAN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"source_slugs\":[\"26540--witch-watch-2nd-season-anime\",\"26956--oshi-no-ko-final-season-anime\"]}"

# manual rebuild с replace
curl -X POST "http://localhost:4000/internal/orphans/rebuild?replace=true&max_pages=20" \
  -H "Authorization: Bearer $ORPHAN_ADMIN_TOKEN"
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
curl "http://localhost:4000/top-views?time=day"
curl "http://localhost:4000/anime?q=naruto"
curl "http://localhost:4000/anime/26956--oshi-no-ko-final-season-anime"
curl "http://localhost:4000/anime/26956--oshi-no-ko-final-season-anime/similar"
curl "http://localhost:4000/episodes?anime_id=24326"
curl "http://localhost:4000/episodes/455"
curl "http://localhost:4000/episodes/455?player_id=12345"
curl "http://localhost:4000/episodes/455?resolve=all"
```

`/anime` возвращает обычный upstream-поиск и на первой странице подмешивает локально восстановленные orphan-карточки.

`/top-views` возвращает агрегированный блок `Сейчас смотрят` сразу по трём группам:

- `Завершённое`
- `Онгоинг`
- `Полнометражное`

Поддерживаемые периоды:

- `?time=day`
- `?time=week`
- `?time=month`

`/anime/:slug` сначала идёт в upstream, а если там `404`, пытается восстановить карточку из локального orphan-индекса.

`/anime/:slug/similar` возвращает похожие/связанные тайтлы. Для восстановленных orphan-карточек сначала подмешиваются связанные сезоны и франшизные связи из локального индекса, потом уже upstream `similar`.

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
