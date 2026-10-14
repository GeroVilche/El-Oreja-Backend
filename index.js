// ===================== CONFIGURACIÓN =====================
// Los valores que cambian según dónde corre el servidor (tu compu o Render) no van escritos
// en el código: se leen de variables de entorno (process.env).
//  - En tu compu: salen del archivo .env (que NO se sube a GitHub, está en .gitignore).
//  - En Render: se cargan en el panel de Render, en "Environment".
// En .env.example está la lista de variables que hacen falta, sin valores reales.
require('dotenv').config(); // lee el archivo .env (si no existe, como en Render, no hace nada)

const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { google } = require('googleapis');

// Si falta una variable obligatoria, el servidor no arranca y avisa cuál es.
// Es mejor fallar al arrancar con un mensaje claro que fallar después, en medio de una reserva.
const VARIABLES_OBLIGATORIAS = ['CALENDAR_ID', 'NUMERO_WHATSAPP_NEGOCIO', 'FRONTEND_URL'];
const faltantes = VARIABLES_OBLIGATORIAS.filter(nombre => !process.env[nombre]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}. Revisá tu archivo .env (guiate con .env.example).`);
    process.exit(1);
}

const PORT = process.env.PORT || 3000; // Render asigna el puerto solo, en la variable PORT
const CALENDAR_ID = process.env.CALENDAR_ID;
const NUMERO_WHATSAPP_NEGOCIO = process.env.NUMERO_WHATSAPP_NEGOCIO;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Credenciales de la cuenta de servicio de Google:
//  - En Render no hay archivo: el contenido del JSON va completo en la variable GOOGLE_CREDENTIALS.
//  - En tu compu, si esa variable no está, se usa el archivo google-credentials.json.
const auth = new google.auth.GoogleAuth({
    ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS) }
        : { keyFile: 'google-credentials.json' }),
    scopes: ['https://www.googleapis.com/auth/calendar'],
});
// =================== FIN CONFIGURACIÓN ===================

// CORS: qué páginas web pueden usar esta API desde el navegador de un visitante.
// Solo se permite el ORIGEN del frontend (protocolo + dominio + puerto, sin la ruta):
//   FRONTEND_URL = "https://gerovilche.github.io/El-Oreja-Details"  ->  origen "https://gerovilche.github.io"
// Ojo: CORS lo aplica el NAVEGADOR. No frena a alguien que llame a la API con un script o con curl
// (para eso están las validaciones y el límite de reservas); lo que evita es que OTRA página web
// use tu API desde el navegador de sus visitantes.
const ORIGENES_PERMITIDOS = [
    new URL(FRONTEND_URL).origin,
    // Opcional: otros orígenes separados por coma (ej. en tu compu, Live Server con "localhost")
    ...(process.env.CORS_ORIGENES_EXTRA || '').split(',').map(origen => origen.trim()).filter(Boolean),
];

const app = express();

// En Render (y en casi cualquier hosting) el servidor está detrás de un proxy: sin esto,
// todas las visitas parecerían venir de la misma IP (la del proxy) y el límite por IP no serviría.
// En tu compu no hay proxy, por eso se activa solo con la variable TRUST_PROXY.
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

app.use(cors({ origin: ORIGENES_PERMITIDOS }));
app.use(express.json());

// LÍMITE DE PEDIDOS POR IP (anti-spam)
// Cuenta los pedidos de cada IP en una ventana de tiempo; si se pasa, responde 429 ("demasiados pedidos").
// El mensaje va en { error }, el mismo formato que el resto: el frontend lo muestra en el recuadro rojo.
// Los contadores viven en memoria: se reinician si el servidor se reinicia (para este tamaño alcanza).

// General, para toda la API: generoso, porque el calendario consulta seguido (cambios de día, volver a la pestaña...)
const limiteGeneral = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiadas consultas seguidas. Esperá unos minutos y probá de nuevo.' },
});

// Reservas: mucho más estricto. Una persona real reserva 1 o 2 turnos, no decenas.
// Configurable con LIMITE_RESERVAS_POR_HORA (por defecto 5): en tu compu conviene subirlo para poder probar.
const limiteReservas = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    limit: Number(process.env.LIMITE_RESERVAS_POR_HORA) || 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Hiciste muchas reservas seguidas. Si necesitás más turnos, escribinos por WhatsApp.' },
});

app.use(limiteGeneral);

// Convierte "09:30" a 570 (minutos desde medianoche)
function horaAMinutos(hora) {
    const [horas, minutos] = hora.split(':').map(Number);
    return horas * 60 + minutos;
}

// Convierte 570 de vuelta a "09:30"
function minutosAHora(totalMinutos) {
    const horas = Math.floor(totalMinutos / 60);
    const minutos = totalMinutos % 60;
    const horasStr = String(horas).padStart(2, '0');
    const minutosStr = String(minutos).padStart(2, '0');
    return `${horasStr}:${minutosStr}`;
}

// Genera horarios candidatos cada 30 min, dentro del horario comercial
function generarHorariosCandidatos(horaApertura, horaCierre, intervaloMinutos) {
    const inicioMin = horaAMinutos(horaApertura);
    const cierreMin = horaAMinutos(horaCierre);
    const horarios = [];

    for (let minutos = inicioMin; minutos < cierreMin; minutos += intervaloMinutos) {
        horarios.push(minutosAHora(minutos));
    }

    return horarios;
}

// ¿Se superponen el rango [inicioA, finA) con el rango [inicioB, finB)?
function seSuperponen(inicioA, finA, inicioB, finB) {
    return inicioA < finB && inicioB < finA;
}

// Horario de atención del lavadero (lo usan el cálculo de disponibilidad y la lectura del calendario)
const HORA_APERTURA = '09:00';
const HORA_CIERRE = '18:00';

function obtenerHorariosDisponibles(fecha, duracionServicio, turnosDelDia) {
    const INTERVALO = 30;
    const BUFFER = 15;

    const cierreMin =horaAMinutos(HORA_CIERRE);
    const candidatos = generarHorariosCandidatos(HORA_APERTURA, HORA_CIERRE, INTERVALO);

    return candidatos.filter(horarioCandidato => {
        const inicioMin = horaAMinutos(horarioCandidato);
        const finMin = inicioMin + duracionServicio;

        //Condición 1: no pasarse del cierre
        if(finMin > cierreMin) {
            return false;
        }

        //Condición 2: no chocar con ningún turno ocupado (+ buffer)
        const chocaConAlgunTurno = turnosDelDia.some(turno => {
            const turnoInicioMin = horaAMinutos(turno.horaInicio);
            const turnoFinConBufferMin = horaAMinutos(turno.horaFin) + BUFFER;
            return seSuperponen(inicioMin, finMin, turnoInicioMin, turnoFinConBufferMin);
        });

        return !chocaConAlgunTurno;
    });
}

// Convierte un evento de Google Calendar en la franja que ocupa DENTRO del horario de atención
// de un día puntual: { horaInicio, horaFin }, o null si ese día no ocupa nada del horario.
// Contempla los distintos tipos de evento que Santi puede cargar a mano:
//  - "Todo el día" (ej. bloquea un feriado): no tienen hora, traen start.date en vez de
//    start.dateTime -> ocupan el día completo.
//  - Eventos con hora que empiezan el día anterior o terminan el siguiente.
//  - Eventos fuera del horario de atención (ej. algo personal a las 20:00) -> se ignoran.
// Los horarios "HH:MM" se pueden comparar como texto: "08:00" < "09:00".
function eventoAFranjaOcupada(evento, fecha) {
    // Evento de todo el día: ocupa todo el horario de atención
    if (!evento.start.dateTime) {
        return { horaInicio: HORA_APERTURA, horaFin: HORA_CIERRE };
    }

    const fechaInicio = evento.start.dateTime.substring(0, 10);
    const fechaFin = evento.end.dateTime.substring(0, 10);

    // Si empezó un día anterior, para este día arranca a las 00:00; si termina otro día, hasta las 23:59
    let horaInicio = fechaInicio < fecha ? '00:00' : evento.start.dateTime.substring(11, 16);
    let horaFin = fechaFin > fecha ? '23:59' : evento.end.dateTime.substring(11, 16);

    // Recortamos al horario de atención (así el calendario visual no dibuja bloques afuera)
    if (horaInicio < HORA_APERTURA) horaInicio = HORA_APERTURA;
    if (horaFin > HORA_CIERRE) horaFin = HORA_CIERRE;

    // Si quedó vacío, el evento no toca el horario de atención de este día
    if (horaInicio >= horaFin) {
        return null;
    }

    return { horaInicio, horaFin };
}

// Consulta a Google Calendar los eventos de un día puntual, y los devuelve
// convertidos a nuestro formato interno { horaInicio, horaFin }
async function obtenerTurnosDeGoogleCalendar(fecha) {
    const authClient = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const timeMin = `${fecha}T00:00:00-03:00`;
    const timeMax = `${fecha}T23:59:59-03:00`;

    const respuesta = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: ZONA_HORARIA, // que Google devuelva las horas en hora de Argentina
    });

    const eventos = respuesta.data.items || [];

    return eventos
        .map(evento => eventoAFranjaOcupada(evento, fecha))
        .filter(franja => franja !== null);
}

// Crea un evento nuevo en Google Calendar para un turno reservado
async function crearTurnoEnGoogleCalendar({ fecha, horaInicio, horaFin, servicio, vehiculo, clienteNombre, clienteTelefono, comentario }) {
  const authClient = await auth.getClient();
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  // Lo que Santi ve al abrir el evento en Google Calendar
  const lineasDescripcion = [
    `Servicio: ${servicio}`,
    `Vehículo: ${vehiculo}`,
    `Cliente: ${clienteNombre}`,
    `Teléfono: ${clienteTelefono}`,
  ];
  if (comentario) {
    lineasDescripcion.push(`Comentario: ${comentario}`);
  }

  const evento = {
    // El título incluye el vehículo: así Santi lo ve de un vistazo en la vista semanal
    summary: `${servicio} (${vehiculo}) - ${clienteNombre}`,
    description: lineasDescripcion.join('\n'),
    start: {
      dateTime: `${fecha}T${horaInicio}:00-03:00`,
      timeZone: 'America/Argentina/Buenos_Aires',
    },
    end: {
      dateTime: `${fecha}T${horaFin}:00-03:00`,
      timeZone: 'America/Argentina/Buenos_Aires',
    },
    extendedProperties: {
      private: {
        origen: 'web', // marca para reconocer los turnos creados desde la página
        servicio,
        vehiculo,
        clienteNombre,
        clienteTelefono,
        comentario,
      },
    },
  };

  const respuesta = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: evento,
  });

  return respuesta.data;
}

// "2026-10-10" -> "Sábado 10 de octubre"
// (armamos la fecha en UTC y la formateamos en UTC, así no depende de la zona horaria del servidor)
function formatearFechaLegible(fecha) {
    const [año, mes, dia] = fecha.split('-').map(Number);
    const texto = new Date(Date.UTC(año, mes - 1, dia))
        .toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
        .replace(',', '');
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// Arma el link de WhatsApp con el mensaje ya escrito, que el cliente le manda a Santi al reservar
function generarLinkWhatsApp({ servicio, vehiculo, fecha, horaInicio, horaFin, clienteNombre, comentario, linkCancelacion }) {
    const lineas = [
        `¡Hola! 👋 Soy ${clienteNombre}, acabo de reservar un turno por la web:`,
        '',
        `🚗 ${servicio} (${vehiculo})`,
        `📅 ${formatearFechaLegible(fecha)}, de ${horaInicio} a ${horaFin}`,
    ];
    // El comentario es opcional: la línea solo aparece si el cliente escribió algo
    if (comentario) {
        lineas.push(`💬 ${comentario}`);
    }
    lineas.push('', 'Ver o cancelar el turno:', linkCancelacion);

    const mensajeCodificado = encodeURIComponent(lineas.join('\n'));
    // Usamos api.whatsapp.com/send y no wa.me: wa.me hace una redirección que en WhatsApp
    // Web/Escritorio rompe los emojis (aparecen como �). Es el mismo servicio, sin el paso intermedio.
    return `https://api.whatsapp.com/send?phone=${NUMERO_WHATSAPP_NEGOCIO}&text=${mensajeCodificado}`;
}

