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

    // Horario de atención (igual todos los días, por ahora).
    horario: { apertura: '09:00', cierre: '18:00' },

    // Cada cuántos minutos se ofrece un turno (09:00, 09:30, 10:00...).
    intervaloMinutos: 30,

    // Minutos libres que dejo después de cada turno antes del siguiente (limpiar, acomodar).
    margenEntreTurnosMinutos: 15,

    // Cada cuántos días y hasta cuántos días adelante se puede reservar.
    //minimaDias: 1 = desde mañana (Santi necesita aviso); 0 = permite el mismo día.
    anticipacion: { minimaDias: 1, maximaDias: 60 }, 
};

module.exports = negocio;