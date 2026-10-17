'use strict';
const { EmbedBuilder, Routes } = require('discord.js');
const { db, admin } = require('./firebase');
const { channels, roles } = require('../config/ids');

const TITLE = '🚒 SSFD • Hierarquia da Corporação';
const RANKS = [
 ['Chefe',roles.chefe],['Chefe Adjunto',roles.chefeAdjunto],
 ['Chefe de Batalhão',roles.chefeBatalhao],['Capitão',roles.capitao],
 ['Tenente',roles.tenente],['Bombeiro III',roles.bombeiroIII],
 ['Bombeiro II',roles.bombeiroII],['Bombeiro I',roles.bombeiroI],['Cadete',roles.cadete]
];
const timers = new Map();
const running = new Map();
const dirty = new Set();
const MAX_DELAY = 5000;

// Usa paginação REST, evitando a solicitação de todos os membros via Gateway OP 8.
async function getAllMembers(guild) {
 const members = [];
 let after;
 for (let page=0;page<100;page++) {
  const query = new URLSearchParams({ limit: '1000' });
  if(after) query.set('after', after);
  const batch=await guild.client.rest.get(Routes.guildMembers(guild.id),{query});
  if(!Array.isArray(batch))throw new Error('Resposta inesperada da API de membros.');
  members.push(...batch);
  if(batch.length<1000)break;
  const last=batch[batch.length-1]?.user?.id;
  if(!last || last===after)throw new Error('Paginação de membros interrompida.');
  after=last;
 }
 return members;
}

function buildEmbeds(members) {
 const ranks=new Map(RANKS.map(([,id])=>[id,[]]));
 for(const m of members){
  if(!m.user?.id || m.user.bot)continue;
  // Quem possui múltiplas patentes aparece somente na patente mais alta.
  const rank=RANKS.find(([,id])=>m.roles?.includes(id));
  if(rank)ranks.get(rank[1]).push(m);
 }
 const count=[...ranks.values()].reduce((n,a)=>n+a.length,0);
 const header=new EmbedBuilder().setColor(0xc62828).setTitle(TITLE)
  .setDescription(`**South State Fire Department**\nQuadro atualizado automaticamente a partir dos cargos do Discord.\n\n**Efetivo listado:** ${count} integrante(s)`);
 const embeds=[header];
 for(const [name,id] of RANKS){
  const group=ranks.get(id);
  group.sort((a,b)=>{
   const an=(a.nick||a.user.global_name||a.user.username||'').toLocaleLowerCase('pt-BR');
   const bn=(b.nick||b.user.global_name||b.user.username||'').toLocaleLowerCase('pt-BR');
   return an.localeCompare(bn,'pt-BR');
  });
  let lines=group.map(m=>`• <@${m.user.id}>`);
  if(!lines.length)lines=['*Nenhum integrante*'];
  let current='';
  let part=1;
  for(const line of lines){
   if(current && current.length+line.length+1>3900){
    embeds.push(new EmbedBuilder().setColor(0x353941).setTitle(`${name}${part>1?` (parte ${part})`:''}`).setDescription(current));
    current='';part++;
   }
   current+=(current?'\n':'')+line;
  }
  embeds.push(new EmbedBuilder().setColor(0x353941).setTitle(`${name}${part>1?` (parte ${part})`:''}`).setDescription(current));
 }
 // Discord permite no máximo 10 embeds por mensagem; para o efetivo atual são 10.
 if(embeds.length>10)throw new Error('Hierarquia excedeu 10 embeds; é necessário ampliar para mensagens adicionais.');
 embeds[embeds.length-1].setFooter({text:'SSFD • Alterações de patentes, admissões e exonerações atualizam este quadro'});
 return embeds;
}

async function refresh(guild) {
 if(!channels.hierarquia)return;
 const channel=await guild.channels.fetch(channels.hierarquia).catch(()=>null);
 if(!channel?.isTextBased()||!channel.messages?.fetch||typeof channel.send!=='function'){
  console.error(`[Hierarquia] Canal ${channels.hierarquia} inacessível no servidor ${guild.id}`);return;
 }
 // Primeiro coletar a lista completa; nunca substituir o quadro por uma lista parcial.
 const members=await getAllMembers(guild);
 if(members.length <= 1 && guild.memberCount > 1) {
  throw new Error(`Consulta incompleta: API retornou ${members.length} membro(s), mas o servidor informa ${guild.memberCount}. Quadro preservado.`);
 }
 const embeds=buildEmbeds(members);
 const ref=db.collection('guilds').doc(guild.id).collection('panels').doc('hierarquia');
 const snap=await ref.get();
 let message=null;
 if(snap.exists && snap.data()?.channelId===channel.id && snap.data()?.messageId){
  message=await channel.messages.fetch(snap.data().messageId).catch(()=>null);
  if(message?.author?.id!==guild.client.user.id || message?.embeds?.[0]?.title!==TITLE)message=null;
 }
 if(!message){
  const recent=await channel.messages.fetch({limit:100});
  message=recent.find(m=>m.author?.id===guild.client.user.id&&m.embeds?.[0]?.title===TITLE)||null;
 }
 const payload={embeds,allowedMentions:{parse:[]}};
 if(message)await message.edit(payload);
 else message=await channel.send(payload);
 await ref.set({channelId:channel.id,messageId:message.id,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 console.log(`[Hierarquia] Atualizada: ${members.length} membros consultados, mensagem ${message.id}`);
}

async function run(guild){
 if(running.has(guild.id)){dirty.add(guild.id);return running.get(guild.id);}
 const job=(async()=>{try{await refresh(guild);}catch(err){console.error(`[Hierarquia] Falha no servidor ${guild.id}:`,err);}})();
 running.set(guild.id,job);
 try{await job;}finally{
  running.delete(guild.id);
  if(dirty.delete(guild.id))schedule(guild);
 }
}
function schedule(guild){
 if(timers.has(guild.id))clearTimeout(timers.get(guild.id));
 timers.set(guild.id,setTimeout(()=>{timers.delete(guild.id);run(guild);},MAX_DELAY));
}
function rankChanged(a,b){
 if(!a||!b)return true;
 return RANKS.some(([,id])=>a.roles.cache.has(id)!==b.roles.cache.has(id));
}
function registerHierarchy(client){
 client.on('guildMemberAdd',m=>schedule(m.guild));
 client.on('guildMemberRemove',m=>schedule(m.guild));
 client.on('guildMemberUpdate',(oldM,newM)=>{if(rankChanged(oldM,newM))schedule(newM.guild);});
 client.once('ready',()=>{
  for(const guild of client.guilds.cache.values()){
   run(guild);
   const periodic=setInterval(()=>schedule(guild),15*60*1000);
   periodic.unref?.();
  }
 });
}
module.exports={registerHierarchy,refresh,buildEmbeds};