//Mapeo de servicios a su duración en minutos
const SERVICIOS = {
    'Lavado de Mantenimiento': 45,
    'Lavado Completo': 90,
    'Detailing a Fondo': 180,
};

// ===================== VALIDACIONES =====================
// El backend no confía en nada de lo que llega: el formulario del frontend se puede saltear
// (por ejemplo, llamando a la API directamente). Todo dato se valida acá antes de usarlo.

const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
const DIAS_DE_ANTICIPACION = 1;          // mínimo: desde mañana (igual que en el frontend)
const DIAS_MAXIMOS_DE_ANTICIPACION = 60; // máximo: hasta 60 días adelante
const NOMBRE_MIN = 2;
const NOMBRE_MAX = 60;
const TELEFONO_REGEX = /^[0-9]{6,15}$/;  // misma regla que el pattern del formulario
const VEHICULOS = ['Auto', 'Camioneta / SUV', 'Moto']; // las mismas opciones que el <select> del formulario
const COMENTARIO_MAX = 300;

// ¿Es un servicio que existe? Se usa Object.hasOwn y no SERVICIOS[servicio] a secas, porque
// SERVICIOS['constructor'] o SERVICIOS['toString'] existen en todo objeto de JS y darían "válido".
function esServicioValido(servicio) {
    return typeof servicio === 'string' && Object.hasOwn(SERVICIOS, servicio);
}

