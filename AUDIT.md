# Технічний аудит Parking Map — 1 листопада 2026

Перевірено поточний локальний проєкт разом із незакоміченим попереднім розширенням POI. Знайдено й виправлено **20 груп підтверджених дефектів: 8 High, 10 Medium, 2 Low**. Critical не виявлено в межах виконаних перевірок. Частину дефектів відтворено спеціально некоректними або затриманими відповідями: це не означає, що чинні геодані пошкоджені.

Великий експорт OSM не запускався. Реальні GeoJSON не змінювалися під час аудиту; зміни даних, видимі в git diff, походять із попереднього завдання. Commit, push і deployment не виконувалися.

## Виправлені проблеми

| № | Пріоритет | Файл / місце | Причина та мінімальне виправлення | Регресійна перевірка |
|---|---|---|---|---|
| 1 | High | navigation.js:122, setPosition/orientation | NaN/відсутня accuracy і некоректний heading проходили перевірку; коло точності обрізалося до 500 м попри більшу заявлену похибку. Перевірено числа/діапазони; показується прийнята похибка без заниження. | check_navigation_audit: invalid accuracy/heading |
| 2 | High | navigation.js:166,331,355,392 | Запізнілі GPS/watch/permission callbacks після cancel/stop/remove змінювали стан. Додано покоління запитів, guard disposed, ідемпотентний cleanup обробників і watch. | late one-shot/watch callbacks, restart, dispose |
| 3 | High | navigation.js:166, locate | Невдалий новий fix міг запустити маршрут зі старої позиції. setPosition повертає результат; невдалий fix не запускає calculate. Позиція старша 60 секунд вимагає оновлення. | invalid fix does not recalculate |
| 4 | High | navigation.js:176,205, calculate/setDestination | Старий маршрутний запит та його 429 могли вплинути на нове призначення/backoff. Нове призначення скасовує попередній fetch; identity перевіряється до обробки статусу. | stale success / stale 429 |
| 5 | High | navigation.js:205,331 | Під час перерахунку можна було почати старий preview. routingPending блокує старт до завершення актуального розрахунку. | pending recalculation/start |
| 6 | High | navigation.js:234, validation | Порожні/одноточкові MultiLineString і від’ємні метрики приймалися як маршрут. Перевірено кожну лінію, координати, distance/time, індекси кроків. Геометрія валідного маршруту не змінюється. | malformed route, negative metrics, multi-leg indexes |
| 7 | High | navigation.js:274, catch | Помилка reroute стирала останній придатний маршрут при активному GPS. Тимчасовий збій тепер зберігає маршрут і показує помилку. | reroute failure retains route |
| 8 | High | script.js:408; navigation.js:64; poi.js:186 | Обробник once(style.load) не відновлював маску/POI/навігацію після setStyle. Додано on(style.load), restoreStyle без повторного setup, обмежені listeners і cleanup мобільної палітри. Route/accuracy розташовано перед маскою України. | check_map_audit; два реальні style reload під час watch у check_mobile_ui |
| 9 | Medium | poi.js:68,134, toFeatures/validFeature | Null, неправильні ID та геометрії могли спричинити виняток поза catch. Перевіряється кожен live/local/OCM запис; некоректні записи відкидаються, локальні ID дедуплікуються. | malformed records, ID, coordinates |
| 10 | Medium | poi.js:124,333, readJson/load | Повільний OCM затримував уже доступні OSM; локальні fetch не мали timeout. OSM показується до optional wait, timeout основного файла 30 с, OCM 15 с. | slow OCM, local timeout, retained OSM |
| 11 | Medium | poi.js:342,410,472 | Застарілий load міг почати OCM після await, а стара відповідь Overpass — змінити кеш/лічильники. Guards після await, abort локальних fetch при dispose. | stale toggles, disposed load, stale Overpass |
| 12 | Low | poi.js:356, status | Повідомлення про помилку OCM лишалося після вимкнення зарядок. Воно тепер залежить від активної категорії. | stale error notice |
| 13 | Medium | scripts/merge_vehicle_poi.py:23 | Збіг afterCount блокував будь-який новий кеш. Додано fingerprints входу, правил і виходу; ідентичний запуск no-op, змінений кеш обробляється. | check_data_tools: changed cache / identical rerun / legacy cache |
| 14 | Medium | scripts/data_tool_io.py:11; build/expand/merge/import | Прямі записи могли залишити часткові файли або неузгоджену пару GeoJSON/audit. Попереднє staging, атомарна заміна кожного файла та rollback при контрольованій помилці. | failed second replacement restores originals |
| 15 | Medium | scripts/import_ocm.cjs:13 | Імпорт пропускав дубль ID з іншими координатами, записи поза регіоном і некоректні/майбутні дати. Перевірено ID, bbox, типи координат, дати, значення роз’ємів. | OCM invalid/duplicate/outside/future fixtures |
| 16 | Medium | script.js:43, error handlers | Повний error.message від MapTiler міг потрапляти в лог/інтерфейс із параметром key. Перед виведенням параметри key/apiKey приховуються; логування помилок не вимикається. | fixture URL key redaction |
| 17 | Medium | script.js:56, normalizeBoundary/orientRing | Некоректні координати/вироджені кільця могли потрапити до маски. Додано числові/географічні перевірки та явну помилку замість передачі непридатної геометрії. | malformed/nonfinite/degenerate boundary |
| 18 | Medium | styles.css:260 | Розгорнуті п’ять категорій на 320 px мали цілі менше 44 px. Розширено меню тільки на вузьких екранах; ряд іконок зміщено нижче компаса. | вимірювання усіх п’яти touch targets на 320 px |
| 19 | Low | script.js:363, missing image resolver | Реальний console warning Cannot mix SDF and non-SDF icons in one buffer. Default/transportation sprite фактично SDF, а прозорі fallback були bitmap. Для двох наявних fallback задано sdf:true. Дорожні підписи/номери не видаляються, невідомі іконки не заглушуються. | unit перевіряє image options; browser warnings після двох reload порожні |
| 20 | Medium | script.js:212, readUkraineBoundary | Завислий fetch меж залишав карту в початковому порожньому стані без кінцевої помилки. Додано abort через 30 с і зрозуміле повідомлення. | controlled boundary timeout у check_map_audit |

