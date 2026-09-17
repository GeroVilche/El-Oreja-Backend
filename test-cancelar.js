async function probarCancelacion() {
     const id = 'pa5cv6sgk1ckgl9ppv9mlguroo'; // reelmplazá por un id real

     const respuesta = await fetch(`http://localhost:3000/turnos/${id}`, {
        method: 'DELETE',
     });

     const datos = await respuesta.json();
     console.log('Status:', respuesta.status);
     console.log(datos);
}

probarCancelacion();