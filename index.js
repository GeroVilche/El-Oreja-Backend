const express = require('express');
const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());
const PORT = 3000;

const { google } = require('googleapis');

const NUMERO_WHATSAPP_NEGOCIO = '5492494009695'; //TODO: reemplazar por el número real del negocio
const FRONTEND_URL = 'http://127.0.0.1:5500/frontend'; // TODO: reemplazar por la URL real de GitHub Pages cuando esté todo probado
const CALENDAR_ID = 'geroov49@gmail.com';

const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/calendar'],
});

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
async function crearTurnoEnGoogleCalendar({ fecha, horaInicio, horaFin, servicio, clienteNombre, clienteTelefono }) {
  const authClient = await auth.getClient();
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  const evento = {
    summary: `${servicio} - ${clienteNombre}`,
    description: `Servicio: ${servicio}\nCliente: ${clienteNombre}\nTeléfono: ${clienteTelefono}`,
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
        clienteNombre,
        clienteTelefono,
      },
    },
  };

  const respuesta = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: evento,
  });

  return respuesta.data;
}

// Arma el link de WhatsApp con el mensaje de confirmación ya escrito
function generarLinkWhatsApp({ servicio, fecha, horaInicio, horaFin, clienteNombre, linkCancelacion }) {
    const mensaje = 
    `Hola! Reservé un turno en El Oreja Details:\n\n` +
    `Servicio: ${servicio}\n` +
    `Fecha: ${fecha}\n` +
    `Horario: ${horaInicio} a ${horaFin}\n` +
    `Nombre: ${clienteNombre}\n\n` +
    `Link para cancelar (si lo necesito): ${linkCancelacion}`;

    const mensajeCodificado = encodeURIComponent(mensaje);
    return `https://wa.me/${NUMERO_WHATSAPP_NEGOCIO}?text=${mensajeCodificado}`;
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
    const { fecha, horaInicio, servicio, clienteNombre, clienteTelefono } = body || {};

    const todosSonTexto = [fecha, horaInicio, servicio, clienteNombre, clienteTelefono]
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

    // horaInicio no se valida acá: la ruta comprueba que esté en la lista de horarios
    // disponibles, y cualquier valor raro ("banana", "25:99") nunca va a estar en esa lista.
    return {
        datos: { fecha, horaInicio, servicio, clienteNombre: nombreLimpio, clienteTelefono: telefonoLimpio },
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

app.post('/turnos', async (req, res) => {
    const validacion = validarDatosTurno(req.body);
    if (validacion.error) {
        return res.status(400).json({ error: validacion.error });
    }

    // A partir de acá usamos los datos ya validados y limpios (nombre sin espacios de más, teléfono solo números)
    const { fecha, horaInicio, servicio, clienteNombre, clienteTelefono } = validacion.datos;
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
            fecha, horaInicio, horaFin, servicio, clienteNombre, clienteTelefono,
        });

        const linkCancelacion = `${FRONTEND_URL}/cancelar.html?id=${eventoCreado.id}`;

        const linkWhatsApp = generarLinkWhatsApp({
            servicio, fecha, horaInicio, horaFin, clienteNombre, linkCancelacion,
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