Версії підключення CSS/script/navigation/poi оновлено до `20261101-audit`; спосіб ESM-підключення MapLibre 6.16.0 збережено. Є одне підключення JS та відповідний CSS тієї самої версії; викликів maplibregl.supported немає.

## Дані та географія

Фактично **2 894 унікальних OSM + 5 OCM = 2 899 POI**: 2 329 парковок без підтвердження платності, 106 платних, 73 зарядки, 168 АЗС, 223 СТО. Усі чотири GeoJSON валідні за Shapely та непорожні. Межа України має замкнений Polygon, одне зовнішнє кільце, нуль внутрішніх кілець. Crimea входить до локальної міжнародно визнаної геометрії; змін меж не було.

Перевірено ID/координати/категорії, 2 164 виключені вкладені parking_space та 129 самостійних місць. Відсутній fee не означає безкоштовність; приватний доступ залишається явним у popup. АЗС і зарядки не класифікуються взаємозамінно. Змішаний заклад з одним OSM ID не рахується двічі як два незалежні POI.

Живий браузерний тест підтвердив точки у Львові, Винниках, Брюховичах, Рудному, Сокільниках, Зимній Воді, Малехові та Дублянах. Road/road_label/road_exit і zoom-залежні товщини не видалялися; джерело maptiler_planet_v4 збережене. Зовнішня маска відновлюється разом зі стилем, навігаційні шари розміщені під нею.

## Виконані перевірки

- `node scripts/check_navigation_audit.mjs`: 10 груп сценаріїв PASS — GPS, heading, запізнілі callbacks, HTTP 401/403/429/500, timeout, reroute, state, порядок координат/uk, кілька legs, dispose.
- `node scripts/check_poi_audit.mjs`: PASS — 406/429 без автоматичних циклів; одна retry 502 та подальше блокування; timeout, збереження точок, stale requests, local/OCM, aliases, XSS через textContent, lifecycle.
- `node scripts/check_map_audit.mjs`: PASS — style restore, кількість listeners, boundary validation/timeout, SDF options, key redaction.
- `node scripts/check_lviv_poi.mjs` та `node scripts/check_vehicle_poi.mjs`: PASS — реальні дані, counts, класифікація, геометрія, dedup audit.
- `python scripts/check_data_tools.py`: 3 fixture-тести PASS — rollback, idempotency/new cache, invalid OCM + manual-review metadata. Реальні файли даних не перезаписуються тестами.
- `python scripts/check_pages_audit.py`: PASS — YAML, permissions, references secrets, копіювання/хеші 11 статичних asset-файлів, config validator з тестовими ключами, відносні шляхи, скан явних credential literals у tracked/untracked джерелах.
- `node scripts/check_mobile_ui.cjs`: PASS — 320/360/375/390/430/768/1024/1440 px, portrait/landscape, desktop rectangles/paint проти HEAD, п’ять категорій, GPS/compass, OCM popup/route, запуск/скасування, дві повні заміни стилю при активному watch, та OCM 503. Один fetch основної бази, одна GPS watch-підписка; resize/style reload не створюють нових Routing запитів. Console errors і перевірені style/sprite/SDF warnings відсутні.
- `node scripts/check_lviv_browser.cjs`: PASS — усі категорії/передмістя, popup/route, zoom 10–13, реальні тайли, контрольований 502. Отримано 19 HTTP 200 vector tile responses; MapTiler HTTP failures — 0. Для backoff час стабілізовано; його просування окремо тестується unit-сценаріями, щоб швидкість software WebGL не впливала на результат.
- Синтаксис усіх JS/MJS/CJS/Python та `git diff --check`: PASS.