// ¿Es "AAAA-MM-DD" y además una fecha que existe? ("2026-02-30" cumple el formato pero no existe)
function esFechaValida(fecha) {
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return false;
    }
    const [año, mes, dia] = fecha.split('-').map(Number);
    const comoFecha = new Date(Date.UTC(año, mes - 1, dia));
    // Si el día no existe, JS lo "corre" (30 de febrero -> 2 de marzo) y ya no coincide
    return comoFecha.getUTCFullYear() === año
        && comoFecha.getUTCMonth() === mes - 1
        && comoFecha.getUTCDate() === dia;
}

// Fecha "AAAA-MM-DD" de dentro de N días, según el calendario de ARGENTINA.
// No usamos la fecha del servidor: en Render el servidor corre en UTC, y desde las 21:00
// de Argentina para él ya sería el día siguiente.
function fechaEnArgentina(diasDesdeHoy) {
    // 'en-CA' es un truco conocido: ese formato regional escribe las fechas como AAAA-MM-DD
    const hoyEnArgentina = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());
    const [año, mes, dia] = hoyEnArgentina.split('-').map(Number);
    // Armamos la fecha en UTC a propósito, así toISOString() devuelve exactamente ese día
    return new Date(Date.UTC(año, mes - 1, dia + diasDesdeHoy)).toISOString().slice(0, 10);
}

