'use strict';
const { MessageFlags } = require('discord.js');
const { db } = require('./firebase');
const { channels, roles } = require('../config/ids');
const { hasAnyRole } = require('../utils/permissions');
const { handleFiveMLog, parseLog, messageText } = require('./ponto-fivem');
const allowed=[roles.manutencao,roles.chefe,roles.chefeAdjunto,roles.chefeBatalhao];
const MAX_MESSAGES=500;
const MAX_EVENTS=200;
const MAX_HOURS=24;
const locks=new Set();

async function scan(channel, hours) {
 const cutoff=Date.now()-hours*3600000;
 let before, fetched=0, reachedEnd=false;
 const events=[];
 while(fetched<MAX_MESSAGES && !reachedEnd) {
  const batch=await channel.messages.fetch({limit:Math.min(100,MAX_MESSAGES-fetched),...(before?{before}:{})});
  if(!batch.size) break;
  fetched+=batch.size;
  for(const msg of batch.values()) {
   if(msg.createdTimestamp<cutoff) {reachedEnd=true;continue;}
   if(!msg.author?.bot) continue;
   const event=parseLog(messageText(msg));
   if(event && event.atMs>=cutoff && event.atMs<=Date.now()+120000) events.push({msg,event});
  }
  before=batch.last().id;
  if(batch.size<100) break;
 }
 events.sort((a,b)=>a.event.atMs-b.event.atMs || a.msg.createdTimestamp-b.msg.createdTimestamp);
 const unique=[];const seen=new Set();
 for(const e of events) if(!seen.has(e.event.uuid)) {seen.add(e.event.uuid);unique.push(e);}
 return {events:unique.slice(0,MAX_EVENTS),fetched,limited:unique.length>MAX_EVENTS || fetched===MAX_MESSAGES};
}
async function handleRecoverLogs(interaction) {
 const member=interaction.inGuild()?await interaction.guild.members.fetch({user:interaction.user.id,force:true}).catch(()=>null):null;
 if(!member || !hasAnyRole(member,allowed))
  return interaction.reply({content:'Somente Manutenção, Chefe de Batalhão, Chefe Adjunto e Chefe podem recuperar logs.',flags:MessageFlags.Ephemeral});
 const hours=interaction.options.getInteger('horas')||6;
 const apply=interaction.options.getBoolean('aplicar')===true;
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 const key=interaction.guildId;
 if(locks.has(key)) return interaction.editReply('Já existe uma recuperação em andamento. Aguarde a conclusão.');
 locks.add(key);
 try {
  const channel=await interaction.guild.channels.fetch(channels.logsPontoCidade);
  if(!channel?.isTextBased()) return interaction.editReply('Canal de logs do FiveM indisponível.');
  const {events,fetched,limited}=await scan(channel,hours);
  const collection=db.collection('guilds').doc(key).collection('fivemPontoEvents');
  let processed=0, pending=0, conflicts=0, unresolved=0, failed=0;
  // Prévia: apenas consulta UUIDs existentes; nenhuma alteração no Firebase.
  for(let offset=0;offset<events.length;offset+=50) {
   const slice=events.slice(offset,offset+50);
   const docs=await db.getAll(...slice.map(e=>collection.doc(e.event.uuid)));
   for(let i=0;i<slice.length;i++) {
    if(docs[i].exists){processed++;continue;}
    if(!apply){pending++;continue;}
    try {
     const result=await handleFiveMLog(slice[i].msg,{recovery:true});
     if(['opened','closed','resumed','reentry'].includes(result?.kind)) pending++;
     else if(result?.kind==='unresolved') unresolved++;
     else conflicts++;
    } catch(err) {failed++;console.error('[FiveM] Erro na recuperação:',err);}
   }
  }
  const lines=[apply?'**Recuperação de logs concluída**':'**Prévia da recuperação de logs**',
   `Período consultado: últimas ${hours} hora(s)`,
   `Mensagens consultadas: ${fetched}`,
   `Eventos válidos encontrados: ${events.length}`,
   `Eventos já processados: ${processed}`,
   apply?`Eventos aplicados: ${pending}`:`Eventos ainda não registrados: ${pending}`];
  if(apply) lines.push(`Conflitos/ignorados: ${conflicts}`,`Usuários não identificados: ${unresolved}`,`Falhas: ${failed}`);
  if(limited) lines.push('**Limite de consulta atingido:** o resultado pode não incluir todos os eventos do período.');
  if(!apply) lines.push('\nEsta é apenas uma prévia por UUID; alguns eventos pendentes podem apresentar conflitos de horário ou de sessão. Para executar, repita o comando com **aplicar: Sim**.');
  else lines.push('\nSessões encerradas não são reabertas ou alteradas retroativamente. Conflitos devem ser avaliados pela administração.');
  return interaction.editReply({content:lines.join('\n')});
 } finally {locks.delete(key);}
}
module.exports={handleRecoverLogs};
