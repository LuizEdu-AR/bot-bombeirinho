'use strict';
/**
 * Migração NÃO destrutiva de guilds/{SSFD_ID}/{colecao}/... para /{colecao}/...
 * Execute com bot parado e backup/export do Firestore já realizado.
 * Padrão: preflight somente leitura. --copy copia; --verify confere conteúdo.
 * Não apaga a origem, não sobrescreve destinos existentes.
 */
require('dotenv').config();
const { db, SSFD_GUILD_ID } = require('../src/services/firebase');
const { isDeepStrictEqual } = require('node:util');
const mode = process.argv.includes('--copy') ? 'copy' : process.argv.includes('--verify') ? 'verify' : 'preflight';
const source = db.collection('guilds').doc(SSFD_GUILD_ID);
const stats = { collections: 0, documents: 0, written: 0, verified: 0, conflicts: 0 };

async function walkCollection(from, to) {
    stats.collections++;
    const snapshot = await from.get();
    for (const doc of snapshot.docs) {
        const target = to.doc(doc.id);
        const existing = await target.get();
        const data = doc.data();
        stats.documents++;
        if (existing.exists && !isDeepStrictEqual(existing.data(), data)) {
            stats.conflicts++;
            throw new Error(`CONFLITO: ${target.path} já existe com dados diferentes. Nenhum documento será sobrescrito.`);
        }
        if (mode === 'verify' && !existing.exists)
            throw new Error(`AUSENTE: ${target.path}`);
        if (mode === 'copy' && !existing.exists) {
            await target.create(data);
            stats.written++;
        }
        if (mode === 'verify') stats.verified++;
        const nested = await doc.ref.listCollections();
        for (const collection of nested)
            await walkCollection(collection, target.collection(collection.id));
    }
    // Inclui documentos ancestrais inexistentes com subcoleções: listDocuments()
    // também lista referências sem documento, que get() pode não retornar.
    const refs = await from.listDocuments();
    for (const ref of refs) {
        if (snapshot.docs.some(doc => doc.id === ref.id)) continue;
        const nested = await ref.listCollections();
        for (const collection of nested)
            await walkCollection(collection, to.doc(ref.id).collection(collection.id));
    }
}

(async () => {
    if (mode === 'copy' && process.env.SSFD_MIGRATION_CONFIRM !== SSFD_GUILD_ID)
        throw new Error(`Para copiar, defina SSFD_MIGRATION_CONFIRM=${SSFD_GUILD_ID} no ambiente.`);
    const collections = await source.listCollections();
    if (!collections.length) throw new Error('Nenhuma coleção de origem encontrada. Verifique o projeto e o ID do servidor.');
    console.log(`[SSFD] Modo: ${mode}; origem: ${source.path}; coleções: ${collections.length}`);
    for (const collection of collections) {
        console.log(`[SSFD] ${collection.id}`);
        await walkCollection(collection, db.collection(collection.id));
    }
    console.log('[SSFD] Resultado:', stats);
    if (mode === 'preflight') console.log('Somente leitura. Para copiar, use --copy após backup e parada do bot.');
    if (mode === 'copy') console.log('Cópia concluída. Execute --verify ANTES de iniciar o bot atualizado. Origem preservada.');
})().catch(error => { console.error('[SSFD] Migração interrompida:', error); process.exitCode = 1; });
