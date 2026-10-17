const admin = require('firebase-admin');
const path = require('node:path');
const fs = require('node:fs');
const file = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
let credential;
if (file) {
 const absolute = path.resolve(process.cwd(), file);
 if (!fs.existsSync(absolute)) throw new Error(`Credencial Firebase não encontrada: ${absolute}`);
 credential = admin.credential.cert(JSON.parse(fs.readFileSync(absolute, 'utf8')));
} else credential = admin.credential.applicationDefault();
if (!admin.apps.length) admin.initializeApp({ credential });
module.exports = { db: admin.firestore(), admin };
