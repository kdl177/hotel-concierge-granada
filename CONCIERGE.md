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
```
cp .env.example .env   # rellena PUBLIC_URL, CONCIERGE_SECRET, claves
# edita deploy/Caddyfile con tu dominio (DNS apuntando al VPS)
docker compose up -d --build
```
Datos persistentes en el volumen `concierge-data`. Copia de seguridad: `docker compose cp concierge:/data/concierge.sqlite ./backup.sqlite`.

## Flujo de una solicitud
Huésped (app) → `POST /api/h/:slug/requests` → SQLite → recepción la ve al instante (pitido), la asigna, confirma y añade nota → el huésped ve el estado en "Mis solicitudes". Cada cambio dispara el webhook del hotel (Admin → Hotel) y el global.

## Buscador "de todo" (sin claves)
El huésped puede buscar cualquier cosa: *farmacia*, *para comer*, *cajero*, *supermercado*, *médico*, *taxi*… o el nombre de un sitio (*Bar Los Diamantes*). El servidor traduce la palabra (en es/en/fr/de) a categorías de OpenStreetMap y consulta Overpass alrededor del hotel (2,5 km; 6 km para nombres). Devuelve horario, teléfono, web, cocina y accesibilidad cuando OSM los tiene. Diccionario de categorías en `server/app/places.js` (fácil de ampliar). Caché 15 min y límite por IP. Variable opcional `CONCIERGE_OVERPASS_URL` para usar un Overpass propio.

## Transporte público (horarios oficiales, sin Google)
La app calcula rutas en bus y metro con los horarios GTFS oficiales, en el propio servidor (sin claves ni coste por consulta).

1. Cuenta gratuita en https://nap.transportes.gob.es
2. Descarga el .zip de cada operador (Granada: bus urbano fichero 1367, Metro fichero 1370).
3. Déjalos sin descomprimir en `data/gtfs/` (en Docker se montan desde `./data/gtfs`).
4. Admin → Hotel → "Transporte público" muestra operadores, viajes y **fecha de caducidad**; al renovar, sustituye el .zip y pulsa **Recargar horarios**.

El planificador combina bus y metro con hasta un transbordo, calcula el paseo a la parada y avisa de "Mejor a pie" cuando el transporte no compensa. Si no hay horarios cargados y existe `GOOGLE_MAPS_SERVER_API_KEY`, usa Google Routes como alternativa.
