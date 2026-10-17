const {EmbedBuilder}=require('discord.js');
const {db,admin}=require('./firebase');
const CHANNEL_ID='1560709138567139388';
let client;
function initAdministrativeLogs(discordClient){client=discordClient;}
const {roles,courses}=require('../config/ids');
const names={registration_approved:'Cadastro autorizado',registration_rejected:'Cadastro recusado',registration_manual:'Cadastro manual de bombeiro',manual_rank_change:'Alteração de patente',edit_profile:'Dados do bombeiro editados',course_granted:'Curso atribuído',course_revoked:'Curso removido',courses_restored:'Cursos restaurados',courses_synchronized:'Sincronização de cursos',course_scheduled:'Treinamento agendado',dismissed:'Exoneração',automatic_promotion:'Promoção automática',ranking_reset:'Ranking de ponto reiniciado',nickname_batch:'Padronização de apelidos',inspection_created:'Estabelecimento cadastrado',inspection_edited:'Estabelecimento editado',inspection_deleted:'Estabelecimento excluído',inspection_scheduled:'Vistoria agendada',inspection_contacted:'Contato com estabelecimento',inspection_completed:'Vistoria concluída',inspection_cancelled:'Vistoria cancelada'};
const rankNames={chefe:'Chefe',chefeAdjunto:'Chefe Adjunto',chefeBatalhao:'Chefe de Batalhão',capitao:'Capitão',tenente:'Tenente',bombeiroIII:'Bombeiro III',bombeiroII:'Bombeiro II',bombeiroI:'Bombeiro I',cadete:'Cadete'};
const courseNames={fireEngineering:'Engenharia de Incêndio',fiu:'FIU',pac:'PAC',ems:'EMS',specOpsHighRisk:'Operações de Alto Risco',specOpsFlight:'Operações Aéreas',specOpsSea:'Operações Marítimas',pqd:'PQD',preventionBureau:'Prevenção',trainingDivision:'Divisão de Treinamento'};
const scrub=(value,max=950)=>String(value??'Não informado').replace(/@/g,'＠').replace(/`/g,"'").replace(/[\r\n]+/g,' ').slice(0,max);
const pretty=k=>rankNames[k]||courseNames[k]||({reason:'Motivo',removedRoleIds:'Cargos removidos',previousRanks:'Patentes anteriores',previousCourses:'Cursos preservados',course:'Curso',courses:'Cursos',previous:'Patente anterior',newRank:'Nova patente',name:'Nome',rpId:'ID no RP',phone:'Telefone',membersScanned:'Membros analisados',membersWithCourses:'Membros com cursos',registrationsUpdated:'Cadastros atualizados',certificationsAdded:'Certificações adicionadas',registrationsCreated:'Novos cadastros criados',unchanged:'Cadastros sem alterações',failed:'Falhas',CertificacoesNovas:'Novas certificações',Registro:'Situação do cadastro',reportUrl:'Relatório',Vistoria:'Identificador da vistoria'})[k]||k.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
const roleName=(id,guild)=>{
 if(id===roles.bombeiros)return 'Bombeiros';
 const found=Object.entries(roles).find(([,value])=>value===id);
 return found?(rankNames[found[0]]||guild?.roles.cache.get(id)?.name||pretty(found[0])):(guild?.roles.cache.get(id)?.name||`Cargo ${id}`);
};
const val=(k,v,guild)=>{
 if(Array.isArray(v))return v.length?v.map(x=>k==='removedRoleIds'?roleName(x,guild):pretty(x)).join(', '):'Nenhum';
 if(k==='course'||k==='courses'||k==='previousCourses'||k==='newRank'||k==='previous'||k==='Patente')return pretty(String(v));
 if(k==='reportUrl'&&/^https:\/\/discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/.test(String(v)))return `[Abrir relatório](${v})`;
 if(v&&typeof v==='object')return 'Informações registradas no histórico';
 return scrub(v,650);
};
function formatted(type,details,guild){
 const d=details||{};
 if(type==='courses_synchronized')return '**Resumo da sincronização**\nOs cargos de cursos foram conferidos e as certificações encontradas foram registradas no Firebase.\n\n'+['membersScanned','membersWithCourses','registrationsUpdated','certificationsAdded','registrationsCreated','unchanged','failed'].filter(k=>d[k]!==undefined).map(k=>`**${pretty(k)}:** ${val(k,d[k],guild)}`).join('\n');
 if(type==='dismissed')return [d.reason&&`**Motivo da exoneração**\n${scrub(d.reason,750)}`,d.removedRoleIds&&`**Cargos removidos:** ${val('removedRoleIds',d.removedRoleIds,guild)}`,d.previousRanks&&`**Patentes anteriores:** ${val('previousRanks',d.previousRanks,guild)}`,d.previousCourses&&`**Cursos registrados no histórico:** ${val('previousCourses',d.previousCourses,guild)}`].filter(Boolean).join('\n\n');
 if(type.startsWith('inspection_')){
  const lines=[d.Estabelecimento&&`**Estabelecimento:** ${scrub(d.Estabelecimento,200)}`,d.CNPJ&&`**CNPJ:** ${scrub(d.CNPJ,40)}`,d.Localização&&`**Localização:** ${scrub(d.Localização,100)}`,d.Data&&`**Data agendada:** ${scrub(d.Data,80)}`,d.reportUrl&&`**Relatório:** ${val('reportUrl',d.reportUrl,guild)}`,d.reason&&`**Motivo:** ${scrub(d.reason,700)}`].filter(Boolean);
  if(!d.Estabelecimento&&d.Vistoria)lines.unshift('**Estabelecimento:** Não identificado no registro');
  return lines.join('\n')||'Operação registrada no histórico de vistorias.';
 }
 return Object.entries(d).slice(0,15).map(([k,v])=>`**${pretty(k)}:** ${val(k,v,guild)}`).join('\n').slice(0,3900)||'Operação registrada com sucesso.';
}
/** Nunca lança erro para o fluxo administrativo: a operação principal não depende do canal. */
async function administrativeLog(guildId,type,{actorId=null,targetId=null,details={},key=null}={}){
 try{
  const payload={type,actorId:actorId||null,targetId:targetId||null,details,at:admin.firestore.FieldValue.serverTimestamp()};
  const collection=db.collection('guilds').doc(guildId).collection('administrativeLogs');
  const ref=key?collection.doc(key):collection.doc();
  if(key){try{await ref.create(payload);}catch(e){if(e.code===6||e.code==='already-exists')return;throw e;}}
  else await ref.set(payload);
  const guild=client?.guilds.cache.get(guildId);if(!guild)return;
  const channel=await guild.channels.fetch(CHANNEL_ID).catch(()=>null);
  if(!channel?.isTextBased()||typeof channel.send!=='function')return;
  const embed=new EmbedBuilder().setColor(type==='dismissed'||type==='registration_rejected'?0xc62828:type==='inspection_completed'||type==='courses_restored'?0x27875a:0x247a9e)
   .setTitle(`🚒 SSFD | ${names[type]||'Ação administrativa'}`)
   .addFields({name:'Responsável',value:actorId?`<@${actorId}>`:'Sistema automático',inline:true},...(targetId?[{name:'Membro',value:`<@${targetId}>`,inline:true}]:[]))
   .setFooter({text:'Bombeirinho • Registro administrativo'}).setTimestamp();
  embed.setDescription(formatted(type,details,guild).slice(0,4000));
  await channel.send({embeds:[embed],allowedMentions:{parse:[]}});
 }catch(e){console.error('[Logs Administrativos] Falha (operação principal preservada):',type,e);}
}
module.exports={initAdministrativeLogs,administrativeLog};
