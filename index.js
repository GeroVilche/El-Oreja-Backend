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


// Datos del negocio (servicios, horario, anticipación...): salen de config/negocio.js.
// Acá solo les doy nombres cortos para usarlos en el resto del archivo.
// Ojo: si quiero cambiar un horario o un servicio, se cambia en config/negocio.js, no acá.
const negocio = require('./config/negocio');
const ZONA_HORARIA = negocio.zonaHoraria;
const HORARIOS = negocio.horarios;
const INTERVALO_MINUTOS = negocio.intervaloMinutos;
const MARGEN_ENTRE_TURNOS_MINUTOS = negocio.margenEntreTurnosMinutos;
const DIAS_DE_ANTICIPACION = negocio.anticipacion.minimaDias;
const DIAS_MAXIMOS_DE_ANTICIPACION = negocio.anticipacion.maximaDias;
const VEHICULOS = negocio.vehiculos;
// El límite para cancelar sale de la config, pero en mi .env lo puedo pisar para testear
// (ej. HORAS_LIMITE_CANCELACION=0 -> puedo cancelar cualquier turno que todavía no pasó).
// Ojo: process.env siempre trae TEXTO, por eso el Number(). Y pregunto por el texto, no por el
// número: el texto '0' cuenta como verdadero, así que un 0 en el .env funciona.
const HORAS_LIMITE_CANCELACION = process.env.HORAS_LIMITE_CANCELACION
    ? Number(process.env.HORAS_LIMITE_CANCELACION)
    : negocio.cancelacion.horasLimite;
const MAXIMO_REPROGRAMACIONES = negocio.reprogramacion.maximo;

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


// getUTCDay() devuelve el día de la semana como número: 0 = domingo, 1 = lunes... 6 = sábado.
// Esta lista traduce ese número al nombre que uso en config/negocio.js.
const DIAS_DE_LA_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// Franjas de atención de una fecha "AAAA-MM-DD" según su día de la semana. [] = ese día está cerrado.
// Ojo: armo la fecha con "Z" (UTC) y uso getUTCDay() para que el resultado no dependa de la zona
// horaria de la compu donde corre el servidor (Render corre en UTC; mi compu, en hora de Argentina).
function franjasDelDia(fecha) {
    const numeroDeDia = new Date(`${fecha}T00:00:00Z`).getUTCDay();
    return HORARIOS[DIAS_DE_LA_SEMANA[numeroDeDia]];
}

// Horarios en los que se puede empezar un servicio de esa duración, en esa fecha.
// Recorro cada franja del día por separado: en un horario cortado (9–13 y 16–20) un servicio
// de 3 h no puede empezar a las 12:00, porque terminaría en el mediodía cerrado.
// Un día cerrado no tiene franjas, así que devuelve una lista vacía.
function obtenerHorariosDisponibles(fecha, duracionServicio, turnosDelDia) {
    const disponibles = [];

    franjasDelDia(fecha).forEach(franja => {
        const cierreMin = horaAMinutos(franja.cierre);
        const candidatos = generarHorariosCandidatos(franja.apertura, franja.cierre, INTERVALO_MINUTOS);

        const libresDeLaFranja = candidatos.filter(horarioCandidato => {
            const inicioMin = horaAMinutos(horarioCandidato);
            const finMin = inicioMin + duracionServicio;

            // Condición 1: terminar antes de que cierre ESTA franja
            if (finMin > cierreMin) {
                return false;
            }

            // Condición 2: no chocar con ningún turno ocupado (+ el margen entre turnos)
            const chocaConAlgunTurno = turnosDelDia.some(turno => {
                const turnoInicioMin = horaAMinutos(turno.horaInicio);
                const turnoFinConMargenMin = horaAMinutos(turno.horaFin) + MARGEN_ENTRE_TURNOS_MINUTOS;
                return seSuperponen(inicioMin, finMin, turnoInicioMin, turnoFinConMargenMin);
            });

            return !chocaConAlgunTurno;
        });

        disponibles.push(...libresDeLaFranja);
    });

    return disponibles;
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
    const franjas = franjasDelDia(fecha);
    if (franjas.length === 0) return null; // día cerrado: no hay horario que ocupar

    // Uso desde la primera apertura hasta el último cierre del día. En un horario cortado eso
    // incluye el mediodía, pero no importa: en ese hueco igual no se ofrecen turnos.
    const aperturaDelDia = franjas[0].apertura;
    const cierreDelDia = franjas[franjas.length - 1].cierre;
    // Evento de todo el día: ocupa todo el horario de atención
    if (!evento.start.dateTime) {
        return { horaInicio: aperturaDelDia, horaFin: cierreDelDia };
    }

    const fechaInicio = evento.start.dateTime.substring(0, 10);
    const fechaFin = evento.end.dateTime.substring(0, 10);

    // Si empezó un día anterior, para este día arranca a las 00:00; si termina otro día, hasta las 23:59
    let horaInicio = fechaInicio < fecha ? '00:00' : evento.start.dateTime.substring(11, 16);
    let horaFin = fechaFin > fecha ? '23:59' : evento.end.dateTime.substring(11, 16);

    // Recortamos al horario de atención (así el calendario visual no dibuja bloques afuera)
    if (horaInicio < aperturaDelDia) horaInicio = aperturaDelDia;
    if (horaFin > cierreDelDia) horaFin = cierreDelDia;

    // Si quedó vacío, el evento no toca el horario de atención de este día
    if (horaInicio >= horaFin) {
        return null;
    }

    return { horaInicio, horaFin };
}

