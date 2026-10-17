'use strict';
const {ActionRowBuilder,ButtonBuilder,ButtonStyle,MessageFlags,PermissionFlagsBits}=require('discord.js');
const {db,admin}=require('./firebase');
const {roles}=require('../config/ids');
const {administrativeLog}=require('./logs-administrativos');
const pending=new Map();
const TTL=10*60*1000;
const ref=(g,u)=>db.collection('guilds').doc(g).collection('registrations').doc(u);
const missing=v=>v===null||v===undefined||String(v).trim()===''||/^n[aã]o cadastrad[oa]$/i.test(String(v).trim());
function parseId(nickname,isStaff){
 if(typeof nickname!=='string')return null;
 const m=/^\s*(?:\[\s*([A-Za-z0-9]{1,15})\s*\]|([A-Za-z0-9]{1,15})\s*\|)\s*(?:\|\s*)?\S/.exec(nickname);
 if(!m)return null;
 const value=m[1]||m[2];
 if(/^\d{1,15}$/.test(value))return value;
 if(isStaff&&/^(MOD|SPV|ADM|ADMIN|DEV|SUP|STAFF)$/i.test(value))return value.toUpperCase();
 return null;
}
function authorized(i){return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||[roles.chefe,roles.chefeAdjunto,roles.manutencao].some(id=>i.member?.roles?.cache?.has(id));}
async function updateOne(guildId,userId,rpId){
 return db.runTransaction(async tx=>{
  const r=ref(guildId,userId),s=await tx.get(r);
  if(!s.exists||!['approved','importado'].includes(s.data().status))return false;
  if(!missing(s.data().rpId))return false;
  tx.update(r,{rpId,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  return true;
 });
}
async function onNicknameUpdate(oldMember,newMember){
 if(oldMember.nickname===newMember.nickname||!newMember.nickname||newMember.user.bot)return;
 const rpId=parseId(newMember.nickname,newMember.roles.cache.has(roles.staff));
 if(!rpId)return;
 const changed=await updateOne(newMember.guild.id,newMember.id,rpId);
 if(changed)console.log(`[IDs] Cadastro ${newMember.id} preenchido pelo apelido.`);
}
async function handleSyncIds(i){
 if(!i.guild||!authorized(i))return i.reply({content:'Você não tem permissão para sincronizar IDs.',flags:MessageFlags.Ephemeral});
 const key=`${i.guildId}:${i.user.id}`;
 if(i.isChatInputCommand()){
  await i.deferReply({flags:MessageFlags.Ephemeral});
  const members=await i.guild.members.fetch();
  const candidates=[...members.values()].filter(m=>!m.user.bot&&m.nickname).map(m=>({member:m,id:parseId(m.nickname,m.roles.cache.has(roles.staff))})).filter(x=>x.id);
  const changes=[];let already=0,unregistered=0;
  for(let start=0;start<candidates.length;start+=100){
   const chunk=candidates.slice(start,start+100);
   const snaps=await db.getAll(...chunk.map(x=>ref(i.guildId,x.member.id)));
   snaps.forEach((s,index)=>{
    const c=chunk[index];
    if(!s.exists||!['approved','importado'].includes(s.data().status)){unregistered++;return;}
    if(!missing(s.data().rpId)){already++;return;}
    changes.push({userId:c.member.id,rpId:c.id,nickname:c.member.nickname});
   });
  }
  pending.set(key,{changes,at:Date.now()});
  const examples=changes.slice(0,12).map(c=>`• ${c.nickname} → ${c.rpId}`).join('\n')||'Nenhum cadastro precisa ser atualizado.';
  const buttons=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ids:confirm').setLabel('Confirmar atualização').setStyle(ButtonStyle.Success).setDisabled(!changes.length),new ButtonBuilder().setCustomId('ids:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
  return i.editReply({content:`**Prévia de sincronização de IDs**\nCadastros a preencher: **${changes.length}**\nIDs já cadastrados (preservados): **${already}**\nSem cadastro aprovado: **${unregistered}**\n\n${examples}${changes.length>12?`\n... e mais ${changes.length-12}.`:''}\n\nA prévia expira em 10 minutos. Nenhuma informação foi alterada.`,components:[buttons]});
 }
 if(!i.isButton())return;
 if(i.customId==='ids:cancel'){pending.delete(key);return i.update({content:'Sincronização cancelada. Nenhum dado foi alterado.',components:[]});}
 const job=pending.get(key);
 if(!job||Date.now()-job.at>TTL){pending.delete(key);return i.update({content:'Prévia expirada. Execute `/sincronizar-ids` novamente.',components:[]});}
 pending.delete(key);
 await i.update({content:'Atualizando IDs no Firebase. Aguarde...',components:[]});
 let updated=0,skipped=0,failed=0;
 for(const c of job.changes){
  try{
   const member=await i.guild.members.fetch(c.userId).catch(()=>null);
   if(!member||parseId(member.nickname,member.roles.cache.has(roles.staff))!==c.rpId){skipped++;continue;}
   if(await updateOne(i.guildId,c.userId,c.rpId))updated++;else skipped++;
  }catch(err){failed++;console.error('[IDs] Falha ao atualizar',c.userId,err);}
 }
 try{await administrativeLog(i.guildId,'ids_synchronized',{actorId:i.user.id,details:{Atualizados:updated,Ignorados:skipped,Falhas:failed}});}catch(err){console.error('[IDs] Falha ao registrar log',err);}
 return i.editReply({content:`**Sincronização concluída**\nIDs preenchidos: **${updated}**\nIgnorados: **${skipped}**\nFalhas: **${failed}**\n\nTelefones e demais dados preservados.`,components:[]});
}
module.exports={handleSyncIds,onNicknameUpdate,parseId};
