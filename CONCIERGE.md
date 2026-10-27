# Hotel Concierge — guía rápida

App de orientación para huéspedes construida sobre God's Eye View: mapa 3D, qué hacer, cómo llegar (a pie, bici, transporte público), servicios del hotel y solicitudes a recepción. Multi-hotel.

## Páginas
| URL | Para quién |
|---|---|
| `/?h=<slug>` | Huésped (móvil vía QR o kiosko). Sin `h` usa el primer hotel. `&r=<token>` identifica la habitación. |
| `/reception.html` | Recepción: bandeja de solicitudes en vivo, asignación, notas, historial, check-in/out. |
| `/admin.html` | Administración del hotel: datos, servicios, acciones rápidas, lugares, habitaciones + QR, usuarios. Superadmin: hoteles. |
| `/console.html` | Consola original de God's Eye View: siempre en `npm run dev`; en producción solo con `CONCIERGE_CONSOLE=1`. |

## Arrancar en local
```
npm install        # tras cada actualización (en PowerShell, dentro de la carpeta)
npm run dev        # desarrollo (Vite + API integrada) → http://localhost:4180
npm start          # producción: build + servidor Node
```
Primer arranque: crea `data/concierge.sqlite` con el Gran Hotel Luna de Granada y el superadmin `admin@hotel.local`.
- En desarrollo la contraseña inicial es `admin1234`; en producción (sin `ADMIN_PASSWORD`) se genera una aleatoria que aparece **una vez** en el log.
- En ambos casos el primer acceso **obliga a cambiarla** (mínimo 10 caracteres, letras y números).
- ¿Contraseña perdida? Con `SMTP_URL`: enlace "¿Has olvidado la contraseña?". Sin correo: otro admin la restablece en Admin → Usuarios, o desde el servidor `npm run reset-password -- correo@hotel.es`.

## Pruebas
```
npm run test:concierge       # unitarias + integración de la API (node:test)
npm run build && npm run test:e2e:concierge   # E2E en navegador real + accesibilidad (axe)
# E2E_SHOTS=capturas npm run test:e2e:concierge  → guarda además una captura de cada pantalla auditada
npm run test:all             # suite del proyecto base + concierge
```

## Variables (.env)
```
PORT=4180
PUBLIC_URL=https://concierge.tuhotel.com   # para los enlaces de los QR
CONCIERGE_SECRET=<cadena larga aleatoria>   # firma de sesiones
CONCIERGE_DB=data/concierge.sqlite
ADMIN_EMAIL= / ADMIN_PASSWORD=              # primer superadmin
CONCIERGE_WEBHOOK_URL=                      # webhook global (n8n…) para todas las solicitudes
SMTP_URL=smtp://user:pass@host:587          # email de aviso a recepción (opcional)
SMTP_FROM=concierge@tuhotel.com
GOOGLE_MAPS_API_KEY=                        # 3D fotorrealista + búsqueda de lugares
GOOGLE_MAPS_SERVER_API_KEY=                 # Routes API (transporte público con horarios)
CESIUM_ION_TOKEN=                           # alternativa para el 3D
TRUST_PROXY=loopback, uniquelocal           # proxies de confianza (Caddy/Docker); por defecto así
CONCIERGE_CONSOLE=                          # 1 = publicar también la consola de God's Eye View en producción
PROVIDER_RATE_PER_MIN=60                    # límite por IP de rutas/búsquedas de mapa
```
`GOOGLE_MAPS_API_KEY` y `CESIUM_ION_TOKEN` viajan al navegador: restríngelas por dominio en sus consolas.

## Seguridad (resumen)
Roles superadmin / admin / recepción / personal; los admins de hotel no ven ni tocan al superadmin. Contraseñas scrypt, sesiones firmadas y revocables ("cerrar sesión en todos los dispositivos"), bloqueo tras 5 intentos, CSP y cabeceras de seguridad, protección CSRF por origen, límites a solicitudes de huéspedes, webhooks solo hacia Internet pública (https). Detalle en `AUDITORIA.md`.

## Despliegue (VPS con Docker)
Funciona en cualquier VPS con Ubuntu/Debian (Hetzner, DigitalOcean, OVH, Contabo… desde ~4 €/mes). No hace falta dominio: sin él usa `<ip>.sslip.io`, que también recibe certificado HTTPS real.

```
ssh root@<ip-del-vps>
curl -fsSL https://raw.githubusercontent.com/kdl177/hotel-concierge-granada/main/deploy/install.sh | sudo bash
```
El instalador instala Docker, clona el proyecto en `/opt/concierge`, crea `.env` con un secreto y una contraseña de admin aleatorios, pregunta el dominio (Enter para usar la IP), levanta la app detrás de Caddy con HTTPS automático, espera a que responda y muestra las URLs y la contraseña temporal (una sola vez; el primer acceso obliga a cambiarla). Si ya existe `.env`, lo respeta. Programa una copia diaria (`04:17`, `backups/`, 14 días).

