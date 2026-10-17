'use strict';
const {MessageFlags}=require('discord.js');
const {roles,courses}=require('../config/ids');
const {db,admin}=require('./firebase');
const {administrativeLog}=require('./logs-administrativos');
const {PATENTES}=require('../utils/patentes');
const ADMINS=[roles.manutencao,roles.chefe,roles.chefeAdjunto];
const reg=(g,u)=>db.collection('guilds').doc(g).collection('registrations').doc(u);
const sanitize=s=>String(s||'').trim().replace(/[\r\n<>@]/g,'').slice(0,80);
async function handleManualRegistration(interaction){
 if(!interaction.guild||!ADMINS.some(id=>interaction.member?.roles?.cache?.has(id)))
  return interaction.reply({content:'Apenas Manutenção, Chefe e Chefe Adjunto podem usar este comando.',flags:MessageFlags.Ephemeral});
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 const user=interaction.options.getUser('usuario',true);
 const name=sanitize(interaction.options.getString('nome',true));
 const rpId=sanitize(interaction.options.getString('id',true));
 const rank=interaction.options.getString('patente',true);
 const phone=sanitize(interaction.options.getString('telefone')||'');
 if(user.bot)return interaction.editReply('Bots não podem ser cadastrados como bombeiros.');
 if(!name||!/^[A-Za-z0-9]{1,15}$/.test(rpId)||!roles[rank]||!PATENTES.includes(roles[rank]))
  return interaction.editReply('Dados inválidos. Verifique nome, ID do RP e patente.');
 const member=await interaction.guild.members.fetch(user.id).catch(()=>null);
 if(!member)return interaction.editReply('O usuário selecionado não está no servidor.');
 if(!member.roles.cache.has(roles[rank]))return interaction.editReply('A patente informada não corresponde aos cargos atuais do membro no Discord. Ajuste a seleção antes de cadastrar.');
 const currentRanks=PATENTES.filter(id=>member.roles.cache.has(id));
 if(currentRanks.length!==1)return interaction.editReply('O membro deve possuir exatamente uma patente no Discord para evitar cadastro incorreto.');
 const ref=reg(interaction.guildId,user.id);
 const earned=Object.entries(courses).filter(([,id])=>member.roles.cache.has(id)).map(([key])=>key);
 let created=false,addedCourses=0;
 try{
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref),data=snap.data()||{};
   // Course-only placeholders from /sincronizar-cursos can be completed safely.
   // Existing registrations (including dismissed/left) must not be overwritten.
   if(snap.exists&&(data.status||data.name||data.rpId||data.type))throw new Error('Este usuário já possui um cadastro no Firebase. Use Gestão de Cargos para editar ou regularizar o registro existente.');
   const old=[...(Array.isArray(data.courseCertifications)?data.courseCertifications:[]),...(Array.isArray(data.previousCourses)?data.previousCourses:[])].filter(k=>Object.hasOwn(courses,k));
   const all=[...new Set([...old,...earned])];
   addedCourses=all.length-new Set(old).size;
   const now=admin.firestore.FieldValue.serverTimestamp();
   tx.set(ref,{discordId:user.id,guildId:interaction.guildId,name,rpId,phone:phone||null,type:'importado',status:'approved',imported:true,manuallyRegistered:true,registeredBy:interaction.user.id,reviewedBy:interaction.user.id,reviewedAt:now,patentes:[rank],courseCertifications:all,createdAt:data.createdAt||now,updatedAt:now},{merge:true});
   created=!snap.exists;
  });
 }catch(error){
  if(error.message?.startsWith('Este usuário já possui'))return interaction.editReply(error.message);
  console.error('[Cadastro manual] Falha:',error);
  return interaction.editReply('Falha ao salvar cadastro no Firebase. Nenhum cargo foi alterado.');
 }
 await administrativeLog(interaction.guildId,'registration_manual',{actorId:interaction.user.id,targetId:user.id,details:{Nome:name,ID:rpId,Patente:rank,CertificacoesNovas:addedCourses,Registro:created?'novo':'completado'}});
 return interaction.editReply({content:`**Cadastro manual concluído**\nUsuário: <@${user.id}>\nNome: **${name}**\nID RP: **${rpId}**\nPatente: **${rank}**\nCursos novos registrados: **${addedCourses}**\n\nCadastro aprovado no Firebase. Nenhum cargo ou apelido foi alterado no Discord.`,allowedMentions:{parse:[]}});
}
module.exports={handleManualRegistration};
