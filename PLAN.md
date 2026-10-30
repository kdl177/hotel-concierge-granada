# Plan de ejecución

Presupuesto: el enunciado fija 259 USDT, pero desde la sesión no puedo medir el gasto real en dólares. Por eso el reparto va en **porcentaje del esfuerzo**, y el 20 % queda reservado para las pruebas finales.

| Fase | Contenido | % | Hallazgos |
|---|---|---|---|
| 1 | Auditoría (`AUDITORIA.md`) | 8 % | — |
| 2 | Este plan | 2 % | — |
| 3a | Críticos de seguridad: autorización de usuarios, admin por defecto, superficie de proveedores | 12 % | A-01, A-02, A-03, A-22 |
| 3b | Autenticación robusta: rate limit, versión de sesión, recuperación de contraseña, CSRF, cabeceras, proxy | 12 % | A-04, A-05, A-11, A-13, A-14 |
| 3c | Validación e XSS: escape en el cliente y validadores en el servidor, webhook SSRF, límites a huéspedes, privacidad de solicitudes | 12 % | A-06–A-09, A-12, A-15, A-18 |
| 3d | Funciones: catálogo de lugares con filtros, estados de carga/vacío/error, seguridad de cuentas en Admin (forzar cambio de contraseña, cerrar sesiones), moderación del chat | 14 % | A-16, A-17 |
| 4 | Sistema de diseño propio + accesibilidad WCAG AA + SEO/PWA | 20 % | A-19, A-20, A-21 |
| 5 | Pruebas automáticas en el repo (unitarias, integración, E2E, axe), cero errores de consola, 2ª auditoría | 20 % (reserva) | A-10 |
| 6 | Ciclos extra: rendimiento, más cobertura y pulido | resto | — |
| 7 (28 oct) | Pruebas en Windows y en el CI, subida a GitHub → validar GTFS con clave real → Recepción y Admin en móvil → primera instalación en VPS (SMTP, claves por dominio) | — | A-25–A-33, D-17–D-19 (Windows, CI, móvil y tablet hechos del 28 al 30 oct) |

Orden: críticos → altos → funciones → diseño → pruebas. Cada bloque va en un commit pequeño y se valida con pruebas antes de pasar al siguiente.
