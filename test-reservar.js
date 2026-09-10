const { servicedirectory } = require("googleapis/build/src/apis/servicedirectory");

async function probarReserva() {
    const respuesta = await fetch('http://localhost:3000/turnos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fecha: '2026-09-15',
            horaInicio: '12:00',
            servicio: 'Lavado de Mantenimiento',
            clienteNombre: 'Cliente de Prueba',
            clienteTelefono: '2494123456',
        }),
    });

    const datos = await respuesta.json();
    console.log('Status:', respuesta.status);
    console.log(datos);
}

probarReserva();