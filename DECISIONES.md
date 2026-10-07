# Decisiones

- **D-01 — Adaptación del enunciado.** El prompt habla de "profesionales certificados", pero el usuario indicó aplicarlo a esta web (OJO DE DIOS). Se traduce así:
  - "Roles" → superadmin, admin de hotel, recepción y personal. El huésped no se registra: se identifica con el QR de su habitación y una clave anónima del dispositivo, sin datos personales.
  - "Certificaciones / verificación" → sellos verificables de datos reales: *Horario oficial* (solo si la ruta sale del GTFS oficial cargado y vigente) y *Recomendado por el hotel* (lugares curados en Admin). No se pinta ninguna insignia sin un dato que la respalde.
  - "Reseñas" y "pagos" → no aplican. Inventarlas iría contra la regla "sin datos falsos". Queda anotado en PENDIENTES (P-05).
- **D-02 — No se borra nada.** God's Eye View (original y consola dentro de la copia) se conserva. En producción la consola y sus ~35 endpoints solo se activan con `CONCIERGE_CONSOLE=1`. En desarrollo todo sigue igual.
- **D-03 — Sin dependencias nuevas en el servidor** para seguridad (rate limit, cabeceras, CSRF): un middleware propio pequeño evita sumar superficie y peso.
- **D-04 — Contraseña inicial.** En desarrollo se mantiene `admin1234` para no romper tu flujo local. En producción, sin `ADMIN_PASSWORD`, se genera una aleatoria que se muestra una sola vez en el log. En ambos casos el primer login obliga a cambiarla.
- **D-05 — Recuperación de contraseña.** Con SMTP configurado: enlace de un solo uso (30 min) por email. Sin SMTP: el admin la restablece desde el panel o se usa `npm run reset-password -- email`. La respuesta del endpoint es siempre la misma, para no revelar qué emails existen.
- **D-06 — Fuente de verdad del código.** Se trabaja en un clon de la copia, con commits que luego se aplican en tu equipo mediante `git bundle`.
- **D-07 — Sin habitaciones de ejemplo en producción.** Los datos sembrados del hotel (servicios, lugares, horarios) están investigados y son reales. Las habitaciones 101–302 eran inventadas: solo se crean en desarrollo y pruebas.
- **D-08 — Fuentes propias.** Fraunces, Manrope y un subconjunto de Material Symbols (Apache-2.0) van dentro del proyecto. Así se evita que el navegador del huésped contacte con Google (RGPD), la app funciona sin red externa y se ahorran ~5 MB. Para regenerar los iconos: `tools/icons/build-icons.py`.
- **D-09 — Bloqueo por cuenta.** Se usan dos límites: 5 fallos por IP+cuenta y 25 por cuenta desde cualquier IP. Así un atacante no puede bloquear indefinidamente al admin legítimo desde una sola IP.
- **D-10 — `npm test` intacto.** El contrato del proyecto base (`npm test` = su runner) no se toca. La suite completa es `npm run test:all` y el E2E es `npm run test:e2e:concierge`.
- **D-11 — Moderación.** En lugar de "reseñas", la moderación de esta app es sobre el chat y las solicitudes: recepción puede bloquear o desbloquear un dispositivo abusivo y queda constancia en el hilo.
- **D-12 — No toco `node_modules` de tu PC.** Tu equipo es Windows. Instalar dependencias desde la VM Linux metería binarios incompatibles, así que el `npm install` lo ejecutas tú en PowerShell.