Con dominio propio: crea un registro DNS `A` apuntando a la IP del VPS y ejecuta `sudo env DOMAIN=concierge.tuhotel.com bash deploy/install.sh` (o escríbelo cuando lo pregunte). Luego, en Admin → Habitaciones y QR, regenera los QR si antes apuntaban a otra dirección.

Mantenimiento (en `/opt/concierge`):
```
sudo bash deploy/update.sh                  # copia de seguridad + git pull + rebuild sin perder datos
sudo concierge-backup                       # copia ahora (backups/concierge-<fecha>.tar.gz: base de datos + fotos)
sudo bash deploy/restore.sh backups/concierge-<fecha>.tar.gz
docker compose logs -f concierge            # registro en vivo
docker compose exec concierge npm run reset-password -- admin@hotel.local
```
Claves opcionales (Google Routes/Places, Cesium ion, SMTP, webhook): edita `/opt/concierge/.env` y `docker compose up -d`. Restringe las claves de Google y Cesium al dominio del VPS en sus consolas. Horarios GTFS: deja los `.zip` en `/opt/concierge/data/gtfs/` y recarga desde Admin.

## Flujo de una solicitud
Huésped (app) → `POST /api/h/:slug/requests` → SQLite → recepción la ve al instante (pitido), la asigna, confirma y añade nota → el huésped ve el estado en "Mis solicitudes". Cada cambio dispara el webhook del hotel (Admin → Hotel) y el global.

## Modo kiosko (pantalla del lobby)
Abre `/?h=<slug>&kiosk=1` a pantalla completa en la pantalla táctil del lobby (el enlace está en Admin → Hotel → "Pantalla de kiosko"). Texto y botones más grandes, sin zoom ni selección. Tras 120 s sin tocar (`&idle=300` para cambiarlo) muestra "Toca para empezar" con el hotel y la hora, orbita despacio sobre el hotel y **olvida todo lo del huésped anterior** (plan, solicitudes, chat, idioma). En el inicio y en cada lugar aparece un QR para llevarse la guía (o ese lugar) al móvil: `/api/h/<slug>/qr.svg?p=<lugar>`, que abre `/?h=<slug>&p=<lugar>`.

## Fotos de los lugares
`npm run photos:fetch` descarga una foto libre (Wikimedia Commons) para cada lugar del hotel y guarda su crédito (autor · licencia), que la app muestra bajo la foto como exige la licencia. Necesita internet; se puede repetir con `--force` para renovarlas. Desde Admin → Lugares se puede sustituir cualquiera por una foto propia (y editar el crédito).

## Buscador "de todo" (sin claves)
El huésped puede buscar cualquier cosa: *farmacia*, *para comer*, *cajero*, *supermercado*, *médico*, *taxi*… o el nombre de un sitio (*Bar Los Diamantes*). El servidor traduce la palabra (en es/en/fr/de) a categorías de OpenStreetMap y consulta Overpass alrededor del hotel (2,5 km; 6 km para nombres). Devuelve horario, teléfono, web, cocina y accesibilidad cuando OSM los tiene. Diccionario de categorías en `server/app/places.js` (fácil de ampliar). Caché 15 min y límite por IP. Variable opcional `CONCIERGE_OVERPASS_URL` para usar un Overpass propio.

## Transporte público (horarios oficiales, sin Google)
La app calcula rutas en bus y metro con los horarios GTFS oficiales, en el propio servidor (sin claves ni coste por consulta).

**Renovación automática (recomendado).** Los horarios caducan (el del Metro, el 13/12/2026). Para que se renueven solos:
1. Cuenta gratuita en https://nap.transportes.gob.es y copia la *ApiKey* de tu perfil de usuario.
2. En `.env`: `NAP_API_KEY=<tu clave>`. Opcional: `GTFS_NAP_FILES=1367:bus-urbano-granada,1370:metro-granada` (ficheros NAP; es el valor por defecto) y `GTFS_UPDATE_DAYS=7`.
3. El servidor descarga los ficheros al arrancar y cada 7 días; solo sustituye un fichero si el nuevo es válido al menos hasta la misma fecha que el actual, y nunca deja uno corrupto. En Admin → Hotel → Transporte público hay un botón **Descargar ahora** y se ve la última comprobación.
También a mano: `npm run gtfs:update` (misma lógica, desde la línea de comandos).

**Sin clave:** descarga el .zip de cada operador en NAP (Granada: bus urbano fichero 1367, Metro fichero 1370), déjalo sin descomprimir en `data/gtfs/` (en Docker se monta desde `./data/gtfs`) y pulsa **Recargar horarios** en Admin.

El planificador combina bus y metro con hasta un transbordo, calcula el paseo a la parada y avisa de "Mejor a pie" cuando el transporte no compensa. Si no hay horarios cargados y existe `GOOGLE_MAPS_SERVER_API_KEY`, usa Google Routes como alternativa.