// ¿La fecha está dentro del rango en el que se puede reservar? (desde mañana hasta 60 días)
function estaEnRangoReservable(fecha) {
    return fecha >= fechaEnArgentina(DIAS_DE_ANTICIPACION)
        && fecha <= fechaEnArgentina(DIAS_MAXIMOS_DE_ANTICIPACION);
}

// Valida el cuerpo de POST /turnos.
// Devuelve { error } si algo está mal, o { datos } con los valores ya limpios para usar.
function validarDatosTurno(body) {
    const { fecha, horaInicio, servicio, clienteNombre, clienteTelefono, vehiculo, comentario } = body || {};

    const todosSonTexto = [fecha, horaInicio, servicio, clienteNombre, clienteTelefono, vehiculo]
        .every(valor => typeof valor === 'string' && valor.trim() !== '');
    if (!todosSonTexto) {
        return { error: 'Faltan datos obligatorios' };
    }

    if (!esFechaValida(fecha)) {
        return { error: 'La fecha no es válida' };
    }

    if (!estaEnRangoReservable(fecha)) {
        return { error: `Los turnos se reservan desde mañana y hasta ${DIAS_MAXIMOS_DE_ANTICIPACION} días adelante` };
    }

    if (!esServicioValido(servicio)) {
        return { error: 'Servicio desconocido' };
    }

    const nombreLimpio = clienteNombre.trim();
    if (nombreLimpio.length < NOMBRE_MIN || nombreLimpio.length > NOMBRE_MAX) {
        return { error: `El nombre tiene que tener entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres` };
    }

    const telefonoLimpio = clienteTelefono.replace(/\s/g, ''); // sacamos los espacios
    if (!TELEFONO_REGEX.test(telefonoLimpio)) {
        return { error: 'El teléfono tiene que tener solo números, entre 6 y 15 dígitos' };
    }

    if (!VEHICULOS.includes(vehiculo)) {
        return { error: 'Tipo de vehículo desconocido' };
    }

    // El comentario es opcional: puede no venir, pero si viene tiene que ser texto y no muy largo
    if (comentario !== undefined && typeof comentario !== 'string') {
        return { error: 'El comentario no es válido' };
    }
    const comentarioLimpio = (comentario || '').trim();
    if (comentarioLimpio.length > COMENTARIO_MAX) {
        return { error: `El comentario puede tener hasta ${COMENTARIO_MAX} caracteres` };
    }

    // horaInicio no se valida acá: la ruta comprueba que esté en la lista de horarios
    // disponibles, y cualquier valor raro ("banana", "25:99") nunca va a estar en esa lista.
    return {
        datos: {
            fecha, horaInicio, servicio, vehiculo,
            clienteNombre: nombreLimpio,
            clienteTelefono: telefonoLimpio,
            comentario: comentarioLimpio,
        },
    };
}
// =================== FIN VALIDACIONES ===================

