const admin = require('firebase-admin');
const path = require('node:path');
const fs = require('node:fs');
const file = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
let credential;
if (file) {
    const absolute = path.resolve(process.cwd(), file);
    if (!fs.existsSync(absolute))
        throw new Error(`Credencial Firebase não encontrada: ${absolute}`);
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(absolute, 'utf8')));
}
else
    credential = admin.credential.applicationDefault();
if (!admin.apps.length)
    admin.initializeApp({ credential });
module.exports = { db: admin.firestore(), admin };

// Banco dedicado exclusivamente ao servidor oficial SSFD.
const SSFD_GUILD_ID = '1318928108601999392';
function guildCollection(guildId, name) {
    if (String(guildId) !== SSFD_GUILD_ID)
        throw new Error(`Servidor Discord não autorizado: ${guildId}`);
    return admin.firestore().collection(name);
}
module.exports.guildCollection = guildCollection;
module.exports.SSFD_GUILD_ID = SSFD_GUILD_ID;
