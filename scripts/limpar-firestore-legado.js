'use strict';
/**
 * Limpeza controlada da estrutura LEGADA do Bombeirinho SSFD.
 * Por padrão: somente leitura. --delete exige confirmação explícita e backup externo.
 * Exclui APENAS guilds/1318928108601999392 e suas subcoleções, nunca coleções na raiz.
 */
require('dotenv').config();
const { db, SSFD_GUILD_ID } = require('../src/services/firebase');
const { isDeepStrictEqual } = require('node:util');

const source = db.collection('guilds').doc(SSFD_GUILD_ID);
const deleting = process.argv.includes('--delete');
const stats = { collections: 0, sourceDocuments: 0, missingAtRoot: 0, differingAtRoot: 0 };
const examples = { missing: [], differing: [] };

async function inspectCollection(oldCollection, newCollection) {
    stats.collections++;
    // listDocuments também retorna documentos ancestrais sem conteúdo que têm subcoleções.
    const refs = await oldCollection.listDocuments();
    for (const oldRef of refs) {
        const oldSnap = await oldRef.get();
        const newRef = newCollection.doc(oldRef.id);
        if (oldSnap.exists) {
            stats.sourceDocuments++;
            const newSnap = await newRef.get();
            if (!newSnap.exists) {
                stats.missingAtRoot++;
                if (examples.missing.length < 10) examples.missing.push(newRef.path);
            } else if (!isDeepStrictEqual(oldSnap.data(), newSnap.data())) {
                // Dados podem ter evoluído na raiz desde a migração; nunca os sobrescrevemos.
                stats.differingAtRoot++;
                if (examples.differing.length < 10) examples.differing.push(newRef.path);
            }
        }
        const nested = await oldRef.listCollections();
        for (const sub of nested) {
            await inspectCollection(sub, newRef.collection(sub.id));
        }
    }
}

(async () => {
    if (SSFD_GUILD_ID !== '1318928108601999392') throw new Error('ID SSFD inesperado.');
    if (source.path !== 'guilds/1318928108601999392') throw new Error('Caminho de origem inesperado.');
    const collections = await source.listCollections();
    if (!collections.length) throw new Error('Nenhuma subcoleção legada encontrada; limpeza não necessária.');
    for (const col of collections) await inspectCollection(col, db.collection(col.id));
    console.log('[SSFD] Pré-verificação da limpeza:', stats);
    if (examples.missing.length) console.error('[SSFD] Exemplos AUSENTES:', examples.missing);
    if (examples.differing.length) console.warn('[SSFD] Exemplos ALTERADOS na raiz:', examples.differing);
    if (stats.missingAtRoot) throw new Error('Há documentos ausentes na raiz. Limpeza BLOQUEADA.');
    if (stats.sourceDocuments === 0) throw new Error('Nenhum documento legado encontrado. Limpeza BLOQUEADA.');
    if (!deleting) {
        console.log('[SSFD] SIMULAÇÃO CONCLUÍDA. Nada foi excluído.');
        console.log('[SSFD] Diferenças são esperadas após uso do bot, mas revise antes de excluir.');
        return;
    }
    const expected = `EXCLUIR-${SSFD_GUILD_ID}`;
    if (process.env.SSFD_DELETE_CONFIRM !== expected)
        throw new Error(`Confirmação ausente. Defina SSFD_DELETE_CONFIRM=${expected}`);
    if (process.env.SSFD_BACKUP_CONFIRMED !== 'SIM')
        throw new Error('Backup externo recuperável não confirmado: SSFD_BACKUP_CONFIRMED=SIM.');
    if (process.env.SSFD_BOT_STOPPED !== 'SIM')
        throw new Error('Bot parado não confirmado: SSFD_BOT_STOPPED=SIM.');
    if (stats.differingAtRoot)
        console.warn(`[SSFD] ${stats.differingAtRoot} documentos diferem da origem (possíveis atualizações posteriores).`);
    console.log(`[SSFD] Excluindo recursivamente SOMENTE ${source.path}...`);
    await db.recursiveDelete(source);
    const remaining = await source.listCollections();
    if (remaining.length) throw new Error(`Ainda existem ${remaining.length} subcoleções na origem.`);
    console.log('[SSFD] Limpeza concluída. As coleções na raiz foram preservadas.');
})().catch(err => { console.error('[SSFD] FALHA:', err.message); process.exitCode = 1; });
