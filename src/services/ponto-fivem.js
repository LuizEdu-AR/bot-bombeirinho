'use strict';
const { randomUUID } = require('node:crypto');
const { db, admin } = require('./firebase');
const { channels, roles } = require('../config/ids');
const { parseId } = require('./sincronizar-ids');
const { display, log, updatePublicMessage, base, stamp } = require('./ponto');

// Apenas eventos novos; nunca varrer mensagens antigas do canal automaticamente.
const MAX_EVENT_AGE_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const TZ_OFFSET_MINUTES = Number(process.env.FIVEM_LOG_UTC_OFFSET_MINUTES ?? -180);
const approved = d => d && ['approved', 'importado'].includes(d.status);

function messageText(message) {
 const pieces = [message.content || ''];
 for (const embed of message.embeds || []) {
  pieces.push(embed.title || '', embed.description || '', embed.footer?.text || '');
  for (const field of embed.fields || []) pieces.push(field.name || '', field.value || '');
 }
 return pieces.join('\n').replace(/```[\w-]*\n?/g, '\n').replace(/```/g, '\n').replace(/`/g, '');
}
function parseLog(text) {
 const idLine = text.match(/\[ID\]\s*:\s*(\d{1,15})\s+([^\r\n]+?)\s*\(\s*(ENTROU\s+EM|SAIU\s+DE)\s+SERVI[CÇ]O\s*-\s*Bombeiros\s*\)/i);
 const date = text.match(/\[DATA\]\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s*,\s*(\d{2}):(\d{2}):(\d{2})/i);
 const uuid = text.match(/\[UUID\]\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
 if (!idLine || !date || !uuid) return null;
 const [,day,month,year,hour,minute,second] = date;
 const ms = Date.UTC(+year,+month-1,+day,+hour,+minute,+second) - TZ_OFFSET_MINUTES*60000;
 const check = new Date(ms + TZ_OFFSET_MINUTES*60000);
 if (check.getUTCFullYear()!==+year || check.getUTCMonth()!==+month-1 || check.getUTCDate()!==+day || check.getUTCHours()!==+hour || check.getUTCMinutes()!==+minute || check.getUTCSeconds()!==+second) return null;
 return {rpId:idLine[1],name:idLine[2].trim(),action:idLine[3].toUpperCase().startsWith('ENTROU')?'open':'close',atMs:ms,uuid:uuid[1].toLowerCase()};
}
async function resolveUser(guild,rpId) {
 const registrations = db.collection('guilds').doc(guild.id).collection('registrations');
 const found = new Set();
 // Fonte principal: ID confirmado no cadastro, sem depender do nome.
 const exact = await registrations.where('rpId','==',rpId).get();
 for (const snap of exact.docs) if (approved(snap.data())) found.add(snap.id);
 // Cadastros antigos podem ter ID no nickname e ainda não ter rpId no Firebase.
 const members = await guild.members.fetch();
 const candidates = [...members.values()].filter(m => !m.user.bot && parseId(m.nickname, m.roles.cache.has(roles.staff))===rpId);
 if (candidates.length) {
  const snaps = await db.getAll(...candidates.map(m=>registrations.doc(m.id)));
  snaps.forEach((snap,i)=>{if(snap.exists && approved(snap.data())) found.add(candidates[i].id);});
 }
 if(found.size!==1) {
  console.warn(`[FiveM] ID ${rpId}: ${found.size} cadastros aprovados identificados; evento ignorado.`);
  return null;
 }
 const userId=[...found][0];
 const member=members.get(userId);
 if(!member || member.user.bot) return null;
 return userId;
}
async function handleFiveMLog(message) {
 if (!message.guild || message.channelId!==channels.logsPontoCidade || !message.author?.bot) return;
 const event=parseLog(messageText(message));
 if (!event) return;
 const age=Date.now()-event.atMs;
 if (age>MAX_EVENT_AGE_MS || age < -FUTURE_TOLERANCE_MS) {
  console.warn(`[FiveM] Evento fora da janela de tempo: ${event.uuid}`); return;
 }
 const userId=await resolveUser(message.guild,event.rpId);
 if(!userId) return;
 const ref=base(message.guild.id,userId);
 const eventRef=db.collection('guilds').doc(message.guild.id).collection('fivemPontoEvents').doc(event.uuid);
 let result=null;
 await db.runTransaction(async tx=>{
  const [seen,snap]=await Promise.all([tx.get(eventRef),tx.get(ref)]);
  if(seen.exists) return;
  const old=snap.exists?snap.data():null;
  // O UUID identifica o evento, não a sessão. Registre também eventos ignorados.
  const audit={rpId:event.rpId,name:event.name,action:event.action,atMs:event.atMs,userId,sourceMessageId:message.id,processedAt:admin.firestore.FieldValue.serverTimestamp()};
  if(event.action==='open') {
   if(old && ['open','paused'].includes(old.status)) {
    if(event.atMs<old.startedAtMs) {tx.create(eventRef,{...audit,result:'out_of_order'});return;}
    const reentries=[...(old.fivemReentries||[]),{atMs:event.atMs,uuid:event.uuid}];
    const changes={fivemReentries:reentries,fivemReviewPending:true,updatedAtMs:Date.now()};
    tx.update(ref,changes);
    tx.set(ref.collection('sessions').doc(old.sessionId),changes,{merge:true});
    tx.set(ref.collection('events').doc(event.uuid),{type:'fivem_reentry',at:stamp(event.atMs),sessionId:old.sessionId,sourceUuid:event.uuid,reviewRequired:true});
    tx.create(eventRef,{...audit,result:'reentry'});
    result={kind:'reentry',data:{...old,...changes}};return;
   }
   if(old && old.status==='closed' && event.atMs <= (old.closedAtMs||0)) {tx.create(eventRef,{...audit,result:'out_of_order'});return;}
   const sessionId=randomUUID();
   const d={status:'open',sessionId,startedAtMs:event.atMs,pausedMs:0,pauseStartedMs:null,pauseHistory:[],channelId:channels.baterPonto,messageId:null,userId,guildId:message.guild.id,source:'fivem',fivemReviewPending:false,fivemReentries:[]};
   tx.set(ref,{...d,startedAt:stamp(event.atMs),updatedAt:stamp(Date.now())});
   tx.set(ref.collection('sessions').doc(sessionId),{...d,startedAt:stamp(event.atMs)});
   tx.set(ref.collection('events').doc(event.uuid),{type:'open',at:stamp(event.atMs),sessionId,source:'fivem'});
   tx.create(eventRef,{...audit,result:'opened',sessionId});
   result={kind:'opened',data:d};return;
  }
  if(!old || !['open','paused'].includes(old.status) || event.atMs<old.startedAtMs) {
   tx.create(eventRef,{...audit,result:'no_matching_open_point'});return;
  }
  const pauseHistory=Array.isArray(old.pauseHistory)?old.pauseHistory.map(x=>({...x})):[];
  const pausedMs=(old.pausedMs||0)+(old.status==='paused'?Math.max(0,event.atMs-(old.pauseStartedMs||event.atMs)):0);
  if(old.status==='paused') {
   const last=pauseHistory.at(-1);
   if(last && !last.endedAtMs) last.endedAtMs=event.atMs;
   else if(old.pauseStartedMs) pauseHistory.push({startedAtMs:old.pauseStartedMs,endedAtMs:event.atMs});
  }
  const changes={status:'closed',closedAtMs:event.atMs,pausedMs,pauseStartedMs:null,pauseHistory,workedMs:Math.max(0,event.atMs-old.startedAtMs-pausedMs),updatedAtMs:Date.now(),closedBy:'fivem'};
  tx.update(ref,changes);
  tx.set(ref.collection('sessions').doc(old.sessionId),changes,{merge:true});
  tx.set(ref.collection('events').doc(event.uuid),{type:'close',at:stamp(event.atMs),sessionId:old.sessionId,source:'fivem'});
  tx.create(eventRef,{...audit,result:'closed',sessionId:old.sessionId});
  result={kind:'closed',data:{...old,...changes}};
 });
 if(!result) return;
 if(result.kind==='opened') {
  try {
   const ch=await message.guild.channels.fetch(channels.baterPonto);
   if(!ch?.isTextBased()) throw new Error('Canal Bater Ponto indisponível');
   const sent=await ch.send(display(result.data,userId));
   const active=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists || snap.data().sessionId!==result.data.sessionId) return false;
    tx.update(ref,{messageId:sent.id});
    tx.set(ref.collection('sessions').doc(result.data.sessionId),{messageId:sent.id},{merge:true});
    return true;
   });
   if(active) {
    const latest=await ref.get();
    if(latest.exists && latest.data().sessionId===result.data.sessionId && latest.data().status!=='open') {
     await sent.edit(display(latest.data(),userId)).catch(err=>console.error('[FiveM] Erro ao atualizar painel recém-criado:',err));
    }
    await log(message.guild,userId,'Aberto',{...result.data,messageId:sent.id},userId);
   }
  } catch(err) {console.error('[FiveM] Ponto aberto no banco, mas falhou a publicação do painel:',err);}
 } else {
  if(result.data.messageId) {
   try {await updatePublicMessage(message.guild,userId,result.data);} catch(err) {console.error('[FiveM] Não foi possível atualizar painel:',err);}
  }
  if(result.kind==='closed') await log(message.guild,userId,'Encerrado',result.data,userId);
  if(result.kind==='reentry') console.warn(`[FiveM] Reconexão para revisão: ID ${event.rpId}, usuário ${userId}, sessão ${result.data.sessionId}`);
 }
}
module.exports={handleFiveMLog,parseLog,messageText};
