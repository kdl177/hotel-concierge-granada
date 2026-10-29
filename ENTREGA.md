# Entrega — mejoras sobre OJO DE DIOS (Gran Hotel Luna de Granada)

Todo está hecho **encima** del proyecto existente (`hotel-concierge-rome`): no se ha borrado ni rehecho nada, y God's Eye View sigue intacto. Cada bloque va en un commit pequeño (`git log`).

## 1. Auditoría antes / después
Ver `AUDITORIA.md`: 24 hallazgos iniciales (3 críticos, 7 altos) y la 2ª auditoría con cada uno comprobado. Las decisiones están en `DECISIONES.md` y lo que falta, con su motivo, en `PENDIENTES.md`.

## 2. Cambios realizados
**Seguridad**
- Arreglado que un admin de hotel pudiera tomar el control del superadmin.
- Contraseña inicial obligatoria de cambiar; en producción, aleatoria.
- Bloqueo tras 5 intentos de acceso.
- Recuperación de contraseña por email, por un admin o por CLI.
- "Cerrar sesión en todos los dispositivos"; las sesiones se revocan al cambiar la contraseña.
- CSP y cabeceras de seguridad, protección CSRF y proxies de confianza.
- Validación en servidor y cliente de todo lo que edita un admin (iconos, teléfonos, enlaces, coordenadas, campos).
- Webhooks protegidos contra SSRF.
- Límites a solicitudes de huéspedes y a las rutas; solo se aceptan habitaciones reales.
- Cada solicitud solo la ve el dispositivo que la creó.
- Producción publica solo lo que usa la app del hotel. La consola de God's Eye View se conserva y se activa con `CONCIERGE_CONSOLE=1`.

**Funciones**
- Catálogo "Todos los lugares" con filtros (categoría, ideal ahora, bajo techo) y orden.
- Sellos con datos reales: *Horario oficial*, *Ideal ahora*, *Interior*.
- Moderación: recepción puede bloquear un dispositivo abusivo.
- Estados de carga, vacío y error con botón "Reintentar" en el panel.
- Selector de iconos con vista previa.
- Usuarios con estado (activo / contraseña temporal) y último acceso.
- Mensajes de error traducidos.

**Diseño "Cuaderno del conserje"** (sustituye al primer diseño "Nazarí", D-13 y D-14)
- Papel cálido sobre el mapa nocturno para huésped, Recepción y Admin: títulos en Fraunces, texto en Manrope, versalitas en las etiquetas, filas con filo en lugar de tarjetas, un solo acento terracota y oliva para "abierto". Foco visible y `prefers-reduced-motion`.
- Fuentes e iconos dentro del proyecto: sin Google Fonts, 24 KB de iconos en lugar de ~5 MB, y funciona aunque falle la red externa.

**Rendimiento y SEO**
- Compresión gzip: el JS pasa de 78 KB a 27 KB.
- Caché larga para los assets con hash.
- Manifest, `robots.txt`, metadatos y `noindex` en el back-office.

**Calidad**
- 33 pruebas unitarias y de integración del concierge, más un E2E en navegador real.
- 42 pruebas del proyecto base que ya estaban rotas, arregladas.

## 3. Informe de pruebas

**Actual (28 oct 2026, Windows 11, Node 24.16):**
| Suite | Resultado |
|---|---|
| `npm run test:concierge` | **56/56 ✅** y 2 omitidas (`install.sh` necesita bash; en el CI de Ubuntu sí se ejecutan) |
| `npm run build && npm run test:e2e:concierge` | **35/35 ✅** (incluye Recepción y Admin a 375 px, 29 oct), 0 errores de consola, 0 fallos serios de accesibilidad |
| CI (GitHub Actions) | Ejecuta también `test:concierge` desde el 28 oct (D-17) |

**Primera entrega (7 oct 2026, entorno de pruebas Linux, Node 22):**
| Suite | Resultado |
|---|---|
| `npm run test:concierge` (unitarias + API: roles, escalada de privilegios, bloqueo, recuperación, revocación, XSS, SSRF, CSRF, límites, chat, fotos, estadísticas, GTFS real, tiempo) | **33/33 ✅** |
| `npm run test:e2e:concierge` (build de producción + Chromium: admin → recepción → huésped, cambio forzado de contraseña, catálogo y filtros, solicitud con habitación por QR, confirmación en vivo, recuperación, superficie de producción) | **25/25 ✅**, 0 errores de consola propios, 0 fallos serios/críticos de accesibilidad WCAG 2 A/AA en 10 pantallas |
| `npm test` (suite original de God's Eye View, 5065 pruebas) | 5063 ✅, 1 omitida (por diseño) y 1 que fallaba por haber cambiado yo el script `test`; ya corregida y verificada por separado |
| Ataques manuales con `curl` contra producción | Fuerza bruta → 429 · spam → 429 · endpoints de GEV → 404 · 5/5 cabeceras de seguridad |

## 4. Ejecutar y desplegar
En PowerShell, dentro de `hotel-concierge-rome`:
```
npm install
npm run dev                 # http://localhost:4180  (admin: http://localhost:4180/admin.html)
```
Producción:
```
npm start                   # build + servidor en el puerto 4180
```
En un VPS (Ubuntu/Debian), un solo comando instala Docker, configura HTTPS y arranca:
```
curl -fsSL https://raw.githubusercontent.com/kdl177/hotel-concierge-granada/main/deploy/install.sh | sudo bash
```
Sin dominio usa `<ip>.sslip.io`. Copias diarias, actualización y restauración en `deploy/`. Todo detallado en `CONCIERGE.md` → Despliegue.

## 5. Pendientes
Ver `PENDIENTES.md`. Lo más importante: ejecutar `npm install` tú en tu PC (hay dependencias nuevas), renovar el GTFS del Metro antes del 13/12/2026, configurar SMTP si quieres recuperación por email y restringir las claves de Google y Cesium por dominio. El gasto en USDT no se puede medir desde aquí.