// idAExcluir (opcional): un evento que no cuento como ocupado. Lo uso al reprogramar,
// para que el propio turno no bloquee los horarios de alrededor (si no, no se podría
// mover ni media hora). Si no lo paso, vale null y no se excluye nada.
async function obtenerTurnosDeGoogleCalendar(fecha, idAExcluir = null) {
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
        .filter(evento => evento.id !== idAExcluir)
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
    lineas.push('', 'Ver, reprogramar o cancelar el turno:', linkCancelacion);

    const mensajeCodificado = encodeURIComponent(lineas.join('\n'));
    // Usamos api.whatsapp.com/send y no wa.me: wa.me hace una redirección que en WhatsApp
    // Web/Escritorio rompe los emojis (aparecen como �). Es el mismo servicio, sin el paso intermedio.
    return `https://api.whatsapp.com/send?phone=${NUMERO_WHATSAPP_NEGOCIO}&text=${mensajeCodificado}`;
}

// ===================== VALIDACIONES =====================
// El backend no confía en nada de lo que llega: el formulario del frontend se puede saltear
// (por ejemplo, llamando a la API directamente). Todo dato se valida acá antes de usarlo.

const NOMBRE_MIN = 2;
const NOMBRE_MAX = 60;
const TELEFONO_REGEX = /^[0-9]{6,15}$/;  // misma regla que el pattern del formulario
const COMENTARIO_MAX = 300;

// Busco un servicio por nombre en la lista de config/negocio.js.
// Devuelve el servicio ({ nombre, duracion }) o undefined si no existe.
// Ojo: con .find() comparo contra los nombres reales de la lista, así que "constructor" o
// "toString" ya no pueden pasar como servicio (el problema que tenía con el objeto).
function buscarServicio(nombre) {
    return negocio.servicios.find(servicio => servicio.nombre === nombre);
}

function esServicioValido(servicio) {
    return typeof servicio === 'string' && buscarServicio(servicio) !== undefined;
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
        return { error: `Los turnos se reservan con ${DIAS_DE_ANTICIPACION} día(s) de anticipación y hasta ${DIAS_MAXIMOS_DE_ANTICIPACION} días adelante` };    }

    if (!esServicioValido(servicio)) {
        return { error: 'Servicio desconocido' };
    }

    const nombreLimpio = clienteNombre.trim();
    if (nombreLimpio.length < NOMBRE_MIN || nombreLimpio.length > NOMBRE_MAX) {
        return { error: `El nombre tiene que tener entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres` };
    }

    // Saco espacios, guiones, puntos, paréntesis y el "+": así "249 412-3456" o "(249) 4123456"
    // quedan como 2494123456. El frontend ya lo limpia, pero acá lo vuelvo a hacer (defensa en profundidad).
    const telefonoLimpio = clienteTelefono.replace(/[\s\-().+]/g, '');
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

