const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/calendar'],
});

async function probarConexion() {
    const authClient = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const respuesta = await calendar.events.list({
        calendarId: 'geroov49@gmail.com',
        timeMin: new Date().toISOString(),
        maxResult: 5,
        singleEvents: true,
        orderBy: 'startTime',
    });

    console.log('Proximos eventos encontrados:');
    console.log(respuesta.data.items);
}

probarConexion();