MapTiler style/sprite JSON і vector tiles отримувалися з реального сервісу через наявну опубліковану конфігурацію; ключ не виводився. GPS, Geoapify та помилки Overpass — контрольовані. Живі Overpass-запити не виконувалися.

## Продуктивність, безпека та Pages

POI відображаються п’ятьма circle layers; окремих DOM-маркерів для кожного POI немає. Browser checks з усіма категоріями й двома reload підтверджують одноразове читання основного GeoJSON та відсутність дублікатів layers/watch. Unit-тести перевіряють звільнення observers/media/UI handlers і local fetch controllers; повільний optional OCM більше не блокує OSM. Довільного переписування циклів без виміряної проблеми не проводили.

Назви та інші зовнішні значення в popup виводяться через textContent. innerHTML використовується для статичної навігаційної стрілки, не для OSM/OCM/API-тексту. GPS-координати не зберігаються в localStorage; там лише лічильник запитів Overpass. Явних вбудованих API-ключів у перевірених джерелах не знайдено. Клієнтські MapTiler/Geoapify ключі за архітектурою доступні браузеру; їхнє розміщення у deployment config є очікуваним, GitHub Secret не робить браузерний ключ приватним.

Workflow використовує тільки contents:read, pages:write, id-token:write; конфігурація генерується в dist, порожній локальний map-config.js туди не копіюється. Артефакт — dist. Тестовий allowlist не допускає .env, raw PBF, кеші, приватні файли або Python-інструменти до статичного артефакту. Іконка, navigation.js, poi.js, OCM та інші локальні дані включені. Робота в /parking-map/ перевірена локальним HTTP-сервером.

## Залишені обмеження та неперевірене

1. **Medium, якість покриття OCM:** радіус 250 м не доводить тотожності станцій. Конкретний кандидат: OCM 311760 (TOKA #2080, verified 2025-04-14) та OSM node/7812964839 (Toka ref 187) на відстані 206 м. Різні номери — сильна ознака різних станцій, але кеш не доводить їх одночасної актуальності. Автоматично нових точок під час аудиту не додавали. Імпортер тепер зберігає needsReview, nearestID/ref/operator і не називає близькість доведеним дублікатом. Потрібна свіжа перевірка оператором/на місці.
2. Не перевірено фізичний GPS/компас, Safari/iPhone/Android на реальному пристрої, поведінку системного permission UI та реальний notch/safe-area. Перевірено responsive browser emulation, не фізичний слабкий смартфон.
3. Не виконувалося повне heap/GPU profiling або вимірювання батареї на слабкому телефоні. Відсутність дублікатів/listeners у перевірених сценаріях не є доказом відсутності всіх можливих витоків рушія/драйвера.
4. Не перевірено живий Geoapify API, фактичні доменні обмеження/квоти в кабінетах, актуальну наявність GitHub Secrets чи запуск Actions. Наявний MapTiler доступний; конфігурація workflow перевірена локально з fixture secrets. Після публікації потрібна коротка перевірка саме нового deployment.
5. OSM/OCM — зрізи джерел; поточна робота закладів, тарифи, перекриття та повнота картографування не підтверджуються цим аудитом.
6. Групова заміна геоданих захищена від звичайної помилки запису, але раптове вимкнення живлення між двома файловими rename не є транзакцією файлової системи. Перевірки data/audit потрібно запускати після оновлення бази.

Локальні перевірки дозволяють **контрольну публікацію статичного сайту**. Готовність до польової автомобільної навігації цими тестами не підтверджена. Автоматичної публікації немає.