// Le paso al frontend los datos del negocio que necesita para armar el formulario
// (los <select>, el calendario visual y los límites de fecha).
// Ojo: elijo a mano qué mando y no mando el objeto negocio entero. Si un día agrego algo
// interno a la config, no queda público sin darme cuenta.
app.get('/configuracion', (req, res) => {
    res.json({
        servicios: negocio.servicios,
        vehiculos: negocio.vehiculos,
        horarios: negocio.horarios,
        anticipacion: negocio.anticipacion,
    });
});

app.get('/disponibilidad', async (req, res) => {
    const { fecha, servicio } = req.query;

    if (!esFechaValida(fecha)) {
        return res.status(400).json({ error: 'La fecha no es válida' });
    }

    if (!esServicioValido(servicio)) {
        return res.status(400).json({ error: 'Servicio desconocido' });
    }

    const duracion = buscarServicio(servicio).duracion;

    // Fuera del rango reservable no hay horarios (no es un error: simplemente ese día no se puede)
    if (!estaEnRangoReservable(fecha)) {
        return res.json({ fecha, servicio, duracion, horariosDisponibles: [] });
    }

    // Día cerrado según config/negocio.js: aviso con "cerrado: true" para que el frontend
    // muestre "Cerrado" en vez de "No hay horarios" (y ni consulto el Calendar: no hace falta)
    if (franjasDelDia(fecha).length === 0) {
        return res.json({ fecha, servicio, duracion, cerrado: true, horariosDisponibles: [] });
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
    const duracion = buscarServicio(servicio).duracion;

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
            // Los datos del turno, para que el frontend muestre la tarjeta (modal) sin pedirlos de nuevo
            turno: armarDatosTurno(eventoCreado),
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

// Horas que faltan para que empiece el turno (negativo si ya pasó).
// Ojo: start.dateTime trae la zona horaria ("2026-10-26T10:00:00-03:00"), así que new Date()
// lo entiende bien sin importar en qué zona corre el servidor. Restar dos fechas da milisegundos.
function horasQueFaltan(evento) {
    const milisegundos = new Date(evento.start.dateTime) - Date.now();
    return milisegundos / (1000 * 60 * 60);
}

// ¿Todavía se puede cancelar desde el link? Un turno que ya pasó, nunca (faltan horas negativas).
// diaBloqueado: Santi cerró el día del turno (evento de "todo el día" en el Calendar). Ahí el cambio
// no es culpa del cliente, así que no aplico el límite de horas (pero un turno que ya pasó, igual no).
function sePuedeCancelar(evento, diaBloqueado = false) {
    const horas = horasQueFaltan(evento);
    if (diaBloqueado) return horas > 0;
    return horas >= HORAS_LIMITE_CANCELACION;
}

// Cuántas veces el cliente ya reprogramó este turno desde la web. El contador vive en el propio
// evento (extendedProperties.private.reprogramaciones). Google guarda esas propiedades como TEXTO,
// por eso el Number(); si no existe (turno nunca reprogramado), Number(undefined) da NaN -> uso 0.
function vecesReprogramado(evento) {
    return Number(evento.extendedProperties?.private?.reprogramaciones) || 0;
}

function agotoReprogramaciones(evento) {
    return vecesReprogramado(evento) >= MAXIMO_REPROGRAMACIONES;
}

// Reprogramar tiene DOS reglas: el límite de horas (el mismo que cancelar) y el máximo de veces.
// Cancelar, en cambio, solo depende de las horas: aunque ya haya reprogramado, siempre puede cancelar.
// Si Santi bloqueó el día, ninguna de las dos aplica: el cliente tiene que poder elegir otro horario.
function sePuedeReprogramar(evento, diaBloqueado = false) {
    if (diaBloqueado) return sePuedeCancelar(evento, true);
    return sePuedeCancelar(evento) && !agotoReprogramaciones(evento);
}

// ¿Santi bloqueó ese día? Busco en el Calendar algún evento de "todo el día" en esa fecha
// (los eventos de todo el día traen start.date en vez de start.dateTime; los turnos web nunca lo son).
// Es una consulta más a Google: la hago solo en las rutas de la tarjeta del turno, no al reservar.
async function esDiaBloqueado(calendar, fecha) {
    const respuesta = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: `${fecha}T00:00:00-03:00`,
        timeMax: `${fecha}T23:59:59-03:00`,
        singleEvents: true,
        timeZone: ZONA_HORARIA,
    });
    const eventos = respuesta.data.items || [];
    return eventos.some(evento => !evento.start.dateTime);
}

// Link de WhatsApp para cuando ya no se puede cancelar online: el cliente le avisa al negocio
// igual, así Santi se entera y el turno no queda como un "no vino".
function generarLinkAvisoCancelacion(evento) {
    const propiedades = evento.extendedProperties.private;
    const fecha = evento.start.dateTime.substring(0, 10);
    const hora = evento.start.dateTime.substring(11, 16);

    const mensaje = `¡Hola! Soy ${propiedades.clienteNombre}, tengo un turno el `
        + `${formatearFechaLegible(fecha).toLowerCase()} a las ${hora} (${propiedades.servicio}) `
        + 'y no voy a poder ir. ¿Lo podemos cancelar o pasar a otro día?';

    return `https://api.whatsapp.com/send?phone=${NUMERO_WHATSAPP_NEGOCIO}&text=${encodeURIComponent(mensaje)}`;
}

// Cuántos minutos dura el turno, calculado del propio evento (fin - inicio).
// Uso el evento y no la duración del servicio en la config: si un día cambio la duración de
// un servicio, los turnos que ya estaban reservados tienen que mantener la suya.
function duracionDelTurno(evento) {
    const milisegundos = new Date(evento.end.dateTime) - new Date(evento.start.dateTime);
    return milisegundos / (1000 * 60);
}

// Link de WhatsApp para avisarle al negocio que el cliente reprogramó (se arma ANTES de mover
// el evento, porque necesito la fecha y hora viejas).
function generarLinkAvisoReprogramacion(evento, fechaNueva, horaNueva) {
    const propiedades = evento.extendedProperties.private;
    const fechaVieja = evento.start.dateTime.substring(0, 10);
    const horaVieja = evento.start.dateTime.substring(11, 16);

    const lineas = [
        `¡Hola! 👋 Soy ${propiedades.clienteNombre}, reprogramé mi turno por la web:`,
        '',
        `🚗 ${propiedades.servicio}`,
        `❌ Antes: ${formatearFechaLegible(fechaVieja)}, ${horaVieja}`,
        `✅ Ahora: ${formatearFechaLegible(fechaNueva)}, ${horaNueva}`,
    ];

    return `https://api.whatsapp.com/send?phone=${NUMERO_WHATSAPP_NEGOCIO}&text=${encodeURIComponent(lineas.join('\n'))}`;
}

// Los datos de un turno que le mando al frontend (la tarjeta del turno).
// Es una función porque la usan dos rutas: GET /turnos/:id (cuando el cliente vuelve con su link)
// y POST /turnos (recién reservado, para mostrar la tarjeta en el modal sin pedirla de nuevo).
// Así las dos devuelven exactamente lo mismo y nunca se desincronizan.
// diaBloqueado: si Santi cerró ese día (lo calcula la ruta con esDiaBloqueado; al reservar es false,
// porque en un día bloqueado no se puede reservar).
function armarDatosTurno(evento, diaBloqueado = false) {
    const propiedades = evento.extendedProperties.private;
    const puedeCancelar = sePuedeCancelar(evento, diaBloqueado);

    return {
        id: evento.id,
        fecha: evento.start.dateTime.substring(0, 10),
        horaInicio: evento.start.dateTime.substring(11, 16),
        horaFin: evento.end.dateTime.substring(11, 16),
        servicio: propiedades.servicio || null,
        // Solo el primer nombre: alcanza para el saludo y expone menos si el link se comparte
        primerNombre: (propiedades.clienteNombre || '').trim().split(/\s+/)[0] || null,
        // Regla de cancelación: el frontend decide con esto qué mostrar
        yaPaso: horasQueFaltan(evento) < 0,
        diaBloqueado, // la tarjeta avisa "el negocio no va a abrir ese día"
        sePuedeCancelar: puedeCancelar,
        sePuedeReprogramar: sePuedeReprogramar(evento, diaBloqueado),
        // para explicar por qué ya no puede reprogramar (si el día está bloqueado, el máximo no aplica)
        agotoReprogramaciones: !diaBloqueado && agotoReprogramaciones(evento),
        horasLimiteCancelacion: HORAS_LIMITE_CANCELACION,
        // El link de WhatsApp lleva el nombre completo: lo mando solo cuando hace falta
        linkWhatsApp: puedeCancelar ? null : generarLinkAvisoCancelacion(evento),
    };
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

    const diaBloqueado = await esDiaBloqueado(calendar, evento.start.dateTime.substring(0, 10));
    res.json(armarDatosTurno(evento, diaBloqueado));

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al consultar el turno' });
  }
});

