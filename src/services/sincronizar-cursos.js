'use strict';
const {MessageFlags}=require('discord.js');
const {roles,courses}=require('../config/ids');
const {db,admin}=require('./firebase');
const {administrativeLog}=require('./logs-administrativos');

const reg=(guildId,userId)=>db.collection('guilds').doc(guildId).collection('registrations').doc(userId);
const courseKeys=Object.keys(courses);
const normalize=(value)=>Array.isArray(value)?value.filter(key=>courseKeys.includes(key)):[];

async function handleSyncCourses(interaction){
 if(!interaction.guild||![roles.manutencao,roles.chefe,roles.chefeAdjunto].some(role=>interaction.member?.roles?.cache?.has(role))){
  return interaction.reply({content:'Apenas Manutenção, Chefe e Chefe Adjunto podem usar este comando.',flags:MessageFlags.Ephemeral});
 }
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 let members;
 try{members=await interaction.guild.members.fetch();}
 catch(error){console.error('[Cursos] Falha ao listar membros:',error);return interaction.editReply('Não foi possível consultar os membros do servidor. Verifique o acesso a membros do bot.');}
 const people=[...members.values()].filter(member=>!member.user.bot);
 const candidates=people.map(member=>({member,keys:courseKeys.filter(key=>member.roles.cache.has(courses[key]))})).filter(entry=>entry.keys.length);
 let updated=0,added=0,unchanged=0,failed=0,created=0;
 const errors=[];
 for(const {member,keys} of candidates){
  try{
   const result=await db.runTransaction(async transaction=>{
    const doc=reg(interaction.guildId,member.id);
    const snapshot=await transaction.get(doc);
    const data=snapshot.data()||{};
    const existing=normalize(data.courseCertifications);
    const previous=normalize(data.previousCourses);
    const union=[...new Set([...existing,...previous,...keys])];
    const newlyAdded=keys.filter(key=>!existing.includes(key)&&!previous.includes(key));
    // Preserve previousCourses and all unrelated registration fields.
    if(!snapshot.exists||union.length!==existing.length){
     transaction.set(doc,{courseCertifications:union,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
     return {changed:true,added:newlyAdded.length,created:!snapshot.exists};
    }
    return {changed:false,added:0,created:false};
   });
   if(result.changed){updated++;added+=result.added;if(result.created)created++;}
   else unchanged++;
  }catch(error){failed++;errors.push(member.id);console.error(`[Cursos] Erro ao sincronizar ${member.id}:`,error);}
 }
 try{
  await administrativeLog(interaction.guildId,'courses_synchronized',{actorId:interaction.user.id,details:{membersScanned:people.length,membersWithCourses:candidates.length,registrationsUpdated:updated,certificationsAdded:added,registrationsCreated:created,unchanged,failed}});
 }catch(error){console.error('[Cursos] Falha ao registrar log administrativo:',error);}
 const report=[
  '**Sincronização de cursos concluída**',
  `Membros analisados: **${people.length}**`,
  `Membros com cargos de cursos: **${candidates.length}**`,
  `Cadastros atualizados: **${updated}**`,
  `Certificações novas: **${added}**`,
  `Cadastros de cursos criados: **${created}**`,
  `Sem alterações: **${unchanged}**`,
  `Falhas: **${failed}**`,
  '',
  'Nenhum cargo foi alterado no Discord. Certificações anteriores e demais dados foram preservados.'
 ];
 if(errors.length)report.push(`IDs Discord com erro: ${errors.slice(0,12).join(', ')}${errors.length>12?' ...':''}`);
 return interaction.editReply({content:report.join('\n')});
}
module.exports={handleSyncCourses};
