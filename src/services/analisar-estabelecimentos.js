'use strict';
const { AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { db } = require('./firebase');
const { roles } = require('../config/ids');
const { hasAnyRole } = require('../utils/permissions');
const CHANNEL_ID = '1477673762596978828';
const LIMIT = 10000;
const missing = v => !v || /^(?:n[aã]o\s+(?:informad[oa]|h[aá])|nenhum|nenhuma|n\/?a|sem\s+(?:dados|s[oó]cios?))$/i.test(v.trim());
const value = v => missing(v) ? '' : String(v || '').trim().slice(0,200);
const cnpjKey = v => { const digits=String(v||'').replace(/\D/g,''); return digits.length===14 ? digits : ''; };
const validCnpj = v => { const d=cnpjKey(v); if(!d || /^(\d)\1{13}$/.test(d)) return false; const check=(len)=>{let sum=0,weight=len-7; for(let j=0;j<len;j++){sum+=Number(d[j])*weight--;if(weight<2)weight=9;} const mod=sum%11;return Number(d[len])===(mod<2?0:11-mod);}; return check(12)&&check(13); };
const displayCnpj = v => { const raw=value(v); return cnpjKey(raw) ? raw : ''; };
const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const nameTokens = v => new Set(String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
function similar(a,b) {
 if (!a || !b) return 0;
 if (norm(a) === norm(b)) return 1;
 const x=nameTokens(a),y=nameTokens(b),intersection=[...x].filter(t=>y.has(t)).length;
 return intersection/Math.max(x.size,y.size,1);
}
function textOf(m) {
 return [m.content||'',...(m.embeds||[]).map(e=>[e.title,e.description,...(e.fields||[]).map(f=>`${f.name}: ${f.value}`)].filter(Boolean).join('\n'))].join('\n');
}
function parse(m) {
 const lines=textOf(m).replace(/\*\*/g,'').replace(/\r/g,'').split('\n').map(s=>s.trim().replace(/^[•-]\s*/, '')).filter(Boolean);
 let section='other',person=null, owner=null,partners=[],business={}, explicitNoPartners=false;
 const flush=()=>{
  if(!person) return;
  if(section==='partners'){
   if(value(person.name) && (norm(person.name)!==norm(owner?.name) || (person.rpId && owner?.rpId && person.rpId!==owner.rpId))) {
    if(!partners.some(p=>norm(p.name)===norm(person.name) && p.rpId===person.rpId))partners.push(person);
   }
  }else if(section==='owner' && (!owner || !owner.name)) owner=person;
  person=null;
 };
 for(const line of lines){
  if(/^(?:[-=_]{3,}|alvar[aá]s?\s+e\s+cnpj\s*:?|\*+)$/i.test(line))continue;
  const ownerHeader=line.match(/^propriet[aá]ri[oa]\s*:\s*(.+)$/i);
  if(ownerHeader){flush();section='owner';person={name:value(ownerHeader[1]),rpId:'',phone:''};continue;}
  if(/^propriet[aá]ri[oa]\s*:?$/i.test(line)){flush();section='owner';person={name:'',rpId:'',phone:''};continue;}
  const partnersHeader=line.match(/^s[oó]ci(?:os?|a(?:\))?)\s*:\s*(.*)$/i);
  if(partnersHeader){flush();section='partners';if(/n[aã]o\s+h[aá]|nenhum/i.test(partnersHeader[1]))explicitNoPartners=true;continue;}
  if(/^s[oó]ci[oa]\s*\d+\s*:?$/i.test(line)){flush();section='partners';continue;}
  const kv=line.match(/^([^:]{2,55})\s*:\s*(.*)$/);
  if(!kv)continue;
  const key=norm(kv[1]),v=value(kv[2]);
  if(['estabelecimento','nomedoestabelecimento','empresa','nomefantasia','razaosocial','nomefantasiarazaosocial','instituicao'].includes(key)) {if(v && !business.name)business.name=v;continue;}
  if(key==='cnpj'){if(v){business.cnpjRaw=v;if(displayCnpj(v))business.cnpj=displayCnpj(v);}continue;}
  if(['localdoestabelecimento','localizacao','regiao'].includes(key)){if(v)business.location=v;continue;}
  if(['finscomerciais','ramodeatividade','finscomerciaisramodeatividade','atividade','tipo','segmento'].includes(key)){if(v)business.type=v;continue;}
  if(['datadeemissao','emissao'].includes(key)){if(v)business.issueDate=v;continue;}
  if(key.startsWith('advogado')||key.startsWith('juiza')||key.startsWith('juiz')||key==='oar'){if(v)business.legalOfficer=v;continue;}
  if(['nome','sra','contato','telefone','telefonedecontato','passaporte','passaporteid','id'].includes(key)){
   if(section==='other')section='owner';
   if(!person)person={name:'',rpId:'',phone:''};
   if(['nome','sra'].includes(key) && person.name && v && norm(person.name)!==norm(v)){flush();person={name:'',rpId:'',phone:''};}
   if(['nome','sra'].includes(key))person.name=v;
   else if(['passaporte','passaporteid','id'].includes(key))person.rpId=v;
   else person.phone=v;
  }
 }
 flush();
 if(!business.name && !business.cnpj)return null;
 // Keep the repeated owner block from becoming a partner.
 partners=partners.filter(p=>!(norm(p.name)===norm(owner?.name) && (!p.rpId||!owner?.rpId||p.rpId===owner.rpId)));
 return {...business,owner:owner||{name:'',rpId:'',phone:''},partners:explicitNoPartners?[]:partners,explicitNoPartners,
  sourceId:m.id,sourceUrl:m.url,messageDate:m.createdAt.toISOString(),sample:textOf(m).slice(0,900)};
}
function dateValue(r){
 const v=r.issueDate||'';
 const numeric=v.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
 if(numeric)return `${numeric[3]}-${numeric[2].padStart(2,'0')}-${numeric[1].padStart(2,'0')}`;
 const monthNames={janeiro:1,fevereiro:2,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12};
 const m=v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
 if(m&&monthNames[m[2]])return `${m[3]}-${String(monthNames[m[2]]).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
 return '';
}
function groupRecords(records){
 // One group per exact normalized commercial name, regardless of CNPJ changes.
 // Different names sharing CNPJ are kept separate and flagged for human review.
 // This avoids creating multiple groups for recurring alvarás with inconsistent CNPJs.
 const byName=new Map(),groups=[];
 for(const r of records){
  const key=norm(r.name);
  if(!key){groups.push({records:[r],mergeConflict:true,unidentifiedName:true});continue;}
  if(!byName.has(key)){
   const group={records:[],mergeConflict:false,unidentifiedName:false};
   byName.set(key,group);groups.push(group);
  }
  byName.get(key).records.push(r);
 }
 for(const g of groups){
  g.records.sort((a,b)=>(dateValue(b)||b.messageDate.slice(0,10)).localeCompare(dateValue(a)||a.messageDate.slice(0,10)) || b.messageDate.localeCompare(a.messageDate));
  const newest=g.records[0];
  const valid=field=>g.records.find(r=>value(r[field]))?.[field]||'';
  const ownerField=k=>g.records.find(r=>value(r.owner?.[k]))?.owner?.[k]||'';
  g.latest={...newest,name:valid('name'),cnpj:valid('cnpj'),location:valid('location'),type:valid('type'),owner:{name:ownerField('name'),rpId:ownerField('rpId'),phone:ownerField('phone')}};
  g.cnpjConflict=new Set(g.records.map(r=>cnpjKey(r.cnpj)).filter(Boolean)).size>1;
  g.locationSuspicious=g.records.some(r=>r.location && norm(r.location)===norm(r.name));
  g.cnpjInvalid=g.records.some(r=>r.cnpjRaw && !cnpjKey(r.cnpjRaw));
  g.cnpjCheckDigitWarning=g.records.some(r=>cnpjKey(r.cnpj) && !validCnpj(r.cnpj));
  g.ownerConflict=new Set(g.records.map(r=>norm(r.owner?.name)).filter(Boolean)).size>1;
  g.nameConflict=new Set(g.records.map(r=>norm(r.name)).filter(Boolean)).size>1;
  g.latest.partners=newest.explicitNoPartners?[]:newest.partners.length?newest.partners:(g.records.find(r=>r.partners.length)?.partners||[]);
  g.latest.partnersStatus=newest.explicitNoPartners?'nenhum':newest.partners.length?'informados':'não confirmado';
 }
 return groups;
}
const csvCell=v=>'"'+String(v??'').replace(/"/g,'""').replace(/\r?\n/g,' ')+'"';
async function handleAnalysis(i){
 if(!i.inGuild())return i.reply({content:'Use este comando no servidor.',flags:MessageFlags.Ephemeral});
 if(!hasAnyRole(i.member,[roles.juridico,roles.chefe,roles.chefeAdjunto,roles.chefeBatalhao]))
  return i.reply({content:'Acesso restrito ao Jurídico, comando e Manutenção.',flags:MessageFlags.Ephemeral});
 await i.deferReply({flags:MessageFlags.Ephemeral});
 try{
  const channel=await i.guild.channels.fetch(CHANNEL_ID);
  if(!channel?.messages?.fetch)return i.editReply('O canal antigo não está acessível pelo bot neste servidor.');
  const self=await i.guild.members.fetchMe();
  if(!channel.permissionsFor(self)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))
   return i.editReply('Faltam permissões Ver Canal e/ou Ler Histórico de Mensagens no canal antigo.');
  let before,scanned=0,records=[],unparsed=[],complete=false;
  while(scanned<LIMIT){
   const page=await channel.messages.fetch({limit:Math.min(100,LIMIT-scanned),...(before?{before}:{})});
   if(!page.size){complete=true;break;}
   scanned+=page.size;
   for(const m of page.values()){
    if(m.author?.bot)continue;
    const r=parse(m);
    if(r)records.push(r);
    else if(/alvar[aá]|cnpj|propriet[aá]ri|estabelecimento/i.test(textOf(m)))unparsed.push({url:m.url,date:m.createdAt.toISOString(),excerpt:textOf(m).slice(0,350)});
   }
   before=page.last().id;
   if(page.size<100){complete=true;break;}
  }
  const groups=groupRecords(records);
  const cnpjToGroups=new Map();
  for(const g of groups)for(const c of new Set(g.records.map(r=>cnpjKey(r.cnpj)).filter(Boolean))){
   if(!cnpjToGroups.has(c))cnpjToGroups.set(c,new Set());
   cnpjToGroups.get(c).add(g);
  }
  const snap=await db.collection('guilds').doc(i.guildId).collection('establishments').get();
  const existing=snap.docs.map(d=>({id:d.id,...d.data()}));
  groups.forEach((g,idx)=>{
   g.id=idx+1;
   const sharedCnpj=new Set(g.records.map(r=>cnpjKey(r.cnpj)).filter(Boolean));
   g.possibleDuplicates=groups.filter(other=>other!==g && (
    similar(g.latest.name,other.latest.name)>=0.6 ||
    other.records.some(r=>sharedCnpj.has(cnpjKey(r.cnpj)) && cnpjKey(r.cnpj))
   )).map(other=>({id:groups.indexOf(other)+1,name:other.latest.name,
    sameCnpj:other.records.some(r=>sharedCnpj.has(cnpjKey(r.cnpj)) && cnpjKey(r.cnpj))}));
   g.existingMatches=existing.filter(e=>(cnpjKey(e.cnpj)&&g.records.some(r=>cnpjKey(r.cnpj)===cnpjKey(e.cnpj))) || similar(g.latest.name,e.name)>=0.6).map(e=>({id:e.id,name:e.name,active:e.active!==false}));
   g.reviewRequired=!!(g.mergeConflict||g.cnpjConflict||g.cnpjInvalid||g.cnpjCheckDigitWarning||g.locationSuspicious||g.ownerConflict||g.nameConflict||g.possibleDuplicates.length||g.existingMatches.length||
    !g.latest.name||!g.latest.owner.name||!g.latest.owner.rpId||!g.latest.location||!g.latest.owner.phone);
  });
  const report={mode:'READ_ONLY',channelId:CHANNEL_ID,scanned,complete,parsed:records.length,unparsed,existingCount:existing.length,
   groupingRule:'exact_normalized_name_only; CNPJ conflicts and similar names flagged for review',groups:groups.map(g=>({id:g.id,latest:g.latest,occurrences:g.records.length,reviewRequired:g.reviewRequired,
    conflicts:{merge:g.mergeConflict,cnpj:g.cnpjConflict,cnpjInvalid:g.cnpjInvalid,cnpjCheckDigitWarning:g.cnpjCheckDigitWarning,locationSuspicious:g.locationSuspicious,owner:g.ownerConflict,name:g.nameConflict},possibleDuplicates:g.possibleDuplicates,
    existingMatches:g.existingMatches,history:g.records}))};
  const header=['grupo','estabelecimento','cnpj','localizacao','atividade','proprietario','passaporte','contato','socios','data_emissao','ocorrencias','revisar','possiveis_duplicatas','firebase','fonte'];
  const csv=[header.map(csvCell).join(',')];
  for(const g of groups){const r=g.latest;csv.push([g.id,r.name,r.cnpj,r.location,r.type,r.owner.name,r.owner.rpId,r.owner.phone,
   r.partners.map(p=>`${p.name} (${p.rpId}; ${p.phone})`).join(' | '),r.issueDate,g.records.length,g.reviewRequired?'SIM':'NÃO',
   g.possibleDuplicates.map(x=>`${x.id}:${x.name}`).join(' | '),g.existingMatches.map(x=>`${x.id}:${x.name}`).join(' | '),r.sourceUrl].map(csvCell).join(','));}
  const json=Buffer.from(JSON.stringify(report,null,2),'utf8');
  const csvBuffer=Buffer.from('\ufeff'+csv.join('\r\n'),'utf8');
  const tooLarge=json.length>7*1024*1024||csvBuffer.length>7*1024*1024;
  const desc=`**Mensagens lidas:** ${scanned}${complete?'':' (limite de segurança atingido)'}\n**Documentos reconhecidos:** ${records.length}\n**Nomes distintos agrupados:** ${groups.length}\n**Possíveis mensagens não reconhecidas:** ${unparsed.length}\n**Grupos para revisão:** ${groups.filter(g=>g.reviewRequired).length}\n**CNPJs divergentes no mesmo nome:** ${groups.filter(g=>g.cnpjConflict).length}\n**CNPJs inválidos ou incompletos:** ${groups.filter(g=>g.cnpjInvalid||g.cnpjCheckDigitWarning).length}\n**Cadastros existentes no Firebase:** ${existing.length}\n\n**Nenhum cadastro foi criado, alterado ou excluído.**${tooLarge?'\n⚠️ Relatório excedeu o limite de arquivo do Discord. Consulte os logs e solicite exportação em partes.':''}`;
  await i.editReply({embeds:[new EmbedBuilder().setTitle('🚒 SSFD | Prévia de estabelecimentos').setColor(0xd92929).setDescription(desc)],
   files:tooLarge?[]:[new AttachmentBuilder(csvBuffer,{name:'estabelecimentos-revisao.csv'}),new AttachmentBuilder(json,{name:'estabelecimentos-historico.json'})]});
 }catch(err){console.error('[Análise de estabelecimentos]',err);await i.editReply('Não foi possível concluir a análise. Consulte os logs do serviço. Nenhum cadastro foi alterado.');}
}
module.exports={handleAnalysis,parse,groupRecords};
