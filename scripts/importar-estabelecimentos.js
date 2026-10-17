'use strict';
// Prévia: node scripts/importar-estabelecimentos.js --preview
// Aplicação: node scripts/importar-estabelecimentos.js --aplicar --confirmar=37
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { db, admin } = require('../src/services/firebase');
const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const confirmation = args.includes('--confirmar=37');
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname,'estabelecimentos_aprovados.json'),'utf8'));
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const digits = value => String(value ?? '').replace(/\D/g,'');
const sameCnpj = (a,b) => digits(a).length === 14 && digits(a) === digits(b);
const legacyDocId = id => 'import-' + id;
function validate(){
  if (dataset.schemaVersion !== 1 || dataset.guildId !== '1318928108601999392' || !Array.isArray(dataset.records) || dataset.records.length !== 37) throw Error('Arquivo de dados inesperado.');
  const ids = new Set(), names = new Set(), cnpjs = new Set();
  for(const r of dataset.records){
    if(!/^legacy-juridico-\d{3}$/.test(r.legacyId||'') || ids.has(r.legacyId)) throw Error('ID de origem inválido/duplicado: '+r.legacyId);
    ids.add(r.legacyId);
    if(!r.name || !r.type || !r.ownerName || !r.ownerId || !['Norte','Sul'].includes(r.location) || !Array.isArray(r.socios) || r.socios.length>15) throw Error('Dados obrigatórios inválidos: '+r.legacyId);
    const name=normalize(r.name);
    if(names.has(name)) throw Error('Nome repetido no arquivo: '+r.name);
    names.add(name);
    if(r.cnpj){const c=digits(r.cnpj);if(c.length!==14) throw Error('CNPJ malformado: '+r.name);if(cnpjs.has(c)) throw Error('CNPJ repetido no arquivo: '+r.name);cnpjs.add(c);}
    for(const s of r.socios) if(!s.name || !s.rpId || !s.phone) throw Error('Sócio incompleto: '+r.name);
  }
}
function compare(e,r){
  const name = normalize(e.name) === normalize(r.name);
  const cnpj = sameCnpj(e.cnpj,r.cnpj);
  const legacy = e.importSource?.legacyId === r.legacyId && e.importSource?.kind === 'juridico_csv_aprovado';
  return {name,cnpj,legacy};
}
async function main(){
  validate();
  const col=db.collection('guilds').doc(dataset.guildId).collection('establishments');
  const snapshot=await col.get();
  const existing=snapshot.docs.map(d=>({id:d.id,...d.data()}));
  const plans=dataset.records.map(r=>{
    const hits=existing.filter(e=>{const m=compare(e,r);return m.name||m.cnpj||m.legacy||e.id===legacyDocId(r.legacyId);});
    const exactImported=hits.length===1 && hits[0].id===legacyDocId(r.legacyId) && hits[0].importSource?.legacyId===r.legacyId;
    return {r,action:hits.length?(exactImported?'IGNORAR':'REVISAR'):'CRIAR',hits};
  });
  for(const p of plans){
    const note=p.hits.map(e=>`${e.name} [${e.id}]`).join('; ');
    console.log(`${p.action.padEnd(8)} ${p.r.name} (${p.r.location})${note?' => '+note:''}`);
  }
  const count=a=>plans.filter(p=>p.action===a).length;
  console.log(`\nResumo: ${count('CRIAR')} criar, ${count('IGNORAR')} ignorar, ${count('REVISAR')} revisar. ${existing.length} registros já existentes.`);
  if(!apply){console.log('PRÉVIA: nenhuma gravação realizada.');return;}
  if(!confirmation) throw Error('Confirmação ausente: use --confirmar=37.');
  if(count('REVISAR')) throw Error('Importação bloqueada: existem conflitos a revisar.');
  // Revalida a coleção imediatamente antes de gravar; se mudou, interrompe.
  const current=await col.get();
  if(current.docs.length!==snapshot.docs.length || current.docs.some(d=>!snapshot.docs.find(x=>x.id===d.id && x.updateTime?.isEqual(d.updateTime)))) throw Error('Banco mudou desde a leitura inicial. Execute nova prévia.');
  let created=0;
  for(const p of plans){
    if(p.action!=='CRIAR') continue;
    const r=p.r, ref=col.doc(legacyDocId(r.legacyId));
    await db.runTransaction(async tx=>{
      const old=await tx.get(ref);
      if(old.exists) throw Error('ID já ocupado: '+ref.id);
      tx.create(ref,{
        name:r.name,type:r.type,location:r.location,cnpj:r.cnpj||'',ownerName:r.ownerName,ownerId:r.ownerId,ownerPhone:r.ownerPhone||'',socios:r.socios,
        active:true,importSource:{kind:'juridico_csv_aprovado',legacyId:r.legacyId},
        createdBy:'importacao-administrativa',updatedBy:'importacao-administrativa',
        createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });
    created++;
    console.log('CRIADO:',r.name);
  }
  console.log(`Concluído: ${created} criados. ${count('IGNORAR')} já importados. Registros preexistentes preservados.`);
}
main().catch(err=>{console.error('IMPORTAÇÃO INTERROMPIDA:',err.message);process.exitCode=1;});