app.get('/disponibilidad', async (req, res) => {
    const { fecha, servicio } = req.query;

    if (!esFechaValida(fecha)) {
        return res.status(400).json({ error: 'La fecha no es válida' });
    }

    if (!esServicioValido(servicio)) {
        return res.status(400).json({ error: 'Servicio desconocido' });
    }

    const duracion = SERVICIOS[servicio];

    // Fuera del rango reservable no hay horarios (no es un error: simplemente ese día no se puede)
    if (!estaEnRangoReservable(fecha)) {
        return res.json({ fecha, servicio, duracion, horariosDisponibles: [] });
    }

    try {
        const turnosDelDia = await obtenerTurnosDeGoogleCalendar(fecha);
        const disponibles = obtenerHorariosDisponibles(fecha, duracion, turnosDelDia);
        res.json({ fecha, servicio, duracion, horariosDisponibles: disponibles });
    }   catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al consultar disponibilidad' });
    }
});

app.post('/turnos', limiteReservas, async (req, res) => {
    const validacion = validarDatosTurno(req.body);
    if (validacion.error) {
        return res.status(400).json({ error: validacion.error });
    }

    // A partir de acá usamos los datos ya validados y limpios (nombre sin espacios de más, teléfono solo números)
    const { fecha, horaInicio, servicio, vehiculo, clienteNombre, clienteTelefono, comentario } = validacion.datos;
    const duracion = SERVICIOS[servicio];

    try {
        // Re-consultamos disponibilidad real, por si alguien más reservó ese horario mientras tanto
        const turnosDelDia = await obtenerTurnosDeGoogleCalendar(fecha);
        const disponibles = obtenerHorariosDisponibles(fecha, duracion, turnosDelDia);

        if (!disponibles.includes(horaInicio)) {
            return res.status(409).json({ error: 'Ese horario ya no está disponible' });
        }

        const horaFin = minutosAHora(horaAMinutos(horaInicio) + duracion);

        const eventoCreado = await crearTurnoEnGoogleCalendar({
            fecha, horaInicio, horaFin, servicio, vehiculo, clienteNombre, clienteTelefono, comentario,
        });

        const linkCancelacion = `${FRONTEND_URL}/cancelar.html?id=${eventoCreado.id}`;

        const linkWhatsApp = generarLinkWhatsApp({
            servicio, vehiculo, fecha, horaInicio, horaFin, clienteNombre, comentario, linkCancelacion,
        });

        res.status(201).json({
            mensaje: 'Turno reservado con éxito',
            linkWhatsApp,
            linkCancelacion,
        });
    }   catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear el turno' });
    }
});

app.get('/turnos', async (req, res) => {
  const fecha = req.query.fecha;

  if (!esFechaValida(fecha)) {
    return res.status(400).json({ error: 'La fecha no es válida' });
  }

  try {
    const turnosDelDia = await obtenerTurnosDeGoogleCalendar(fecha);
    res.json(turnosDelDia);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al consultar turnos' });
  }
});

// Busca un turno por id y lo devuelve SOLO si fue creado desde la web.
// Devuelve null si no existe, si ya fue cancelado o si es un evento cargado a mano.
async function obtenerTurnoWeb(calendar, id) {
  try {
    const respuesta = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId: id,
    });

    const evento = respuesta.data;
    const propiedades = evento.extendedProperties?.private || {};

    if (propiedades.origen !== 'web') return null;
    if (evento.status === 'cancelled') return null;

    return evento;
  } catch (error) {
    // 404 / 410 de Google = el evento no existe o ya fue borrado
    if (error.code === 404 || error.code === 410) return null;
    throw error; // cualquier otro error (credenciales, red...) lo maneja la ruta
  }
}

app.get('/turnos/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const authClient = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const evento = await obtenerTurnoWeb(calendar, id);

    if (!evento) {
      return res.status(404).json({ error: 'Turno no encontrado' });
    }

    const propiedades = evento.extendedProperties.private;

    res.json({
      id: evento.id,
      fecha: evento.start.dateTime.substring(0, 10),
      horaInicio: evento.start.dateTime.substring(11, 16),
      horaFin: evento.end.dateTime.substring(11, 16),
      servicio: propiedades.servicio || null,
      // Solo el primer nombre: alcanza para el saludo y expone menos si el link se comparte
      primerNombre: (propiedades.clienteNombre || '').trim().split(/\s+/)[0] || null,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al consultar el turno' });
  }
});

app.delete('/turnos/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const authClient = await auth.getClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        const evento = await obtenerTurnoWeb(calendar, id);

        if (!evento) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }

        await calendar.events.delete({
            calendarId: CALENDAR_ID,
            eventId: id,
        });

        res.json({ mensaje: 'Turno cancelado con éxito' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cancelar el turno' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});



