const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,UserSelectMenuBuilder,StringSelectMenuBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,MessageFlags}=require('discord.js');
const {roles,courses,channels}=require('../config/ids');
const {hasAnyRole}=require('../utils/permissions');
const {db,admin}=require('./firebase');
const {saveSnapshot}=require('./sync-members');
const {administrativeLog}=require('./logs-administrativos');
const admins=[roles.chefe,roles.chefeAdjunto];
const ANNOUNCEMENTS_CHANNEL='1560354767740346438';
const EXONERATION_CHANNEL=channels.exoneracao;
const dismissalDrafts=new Map();
const restorationDrafts=new Map();
const dismissalKey=i=>`${i.guildId}:${i.user.id}`;
const BOMBEIROS_ROLE='1518804307607163130';
const scheduleDrafts=new Map();
const scheduleCourseKeys=['ems','specFlight','specSea','fiu','preventionBureau','pac','pqd'];
const scheduleCourseNames={ems:'EMS',specFlight:'Spec Flight',specSea:'Spec Sea',fiu:'FIU',preventionBureau:'Prevention Bureau',pac:'PAC',pqd:'PQD'};
const scheduleCourseAliases={ems:['ems'],specFlight:['specFlight','flight','specflight','flightSpecialization'],specSea:['specSea','sea','specsea'],fiu:['fiu'],preventionBureau:['preventionBureau','prevention','preventionbureau'],pac:['pac'],pqd:['pqd']};
const courseKeyFor=key=>(scheduleCourseAliases[key]||[]).find(k=>courses[k]);
const draftKey=i=>`${i.guildId}:${i.user.id}`;
function getDraft(i){const d=scheduleDrafts.get(draftKey(i));if(!d||Date.now()-d.createdAt>15*60*1000){scheduleDrafts.delete(draftKey(i));return null;}return d;}
function validDate(date,time){const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);const t=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);if(!m||!t)return false;const day=+m[1],month=+m[2],year=+m[3];const d=new Date(Date.UTC(year,month-1,day));return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day&&year>=2026&&year<=2100;}