// Horarios libres para mover ESTE turno a otra fecha. Es como /disponibilidad, pero:
//  - el servicio (y su duración) salen del propio turno: el cliente no los puede cambiar
//  - el propio turno no cuenta como ocupado (idAExcluir)
//  - aplica el mismo límite de horas que cancelar
app.get('/turnos/:id/disponibilidad', async (req, res) => {
    const { id } = req.params;
    const { fecha } = req.query;

    if (!esFechaValida(fecha)) {
        return res.status(400).json({ error: 'La fecha no es válida' });
    }

    try {
        const authClient = await auth.getClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        const evento = await obtenerTurnoWeb(calendar, id);
        if (!evento) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }

        const diaBloqueado = await esDiaBloqueado(calendar, evento.start.dateTime.substring(0, 10));
        if (!sePuedeCancelar(evento, diaBloqueado)) {
            return res.status(403).json({ error: `Los turnos se pueden modificar online hasta ${HORAS_LIMITE_CANCELACION} h antes.` });
        }
        if (!sePuedeReprogramar(evento, diaBloqueado)) {
            return res.status(403).json({ error: 'Ya reprogramaste este turno. Si necesitás otro horario, cancelalo y reservá uno nuevo.' });
        }

        // Fuera de rango o día cerrado: no es un error, simplemente no hay horarios
        if (!estaEnRangoReservable(fecha)) {
            return res.json({ fecha, horariosDisponibles: [] });
        }
        if (franjasDelDia(fecha).length === 0) {
            return res.json({ fecha, cerrado: true, horariosDisponibles: [] });
        }

        const turnosDelDia = await obtenerTurnosDeGoogleCalendar(fecha, id);
        const disponibles = obtenerHorariosDisponibles(fecha, duracionDelTurno(evento), turnosDelDia);
        res.json({ fecha, horariosDisponibles: disponibles });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al consultar disponibilidad' });
    }
});

