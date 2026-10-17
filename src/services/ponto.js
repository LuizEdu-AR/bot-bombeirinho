const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { db, admin } = require('./firebase');
const { channels, roles } = require('../config/ids');
const { hasPatente } = require('../utils/patentes');
const { hasAnyRole } = require('../utils/permissions');
const { randomUUID } = require('node:crypto');
const ephemeral = MessageFlags.Ephemeral;
const now = () => Date.now();
const stamp = ms => admin.firestore.Timestamp.fromMillis(ms);
const base = (g,u) => db.collection('guilds').doc(g).collection('pontos').doc(u);
const fmt = ms => { const m=Math.floor(Math.max(0,ms)/60000); return `${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}min`; };
const commandRoles = [roles.tenente,roles.capitao,roles.chefeBatalhao,roles.chefeAdjunto,roles.chefe];
const manageRoles = [roles.capitao,roles.chefeBatalhao,roles.chefeAdjunto,roles.chefe];
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const controlId = (action,userId,sessionId) => `ponto:${action}:${userId}:${sessionId}`;
function components(d,userId) {
 if(d.status==='closed') return [];
 return [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(controlId('pause',userId,d.sessionId)).setLabel('Pausar').setStyle(ButtonStyle.Secondary).setDisabled(d.status!=='open'),
  new ButtonBuilder().setCustomId(controlId('resume',userId,d.sessionId)).setLabel('Retomar').setStyle(ButtonStyle.Primary).setDisabled(d.status!=='paused'),
  new ButtonBuilder().setCustomId(controlId('close',userId,d.sessionId)).setLabel('Encerrar').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(controlId('alert',userId,d.sessionId)).setLabel('Alertar Ponto Aberto').setStyle(ButtonStyle.Secondary)
 )];
}
// Os horários de pausas e retornos são mantidos na sessão e no documento ativo.
// Registros anteriores à atualização continuam compatíveis (histórico vazio).
const discordDate = ms => ms ? `<t:${Math.floor(ms/1000)}:F>` : 'Não registrado';
const historyEntries = d => Array.isArray(d.pauseHistory) ? d.pauseHistory : [];
function pauseHistoryText(d) {
 const entries = historyEntries(d);
 if (!entries.length) return 'Nenhuma pausa registrada.';
 const lines = entries.map((entry,i) => {
  const start = entry.startedAtMs || entry.pauseAtMs;
  const end = entry.endedAtMs || entry.resumeAtMs;
  return `**Pausa ${i+1}**\nInício: ${discordDate(start)}\nRetorno: ${end ? discordDate(end) : 'Aguardando retorno'}`;
 });
 // Limite de 1024 caracteres por campo de embed do Discord.
 const shown = [];
 let used = 0;
 for (const line of lines.slice().reverse()) {
  if (used + line.length + 2 > 920) break;
  shown.unshift(line); used += line.length + 2;
 }
 const omitted = lines.length - shown.length;
 return `${omitted ? `_${omitted} pausa(s) anterior(es) omitida(s) do painel; preservadas no banco._\n\n` : ''}${shown.join('\n\n')}`;
}
function display(d,userId) {
 const t = d.closedAtMs || now();
 const paused = (d.pausedMs || 0) + (d.status === 'paused' ? Math.max(0,t-(d.pauseStartedMs || t)) : 0);
 const worked = d.status === 'closed' && Number.isFinite(d.workedMs)
  ? d.workedMs : Math.max(0,t-d.startedAtMs-paused);
 const closed = d.status === 'closed';
 const embed = new EmbedBuilder()
  .setColor(closed ? 0x2e8b57 : d.status === 'paused' ? 0xe0a12d : 0xd92929)
  .setTitle(closed ? 'Registro de Ponto • SSFD' : 'CONTROLE DE PONTO • SSFD')
  .setDescription(closed ? 'Expediente encerrado. Resumo do registro de serviço.' : 'South State Fire Department • Controle de expediente')
  .addFields({name:'Bombeiro',value:`<@${userId}>`,inline:false});
 if (closed) {
  embed.addFields(
   {name:'Início',value:discordDate(d.startedAtMs),inline:false},
   {name:'Término',value:discordDate(d.closedAtMs),inline:false},
   {name:'Histórico de pausas e retornos',value:pauseHistoryText(d),inline:false},
   {name:'Tempo total trabalhado',value:`**${fmt(worked)}**`,inline:false},
   {name:'Tempo total em pausas',value:fmt(paused),inline:false},
   {name:'Situação',value:'Finalizado',inline:false}
  );
 } else {
  embed.addFields(
   {name:'Situação',value:d.status === 'paused' ? 'Em pausa' : 'Em andamento',inline:false},
   {name:'Entrada',value:discordDate(d.startedAtMs),inline:true},
   {name:'Tempo trabalhado',value:`**${fmt(worked)}**`,inline:true},
   {name:'Tempo em pausas',value:fmt(paused),inline:false},
   {name:'Última atividade',value:d.status === 'paused'
    ? `Pausa iniciada ${discordDate(d.pauseStartedMs)}`
    : (historyEntries(d).length && historyEntries(d).at(-1).endedAtMs
      ? `Retorno ${discordDate(historyEntries(d).at(-1).endedAtMs)}` : 'Ponto iniciado'),inline:false}
  );
 }
 if (d.fivemReviewPending) embed.addFields({name:'Revisão pendente',value:`Nova entrada no FiveM durante o expediente. ${d.fivemReentries?.length || 0} reconexão(ões) detectada(s). O tempo de desconexão não foi presumido.`,inline:false});
 embed.setFooter({text:'Bombeirinho • South State Fire Department'}).setTimestamp(t);
 return {content:`<@${userId}>`,embeds:[embed],components:components(d,userId),allowedMentions:{users:[userId]}};
}
const fmtDetailed = ms => {
 const seconds = Math.floor(Math.max(0,ms)/1000);
 const hours = Math.floor(seconds/3600);
 const minutes = Math.floor((seconds%3600)/60);
 const rest = seconds%60;
 return [hours && `${hours} hora${hours===1?'':'s'}`,minutes && `${minutes} minuto${minutes===1?'':'s'}`,`${rest} segundo${rest===1?'':'s'}`].filter(Boolean).join(', ');
};
async function log(guild,userId,label,d,actorId) {
 if(!['Aberto','Encerrado'].includes(label)) return;
 try {
  const ch=await guild.channels.fetch(channels.logPonto);
  if(!ch?.isTextBased()) return;
  const messageUrl=d.messageId && d.channelId
   ? `https://discord.com/channels/${guild.id}/${d.channelId}/${d.messageId}`
   : null;
  const isOpen=label==='Aberto';
  const workedMs=d.workedMs ?? Math.max(0,(d.closedAtMs||now())-d.startedAtMs-(d.pausedMs||0));
  const text=isOpen
   ? `O bombeiro <@${userId}> **abriu seu ponto de serviço**.`
   : `O bombeiro <@${userId}> **encerrou seu ponto de serviço**, totalizando **${fmtDetailed(workedMs)}** de trabalho.`;
  const payload={
   embeds:[new EmbedBuilder().setColor(isOpen?0x239e60:0xd92929).setDescription(text).setTimestamp()],
   allowedMentions:{parse:[]}
  };
  if(messageUrl) payload.components=[new ActionRowBuilder().addComponents(
   new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ir para a mensagem').setURL(messageUrl)
  )];
  await ch.send(payload);
 } catch(e) { console.error('[Ponto] Falha ao enviar log:',e); }
}
async function updatePublicMessage(guild,userId,d,sourceMessage) {
 const ch=await guild.channels.fetch(d.channelId || channels.baterPonto);
 if(!ch?.isTextBased()) throw new Error('Canal do ponto não encontrado.');
 const msg=sourceMessage?.id===d.messageId && sourceMessage.channelId===ch.id ? sourceMessage : await ch.messages.fetch(d.messageId);
 await msg.edit(display(d,userId));
}
async function handlePonto(interaction) {
 if(!interaction.inGuild()) return interaction.reply({content:'Use este recurso no servidor SSFD.',flags:ephemeral});
 if(interaction.isChatInputCommand()) {
  if(interaction.channelId!==channels.baterPonto) return interaction.reply({content:`Abra o ponto no canal <#${channels.baterPonto}>.`,flags:ephemeral});
  const member=await interaction.guild.members.fetch({user:interaction.user.id,force:true}).catch(()=>null);
  if(!member || (!hasPatente(member) && !hasAnyRole(member,[roles.bombeiros]))) return interaction.reply({content:'Apenas membros do SSFD podem registrar ponto.',flags:ephemeral});
  await interaction.deferReply({flags:ephemeral});
  const ref=base(interaction.guildId,interaction.user.id); let result;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref),prev=snap.exists?snap.data():null;
   if(prev && ['open','paused'].includes(prev.status)){result={already:true,data:prev};return;}
   const t=now(),sessionId=randomUUID();
   const data={status:'open',sessionId,startedAtMs:t,pausedMs:0,pauseStartedMs:null,pauseHistory:[],channelId:channels.baterPonto,messageId:null,userId:interaction.user.id,guildId:interaction.guildId};
   result={already:false,data};
   tx.set(ref,{...data,startedAt:stamp(t),updatedAt:stamp(t)});
   tx.set(ref.collection('sessions').doc(sessionId),{...data,startedAt:stamp(t)});
   tx.set(ref.collection('events').doc(),{type:'open',at:stamp(t),sessionId,actorId:interaction.user.id});
  });
  const d=result.data;
  if(result.already) return interaction.editReply({content:d.messageId?`Você já possui um ponto aberto: https://discord.com/channels/${interaction.guildId}/${d.channelId||channels.baterPonto}/${d.messageId}`:'Você já possui um ponto aberto. Se o painel não estiver disponível, solicite ajuda à administração.'});
  try {
   const ch=await interaction.guild.channels.fetch(channels.baterPonto);
   if(!ch?.isTextBased()) throw new Error('Canal Bater Ponto indisponível');
   const message=await ch.send(display(d,interaction.user.id));
   // Evita associar uma mensagem nova a outra sessão caso o estado tenha mudado.
   await db.runTransaction(async tx=>{
    const s=await tx.get(ref);
    if(!s.exists || s.data().sessionId!==d.sessionId) return;
    tx.update(ref,{messageId:message.id});
    tx.set(ref.collection('sessions').doc(d.sessionId),{messageId:message.id},{merge:true});
   });
   await log(interaction.guild,interaction.user.id,'Aberto',{...d,messageId:message.id},interaction.user.id);
   return interaction.editReply({content:`Ponto iniciado: ${message.url}`});
  } catch(e) {
   console.error('[Ponto] Falha ao publicar painel:',e);
   return interaction.editReply({content:'O ponto foi registrado, mas não consegui publicar o painel. Avise a administração antes de tentar novamente.'});
  }
 }
 if(!interaction.isButton()) return;
 const parts=interaction.customId.split(':');
 if(parts.length!==4) return interaction.reply({content:'Este botão pertence à versão antiga do sistema de ponto. Abra um novo expediente ou procure a administração.',flags:ephemeral});
 const [,action,userId,sessionId]=parts;
 if(!['pause','resume','close','alert'].includes(action)) return;
 const member=await interaction.guild.members.fetch({user:interaction.user.id,force:true}).catch(()=>null);
 if(!member) return interaction.reply({content:'Não foi possível verificar suas permissões.',flags:ephemeral});
 const isOwner=interaction.user.id===userId;
 if(action==='alert' ? !hasAnyRole(member,commandRoles) : (!isOwner && !hasAnyRole(member,manageRoles)))
  return interaction.reply({content:'Você não tem permissão para realizar esta ação neste ponto.',flags:ephemeral});
 // Reconhece o clique sem criar mensagem de confirmação no canal.
 await interaction.deferUpdate();
 const ref=base(interaction.guildId,userId); let updated,error;
 await db.runTransaction(async tx=>{
  const snap=await tx.get(ref);
  if(!snap.exists){error='Ponto não encontrado.';return;}
  const d=snap.data(),t=now();
  if(d.sessionId!==sessionId || d.messageId!==interaction.message.id || d.channelId!==interaction.channelId){error='Este painel não corresponde ao expediente atual.';return;}
  if(d.status==='closed'){error='Este ponto já foi encerrado.';return;}
  if(action==='alert') {
   if(d.lastAlertAtMs && t-d.lastAlertAtMs<ALERT_COOLDOWN_MS){error='Este ponto já recebeu um alerta recentemente. Aguarde 15 minutos.';return;}
   updated={...d,lastAlertAtMs:t};
   tx.update(ref,{lastAlertAtMs:t});
   tx.set(ref.collection('sessions').doc(sessionId),{lastAlertAtMs:t},{merge:true});
  } else {
   if(action==='pause' && d.status!=='open'){error='O ponto já está pausado.';return;}
   if(action==='resume' && d.status!=='paused'){error='O ponto não está pausado.';return;}
   const pausedMs=(d.pausedMs||0)+(d.status==='paused'?Math.max(0,t-(d.pauseStartedMs||t)):0);
   const pauseHistory = historyEntries(d).map(entry => ({...entry}));
   if(action==='pause') pauseHistory.push({startedAtMs:t,endedAtMs:null});
   if(d.status==='paused' && action!=='pause') {
    const last=pauseHistory.at(-1);
    if(last && !last.endedAtMs) last.endedAtMs=t;
    else if(d.pauseStartedMs) pauseHistory.push({startedAtMs:d.pauseStartedMs,endedAtMs:t});
   }
   updated={...d,status:action==='pause'?'paused':action==='resume'?'open':'closed',pausedMs:action==='pause'?(d.pausedMs||0):pausedMs,pauseStartedMs:action==='pause'?t:null,pauseHistory,updatedAtMs:t};
   if(action==='close'){updated.closedAtMs=t;updated.workedMs=Math.max(0,t-d.startedAtMs-updated.pausedMs);}
   tx.update(ref,updated);
   tx.set(ref.collection('sessions').doc(sessionId),updated,{merge:true});
  }
  tx.set(ref.collection('events').doc(),{type:action,at:stamp(t),sessionId,actorId:interaction.user.id,targetUserId:userId});
 });
 if(error) return interaction.followUp({content:error,flags:ephemeral});
 if(action==='alert') {
  try {
   await interaction.channel.send({content:`<@${userId}>, seu ponto continua aberto. Alerta enviado por <@${interaction.user.id}>.`,allowedMentions:{users:[userId]}});
   return;
  } catch(e) {console.error('[Ponto] Erro ao enviar alerta:',e);return interaction.followUp({content:'Alerta registrado, mas não foi possível publicar a notificação.',flags:ephemeral});}
 }
 try {
  await updatePublicMessage(interaction.guild,userId,updated,interaction.message);
 } catch(e) {
  console.error('[Ponto] Falha ao atualizar mensagem pública:',e);
  return interaction.followUp({content:'O ponto foi atualizado, mas não foi possível atualizar o painel. Avise a administração.',flags:ephemeral});
 }
 const label={pause:'Pausado',resume:'Retomado',close:'Encerrado'}[action];
 if(action==='close') await log(interaction.guild,userId,label,updated,interaction.user.id);
 return;
}
module.exports={handlePonto,display,log,updatePublicMessage,base,stamp};
