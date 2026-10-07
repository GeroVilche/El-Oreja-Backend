const express = require('express');
const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());
const PORT = 3000;

const { google } = require('googleapis');

const NUMERO_WHATSAPP_NEGOCIO = '5492494009695'; //TODO: reemplazar por el número real del negocio
const FRONTEND_URL = 'http://127.0.0.1:5500/El-Oreja-Details'; // TODO: reemplazar por la URL real de GitHub Pages cuando esté todo probado
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

function obtenerHorariosDisponibles(fecha, duracionServicio, turnosDelDia) {
    const HORA_APERTURA = '09:00';
    const HORA_CIERRE = '18:00';
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

// Consulta a Google Calendar los eventos de un dia puntual, y los devuelve
// Convertidos a nuestro formato interno { horaInicio, horaFin, servicio }
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
    });

    const eventos = respuesta.data.items || [];

    return eventos.map(evento => ({
        horaInicio: evento.start.dateTime.substring(11, 16),
        horaFin: evento.end.dateTime.substring(11, 16),
    }));
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

app.get('/disponibilidad', async (req, res) => {
    const { fecha, servicio } = req.query;

    if (!fecha || !servicio) {
        return res.status(400).json({ error: 'Faltan los parámetros fecha y/o servicio' });
    }

    const duracion = SERVICIOS[servicio];

    if(!duracion) {
        return res.status(400).json({ error: `Servicio desconocido: ${servicio}` });
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
    const { fecha, horaInicio, servicio, clienteNombre, clienteTelefono } = req.body;

    if (!fecha || !horaInicio || !servicio || !clienteNombre || !clienteTelefono) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const duracion = SERVICIOS[servicio];
    if (!duracion) {
        return res.status(400).json({ error: `Servicio desconocido: ${servicio}` });
    }

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
            evento: eventoCreado,
        });
    }   catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear el turno' });
    }
});

app.get('/turnos', async (req, res) => {
  const fecha = req.query.fecha;

  if (!fecha) {
    return res.status(400).json({ error: 'Falta el parámetro fecha' });
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



