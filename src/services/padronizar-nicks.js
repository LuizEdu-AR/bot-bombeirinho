const {administrativeLog}=require('./logs-administrativos');
'use strict';
const {Routes,MessageFlags,PermissionFlagsBits}=require('discord.js');
const {roles}=require('../config/ids');
const jobs=new Map();
const STAFF=roles.staff;
const FORMAT=/^\s*\[\s*([^\]\r\n]{1,24}?)\s*\]\s+(.+?)\s*$/u;
const MAX_AGE=10*60*1000;
async function listMembers(guild){
 const out=[];let after;
 for(let page=0;page<100;page++){
  const query=new URLSearchParams({limit:'1000'});
  if(after)query.set('after',after);
  const batch=await guild.client.rest.get(Routes.guildMembers(guild.id),{query});
  if(!Array.isArray(batch))throw new Error('Resposta inválida da API de membros');
  out.push(...batch);
  if(batch.length<1000)break;
  const next=batch.at(-1)?.user?.id;
  if(!next||next===after)throw new Error('Falha na paginação');
  after=next;
 }
 if(out.length<=1&&guild.memberCount>1)throw new Error(`Consulta incompleta (${out.length}/${guild.memberCount}). Nenhuma alteração realizada.`);
 return out;
}
function plan(members,botId){
 const changes=[];let staff=0,unmatched=0;
 for(const m of members){
  if(!m.user?.id||m.user.bot||m.user.id===botId)continue;
  if(m.roles?.includes(STAFF)){staff++;continue;}
  const current=m.nick??m.user.global_name??m.user.username??'';
  // Só altera apelidos já existentes no servidor, não nomes globais do Discord.
  if(!m.nick){unmatched++;continue;}
  const match=FORMAT.exec(current);
  if(!match){unmatched++;continue;}
  const next=`${match[1].trim()} | ${match[2].trim()}`;
  if(next.length>32||next===m.nick){unmatched++;continue;}
  changes.push({id:m.user.id,old:m.nick,next});
 }
 return {changes,staff,unmatched};
}
function authorized(i){return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||i.member?.roles?.cache?.has(roles.manutencao)||i.member?.roles?.cache?.has(roles.chefe)||i.member?.roles?.cache?.has(roles.chefeAdjunto);}
async function handleNicks(i){
 if(!i.guild||!authorized(i))return i.reply({content:'Apenas o comando do SSFD pode usar esta função.',flags:MessageFlags.Ephemeral});
 if(i.isChatInputCommand()){
  await i.deferReply({flags:MessageFlags.Ephemeral});
  const members=await listMembers(i.guild);
  const result=plan(members,i.client.user.id);
  const id=`${i.guild.id}:${i.user.id}`;
  jobs.set(id,{...result,created:Date.now()});
  const preview=result.changes.slice(0,12).map(c=>`• ${c.old} → ${c.next}`).join('\n')||'Nenhum apelido precisa de alteração.';
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require('discord.js');
  const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nicks:confirm').setLabel('Confirmar padronização').setStyle(ButtonStyle.Danger).setDisabled(!result.changes.length),new ButtonBuilder().setCustomId('nicks:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
  return i.editReply({content:`**🚒 Prévia da padronização de apelidos**\nMembros consultados: ${members.length}\nExcluídos por cargo Staff: ${result.staff}\nApelidos elegíveis: **${result.changes.length}**\nIgnorados (formato diferente ou sem apelido): ${result.unmatched}\n\n${preview}${result.changes.length>12?`\n... e mais ${result.changes.length-12}.`:''}\n\nA confirmação expira em 10 minutos. Nenhum apelido foi alterado ainda.`,components:[row]});
 }
 if(!i.isButton())return;
 const id=`${i.guild.id}:${i.user.id}`;
 const job=jobs.get(id);
 if(i.customId==='nicks:cancel'){
  jobs.delete(id);return i.update({content:'Padronização cancelada. Nenhum apelido foi alterado.',components:[]});
 }
 if(!job||Date.now()-job.created>MAX_AGE){jobs.delete(id);return i.update({content:'Prévia expirada. Execute `/padronizar-nicks` novamente.',components:[]});}
 jobs.delete(id);
 await i.update({content:`Processando ${job.changes.length} apelidos. Aguarde o resultado...`,components:[]});
 let ok=0,skipped=0;const failed=[];
 for(const c of job.changes){
  try{
   const member=await i.guild.members.fetch(c.id);
   if(member.roles.cache.has(STAFF)||member.nickname!==c.old){skipped++;continue;}
   if(!member.manageable){failed.push(`${c.old}: hierarquia/permissões`);continue;}
   await member.setNickname(c.next,`Padronização solicitada por ${i.user.tag} (${i.user.id})`);ok++;
  }catch(e){failed.push(`${c.old}: ${e.code||e.message}`);}
 }
 await administrativeLog(i.guild.id,'nickname_batch',{actorId:i.user.id,details:{Atualizados:ok,Ignorados:skipped,Falhas:failed.length}});
 const detail=failed.slice(0,12).map(s=>`• ${s}`).join('\n');
 return i.editReply({content:`**🚒 Padronização concluída**\nAtualizados: **${ok}**\nIgnorados (mudança de cargo/apelido durante execução): ${skipped}\nFalhas: ${failed.length}${detail?`\n\n${detail}`:''}${failed.length>12?'\n... demais falhas omitidas.':''}`,components:[]});
}
module.exports={handleNicks};
