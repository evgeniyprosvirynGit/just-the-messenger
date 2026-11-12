# Разработка и проверки

## Запуск приложения

Скопируйте пример окружения и задайте уникальный пароль PostgreSQL:

```sh
cp .env.example .env
```

Поднимите сервисы:

```sh
docker compose up --build -d
docker compose ps
```

Откройте <http://localhost:8090>. `VITE_DEMO_MODE` и `VITE_MAPTILER_API_KEY` — build-time переменные web-образа; их изменение требует пересборки:

```sh
docker compose build web
docker compose up -d web
```

Демо-режим выключен по умолчанию. Для визуального просмотра с фиктивными сообщениями временно включите `VITE_DEMO_MODE=true` в `.env`, пересоберите `web`, а после просмотра верните `false` и снова пересоберите образ.

`VITE_MAPTILER_API_KEY` оставьте пустым, чтобы использовать только встроенную NASA-текстуру. Ключ MapTiler публично виден в клиенте: задайте его в `.env` лишь после ограничения разрешённых HTTP-origin в MapTiler, используйте разные ключи для локальной разработки, staging и production и следите за квотами. Запросы идут из браузера напрямую на CDN провайдера; приложение не проксирует тайлы и не сохраняет их сервером. Для production выбирайте план, разрешающий коммерческое использование.

Google sign-in по умолчанию выключен. Для локальной проверки создайте OAuth Web client в Google Cloud Console и укажите реквизиты в `.env`; callback URI должен совпадать с зарегистрированным:

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URL=http://localhost:8090/api/auth/google/callback
```

Для staging/production указывайте внешний HTTPS callback своего домена. Храните `GOOGLE_CLIENT_SECRET` только в секретах серверного окружения. Не устанавливайте `GOOGLE_OIDC_ALLOW_INSECURE=true` вне локального тестового Compose override.

## Playwright

Полный набор выполняется в контейнере браузера:

```sh
docker compose -f compose.yaml -f compose.test.yaml --profile test run --build --rm playwright
```

Контейнер Playwright открывает production web-образ по `E2E_BASE_URL=http://web`. Google OIDC-интеграция использует второй экземпляр того же web-образа (`web-auth`) и локальный тестовый OIDC provider; отдельное состояние Nginx rate limit не даёт остальным интеграционным сценариям исчерпать лимит этого теста. API, callback и cookie проходят через настоящий Nginx и Go API. Мок issuer разрешён только test override.

Визуальные тесты подменяют REST-ответы fixtures для предсказуемых снимков. Интеграционный тест публичного потока удаляет route-подмены, создаёт гостевой профиль, проверяет уникальность ника и атрибуты cookie, подтверждает `201 Created`, сохранение идентичности и broadcast через настоящий WebSocket. Отдельный тестовый API replica `api-secondary` проверяет межрепличный счётчик активных WebSocket-сессий через тот же NATS: увеличение, disconnect, reconnect и RU/EN screenshots на desktop/mobile. Другие интеграционные сценарии проверяют Nginx-лимит создания сессий и попытку обойти его подменой `X-Forwarded-For`. Google Playwright-сценарий связывает профиль гостя, проверяет смену сессионного токена, logout и восстановление того же профиля через mock OIDC. Он не заменяет проверку production Google credentials и Google Cloud callback-конфигурации.

Обычный полный прогон оставляет `VITE_MAPTILER_API_KEY` пустым, чтобы скриншоты не сохраняли изображения стороннего провайдера. Изолированную проверку сетевого URL, attribution и fallback можно выполнить только с тестовой сборкой и перехваченным ответом провайдера; E2E ключ не должен разрешать реальные production-origin или получать настоящие тайлы. Google OIDC-сценарий также проверяет перенос гостевой настройки показа в профиль и восстановление значения после повторного входа.

Playwright-тест — обязательная часть каждой новой фичи, правки и исправления ошибки; тест добавляется параллельно с кодом. Каждый затронутый экран или крупное состояние интерфейса должно сохранять скриншот через `page.screenshot()` или `toHaveScreenshot()`. При изменении раскладки снимайте desktop и mobile, при изменении цветовой схемы или текста — обе темы и локали. Ключевые пользовательские пути дополнительно проверяйте по действиям, доступности, состояниям ошибки/пустого списка и результату API.

