# El Oreja Backend — API de turnos

API REST del sistema de turnos de [El Oreja Details](https://github.com/GeroVilche/El-Oreja-Details). Calcula los horarios disponibles y crea, reprograma y cancela turnos guardándolos como eventos en **Google Calendar**, así el negocio los ve en su agenda de siempre.

🔗 **Demo del sistema:** https://gerovilche.github.io/El-Oreja-Details/
🖥️ **API en producción:** https://el-oreja-backend.onrender.com (Render gratis: el primer pedido puede tardar unos segundos en "despertar" al servidor)

## Tecnologías
- Node.js + Express
- Google Calendar API (`googleapis`) con una cuenta de servicio
- `express-rate-limit` y `cors` para seguridad básica
- `dotenv` para las variables de entorno
- Deploy en **Render**

## Endpoints
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/configuracion` | Servicios, vehículos, horarios y reglas del negocio (las usa el frontend para armar el formulario) |
| GET | `/disponibilidad?fecha=&servicio=` | Horarios libres de un día para un servicio |
| GET | `/turnos?fecha=` | Turnos ocupados de un día |
| POST | `/turnos` | Crea un turno y devuelve sus datos |
| GET | `/turnos/:id` | Datos de un turno (para la página de reprogramar/cancelar) |
| GET | `/turnos/:id/disponibilidad?fecha=` | Horarios libres para reprogramar, sin contar el propio turno |
| PATCH | `/turnos/:id` | Reprograma un turno (respeta el máximo de reprogramaciones) |
| DELETE | `/turnos/:id` | Cancela un turno (respeta el límite de horas antes) |

## Reglas del negocio configurables
Todo lo que define al negocio está en [`config/negocio.js`](config/negocio.js): servicios y su duración, vehículos, horario de cada día (con horario cortado o días cerrados), intervalo entre turnos, margen entre turnos, anticipación mínima y máxima, horas límite para cancelar y cantidad de reprogramaciones.

Para adaptar el sistema a otro negocio (peluquería, veterinaria...) solo cambio ese archivo.

Los **feriados o días cerrados** se bloquean creando un evento de "todo el día" en el Google Calendar: ese día no se ofrecen turnos, y los clientes que ya tenían uno pueden moverlo o cancelarlo sin límites.

## Seguridad
- Los secretos (`.env` y credenciales de Google) **nunca se suben** al repo; en producción van como variables de entorno en Render.
- **Límite de pedidos por IP** para evitar abusos (reservas por hora y pedidos en general).
- **CORS** restringido al dominio del frontend.
- Validación de todos los datos que llegan (fecha, servicio, teléfono, etc.) antes de tocar el calendario.

## Cómo correrlo en local
1. Clonar el repo e instalar dependencias:
   ```bash
   npm install
   ```
2. Crear una **cuenta de servicio** en Google Cloud con la Calendar API activada, descargar su JSON como `google-credentials.json` en la raíz y **compartir el calendario** con el email de la cuenta de servicio.
3. Copiar `.env.example` como `.env` y completar los valores (cada variable está explicada en el archivo).
4. Levantar el servidor:
   ```bash
   npm run dev   # con recarga automática
   npm start     # modo normal
   ```
   Queda en `http://localhost:3000`.

## Autor
**Gerónimo Vilche** — [Portfolio](https://gerovilche.github.io/Portfolio/) · [LinkedIn](https://www.linkedin.com/in/geronimo-vilche-160ab4274/)