// Reprogramar: mueve el MISMO evento a otra fecha/hora (no crea uno nuevo), así el link del
// Cliente sigue sirviendo. PATCH = "modificá una parte de esto" (acá, solo el horario).
// LLeva limiteReservas, igual que POST /turnos: mover turnos sin parar también sería spam.
app.patch('/turnos/:id', limiteReservas, async (req, res) => {
    const { id } = req.params;
    const { fecha, horaInicio } = req.body || {};

    if (typeof horaInicio !== 'string' || !esFechaValida(fecha)) {
        return res.status(400).json({ error: 'Faltan la fecha o el horario' });
    }
    if (!estaEnRangoReservable(fecha)) {
        return res.status(400).json({ error: `Los turnos se reservan con ${DIAS_DE_ANTICIPACION} día(s) de anticipación y hasta ${DIAS_MAXIMOS_DE_ANTICIPACION} días adelante` });
    }

    try {
        const authClient = await auth.getClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        const evento = await obtenerTurnoWeb(calendar, id);
        if (!evento) {
            return res.status(404).json({ error: `Turno no encontrado`});
        }

        const diaBloqueado = await esDiaBloqueado(calendar, evento.start.dateTime.substring(0, 10));
        if (!sePuedeCancelar(evento, diaBloqueado)) {
            return res.status(403).json({ error: `Los turnos se pueden modificar online hasta ${HORAS_LIMITE_CANCELACION} hs antes. Escribinos por WhatsApp.`});
        }
        if (!sePuedeReprogramar(evento, diaBloqueado)) {
            return res.status(403).json({ error: 'Ya reprogramaste este turno. Si necesitás otro horario, cancelalo y reservá uno nuevo.' });
        }

        if (evento.start.dateTime.substring(0, 16) === `${fecha}T${horaInicio}`) {
            return res.status(400).json({ error: 'Elegí un día u horario distinto al que ya tenés'});
        }

        // Igual que al reservar: vuelvo a consultar en el momento, por si alguien tomó ese horario
        // mientras tanto. Un horario raro ("banana") nunca va a estar en la lista, así que también lo frena
        const duracion = duracionDelTurno(evento);
        const turnosDelDia = await obtenerTurnosDeGoogleCalendar(fecha, id);
        const disponibles = obtenerHorariosDisponibles(fecha, duracion, turnosDelDia);
        if (!disponibles.includes(horaInicio)) {
            return res.status(409).json({ error: 'Ese horario ya no está disponible' });
        }

        const horaFin = minutosAHora(horaAMinutos(horaInicio) + duracion);
        const linkWhatsApp = generarLinkAvisoReprogramacion(evento, fecha, horaInicio); //antes de mover

        // patch solo cambia lo que le paso: inicio, fin y el contador de reprogramaciones.
        // Título, descripción y el resto de los datos del cliente quedan igual.
        // Ojo: en extendedProperties.private mando TODAS las propiedades (las que ya tenía + el contador)
        // y no solo el contador: así me aseguro de no perder "origen: 'web'" (sin esa marca, el turno
        // dejaría de poder verse y cancelarse desde la web).
        const actualizado = await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: id,
            requestBody: {
                start: { dateTime: `${fecha}T${horaInicio}:00-03:00`, timeZone: ZONA_HORARIA },
                end: { dateTime: `${fecha}T${horaFin}:00-03:00`, timeZone: ZONA_HORARIA },
                extendedProperties: {
                    private: {
                        ...evento.extendedProperties.private,
                        // Si lo movió porque Santi cerró el día, no le cuento la reprogramación (no fue su culpa)
                        reprogramaciones: String(vecesReprogramado(evento) + (diaBloqueado ? 0 : 1)),
                    },
                },
            },
        });

        // Devuelvo el turno ya actualizado (con sePuedeReprogramar en false si llegó al máximo),
        // así el frontend muestra las opciones correctas sin pedirlo de nuevo
        res.json({ mensaje: 'Turno reprogramado', turno: armarDatosTurno(actualizado.data), linkWhatsApp });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al reprogramar el turno' });
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
        
        // El backend también aplica el límite: el frontend solo esconde el botón, pero alguien
        // podría llamar a la API directamente (defensa en profundidad, como en las validaciones)
        const diaBloqueado = await esDiaBloqueado(calendar, evento.start.dateTime.substring(0, 10));
        if (!sePuedeCancelar(evento, diaBloqueado)) {
            return res.status(403).json({
                error: `Los turnos se pueden cancelar online hasta ${HORAS_LIMITE_CANCELACION} h antes. Escribinos por WhatsApp.`,
            });
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