const rankKeys=['chefe','chefeAdjunto','chefeBatalhao','capitao','tenente','bombeiroIII','bombeiroII','bombeiroI','cadete'];
const rankOptions=rankKeys.map(key=>({label:({chefe:'Chefe',chefeAdjunto:'Chefe Adjunto',chefeBatalhao:'Chefe de Batalhão',capitao:'Capitão',tenente:'Tenente',bombeiroIII:'Bombeiro III',bombeiroII:'Bombeiro II',bombeiroI:'Bombeiro I',cadete:'Cadete'})[key],value:key}));
const courseOptions=Object.entries(courses).map(([key,id])=>({label:key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()).slice(0,100),value:key,description:`Cargo ${id}`}));
const ephemeral={flags:MessageFlags.Ephemeral};
const reg=(g,u)=>db.collection('guilds').doc(g).collection('registrations').doc(u);
const events=(g,u)=>reg(g,u).collection('managementEvents');
const clean=s=>s.trim().replace(/[\r\n<>@]/g,'').slice(0,80);
function panel(){return {embeds:[new EmbedBuilder().setColor(0xd92929).setTitle('🚒 SSFD • Gestão de Cargos').setDescription('Gerencie cadastros e cursos dos bombeiros. Alterações são registradas no Firebase. A concessão de qualquer curso reconhecido promove automaticamente Bombeiro I para Bombeiro II.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gest:edit').setLabel('Editar usuário').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('gest:course').setLabel('Atribuir / remover curso').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('gest:schedule').setLabel('Cadastrar curso').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('gest:dismiss').setLabel('Exonerar usuário').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('gest:restore').setLabel('Restaurar Cursos').setStyle(ButtonStyle.Secondary))]};}
const selectUser=(action)=>new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`gest:user:${action}`).setPlaceholder('Selecione um membro do servidor').setMinValues(1).setMaxValues(1));
const back=()=>new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gest:home').setLabel('Voltar').setStyle(ButtonStyle.Secondary));
async function memberFor(interaction,id){return interaction.guild.members.fetch(id).catch(()=>null);}
async function log(interaction,userId,type,details){await events(interaction.guildId,userId).add({type,by:interaction.user.id,details,at:admin.firestore.FieldValue.serverTimestamp()});await administrativeLog(interaction.guildId,type,{actorId:interaction.user.id,targetId:userId,details});}
async function handleGestao(interaction){
 if(!hasAnyRole(interaction.member,admins))return interaction.reply({content:'Apenas Chefe, Chefe Adjunto ou Manutenção podem usar Gestão de Cargos.',...ephemeral});
 const id=interaction.customId;
 if(id==='gest:home')return interaction.update({content:'Escolha uma ação no painel principal.',components:[],embeds:[]});
 if(id==='gest:confirmrestore:'+id.split(':')[2]&&id.startsWith('gest:confirmrestore:')&&interaction.isButton()){
  const target=id.split(':')[2],key=dismissalKey(interaction),draft=restorationDrafts.get(key);
  if(!draft||draft.target!==target||Date.now()-draft.createdAt>10*60*1000)return interaction.update({content:'Confirmação expirada. Inicie novamente.',components:[]});
  restorationDrafts.delete(key);
  await interaction.deferUpdate();
  const m=await memberFor(interaction,target);
  if(!m)return interaction.editReply({content:'O usuário precisa estar no servidor para receber os cargos.',components:[]});
  const snap=await reg(interaction.guildId,target).get(),d=snap.data()||{};
  const stored=Array.isArray(d.courseCertifications)?d.courseCertifications:Array.isArray(d.previousCourses)?d.previousCourses:[];
  const pending=draft.courses.filter(k=>stored.includes(k)&&courses[k]&&!m.roles.cache.has(courses[k]));
  if(!pending.length)return interaction.editReply({content:'Não há cursos pendentes de restauração.',components:[]});
  try{await m.roles.add(pending.map(k=>courses[k]),`Restauração de cursos por ${interaction.user.id}`);}
  catch(err){console.error('[Gestão] Restauração:',err);return interaction.editReply({content:'Falha ao atribuir os cargos. Verifique as permissões e a hierarquia.',components:[]});}
  try{await log(interaction,target,'courses_restored',{courses:pending});}catch(err){console.error('[Gestão] Log restauração:',err);}
  return interaction.editReply({content:`Cursos restaurados: **${pending.map(k=>courseOptions.find(c=>c.value===k)?.label||k).join(', ')}**.`,components:[]});
 }
 if(id==='gest:schedule'&&interaction.isButton()){
  const modal=new ModalBuilder().setCustomId('gest:schedulemodal').setTitle('Agendar curso interno');
  for(const [key,label,placeholder,max] of [['date','Data (DD/MM/AAAA)','Ex.: 20/10/2026',10],['time','Horário (HH:MM)','Ex.: 19:30',5],['location','Local de início','Ex.: Quartel Central',120]])modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true)));
  return interaction.showModal(modal);
 }
 if(id==='gest:schedulemodal'&&interaction.isModalSubmit()){
  const date=interaction.fields.getTextInputValue('date').trim(),time=interaction.fields.getTextInputValue('time').trim(),location=clean(interaction.fields.getTextInputValue('location'));
  if(!validDate(date,time)||!location)return interaction.reply({content:'Informe data válida em DD/MM/AAAA, horário HH:MM (24h) e local de início.',...ephemeral});
  const available=scheduleCourseKeys.filter(k=>courseKeyFor(k));
  if(!available.length)return interaction.reply({content:'Não encontrei os cargos dos cursos previstos no PDF. Confira src/config/ids.js.',...ephemeral});
  scheduleDrafts.set(draftKey(interaction),{date,time,location,createdAt:Date.now()});
  return interaction.reply({content:'Selecione **um ou mais cursos** para esta realização:',components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('gest:schedulecourses').setPlaceholder('Cursos desta turma').setMinValues(1).setMaxValues(available.length).addOptions(available.map(k=>({label:scheduleCourseNames[k],value:k}))))],...ephemeral});
 }
 if(id==='gest:schedulecourses'&&interaction.isStringSelectMenu()){
  const d=getDraft(interaction);if(!d)return interaction.update({content:'Agendamento expirado. Clique em Cadastrar curso novamente.',components:[]});
  const selected=[...new Set(interaction.values)];if(!selected.length||selected.some(k=>!scheduleCourseKeys.includes(k)||!courseKeyFor(k)))return interaction.update({content:'Seleção inválida.',components:[]});
  d.courses=selected;
  return interaction.update({content:'Selecione o **bombeiro instrutor** responsável pela realização:',components:[new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('gest:scheduleinstructor').setPlaceholder('Instrutor responsável').setMinValues(1).setMaxValues(1))]});
 }
 if(id==='gest:scheduleinstructor'&&interaction.isUserSelectMenu()){
  const d=getDraft(interaction);if(!d||!d.courses)return interaction.update({content:'Agendamento expirado. Recomece.',components:[]});
  const instructor=await memberFor(interaction,interaction.values[0]);if(!instructor||instructor.user.bot)return interaction.update({content:'Escolha um instrutor válido que esteja no servidor.',components:[]});
  d.instructorId=instructor.id;
  return interaction.update({content:`**Confirme o agendamento:**\n**Curso(s):** ${d.courses.map(k=>scheduleCourseNames[k]).join(', ')}\n**Data:** ${d.date}\n**Horário:** ${d.time}\n**Local:** ${d.location}\n**Instrutor:** <@${d.instructorId}>\n\nO anúncio mencionará o cargo Bombeiros.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gest:schedulepublish').setLabel('Publicar agendamento').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('gest:schedulecancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}});
 }
 if(id==='gest:schedulecancel'&&interaction.isButton()){scheduleDrafts.delete(draftKey(interaction));return interaction.update({content:'Agendamento cancelado.',components:[]});}
 if(id==='gest:schedulepublish'&&interaction.isButton()){
  const d=getDraft(interaction);if(!d||!d.courses||!d.instructorId)return interaction.update({content:'Agendamento expirado. Recomece.',components:[]});
  await interaction.deferUpdate();
  const channel=await interaction.guild.channels.fetch(ANNOUNCEMENTS_CHANNEL).catch(()=>null);
  if(!channel||!channel.isTextBased()||typeof channel.send!=='function')return interaction.editReply({content:'Canal de anúncios não encontrado ou inacessível. Nenhum agendamento foi publicado.',components:[]});
  const embed=new EmbedBuilder().setColor(0xd92929).setTitle('🚒 SSFD | Cursos Internos — Agendamento').setDescription('Uma nova atividade de capacitação foi programada para os integrantes do **South State Fire Department**.').addFields({name:'📚 Curso(s)',value:d.courses.map(k=>`• ${scheduleCourseNames[k]}`).join('\n'),inline:false},{name:'📅 Data',value:d.date,inline:true},{name:'🕒 Horário',value:d.time,inline:true},{name:'📍 Local de início',value:d.location,inline:false},{name:'👨‍🚒 Instrutor responsável',value:`<@${d.instructorId}>`,inline:false}).setFooter({text:'SSFD • Cursos Internos'}).setTimestamp();
  let msg;try{msg=await channel.send({content:`<@&${BOMBEIROS_ROLE}>`,embeds:[embed],allowedMentions:{parse:[],roles:[BOMBEIROS_ROLE]}});}catch(err){console.error('[Gestão] Publicar agendamento:',err);return interaction.editReply({content:'Falha ao publicar o anúncio. Confira as permissões do bot e a menção ao cargo Bombeiros.',components:[]});}
  scheduleDrafts.delete(draftKey(interaction));
  await administrativeLog(interaction.guildId,'course_scheduled',{actorId:interaction.user.id,targetId:d.instructorId,details:{Cursos:d.courses.map(k=>scheduleCourseNames[k]).join(', '),Data:d.date,Horário:d.time,Local:d.location},key:`course-${msg.id}`});
  try{await db.collection('guilds').doc(interaction.guildId).collection('courseSchedules').doc(msg.id).set({date:d.date,time:d.time,location:d.location,courses:d.courses,instructorId:d.instructorId,createdBy:interaction.user.id,channelId:channel.id,messageId:msg.id,status:'scheduled',createdAt:admin.firestore.FieldValue.serverTimestamp()});}catch(err){console.error('[Gestão] Salvar agendamento:',err);return interaction.editReply({content:`Anúncio publicado: ${msg.url}\n⚠️ Não foi possível registrar no Firebase. Confira os logs antes de repetir.`,components:[]});}
  return interaction.editReply({content:`Agendamento publicado com sucesso: ${msg.url}`,components:[]});
 }
 if(id==='gest:course')return interaction.reply({content:'Selecione o curso que deseja gerenciar:',components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('gest:coursepick').setPlaceholder('Selecione um curso reconhecido pelo SSFD').addOptions(courseOptions))],...ephemeral});
 if(['gest:edit','gest:dismiss','gest:restore'].includes(id))return interaction.reply({content:'Selecione o bombeiro que deseja gerenciar:',components:[selectUser(id.split(':')[1])],...ephemeral});
 if(id.startsWith('gest:user:') && interaction.isUserSelectMenu()){
  const action=id.split(':')[2],target=interaction.values[0],m=await memberFor(interaction,target);
  if(!m||m.user.bot)return interaction.update({content:'Selecione um membro válido que esteja no servidor.',components:[]});
  if(action==='restore'){
   const snap=await reg(interaction.guildId,target).get(),d=snap.data()||{};
   const keys=Array.isArray(d.courseCertifications)?d.courseCertifications:Array.isArray(d.previousCourses)?d.previousCourses:[];
   const valid=[...new Set(keys)].filter(k=>courses[k]);
   if(!valid.length)return interaction.update({content:'Nenhum curso registrado para este usuário no histórico persistente. Não será feita nenhuma atribuição por suposição.',components:[]});
   const pending=valid.filter(k=>!m.roles.cache.has(courses[k]));
   if(!pending.length)return interaction.update({content:'Todos os cursos registrados já estão atribuídos a este membro.',components:[]});
   restorationDrafts.set(dismissalKey(interaction),{target,createdAt:Date.now(),courses:pending});
   return interaction.update({content:`**Restaurar cursos de <@${target}>**\nCursos encontrados: ${valid.map(k=>courseOptions.find(c=>c.value===k)?.label||k).join(', ')}\n\nCargos a restaurar: **${pending.map(k=>courseOptions.find(c=>c.value===k)?.label||k).join(', ')}**\n\nNenhuma patente será alterada.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gest:confirmrestore:${target}`).setLabel('Confirmar restauração').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('gest:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}});
  }
  if(action==='edit'){
   const snap=await reg(interaction.guildId,target).get();if(!snap.exists)return interaction.update({content:'Este membro não possui cadastro. Utilize a Setagem.',components:[]});
   return interaction.update({content:`Editar <@${target}>: escolha o que deseja alterar.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gest:editdata:${target}`).setLabel('Nome, ID e telefone').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId(`gest:editrank:${target}`).setLabel('Alterar patente').setStyle(ButtonStyle.Secondary)),back()],allowedMentions:{parse:[]}});
  }
  if(action==='course'){
   return interaction.update({content:`Gerenciar cursos de <@${target}>. Selecione um curso e a operação:`,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gest:choosecourse:${target}`).setPlaceholder('Escolha o curso').addOptions(courseOptions)),back()],allowedMentions:{parse:[]}});
  }
  if(action==='dismiss')return interaction.update({content:`Você selecionou <@${target}>. Informe o motivo antes de confirmar a exoneração.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gest:dismissreason:${target}`).setLabel('Informar motivo').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('gest:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}});
 }
 if(id.startsWith('gest:editdata:')&&interaction.isButton()){
  const target=id.split(':')[2],snap=await reg(interaction.guildId,target).get();
  if(!snap.exists)return interaction.reply({content:'Cadastro não encontrado.',...ephemeral});
  const d=snap.data(),modal=new ModalBuilder().setCustomId(`gest:editmodal:${target}`).setTitle('Editar dados do RP');
  for(const [key,label,value] of [['name','Nome no RP',d.name],['rpId','ID no RP',d.rpId],['phone','Telefone no RP',d.phone]])modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(key!=='phone').setMaxLength(80).setValue(String(value||'').slice(0,80))));
  return interaction.showModal(modal);
 }
 if(id.startsWith('gest:editrank:')&&interaction.isButton()){
  const target=id.split(':')[2];
  return interaction.update({content:`Selecione a nova patente de <@${target}>:`,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gest:rankchoice:${target}`).setPlaceholder('Escolha uma patente').addOptions(rankOptions)),back()],allowedMentions:{parse:[]}});
 }
 if(id.startsWith('gest:rankchoice:')&&interaction.isStringSelectMenu()){
  const target=id.split(':')[2],rank=interaction.values[0];
  if(!rankKeys.includes(rank))return interaction.update({content:'Patente inválida.',components:[]});
  return interaction.update({content:`Confirma alterar a patente de <@${target}> para **${rankOptions.find(r=>r.value===rank).label}**? A patente anterior será removida.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gest:rankconfirm:${target}:${rank}`).setLabel('Confirmar mudança').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('gest:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}});
 }
 if(id.startsWith('gest:rankconfirm:')&&interaction.isButton()){
  await interaction.deferUpdate();
  const [, ,target,rank]=id.split(':');
  if(!rankKeys.includes(rank))return interaction.editReply({content:'Patente inválida.',components:[]});
  const m=await memberFor(interaction,target);
  if(!m)return interaction.editReply({content:'Membro não encontrado.',components:[]});
  if(hasAnyRole(m,admins)||m.roles.cache.has(roles.manutencao))return interaction.editReply({content:'Por segurança, não é possível alterar a patente de administradores por este painel.',components:[]});
  const previous=rankKeys.filter(k=>m.roles.cache.has(roles[k]));
  if(previous.length===1&&previous[0]===rank)return interaction.editReply({content:'O membro já possui essa patente.',components:[]});
  const removed=previous.filter(k=>k!==rank).map(k=>roles[k]);
  try{
   if(!m.roles.cache.has(roles[rank]))await m.roles.add(roles[rank],`Mudança de patente por ${interaction.user.id}`);
   if(removed.length)await m.roles.remove(removed,`Mudança de patente por ${interaction.user.id}`);
  }catch(err){console.error('[Gestão] Alterar patente:',err);return interaction.editReply({content:'Não foi possível concluir a mudança de patente. Confira a hierarquia e as permissões do bot; verifique também os cargos atuais do membro.',components:[]});}
  try{
   const updated=await memberFor(interaction,target);
   if(updated)await saveSnapshot(updated,'manual_rank_change');
   await reg(interaction.guildId,target).set({patentes:[rank],updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
   await log(interaction,target,'manual_rank_change',{previous,newRank:rank});
  }catch(err){console.error('[Gestão] Registrar mudança de patente:',err);return interaction.editReply({content:'Patente alterada no Discord, mas houve falha ao registrar no Firebase. Confira o log antes de repetir.',components:[]});}
  return interaction.editReply({content:`Patente de <@${target}> atualizada para **${rankOptions.find(r=>r.value===rank).label}**.`,components:[],allowedMentions:{parse:[]}});
 }
 if(id==='gest:cancel'){restorationDrafts.delete(dismissalKey(interaction));dismissalDrafts.delete(dismissalKey(interaction));return interaction.update({content:'Ação cancelada. Nenhum dado foi alterado.',components:[]});}
 if(id==='gest:coursepick'&&interaction.isStringSelectMenu()){
  const key=interaction.values[0];
  if(!courses[key])return interaction.update({content:'Curso inválido.',components:[]});
  return interaction.update({content:`Curso selecionado: **${courseOptions.find(c=>c.value===key).label}**. Escolha a operação:`,components:[new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId(`gest:grantselect:${key}`).setLabel('Atribuir a vários membros').setStyle(ButtonStyle.Success),
   new ButtonBuilder().setCustomId(`gest:revokeselect:${key}`).setLabel('Remover de um membro').setStyle(ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('gest:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  )]});
 }
 if((id.startsWith('gest:grantselect:')||id.startsWith('gest:revokeselect:'))&&interaction.isButton()){
  const [,operation,key]=id.split(':');
  if(!courses[key])return interaction.update({content:'Curso inválido.',components:[]});
  const grant=operation==='grantselect';
  return interaction.update({content:grant?'Selecione de 1 a 25 membros que receberão o curso. Apenas quem ainda não possui o cargo será incluído no anúncio.':'Selecione o membro de quem deseja remover o curso (sem anúncio).',components:[new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`gest:courseusers:${grant?'grant':'revoke'}:${key}`).setPlaceholder(grant?'Selecione até 25 membros':'Selecione um membro').setMinValues(1).setMaxValues(grant?25:1))]});
 }
 if(id.startsWith('gest:courseusers:')&&interaction.isUserSelectMenu()){
  await interaction.deferUpdate();
  const [, ,operation,key]=id.split(':');
  if(!courses[key]||!['grant','revoke'].includes(operation))return interaction.editReply({content:'Operação inválida.',components:[]});
  const granted=[],removed=[],already=[],failed=[];
  for(const userId of [...new Set(interaction.values)]){
   const member=await memberFor(interaction,userId);
   if(!member||member.user.bot){failed.push(userId);continue;}
   const had=member.roles.cache.has(courses[key]);
   if((operation==='grant'&&had)||(operation==='revoke'&&!had)){already.push(userId);continue;}
   try{
    if(operation==='grant')await member.roles.add(courses[key],`Curso atribuído por ${interaction.user.id}`);
    else await member.roles.remove(courses[key],`Curso removido por ${interaction.user.id}`);
    if(operation==='grant')granted.push(userId);else removed.push(userId);
    try{
     const ref=reg(interaction.guildId,userId),snap=await ref.get(),data=snap.data()||{};
     const current=Array.isArray(data.courseCertifications)?data.courseCertifications:Array.isArray(data.previousCourses)?data.previousCourses:Object.keys(courses).filter(k=>member.roles.cache.has(courses[k]));
     const next=operation==='grant'?[...new Set([...current,key])]:current.filter(k=>k!==key);
     await ref.set({courseCertifications:next,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
     await log(interaction,userId,operation==='grant'?'course_granted':'course_revoked',{course:key});}
    catch(err){console.error('[Gestão] Falha no histórico do curso:',err);}
   }catch(err){console.error('[Gestão] Falha ao alterar curso:',userId,err);failed.push(userId);}
  }
  let notice='';
  if(operation==='grant'&&granted.length){
   const ch=await interaction.guild.channels.fetch(ANNOUNCEMENTS_CHANNEL).catch(()=>null);
   if(!ch||!ch.isTextBased()||typeof ch.send!=='function')notice='⚠️ O curso foi atribuído, mas o canal de anúncios não está acessível.';
   else{
    const courseName=courseOptions.find(c=>c.value===key).label;
    const membersList=granted.map(userId=>`• <@${userId}>`).join('\n');
    const embed=new EmbedBuilder()
     .setColor(0xC62828)
     .setTitle('🚒 SSFD | Certificação de Curso')
     .setDescription([
      `**Curso concluído: ${courseName}**`,
      '',
      'O **South State Fire Department** parabeniza os bombeiros que concluíram com êxito as etapas de formação e avaliação:',
      '',
      membersList,
      '',
      'A dedicação, a disciplina e o preparo demonstrados representam um importante avanço em suas trajetórias na corporação.',
      '',
      '**Parabéns aos concluintes!** 🏅'
     ].join('\n'))
     .addFields({name:'Curso atribuído por',value:`<@${interaction.user.id}>`,inline:false})
     .setFooter({text:'South State Fire Department • Formação e excelência'})
     .setTimestamp();
    try{await ch.send({embeds:[embed],allowedMentions:{parse:[],users:granted}});}
    catch(err){console.error('[Gestão] Falha no anúncio de curso:',err);notice='⚠️ Os cargos foram atribuídos, mas não foi possível publicar o anúncio. Verifique as permissões do canal.';}
   }
  }
  const parts=[operation==='grant'?`**${granted.length}** membro(s) receberam o curso **${key}**.`:`Curso **${key}** removido de **${removed.length}** membro(s).`];
  if(already.length)parts.push(`**${already.length}** sem alteração (já possuíam o curso ou não tinham o cargo).`);
  if(failed.length)parts.push(`**${failed.length}** falha(s) ao modificar cargos. Confira a hierarquia do bot.`);
  if(notice)parts.push(notice);
  return interaction.editReply({content:parts.join('\n'),components:[]});
 }
 if(id.startsWith('gest:editmodal:')&&interaction.isModalSubmit()){
  await interaction.deferReply(ephemeral);const target=id.split(':')[2],name=clean(interaction.fields.getTextInputValue('name')),rpId=clean(interaction.fields.getTextInputValue('rpId')),phone=clean(interaction.fields.getTextInputValue('phone'));
  if(!name||!/^[A-Za-z0-9]{1,15}$/.test(rpId))return interaction.editReply('Nome inválido ou ID inválido (1–15 letras e/ou números).');
  const m=await memberFor(interaction,target);if(!m)return interaction.editReply('Membro não encontrado.');
  const r=reg(interaction.guildId,target),snap=await r.get();if(!snap.exists)return interaction.editReply('Cadastro não encontrado.');
  await r.update({name,rpId,phone:phone||null,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  const nickname=`${rpId} | ${name}`.slice(0,32);let nickStatus='';try{await m.setNickname(nickname,`Gestão de Cargos por ${interaction.user.id}`);nickStatus=' Apelido atualizado.';}catch(e){nickStatus=' Não foi possível alterar o apelido (verifique permissões e hierarquia).';}
  await log(interaction,target,'edit_profile',{name,rpId,phone});
  return interaction.editReply(`Cadastro de <@${target}> atualizado.${nickStatus}`);
 }
 if(id.startsWith('gest:dismissreason:')&&interaction.isButton()){
  const target=id.split(':')[2];
  const modal=new ModalBuilder().setCustomId(`gest:dismissmodal:${target}`).setTitle('Motivo da exoneração');
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motivo da exoneração').setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(900).setRequired(true)));
  return interaction.showModal(modal);
 }
 if(id.startsWith('gest:dismissmodal:')&&interaction.isModalSubmit()){
  const target=id.split(':')[2],reason=interaction.fields.getTextInputValue('reason').trim();
  if(reason.length<5)return interaction.reply({content:'Informe um motivo com pelo menos cinco caracteres.',...ephemeral});
  const m=await memberFor(interaction,target);
  if(!m||hasAnyRole(m,admins))return interaction.reply({content:'Membro não encontrado ou protegido contra exoneração.',...ephemeral});
  dismissalDrafts.set(dismissalKey(interaction),{target,reason,createdAt:Date.now()});
  return interaction.reply({content:`**Confirme a exoneração**\n**Bombeiro:** <@${target}>\n**Motivo:** ${reason}\n\nSerão retiradas a patente e o cargo Bombeiros. Os cursos serão mantidos e suas certificações preservadas.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gest:confirmdismiss:${target}`).setLabel('Confirmar exoneração').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('gest:cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]},...ephemeral});
 }
 if(id.startsWith('gest:confirmdismiss:')&&interaction.isButton()){
  const target=id.split(':')[2],draft=dismissalDrafts.get(dismissalKey(interaction));
  if(!draft||draft.target!==target||Date.now()-draft.createdAt>10*60*1000)return interaction.update({content:'Confirmação expirada. Inicie novamente a exoneração.',components:[]});
  dismissalDrafts.delete(dismissalKey(interaction));
  await interaction.deferUpdate();
  const m=await memberFor(interaction,target);
  if(!m||hasAnyRole(m,admins))return interaction.editReply({content:'Membro não encontrado ou protegido contra exoneração.',components:[]});
  const ch=await interaction.guild.channels.fetch(EXONERATION_CHANNEL).catch(()=>null);
  if(!ch?.isTextBased()||typeof ch.send!=='function')return interaction.editReply({content:'Canal de Exoneração indisponível. Nenhum cargo foi removido.',components:[]});
  const toRemove=[...new Set([...rankKeys.map(k=>roles[k]),roles.bombeiros])].filter(role=>m.roles.cache.has(role));
  const previousRanks=rankKeys.filter(k=>m.roles.cache.has(roles[k]));
  const previousCourses=Object.keys(courses).filter(k=>m.roles.cache.has(courses[k]));
  const ref=reg(interaction.guildId,target),existing=await ref.get();
  if(existing.data()?.status==='dismissed')return interaction.editReply({content:'Este usuário já consta como exonerado. Nenhuma alteração foi feita.',components:[]});
  try{if(toRemove.length)await m.roles.remove(toRemove,`Exoneração por ${interaction.user.id}: ${draft.reason.slice(0,150)}`);}
  catch(err){console.error('[Gestão] Exoneração:',err);return interaction.editReply({content:'Falha ao remover cargos. Verifique a hierarquia e as permissões do bot.',components:[]});}
  const data={status:'dismissed',dismissedBy:interaction.user.id,dismissalReason:draft.reason,dismissedAt:admin.firestore.FieldValue.serverTimestamp(),previousRanks,previousCourses,courseCertifications:[...new Set([...(Array.isArray(existing.data()?.courseCertifications)?existing.data().courseCertifications:[]),...previousCourses])],previousRoleIds:toRemove,returnEligibleUntilLeave:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
  let storageWarning='';
  try{await ref.set(data,{merge:true});await log(interaction,target,'dismissed',{reason:draft.reason,removedRoleIds:toRemove,previousRanks,previousCourses});}
  catch(err){console.error('[Gestão] Persistência exoneração:',err);storageWarning='\n⚠️ Falha ao registrar no Firebase. Confira os logs antes de prosseguir.';}
  const embed=new EmbedBuilder().setColor(0xd92929).setTitle('🚒 SSFD | Comunicado de Exoneração')
   .setDescription(`**Bombeiro exonerado:** <@${target}>\n**Responsável:** <@${interaction.user.id}>`)
   .addFields({name:'Motivo',value:draft.reason},{name:'Informações sobre retorno',value:'Você poderá retornar ao SSFD. Permanecerá por **7 dias como Cadete** e, após esse período, poderá recuperar sua patente anterior e os cursos concluídos, conforme as regras da corporação.\n\n**Cursos concluídos:** as certificações registradas permanecem no banco de dados, mesmo após a saída do servidor, e poderão ser restauradas pela Gestão de Cargos.'},{name:'Dúvidas',value:`Entre em contato com <@${interaction.user.id}> ou com alguém do comando do SSFD.`})
   .setFooter({text:'South State Fire Department • Exoneração'}).setTimestamp();
  let announceWarning='';
  try{await ch.send({content:`<@${target}>`,embeds:[embed],allowedMentions:{parse:[],users:[target]}});}
  catch(err){console.error('[Gestão] Publicação exoneração:',err);announceWarning='\n⚠️ Cargos removidos, mas não foi possível publicar no canal de Exoneração.';}
  return interaction.editReply({content:`Exoneração de <@${target}> processada.${storageWarning}${announceWarning}`,components:[],allowedMentions:{parse:[]}});
 }
 return interaction.reply({content:'Ação de Gestão de Cargos desconhecida.',...ephemeral});
}
module.exports={panel,handleGestao};
