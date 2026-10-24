const {administrativeLog}=require('./logs-administrativos');
const { db, admin } = require('./firebase');
const { registrationTypes } = require('../config/registration');
const { channels } = require('../config/ids');
const { hasPatente, fetchMember } = require('../utils/patentes');
const { hasAnyRole } = require('../utils/permissions');
const { reconcileMembership } = require('./membership');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const ephemeral = { flags: MessageFlags.Ephemeral };
const clean = str => str.trim().replace(/[\r\n<>@]/g, '').slice(0,100);
const refFor = (guildId, userId) => db.collection('guilds').doc(guildId).collection('registrations').doc(userId);
// Atualiza o cartão original de autorização, mantendo os dados do cadastro.
async function updateReviewCard(message, status, reviewerId, reason) {
 if (!message) return false;
 const approved = status === 'approved';
 const original = message.embeds?.[0];
 const embed = original ? EmbedBuilder.from(original) : new EmbedBuilder();
 embed.setColor(approved ? 0x22c55e : 0xef4444)
  .setTitle(approved ? 'Cadastro autorizado' : 'Cadastro recusado')
  .setTimestamp(new Date());
 // Evita duplicar campos se uma operação for repetida após falha de rede.
 const previous = (embed.data.fields || []).filter(f => !['Autorizado por', 'Recusado por', 'Motivo da recusa'].includes(f.name));
 embed.setFields(previous);
 embed.addFields({name: approved ? 'Autorizado por' : 'Recusado por', value: `<@${reviewerId}>`});
 if (!approved && reason) embed.addFields({name:'Motivo da recusa',value:reason.slice(0,1024)});
 await message.edit({embeds:[embed],components:[],allowedMentions:{parse:[]}});
 return true;
}
function typeMenu() {
 return new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder().setCustomId('reg:type').setPlaceholder('Selecione seu cargo no RP')
   .addOptions(Object.entries(registrationTypes).map(([value,v]) => ({label:v.label,value})))
 );
}
function panel() {
 return {
  embeds:[new EmbedBuilder().setColor(0xd92929).setTitle('🚒 SSFD • Setagem')
   .setDescription('Bem-vindo ao South State Fire Department! Para acessar os canais do servidor, clique em **Realizar cadastro**, informe seus dados do RP e aguarde a autorização da administração.\n\nPara os membros da Staff colocar seu cargo no ID(MOD, SPV, ADM, etc) e para os demais membros do SSFD, Jurídico ou outras corporações colocar o ID numérico (ex.: 194).')],
  components:[new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('reg:start').setLabel('Realizar cadastro').setStyle(ButtonStyle.Primary)
  )]
 };
}
async function handleRegistration(interaction) {
 const id = interaction.customId;
 if (['reg:start','reg:type'].includes(id) || id.startsWith('reg:submit:')) {
  const member = await fetchMember(interaction);
  if (!member || hasPatente(member)) {
   const message = 'Cadastro indisponível: você já possui uma patente do SSFD (ou não foi possível verificar seus cargos). Procure a administração.';
   if (interaction.isModalSubmit()) { await interaction.deferReply(ephemeral); return interaction.editReply(message); }
   return interaction.reply({content:message,...ephemeral});
  }
 }
 if (id === 'reg:start' && interaction.isButton()) {
  const existing = await reconcileMembership(interaction.member);
  if (existing && ['pending','approved'].includes(existing.status)) {
   return interaction.reply({content: existing.status === 'pending' ? 'Você já possui um cadastro aguardando autorização.' : 'Você já possui um cadastro aprovado.', ...ephemeral});
  }
  return interaction.reply({content:'Selecione sua função no RP para continuar:',components:[typeMenu()],...ephemeral});
 }
 if (id === 'reg:type' && interaction.isStringSelectMenu()) {
  const type = interaction.values[0]; if (!registrationTypes[type]) return interaction.reply({content:'Cargo inválido.',...ephemeral});
  const existing = await reconcileMembership(interaction.member);
  if (existing && ['pending','approved'].includes(existing.status)) {
   return interaction.reply({content:'Você já possui um cadastro pendente ou aprovado.',...ephemeral});
  }
  const modal = new ModalBuilder().setCustomId(`reg:submit:${type}`).setTitle('Cadastro SSFD');
  for (const [key,label] of [['name','Nome no RP'],['rpId','ID no RP'],['phone','Telefone no RP']]) {
   modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(key==='name'?80:35)));
  }
  return interaction.showModal(modal);
 }
 if (id.startsWith('reg:submit:') && interaction.isModalSubmit()) {
  await interaction.deferReply(ephemeral);
  const type = id.split(':')[2]; if (!registrationTypes[type]) return interaction.editReply('Cargo inválido.');
  const name = clean(interaction.fields.getTextInputValue('name'));
  const rpId = clean(interaction.fields.getTextInputValue('rpId'));
  const phone = clean(interaction.fields.getTextInputValue('phone'));
  if (!name || !/^[A-Za-z0-9]{1,15}$/.test(rpId) || !phone) return interaction.editReply('Dados inválidos: o ID do RP deve conter de 1 a 15 letras e/ou números (ex.: 194, MOD, SPV, ADM).');
  await reconcileMembership(interaction.member);
  const ref = refFor(interaction.guildId,interaction.user.id);
  try {
   await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && ['pending','approved'].includes(snap.data().status)) throw new Error('Você já possui um cadastro pendente ou aprovado.');
    tx.set(ref,{ discordId:interaction.user.id,guildId:interaction.guildId,name,rpId,phone,type,status:'pending',createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp() });
   });
  } catch(e) { return interaction.editReply(e.message); }
  try {
   const channel = await interaction.guild.channels.fetch(channels.autorizarEntrada);
   if (!channel?.isTextBased()) throw new Error('Canal de autorização indisponível');
   const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reg:approve:${interaction.user.id}`).setLabel('Autorizar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reg:reject:${interaction.user.id}`).setLabel('Rejeitar').setStyle(ButtonStyle.Danger)
   );
   const msg = await channel.send({embeds:[new EmbedBuilder().setColor(0xf59e0b).setTitle('Cadastro pendente').addFields(
    {name:'Usuário',value:`<@${interaction.user.id}>`},{name:'Nome',value:name},{name:'ID',value:rpId},{name:'Telefone',value:phone},{name:'Cargo',value:registrationTypes[type].label})],components:[row],allowedMentions:{parse:[]}});
   await ref.update({reviewMessageId:msg.id});
   return interaction.editReply('Cadastro enviado! Aguarde a autorização da equipe responsável.');
  } catch(e) {
   console.error('Erro ao enviar cadastro',e);
   await ref.update({status:'delivery_failed',updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   return interaction.editReply('Não foi possível encaminhar seu cadastro. Avise a administração e tente novamente.');
  }
 }
 if (id.startsWith('reg:approve:') || id.startsWith('reg:reject:')) {
  const [,action,userId] = id.split(':');
  const snap = await refFor(interaction.guildId,userId).get();
  if (!snap.exists || snap.data().status!=='pending') return interaction.reply({content:'Esta solicitação já foi processada ou não existe.',...ephemeral});
  const data = snap.data(), config = registrationTypes[data.type];
  if (!config || !hasAnyRole(interaction.member,config.approvers)) return interaction.reply({content:'Você não tem permissão para avaliar esse tipo de cadastro.',...ephemeral});
  if (action==='reject') {
   const modal = new ModalBuilder().setCustomId(`reg:rejectsubmit:${userId}`).setTitle('Rejeitar cadastro');
   modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motivo da rejeição').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));
   return interaction.showModal(modal);
  }
  await interaction.deferReply(ephemeral);
  const member = await interaction.guild.members.fetch(userId).catch(()=>null);
  if (!member) return interaction.editReply('Usuário não encontrado no servidor.');
  if (hasPatente(member)) return interaction.editReply('Este membro já possui uma patente do SSFD. A solicitação não pode ser aprovada.');
  const refreshed = await reconcileMembership(member);
  if (refreshed?.status !== 'pending') return interaction.editReply('Solicitação invalidada após saída/reentrada do servidor. Solicite novo cadastro.');
  const roles = [config.roleId,...(config.extraRoles||[])];
  try {
   for (const roleId of roles) await member.roles.add(roleId,'Cadastro aprovado pelo SSFD');
   await member.setNickname(`${data.rpId} | ${data.name}`.slice(0,32),'Cadastro aprovado pelo SSFD');
  } catch(e) { console.error(e); return interaction.editReply('Falha ao aplicar cargos/apelido. Confira a hierarquia e permissões do bot. Verifique o usuário antes de tentar novamente.'); }
  await refFor(interaction.guildId,userId).update({status:'approved',reviewedBy:interaction.user.id,reviewedAt:admin.firestore.FieldValue.serverTimestamp()});
  await administrativeLog(interaction.guildId,'registration_approved',{actorId:interaction.user.id,targetId:userId,details:{Nome:data.name,ID:data.rpId,Cargo:data.type}});
  await updateReviewCard(interaction.message,'approved',interaction.user.id).catch(e => console.error('Falha ao atualizar cartão de aprovação:',e));
  return interaction.editReply(`Cadastro de <@${userId}> autorizado.`);
 }
 if (id.startsWith('reg:rejectsubmit:') && interaction.isModalSubmit()) {
  await interaction.deferReply(ephemeral);
  const userId=id.split(':')[2], ref=refFor(interaction.guildId,userId), reason=clean(interaction.fields.getTextInputValue('reason'));
  const snap=await ref.get();
  if (!snap.exists || snap.data().status!=='pending') return interaction.editReply('Solicitação já processada.');
  const config=registrationTypes[snap.data().type];
  if (!config || !hasAnyRole(interaction.member,config.approvers)) return interaction.editReply('Sem permissão.');
  await db.runTransaction(async tx => {const current=await tx.get(ref);if(current.data()?.status!=='pending') throw new Error('Solicitação já processada.');tx.update(ref,{status:'rejected',reason,reviewedBy:interaction.user.id,reviewedAt:admin.firestore.FieldValue.serverTimestamp()});});
  await administrativeLog(interaction.guildId,'registration_rejected',{actorId:interaction.user.id,targetId:userId,details:{Motivo:reason}});
  const channel=await interaction.guild.channels.fetch(channels.autorizarEntrada).catch(()=>null);
  const msg=await channel?.messages?.fetch(snap.data().reviewMessageId).catch(()=>null);
  await updateReviewCard(msg,'rejected',interaction.user.id,reason).catch(e => console.error('Falha ao atualizar cartão de recusa:',e));
  await interaction.guild.members.fetch(userId).then(m=>m.send(`Seu cadastro no SSFD foi rejeitado. Motivo: ${reason}`)).catch(()=>{});
  return interaction.editReply('Cadastro rejeitado e motivo registrado.');
 }
}
module.exports = { panel, handleRegistration };
