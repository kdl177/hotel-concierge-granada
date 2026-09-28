# Hotel Concierge — guía rápida

App de orientación para huéspedes construida sobre God's Eye View: mapa 3D, qué hacer, cómo llegar (a pie, bici, transporte público), servicios del hotel y solicitudes a recepción. Multi-hotel.

## Páginas
| URL | Para quién |
|---|---|
| `/?h=<slug>` | Huésped (móvil vía QR o kiosko). Sin `h` usa el primer hotel. `&r=<token>` identifica la habitación. |
| `/reception.html` | Recepción: bandeja de solicitudes en vivo, asignación, notas, historial, check-in/out. |
| `/admin.html` | Administración del hotel: datos, servicios, acciones rápidas, lugares, habitaciones + QR, usuarios. Superadmin: hoteles. |
| `/console.html` | Consola original de God's Eye View (opcional). |

## Arrancar en local
```
npm ci
npm run dev        # desarrollo (Vite + API integrada) → http://localhost:4180
npm start          # producción: build + servidor Node
```
Primer arranque: crea la base de datos `data/concierge.sqlite`, importa el hotel de ejemplo (Gran Hotel Luna de Granada) y el usuario **admin@hotel.local / admin1234** (superadmin). Cámbialo en Admin → Usuarios o define `ADMIN_EMAIL` / `ADMIN_PASSWORD` antes del primer arranque.

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
```

## Despliegue (VPS con Docker)
```
cp .env.example .env   # rellena PUBLIC_URL, CONCIERGE_SECRET, claves
# edita deploy/Caddyfile con tu dominio (DNS apuntando al VPS)
docker compose up -d --build
```
Datos persistentes en el volumen `concierge-data`. Copia de seguridad: `docker compose cp concierge:/data/concierge.sqlite ./backup.sqlite`.

## Flujo de una solicitud
Huésped (app) → `POST /api/h/:slug/requests` → SQLite → recepción la ve al instante (pitido), la asigna, confirma y añade nota → el huésped ve el estado en "Mis solicitudes". Cada cambio dispara el webhook del hotel (Admin → Hotel) y el global.
