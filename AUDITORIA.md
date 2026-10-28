# Auditoría — OJO DE DIOS (concierge Gran Hotel Luna de Granada)

Proyecto auditado: `hotel-concierge-rome` (copia de God's Eye View). App del huésped (`/`), recepción (`/reception.html`), administración (`/admin.html`), API Node/Express + SQLite.
Método: lectura del código, ejecución en desarrollo (Vite, puerto 4180) y en producción (`node server/app/main.js`), pruebas E2E con Playwright (Chromium), axe-core (WCAG 2 A/AA) y ataques manuales con `curl`.

> El enunciado original habla de "profesionales certificados". Esta app es de orientación para huéspedes de hotel: los puntos de certificaciones, perfiles profesionales y reseñas se adaptan (ver `DECISIONES.md`, D-01).

## 1ª auditoría (4 oct 2026) — estado ANTES

| ID | Prioridad | Área | Hallazgo (demostrado) | Archivo | Causa | Solución | Esfuerzo |
|---|---|---|---|---|---|---|---|
| A-01 | **Crítico** | Autorización | Un admin de hotel puede ver al superadmin y **cambiarle la contraseña o borrarlo**. Lo demostré: creé `evil@x.es` (admin), hice `PUT /api/admin/users/<superadmin>` con la contraseña nueva y luego entré como superadmin con ella | `server/app/api.js` (`/admin/users*`) | Los filtros solo miran `hotel_id`, y el superadmin pertenece al primer hotel | Ocultar a los superadmins de `/admin/users` y prohibir editarlos o borrarlos salvo que lo haga otro superadmin. Impedir que un admin se cambie su propio rol | S |
| A-02 | **Crítico** | Autenticación | Se crea un superadmin `admin@hotel.local / admin1234` por defecto **también en producción** y nada obliga a cambiarlo | `server/app/index.js` | Bootstrap "cómodo" | En producción no arrancar con la contraseña por defecto: si falta `ADMIN_PASSWORD`, generar una aleatoria (se muestra una vez en el log) y obligar a cambiarla en el primer login (`must_change_password`) | S |
| A-03 | **Crítico** | Superficie expuesta | En producción se publican ~35 endpoints de God's Eye View sin login: token de OpenAI Realtime, Google Places/Routes y Street View (con coste), OpenSky, TomTom, AIS, el *debug-log* que escribe en disco y `/api/setup/keys`, que puede reescribir `.env` | `server/app/main.js` | Se montan todos los `localProviderPlugins()` | Montar en producción solo lo que usa el concierge (`/api/route`, `/api/geocode`, `/api/google/text-search`, `/api/google/routes`) con límite por IP. La consola GEV pasa a ser opcional (`CONCIERGE_CONSOLE=1`). **No se borra nada** | M |
| A-04 | Alto | Autenticación | Sin protección contra fuerza bruta: 30 logins fallidos seguidos, todos con 401 y sin ningún bloqueo | `api.js` `/auth/login` | No hay rate limit | Limitar por IP y por email (5 fallos → espera progresiva), con respuesta 429 y `Retry-After` | S |
| A-05 | Alto | Autenticación | No hay recuperación de contraseña. Además, cambiarla no cierra las demás sesiones y el logout no invalida el token | `auth.js`, `api.js` | Sesión HMAC sin estado | Añadir `users.session_version` dentro del token (cambio de contraseña o "cerrar sesiones" lo invalida). Recuperación con token de un solo uso (SHA-256 en BD, 30 min) enviado por SMTP, reseteo por un admin y CLI `npm run reset-password` para cuando no hay SMTP | M |
| A-06 | Alto | XSS | `icon()` no escapa. Un icono guardado por un admin (`<img onerror>`) se ejecuta en el móvil de cada huésped y en el panel del superadmin | `src/concierge/ui.js:33`, `src/backoffice/common.js:6` | Interpolación directa | Escapar el valor y validarlo en el servidor contra `^[a-z0-9_]{1,40}$` | S |
| A-07 | Alto | XSS | `telHref()` mete teléfonos sin escapar en `href` (`1"onmouseover=…`). Las URL de acciones de lugares aceptan `javascript:`. `data-mode` y `name` de los campos van sin escapar | `ui.js:34, 299–302, 462` | Falta validar el protocolo y escapar | Escapar en el cliente y validar en el servidor (`https?:` / `tel:` solamente, teléfonos `[0-9+ ()-]`, lista blanca de modos y campos) | S |
| A-08 | Alto | Abuso | Un huésped anónimo puede crear solicitudes sin límite (25 de 25 con 201), lo que satura recepción y dispara webhooks y correos | `api.js` `POST /h/:slug/requests` | Sin rate limit | Limitar a 6 por minuto y 40 por día por IP+dispositivo. Validar `type` contra las acciones del hotel | S |
| A-09 | Alto | Privacidad | `GET /h/:slug/requests?ids=` devuelve nombre, habitación y detalles de cualquier solicitud a partir de un ID de 8 hex (32 bits) | `api.js`, `db.js uid()` | ID corto y sin ligar al dispositivo | Exigir la `guestKey` del dispositivo y filtrar por ella | S |
| A-10 | Alto | Pruebas | No hay ninguna prueba automática en el repositorio (solo scripts sueltos fuera) | — | — | `node:test` (unitarias + integración de la API) y Playwright E2E dentro del repo: `npm test`, `npm run test:e2e` | L |
| A-11 | Medio | Cabeceras | En producción faltan CSP, `X-Content-Type-Options`, `Referrer-Policy` y `Permissions-Policy` | `main.js` | — | Middleware de cabeceras propio (sin dependencias nuevas) | S |
| A-12 | Medio | SSRF | La URL del webhook por hotel acepta cualquier destino (`http://169.254.169.254`, localhost…) | `api.js`, `notify.js` | Sin validar | Solo `https://` (o `http://` en desarrollo) y rechazar loopback, privadas y link-local, comprobando también la IP resuelta | S |
| A-13 | Medio | Proxy | `trust proxy: true` permite falsear `X-Forwarded-For` y saltarse los límites por IP | `index.js`, `main.js` | Confía en cualquier proxy | `TRUST_PROXY` configurable; por defecto `loopback` (Caddy en el mismo host o en la red de Docker: `loopback, uniquelocal`) | S |
| A-14 | Medio | CSRF | Las peticiones que cambian estado dependen solo de `SameSite=Lax` | `api.js` | — | Comprobar `Origin`/`Sec-Fetch-Site` en `POST/PUT/PATCH/DELETE` autenticados | S |
| A-15 | Medio | Validación | El CRUD genérico acepta lat/lon fuera de rango, claves duplicadas y JSON arbitrario. Los errores de SQLite salen tal cual al cliente | `api.js` TABLES | Validación mínima | Validadores por campo (rangos, longitudes, listas blancas) y mensajes de error genéricos | M |
| A-16 | Medio | Funcional | El huésped solo ve 5 sugerencias y 4 lugares cercanos. **Los otros lugares (16 en total) solo aparecen si sabe buscarlos**, y no hay filtros por categoría | `ui.js renderHome` | Diseño inicial | Sección "Todos los lugares" con filtros por categoría, "Abierto/ideal ahora", interior/exterior y distancia | M |
| A-17 | Medio | Funcional | El E2E falla por la tarde porque la Alhambra no está entre las 5 sugerencias. Es una prueba frágil, pero también confirma A-16 | `/tmp/pw/e2e.mjs` | Depende de la hora | Arreglado junto con A-16 y la prueba nueva del repo | S |
| A-18 | Medio | Superadmin | Un `X-Hotel` inexistente provoca un 500 en `/admin/hotel` | `api.js requireRole` | No valida que el hotel exista | 404 si el hotel no existe | S |
| A-19 | Medio | Accesibilidad | axe: botones sin nombre accesible (cerrar sesión, ✓/＋ del plan), `select` sin etiqueta en recepción, falta `h1` y `main` en el login y en los paneles, orden de encabezados incorrecto, y `outline: none` sin foco visible en los inputs | `admin.js`, `reception.js`, `ui.js`, `backoffice.css` | — | `aria-label`, landmarks, `h1` oculto visualmente y `:focus-visible` con un anillo propio | S |
| A-20 | Medio | Diseño | Dos sistemas de estilo distintos (huésped y back-office) con tokens duplicados. Tipografía Inter + Playfair de plantilla y ningún sello propio | `concierge.css`, `backoffice.css` | Hecho por fases | Sistema de diseño "Nazarí" compartido (`src/design/tokens.css`): paleta, tipografía distintiva, insignias a medida ("Horario oficial", "Recomendado por el hotel", "Abierto ahora", "Interior") | M |
| A-21 | Bajo | SEO/PWA | Sin `meta description`, sin `manifest`. El back-office no lleva `noindex` | `*.html` | — | Metas, `robots`, manifest y `noindex` en el back-office | S |
| A-22 | Bajo | Calidad | La consola GEV entra siempre en el build de producción y sigue cargando su JS si alguien abre `/console.html` | `vite.config.js` | — | Incluirla solo si `CONCIERGE_CONSOLE=1` | S |
| A-23 | Bajo | Calidad | Docker: falta `HEALTHCHECK` en la versión de la copia de trabajo. La de tu equipo sí lo tiene | `Dockerfile` | Divergencia | Unificar (se usa la del equipo) | S |
| A-24 | Bajo | Datos | Los horarios del Metro (GTFS) caducan el 13/12/2026 | `data/gtfs` | Dato externo | Ya hay aviso en Admin; queda en `PENDIENTES.md` | — |

Verificado sin problemas: escape de los datos del huésped hacia recepción (nombre, habitación, detalles, chat); subida de fotos (tipo + *magic bytes* + 3 MB, sin SVG); sesiones con HMAC y comparación en tiempo constante; contraseñas con scrypt; SQL siempre parametrizado (los nombres de tabla salen de una lista fija); claves de chat de 128 bits que no cruzan entre hoteles.

Contraste (axe): sin violaciones en las pantallas auditadas.

## 2ª auditoría (7 oct 2026), después de los cambios

Se repitieron los mismos ataques con `curl` contra el build de producción, las pruebas automáticas y axe en todas las pantallas.

| ID | Antes | Después (comprobado) |
|---|---|---|
| A-01 | Un admin de hotel tomaba el control del superadmin | ✅ Corregido. Para un admin de hotel, el superadmin no aparece y no se puede editar ni borrar (404). Prueba `A-01` |
| A-02 | `admin1234` en producción | ✅ Corregido. En producción se genera una contraseña aleatoria y es obligatorio cambiarla. Las cuentas que aún usan `admin1234` quedan forzadas al cambio |
| A-03 | ~35 endpoints de God's Eye View públicos | ✅ Corregido. `/console.html`, `/api/realtime/token`, `/api/setup/keys`, `/api/opensky` y `/api/cctv/*` responden 404 en producción. Los mapas tienen límite por IP. Nada se ha borrado (`CONCIERGE_CONSOLE=1` lo reactiva) |
| A-04 | Fuerza bruta sin límite | ✅ Corregido. 5 fallos → 429 con `Retry-After` |
| A-05 | Sin recuperación de contraseña ni revocación de sesiones | ✅ Corregido. Recuperación por email (token de un solo uso, 30 min), reseteo por un admin, CLI, "cerrar sesión en todos los dispositivos" y versión de sesión |
| A-06/A-07 | XSS por iconos, teléfonos, `javascript:` | ✅ Corregido. Validado en el servidor y escapado en el cliente. Los iconos son códigos de una fuente propia y un nombre desconocido muestra `help` |
| A-08 | Spam ilimitado de solicitudes | ✅ Corregido. 6/min y 60/día por dispositivo e IP. Solo se aceptan habitaciones reales si el hotel las tiene configuradas. Recepción puede bloquear un dispositivo abusivo |
| A-09 | Solicitudes legibles por ID | ✅ Corregido. Solo las ve el dispositivo que las creó |
| A-10 | 0 pruebas | ✅ 33 de integración/unitarias del concierge + E2E de 25 comprobaciones en navegador real. La suite original del proyecto pasa entera con `npm run test:all` |
| A-11 | Sin CSP ni cabeceras | ✅ Corregido. CSP sin scripts inline ni eval, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP y HSTS bajo HTTPS |
| A-12 | SSRF por webhook | ✅ Corregido. Solo https y nunca hacia redes internas, comprobando también la IP resuelta al guardar y al enviar |
| A-13 | `trust proxy: true` | ✅ Corregido. `loopback, uniquelocal`, configurable con `TRUST_PROXY` |
| A-14 | CSRF solo con SameSite | ✅ Corregido. Se bloquean `Origin` y `Sec-Fetch-Site` de otros sitios |
| A-15 | Validación mínima, errores de SQLite visibles | ✅ Corregido. Validadores por campo y mensajes genéricos traducidos al español en el panel |
| A-16/A-17 | El huésped no podía ver todos los lugares | ✅ Corregido. Catálogo con filtros (categoría, ideal ahora, bajo techo) y orden |
| A-18 | 500 con `X-Hotel` inexistente | ✅ 404 |
| A-19 | Fallos de axe | ✅ 0 violaciones serias o críticas WCAG 2 A/AA en 10 pantallas (E2E) |
| A-20 | Diseño de plantilla | ✅ Sistema "Nazarí" compartido: paleta propia, Fraunces + Manrope, sellos con estrella nazarí, foco visible, `prefers-reduced-motion` |
| A-21 | SEO/PWA | ✅ `description`, Open Graph, manifest, `robots.txt` y `noindex` en el back-office |
| A-22 | Consola en el build | ✅ Solo con `CONCIERGE_CONSOLE=1` |
| A-23 | Docker | ✅ Se mantiene el `Dockerfile` de tu equipo, con `HEALTHCHECK` |
| A-24 | GTFS del Metro caduca | ⏳ Externo, ver PENDIENTES P-03 |

### Nuevos hallazgos de esta 2ª pasada (ya corregidos)

- Las etiquetas de las pestañas inferiores sobrescribían su propio icono (`span` equivocado). Era un fallo latente que salía en cuanto la fuente no cargaba.
- La app dependía de Google Fonts: si fallaba la red, los iconos aparecían como texto (`chevron_right`). Ahora las fuentes van en el propio servidor: iconos en 24 KB frente a ~5 MB. Esto también evita enviar la IP de los huéspedes a Google (RGPD).
- `npm test` del proyecto base tenía 42 pruebas rotas porque apuntaban a `index.html`, que ahora es la app del hotel. Ahora apuntan a `console.html`.
- Las respuestas iban sin comprimir. Ahora usan gzip: el JS principal pasa de 78 KB a 27 KB.
- `/api/auth/me` y el tiempo devolvían 401/503 "normales" que ensuciaban la consola. Ahora responden 200 con estado vacío.
- En producción se creaban habitaciones de ejemplo (101–302): eran datos falsos. Ahora no se crean.

## 3ª auditoría (8 oct 2026)

Repasé todo de nuevo con ojos frescos: servidor (ataques confirmados contra una base de datos temporal) y frontend (lectura del código más scripts de comprobación de i18n y contraste). Encontré 17 fallos en el servidor y unos 25 en la interfaz. Los importantes están corregidos y cubiertos por pruebas (`test/concierge/audit3.test.mjs` y el E2E).

| Prioridad | Hallazgo | Estado |
|---|---|---|
| Alto | El enlace de recuperación de contraseña usaba la cabecera `Host`: un atacante podía recibir el token de otro usuario | ✅ En producción solo se usa `PUBLIC_URL`; sin él no se envía el email |
| Alto | El filtro SSRF se saltaba con direcciones IPv6 que esconden una IPv4 (`[::ffff:7f00:1]`, NAT64…) | ✅ Corregido y probado |
| Alto | El chat de recepción del hotel A mostraba solicitudes que el mismo huésped había hecho en el hotel B | ✅ Consultas acotadas al hotel y una clave de dispositivo por hotel (el chat ya funciona en varios hoteles) |
| Alto | Chat sin límite por IP: bastaba rotar la clave del dispositivo para inundar recepción o saltarse un bloqueo | ✅ 30/min y 300/día por IP |
| Alto (UX) | El formulario de solicitud del huésped se borraba cada 15 s mientras escribía | ✅ El texto y el foco se conservan (prueba E2E) |
| Alto (UX) | Tras abrir el chat, los botones de solicitud (entradas, acciones rápidas) no hacían nada | ✅ Corregido |
| Medio | El QR de la habitación mostraba el nombre y la salida del huésped actual a cualquiera con un QR antiguo | ✅ Ya no devuelve datos del huésped |
| Medio | El rol "personal" (pisos) podía hacer check-in, ver los tokens QR y bloquear huéspedes | ✅ Esas acciones son solo para recepción |
| Medio | Cualquier admin de hotel podía recargar los GTFS compartidos (bloquea el servidor) y veía rutas internas | ✅ Solo el superadmin, y sin rutas |
| Medio | El `lang` del chat no se validaba (100.000 caracteres o un 500) | ✅ Lista blanca |
| Medio | Mapa de estadísticas por IP sin limpieza (memoria creciente) | ✅ Limitador común con limpieza |
| Medio | Un hotel desactivado seguía dejando entrar a su personal | ✅ 403 (el superadmin sí entra) |
| Medio (UX) | Recepción: acciones que fallaban en silencio, refrescos solapados, el desplegable "Asignar a" se cerraba solo | ✅ Errores visibles, un refresco cada vez, repintado solo si hay cambios |
| Medio (UX) | Cambiar rápido de pestaña en Admin podía abrir "Nuevo" en vez de "Editar" (posible duplicado) | ✅ Cargas secuenciadas |
| Medio (UX) | Al marcar un lugar en el plan o cambiar de idioma, la cámara volvía a volar y la ruta se contaba dos veces | ✅ Re-render silencioso |
| Medio | La búsqueda y la pantalla de carga tenían "Granada" fijo (rompía otros hoteles) | ✅ Ciudad y nombre salen del hotel |
| Bajo | Subida de fotos: el cuerpo (5 MB) se procesaba antes de comprobar el login | ✅ Primero la autenticación |
| Bajo | `/staff/users` listaba al superadmin; webhook "updated" con estados inválidos; varias estancias activas por habitación; enlace de huésped a estancia sin comprobar la habitación; cambio de contraseña sin límite | ✅ Corregidos |
| Bajo (a11y) | El asa de la hoja no se podía usar con teclado; el foco se perdía al navegar; botones sin nombre; dianas táctiles < 44 px; modal sin trampa de foco; toasts sin región viva | ✅ Corregidos |
| Bajo (rend.) | Seguía haciendo polling con la pestaña en segundo plano | ✅ Se pausa y se pone al día al volver |
| Bajo | Colores de líneas GTFS/Google insertados en CSS sin validar | ✅ Solo `#hex` |

**No corregido** (con motivo en PENDIENTES): *DNS rebinding* entre la comprobación del webhook y el envío, cualquiera puede bloquear 15 min una cuenta conocida, el logout normal no revoca una cookie copiada (está "cerrar sesión en todos los dispositivos") y los datos del huésped en un kiosko compartido.

**Pruebas tras la 3ª auditoría:** 42/42 unitarias y de integración, y 26/26 en el E2E. 0 errores de consola y 0 fallos serios de accesibilidad.

## Pruebas en Windows (28 oct 2026)

Primera ejecución de las suites en el PC del usuario (Windows 11, Node 24.16). Hasta ahora solo se habían ejecutado en Linux.

| ID | Hallazgo (demostrado) | Estado |
|---|---|---|
| A-25 | `npm run test:concierge` no ejecutaba ninguna prueba: `node --test test/concierge/` trata la carpeta como un archivo (`MODULE_NOT_FOUND`) | ✅ Glob `test/concierge/*.test.mjs` |
| A-26 | La prueba de fotos pasaba el *shim* de `fetch` como ruta `C:\…` a `--import`, y Node exige una URL `file://` | ✅ `pathToFileURL` |
| A-27 | El E2E decía "dist/ missing" con `dist/` presente (`URL.pathname` da `/C:/…`) y al terminar fallaba con `EPERM` al borrar la carpeta temporal con el SQLite aún abierto | ✅ `fileURLToPath` y espera a que el servidor termine |
| — | El CI no ejecutaba las pruebas del concierge | ✅ D-17 |

**Resultado:** `test:concierge` 56/56 y 2 omitidas (las de `install.sh` necesitan bash). E2E 31/31, 0 errores de consola y 0 fallos serios de accesibilidad.
