# Pendientes (con motivo)

- **P-01** — La cámara con Google Photorealistic 3D Tiles no se puede validar visualmente desde el entorno de pruebas (sin clave ni GPU real). Se validó con terreno elipsoidal/OSM: centrado 0–0,7 m.
- **P-02** — Open-Meteo, OSRM y Nominatim no son accesibles desde el entorno de pruebas (503). Los fallos se gestionan con estados de error, pero el resultado real se comprueba en tu PC.
- **P-03** — El GTFS del Metro de Granada caduca el 13/12/2026. La renovación ya es automática si pones `NAP_API_KEY` en `.env` (clave de tu cuenta gratuita en nap.transportes.gob.es); sin clave, Admin sigue avisando y hay que sustituir el .zip a mano. Queda: poner la clave.
- **P-04** — No puedo medir el gasto en USDT desde la sesión. Se trabaja por fases y porcentajes (PLAN.md).
- **P-05** — Reseñas y pagos no aplican a esta app (D-01).
- **P-06** — Tras actualizar, ejecuta `npm install` en PowerShell dentro de `hotel-concierge-rome`. Hay dependencias nuevas: `compression`, fuentes `@fontsource-variable/*` y `axe-core` (esta última solo para pruebas). No lo hago yo porque instalaría binarios de Linux en tu carpeta de Windows (D-12).
- **P-07** — La recuperación de contraseña por email necesita `SMTP_URL` en `.env`. Sin SMTP funcionan el reseteo por un admin y `npm run reset-password -- email`.
- **P-08** — El despliegue con Docker y Caddy no se ha podido ejecutar aquí (no hay Docker). Hay instalador de un comando (`deploy/install.sh`, probado en modo `DRY_RUN`) y la imagen se ha validado reproduciendo sus pasos a mano. Queda hacer la primera instalación real en un VPS y comprobar HTTPS, QR y copias.
- **P-09** — `GOOGLE_MAPS_API_KEY` y `CESIUM_ION_TOKEN` se incrustan en el JS del navegador (comportamiento del proyecto base). Restríngelas por dominio (*HTTP referrer*) en Google Cloud y en Cesium ion.
- **P-10** — *DNS rebinding* en webhooks: la IP se comprueba al guardar y justo antes de cada envío, pero no se fija en la conexión. Fijarla exige un agente HTTP propio (undici). El riesgo es bajo: solo un admin de hotel configura webhooks y la ventana es de milisegundos.
- **P-11** — Bloqueo de cuentas: 25 fallos desde cualquier IP bloquean una cuenta conocida durante 15 minutos. La alternativa (CAPTCHA) añade un servicio externo. Si pasa, el superadmin puede seguir entrando desde su IP habitual (el límite por IP+cuenta es independiente) y existe `npm run reset-password`.
- **P-12** — ✅ Resuelto (24 oct): el modo kiosko borra plan, solicitudes, chat e idioma tras el tiempo de reposo (120 s por defecto, `&idle=`).
- **P-13** — El logout normal borra la cookie, pero una cookie copiada sigue valiendo hasta 12 h. Para cortarla está "Cerrar sesión en todos los dispositivos".
