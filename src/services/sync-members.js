const {administrativeLog}=require('./logs-administrativos');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { db, admin } = require('./firebase');
const { roles, courses } = require('../config/ids');
const { hasAnyRole } = require('../utils/permissions');
const ALLOWED=[roles.chefe,roles.chefeAdjunto];
const rankEntries=Object.entries(roles).filter(([key])=>['chefe','chefeAdjunto','chefeBatalhao','capitao','tenente','bombeiroIII','bombeiroII','bombeiroI','cadete'].includes(key));
const courseEntries=Object.entries(courses);
const extraEntries=Object.entries(roles).filter(([key])=>!rankEntries.some(([k])=>k===key));
const ref=(g,u)=>db.collection('guilds').doc(g).collection('registrations').doc(u);
const syncRef=(g,u)=>db.collection('guilds').doc(g).collection('memberSync').doc(u);
const stateRef=g=>db.collection('guilds').doc(g).collection('syncSettings').doc('members');
const match=(member,entries)=>entries.filter(([,id])=>member.roles.cache.has(id)).map(([key])=>key);
function identity(member){const nickname=member.nickname||member.user.globalName||member.user.username;const parsed=/^\s*([A-Za-z0-9]{1,15})\s*\|\s*(.+?)\s*$/.exec(nickname);return {name:parsed?parsed[2].slice(0,80):nickname.slice(0,80),rpId:parsed?parsed[1]:null};}
function eligible(m){return !m.user.bot && (match(m,rankEntries).length || match(m,extraEntries).some(k=>k!=='bombeiros') || match(m,courseEntries).length);}
function panel(){return {embeds:[new EmbedBuilder().setColor(0xd92929).setTitle('🚒 SSFD • Sincronização de Membros').setDescription('Importe os membros antigos sem alterar os cargos do Discord. Cadastros existentes não serão substituídos. A sincronização de cargos do Discord para o Firebase ficará ativa após a importação.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sync:preview').setLabel('Verificar membros').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('sync:import').setLabel('Importar membros').setStyle(ButtonStyle.Success))]};}
async function saveSnapshot(member,source='event'){
 if (!eligible(member)) return;
 const {name,rpId}=identity(member);
 const ranks=match(member,rankEntries),courseKeys=match(member,courseEntries),extra=match(member,extraEntries);
 const r=syncRef(member.guild.id,member.id);
 await r.set({discordId:member.id,guildId:member.guild.id,name,rpId,patentes:ranks,cursos:courseKeys,cargosAdicionais:extra,roleIds:member.roles.cache.map(x=>x.id),source,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 const registration=ref(member.guild.id,member.id);
 await db.runTransaction(async tx=>{
  const snap=await tx.get(registration);
  if (snap.exists) return;
  tx.create(registration,{discordId:member.id,guildId:member.guild.id,name,rpId,phone:null,type:'importado',status:'approved',imported:true,patentes:ranks,cursos:courseKeys,cargosAdicionais:extra,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
 });
}
async function onMemberUpdate(oldMember,newMember){
 const previous=oldMember.roles.cache.map(x=>x.id).sort().join(',');const current=newMember.roles.cache.map(x=>x.id).sort().join(',');
 if(previous===current)return;
 const setting=await stateRef(newMember.guild.id).get();if(!setting.data()?.enabled)return;
 const existing=await syncRef(newMember.guild.id,newMember.id).get();
 if(!existing.exists)return;
 const gainedCourse=courseEntries.some(([,id])=>!oldMember.roles.cache.has(id)&&newMember.roles.cache.has(id));
 const isBombeiroI=newMember.roles.cache.has(roles.bombeiroI);
 const isHigher=rankEntries.some(([key,id])=>!['bombeiroI','cadete'].includes(key)&&newMember.roles.cache.has(id));
 if(gainedCourse&&isBombeiroI&&!isHigher){
  try{
   // Adicionar antes de remover para evitar deixar o membro sem patente caso a adição falhe.
   await newMember.roles.add(roles.bombeiroII,'Promoção automática SSFD: conclusão de curso');
   try{await newMember.roles.remove(roles.bombeiroI,'Promoção automática SSFD: conclusão de curso');}
   catch(err){console.error('[Promoção] Não foi possível remover Bombeiro I:',err);}
   await db.collection('guilds').doc(newMember.guild.id).collection('registrations').doc(newMember.id).collection('managementEvents').add({type:'automatic_promotion',from:'bombeiroI',to:'bombeiroII',courseIds:courseEntries.filter(([,id])=>!oldMember.roles.cache.has(id)&&newMember.roles.cache.has(id)).map(([,id])=>id),at:admin.firestore.FieldValue.serverTimestamp()});
   await administrativeLog(newMember.guild.id,'automatic_promotion',{targetId:newMember.id,details:{De:'Bombeiro I',Para:'Bombeiro II'},key:`promotion-${newMember.id}-${Date.now()}`});
   console.log(`[Promoção] ${newMember.id} Bombeiro I -> Bombeiro II`);
  }catch(err){console.error('[Promoção] Falha ao promover membro:',err);}
 }
 const updated=await newMember.guild.members.fetch(newMember.id).catch(()=>newMember);
 await saveSnapshot(updated,'role_update');
}
async function handleSync(interaction){
 if(!hasAnyRole(interaction.member,ALLOWED))return interaction.reply({content:'Apenas Chefe, Chefe Adjunto ou Manutenção podem sincronizar membros.',flags:MessageFlags.Ephemeral});
 if(interaction.customId==='sync:import')return interaction.reply({content:'A importação analisará os membros do servidor e criará apenas cadastros ausentes. Nenhum cargo será alterado. Deseja confirmar?',flags:MessageFlags.Ephemeral,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sync:confirm').setLabel('Confirmar importação').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('sync:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))]});
 if(interaction.customId==='sync:cancel')return interaction.update({content:'Importação cancelada.',components:[]});
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 const members=await interaction.guild.members.fetch();const candidates=[...members.values()].filter(eligible);
 if(interaction.customId==='sync:preview'){
  let existing=0,missing=0,withId=0,multi=0;
  for(let i=0;i<candidates.length;i+=100){const chunk=candidates.slice(i,i+100);const snaps=await db.getAll(...chunk.map(m=>ref(interaction.guildId,m.id)));snaps.forEach(s=>s.exists?existing++:missing++);}
  for(const m of candidates){if(identity(m).rpId)withId++;if(match(m,rankEntries).length>1)multi++;}
  return interaction.editReply(`**Verificação concluída**\nMembros elegíveis: **${candidates.length}**\nCadastros já existentes: **${existing}**\nNovos cadastros possíveis: **${missing}**\nCom ID extraível do apelido: **${withId}**\nCom múltiplas patentes: **${multi}**\n\nNenhum dado foi alterado.`);
 }
 if(interaction.customId!=='sync:confirm')return interaction.editReply('Ação desconhecida.');
 let imported=0,updated=0,failed=0;
 for(const m of candidates){try{const before=await ref(interaction.guildId,m.id).get();await saveSnapshot(m,'initial_import');if(before.exists)updated++;else imported++;}catch(err){failed++;console.error(`[Sincronização] ${m.id}`,err);}}
 await stateRef(interaction.guildId).set({enabled:true,lastImportBy:interaction.user.id,lastImportAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 return interaction.editReply(`**Importação finalizada**\nNovos cadastros: **${imported}**\nMembros já cadastrados (sem substituir cadastro): **${updated}**\nFalhas: **${failed}**\nSincronização de alterações de cargos: **ativada**.\n\nDados dos cargos ficam em \`memberSync\`; cadastros antigos em \`registrations\`.`);
}
module.exports={panel,handleSync,onMemberUpdate,saveSnapshot};