Для visual-regression тестов используйте предсказуемые fixtures, фиксируйте время и ждите явных признаков готовности вместо произвольных задержек. Тест срока жизни сообщений сначала ждёт готовую карту, затем доставляет fixture, фиксирует время получения через `page.clock` и управляет фазами анимации без зависимости от длительности загрузки карты. Это соответствует рекомендациям [Playwright Clock API](https://playwright.dev/docs/api/class-clock): установить часы до навигации, дать странице загрузиться и затем управлять временем через `pauseAt`, `runFor` и `fastForward`. Для анимаций разделяйте проверку конечного скриншота и проверку наличия/окончания transition. Сохраняйте артефакты тестов для просмотра; не обновляйте baseline так, чтобы скрыть регрессию.

Для локального Playwright-конфига из `web/`:

```sh
npm ci
npm run test:e2e
```

Когда `E2E_BASE_URL` не задан, Playwright сам поднимает Vite dev server с `VITE_DISABLE_REALTIME=true` и `VITE_DEMO_MODE=false`. Такой запуск полезен для разработки интерфейса, но не заменяет интеграционный Docker-прогон.

Результаты находятся в `web/test-results/`: HTML-отчёт, именованные скриншоты успешных UI-сценариев, снимки при сбое и trace-файлы. Скриншоты сохраняются в `artifacts/` и прикладываются к отчёту.

## Полезные команды

```sh
docker compose logs -f web api
docker compose logs -f postgres nats
docker compose exec -T postgres pg_isready -U planet_chat -d planet_chat
```

Health endpoints:

- Web: `GET /healthz`
- API: `GET /healthz` и `GET /readyz`
- Публичные активные сообщения: `GET /api/messages?cells=sz,u4`
- Создание сообщения: `POST /api/messages`
- Настройки показа публичных сообщений: `GET /api/account/settings`, `PUT /api/account/settings` (только сессия связанного Google-профиля)
- Гостевая идентичность: `GET /api/guest-session`, `POST /api/guest-session`
- Google sign-in: `GET /api/auth/google/config`, `GET /api/auth/google/start`, `GET /api/auth/google/callback`, logout `POST /api/auth/logout`
- Realtime: WebSocket `/ws`

Обычный `docker compose down` сохраняет том базы. `docker compose down -v` удаляет её данные и используйте его только для намеренного полного сброса.

## Передача изменений

- Перезапускайте web-образ после изменения Vite build variables.
- Для изменений схемы БД добавляйте миграцию в `server/`.
- Для изменений WebSocket/REST/geocell обновляйте [архитектуру](ARCHITECTURE.md) и реальный интеграционный тест.
- Перед кодом проверьте применимые best practices и существующие повторяющиеся реализации; соблюдайте SOLID/DRY и делайте безопасный локальный рефакторинг с покрытием тестами.
- Подробный непрерывный backlog и целевые метрики смотрите в [плане развития](ROADMAP.md).
- Не сохраняйте `.env`, пароли, токены и пользовательские данные в репозитории.
- Для проверки визуальной производительности дождитесь загрузки глобуса; Playwright измеряет пятисекундный спокойный глобальный вид с намеренной авто-ротацией 1 Гц: менее 30 WebGL draw calls/с и менее 2 Long Tasks/с. После перехода на локальный шестигранный skybox (2026-11-12, полный suite) получено 19 draw calls/с и 1 Long Task/с в Docker Chromium; результат укладывается в диагностические пределы, но не представляет целевой FPS/GPU время. Draw-call обёртки включены только на время окна и восстанавливаются до drag. Тест сохраняет скриншоты desktop/mobile, зума, свёрнутого меню, светлой темы и английского интерфейса; снимки фиксируют стабильное состояние с отключёнными CSS-переходами, а сами анимации проверяются отдельно.
- При scripted drag Playwright записывает интервалы `requestAnimationFrame` callbacks и изменения CSS transform видимого маркера, обновляемого из Cesium [`scene.postRender`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html); во время этого замера WebGL draw-вызовы не перехватываются. Это диагностический сигнал рендер-петли в Docker Chromium, не частота представленных кадров и не время GPU. Для реального FPS и dropped frames используйте целевой GPU и [Chrome Frame Rendering Stats / Performance panel](https://developer.chrome.com/docs/devtools/rendering/performance/); текущий Compose Playwright-контейнер не получает `/dev/dri`.
