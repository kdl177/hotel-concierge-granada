# Pendientes (con motivo)

- **P-01** — La cámara con Google Photorealistic 3D Tiles no se puede validar visualmente desde el entorno de pruebas (sin clave ni GPU real). Se validó con terreno elipsoidal/OSM: centrado 0–0,7 m.
- **P-02** — Open-Meteo, OSRM y Nominatim no son accesibles desde el entorno de pruebas (503). Los fallos se gestionan con estados de error, pero el resultado real se comprueba en tu PC.
- **P-03** — El GTFS del Metro de Granada caduca el 13/12/2026: hay que descargar el nuevo en nap.transportes.gob.es. Admin ya avisa.
- **P-04** — No puedo medir el gasto en USDT desde la sesión. Se trabaja por fases y porcentajes (PLAN.md).
- **P-05** — Reseñas y pagos no aplican a esta app (D-01).
- **P-06** — Tras actualizar, ejecuta `npm install` en PowerShell dentro de `hotel-concierge-rome`. Hay dependencias nuevas: `compression`, fuentes `@fontsource-variable/*` y `axe-core` (esta última solo para pruebas). No lo hago yo porque instalaría binarios de Linux en tu carpeta de Windows (D-12).
- **P-07** — La recuperación de contraseña por email necesita `SMTP_URL` en `.env`. Sin SMTP funcionan el reseteo por un admin y `npm run reset-password -- email`.
- **P-08** — El despliegue con Docker y Caddy (`docker compose up -d`) no se ha podido ejecutar en el entorno de pruebas porque no hay Docker. El servidor de producción sí se ha probado directamente con `node server/app/main.js`.
- **P-09** — `GOOGLE_MAPS_API_KEY` y `CESIUM_ION_TOKEN` se incrustan en el JS del navegador (comportamiento del proyecto base). Restríngelas por dominio (*HTTP referrer*) en Google Cloud y en Cesium ion.
