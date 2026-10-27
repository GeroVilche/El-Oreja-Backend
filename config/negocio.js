// todo lo que define al negocio está acá. Si adapto el sistema a otro negocio
// (peluquería, veterinaria...), cambio este archivo y nada más.
// Ojo: el frontend también lee estos datos (ruta GET /configuracion), así que
// nada de lo que ponga acá puede ser secreto. Los secretos van en el .env.

const negocio = {
    zonaHoraria: 'America/Argentina/Buenos_Aires',

    //Cada servicio con su duración en minutos. El nombre es el que se ve en el
    // formulario y el que se guarda en el evento del Calendar.
    servicios: [
        { nombre: 'Lavado de Mantenimiento', duracion: 45 },
        { nombre: 'Lavado Completo', duracion: 90 },
        { nombre: 'Detailing a Fondo', duracion: 180 },
    ],

    vehiculos: ['Auto', 'Camioneta / SUV', 'Moto'],

    // Horario de atención de cada día, en franjas:
    //  - horario corrido: una franja      -> [{ apertura: '09:00', cierre: '18:00' }]
    //  - horario cortado: varias franjas  -> [{ apertura: '09:00', cierre: '13:00' }, { apertura: '16:00', cierre: '20:00' }]
    //  - cerrado: ninguna franja          -> []
    // Ojo: las franjas de un día van en orden y sin pisarse.
    // Los feriados no van acá: se bloquean con un evento de "todo el día" en el Google Calendar.
    horarios: {
        lunes:     [{ apertura: '09:00', cierre: '18:00' }],
        martes:    [{ apertura: '09:00', cierre: '18:00' }],
        miercoles: [{ apertura: '09:00', cierre: '18:00' }],
        jueves:    [{ apertura: '09:00', cierre: '18:00' }],
        viernes:   [{ apertura: '09:00', cierre: '18:00' }],
        sabado:    [{ apertura: '09:00', cierre: '13:00' }],
        domingo:   [],
    },

    // Cada cuántos minutos se ofrece un turno (09:00, 09:30, 10:00...).
    intervaloMinutos: 30,

    // Minutos libres que dejo después de cada turno antes del siguiente (limpiar, acomodar).
    margenEntreTurnosMinutos: 15,

    // Cada cuántos días y hasta cuántos días adelante se puede reservar.
    //minimaDias: 1 = desde mañana (Santi necesita aviso); 0 = permite el mismo día.
    anticipacion: { minimaDias: 1, maximaDias: 60 }, 

    // Hasta cuántas horas antes del turno el cliente lo puede cancelar desde su link.
    // Pasado ese límite, el link le ofrece escribirle al negocio por WhatsApp.
    // Ojo: es solo para el link del cliente; Santi siempre puede mover o borrar turnos desde el Calendar.
    cancelacion: { horasLimite: 24 },

    // Cuántas veces el cliente puede reprogramar su turno desde el link (con el mismo límite de horas
    // que cancelar). Pasado el máximo, solo puede cancelarlo y reservar uno nuevo. 0 = no se puede reprogramar.
    // Ojo: los cambios que hace Santi desde el Calendar no cuentan (el contador solo suma desde la web).
    reprogramacion: { maximo: 1 },
};

module.exports = negocio;