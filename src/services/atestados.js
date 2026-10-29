'use strict';

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { db, admin } = require('./firebase');
const { channels, roles } = require('../config/ids');

const EP = MessageFlags.Ephemeral;
const ROOT = path.join(__dirname, '..', 'assets', 'atestados');
const LOGO = fs.readFileSync(path.join(ROOT, 'cabecalho.png')).toString('base64');
const WATERMARK = fs.readFileSync(path.join(ROOT, 'marca-dagua.png')).toString('base64');
const SEAL = fs.readFileSync(path.join(ROOT, 'selo.png')).toString('base64');
const guildDoc = id => db.collection('guilds').doc(id);
const places = id => guildDoc(id).collection('establishments');
const drafts = id => guildDoc(id).collection('attestationDrafts');
const documents = id => guildDoc(id).collection('attestations');
const clauses = [
  'Fluxos e redes de GLP (Gás Liquefeito de Petróleo) e/ou fontes de gases inflamáveis;',
  'Checagem de materiais combustíveis não permitidos;',
  'Sistemas de exaustão de fumaça para locais não ventilados;',
  'Estrutura predial sem avarias, incluindo condições básicas sanitárias;',
  'Locais de coleta de lixo e entulho organizados e sinalizados;',
  'Instalações elétricas prediais regulares;',
  'Normas de higiene sanitárias para estoque e manuseio de alimentos.'
];
const escape = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const clean = (text, max = 180) => String(text ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);
const normalize = text => clean(text, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const rankIds = [roles.cadete, roles.bombeiroI, roles.bombeiroII, roles.bombeiroIII, roles.tenente, roles.capitao, roles.chefe, roles.chefeAdjunto, roles.chefeBatalhao, roles.manutencao];
const rankNames = new Map([
  [roles.cadete, 'Cadete'], [roles.bombeiroI, 'Bombeiro I'], [roles.bombeiroII, 'Bombeiro II'],
  [roles.bombeiroIII, 'Bombeiro III'], [roles.tenente, 'Tenente'], [roles.capitao, 'Capitão'],
  [roles.chefe, 'Chefe'], [roles.chefeAdjunto, 'Chefe Adjunto'], [roles.chefeBatalhao, 'Chefe de Batalhão']
]);

function panel() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle('SSFD | Emissão de Atestados')
      .setDescription('Emita um atestado de segurança predial para um estabelecimento cadastrado. Confira a prévia antes de publicar no fórum de relatórios.')
      .setColor(0xef1427)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId('atest:start').setLabel('Emitir atestado').setStyle(ButtonStyle.Primary))]
  };
}

async function ensurePanel(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = await guild.channels.fetch(channels.emissaoAtestados);
      if (!channel?.isTextBased() || !channel.messages?.fetch) continue;
      const ref = guildDoc(guild.id).collection('panels').doc('emissaoAtestados');
      const snap = await ref.get();
      let message = snap.data()?.messageId ? await channel.messages.fetch(snap.data().messageId).catch(() => null) : null;
      if (message?.author?.id !== client.user.id || !message.components?.some(row => row.components.some(button => button.customId === 'atest:start'))) message = null;
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 });
        message = recent.find(m => m.author.id === client.user.id && m.components?.some(row => row.components.some(button => button.customId === 'atest:start'))) || null;
      }
      message = message ? await message.edit(panel()) : await channel.send(panel());
      await ref.set({ channelId: channel.id, messageId: message.id }, { merge: true });
    } catch (error) {
      console.error('[Atestados] Falha ao configurar painel:', error);
    }
  }
}

function stripRpPrefix(value) {
  return clean(value, 100).replace(/^\s*(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|ID\s*[:#-]?\s*\d+)\s*[-|:]?\s*/i, '').trim();
}

// Quebra por largura estimada de glifos, não por número de caracteres.
// textLength abaixo garante que nenhuma linha ultrapasse a margem mesmo com variação de fonte.
function approximateWidth(value, size, bold = false) {
  return [...String(value)].reduce((sum, c) => {
    if ('ilI1.,:;!|\' '.includes(c)) return sum + size * .30;
    if ('MW@%'.includes(c)) return sum + size * .92;
    if (/[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(c)) return sum + size * .69;
    return sum + size * (bold ? .61 : .57);
  }, 0);
}
function wrapWidth(value, maxWidth, size = 23, bold = false) {
  const words = clean(value, 2500).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && approximateWidth(next, size, bold) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}
function textLine(value, x, y, opts = {}) {
  const { size = 23, width = 970, weight = 400, anchor = 'start' } = opts;
  const text = clean(value, 2500);
  const actual = approximateWidth(text, size, weight === 700);
  const target = Math.min(width, Math.max(1, actual));
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" textLength="${target.toFixed(1)}" lengthAdjust="spacingAndGlyphs" fill="#151515">${escape(text)}</text>`;
}
function block(value, x, y, opts = {}) {
  const { size = 23, width = 970, height = 29, weight = 400, maxLines = 99 } = opts;
  const lines = wrapWidth(value, width * .95, size, weight === 700).slice(0, maxLines);
  return { svg: lines.map((line, idx) => textLine(line, x, y + idx * height, { size, width, weight })).join(''), end: y + lines.length * height, lines: lines.length };
}

// A fonte manuscrita é transformada em contornos vetoriais e não depende do fontconfig da Oracle.
const handwriting = require('../assets/atestados/autography-glyphs.json');
function signaturePath(value, centerX, baseline, maxWidth = 450, fontSize = 65) {
  const name = stripRpPrefix(value);
  const glyphs = handwriting.glyphs;
  const units = handwriting.unitsPerEm;
  const advance = [...name].reduce((a, c) => a + (glyphs[c]?.a || glyphs[' ']?.a || units * .4), 0);
  const scale = Math.min(fontSize / units, maxWidth / Math.max(advance, 1));
  let x = centerX - advance * scale / 2;
  let paths = '';
  for (const c of name) {
    const glyph = glyphs[c] || glyphs[' '];
    if (glyph?.d) paths += `<path d="${glyph.d}" transform="translate(${x.toFixed(3)} ${baseline}) scale(${scale.toFixed(6)} ${(-scale).toFixed(6)})" fill="#151515"/>`;
    x += (glyph?.a || units * .4) * scale;
  }
  return paths;
}

async function renderPNG(data) {
  const sharp = require('sharp');
  const w = 1024, h = 1449;
  const date = new Date(data.inspectedAt);
  const due = new Date(date);
  due.setUTCDate(due.getUTCDate() + 15);
  const displayDate = value => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  const longDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const inspector = stripRpPrefix(data.inspectorName);
  const intro = `O Corpo de Bombeiros vem por meio desse atestado, afirmar que o estabelecimento ${data.placeName} segue as seguintes conformidades:`;
  const introduction = block(intro, 27, 365, { size: 23, width: 965, height: 29 });
  let cursor = Math.max(457, introduction.end + 33);
  const clauseMarkup = clauses.map(clause => {
    const lines = block(clause, 50, cursor, { size: 22, width: 930, height: 27 });
    const result = `<circle cx="34" cy="${cursor - 7}" r="7" fill="#000"/>${lines.svg}`;
    cursor = lines.end + 10;
    return result;
  }).join('');
  const infoY = Math.max(826, cursor + 28);
  const colWidth = 465;
  const leftX = 25, rightX = 548;
  const ownerName = block(`Nome: ${data.ownerName}`, leftX, infoY + 33, { size: 21, width: colWidth, height: 25 });
  const inspectorName = block(`Nome: ${inspector}`, rightX, infoY + 33, { size: 21, width: colWidth, height: 25 });
  const leftPassY = ownerName.end + 1;
  const rightPassY = inspectorName.end + 1;
  const leftPhoneY = leftPassY + 27;
  const rightPhoneY = rightPassY + 27;
  const observationsY = Math.max(leftPhoneY, rightPhoneY) + 39;
  const observations = block(data.observations || 'Sem observações.', 25, observationsY + 30, { size: 22, width: 970, height: 26, maxLines: 5 });
  const statusY = Math.max(1186, observations.end + 34);
  if (statusY > 1210) throw new Error('Texto muito longo para caber no atestado. Reduza as observações.');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="1024" height="1449" fill="#fff"/>
    <image href="data:image/png;base64,${WATERMARK}" x="132" y="400" width="760" height="760" opacity="0.22"/>
    <image href="data:image/png;base64,${LOGO}" x="315" y="15" width="394" height="135" preserveAspectRatio="xMidYMid meet"/>
    ${textLine('ATESTADO DE', 512, 196, { size: 52, weight: 700, width: 950, anchor: 'middle' })}
    ${textLine('SEGURANÇA PREDIAL', 512, 257, { size: 52, weight: 700, width: 950, anchor: 'middle' })}
    ${textLine('Rua2, ' + longDate, 512, 310, { size: 29, width: 920, anchor: 'middle' })}
    ${introduction.svg}
    ${clauseMarkup}
    ${textLine('Informações do Solicitante:', leftX, infoY, { size: 23, width: colWidth })}
    ${textLine('Informações do Resp. pela Vistoria:', rightX, infoY, { size: 22, width: colWidth })}
    ${ownerName.svg}
    ${inspectorName.svg}
    ${textLine('Passaporte: ' + data.ownerId, leftX, leftPassY, { size: 21, width: colWidth })}
    ${textLine('Telefone: ' + data.ownerPhone, leftX, leftPhoneY, { size: 21, width: colWidth })}
    ${textLine('Passaporte: ' + data.inspectorId, rightX, rightPassY, { size: 21, width: colWidth })}
    ${textLine('Telefone: ' + data.inspectorPhone, rightX, rightPhoneY, { size: 21, width: colWidth })}
    ${textLine('Observações:', 25, observationsY, { size: 24, width: 970 })}
    ${observations.svg}
    ${textLine('Status da Vistoria: Aprovado', 25, statusY, { size: 24, weight: 700, width: 720 })}
    ${textLine('Data da Vistoria: ' + displayDate(date), 25, statusY + 32, { size: 24, weight: 700, width: 720 })}
    ${textLine('Validade: ' + displayDate(due), 25, statusY + 64, { size: 24, weight: 700, width: 720 })}
    ${signaturePath(inspector, 250, 1342, 430, 75)}
    <path d="M25 1360 H490" stroke="#222" stroke-width="1.5"/>
    ${textLine(inspector + ' (' + data.inspectorRank + ')', 25, 1390, { size: 21, width: 465 })}
    <image href="data:image/png;base64,${SEAL}" x="805" y="1190" width="195" height="195" preserveAspectRatio="xMidYMid meet"/>
    <rect x="0" y="1418" width="1024" height="31" fill="#f11427"/>
    ${textLine('Documento fictício para roleplay (SSFD)', 512, 1410, { size: 10, width: 390, anchor: 'middle' })}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function selectPlace(i, page = 0) {
  const all = (await places(i.guildId).get()).docs
    .filter(doc => doc.data().active !== false)
    .sort((a, b) => String(a.data().name).localeCompare(String(b.data().name), 'pt-BR'));
  if (!all.length) return i.reply({ content: 'Não existem estabelecimentos ativos.', flags: EP });
  const total = Math.ceil(all.length / 25);
  const p = Math.max(0, Math.min(page, total - 1));
  const menu = new StringSelectMenuBuilder().setCustomId('atest:choose').setPlaceholder('Selecione o estabelecimento')
    .addOptions(all.slice(p * 25, (p + 1) * 25).map(doc => ({ label: clean(doc.data().name, 100), description: clean(doc.data().location || 'Localização não informada', 100), value: doc.id })));
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (total > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`atest:page:${p - 1}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
    new ButtonBuilder().setCustomId(`atest:page:${p + 1}`).setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(p === total - 1)
  ));
  return i.reply({ content: `Selecione o estabelecimento (${p + 1}/${total}):`, components, flags: EP });
}

async function identifyInspector(i) {
  const member = await i.guild.members.fetch(i.user.id);
  if (!rankIds.some(id => member.roles.cache.has(id))) throw new Error('Somente bombeiros cadastrados podem emitir atestados.');
  const snap = await guildDoc(i.guildId).collection('registrations').doc(i.user.id).get();
  const d = snap.data() || {};
  const rank = [...rankNames.entries()].find(([id]) => member.roles.cache.has(id))?.[1] || 'Bombeiro';
  return {
    inspectorName: stripRpPrefix(d.name || member.displayName),
    inspectorId: clean(d.rpId || 'Não cadastrado', 30),
    inspectorPhone: clean(d.phone || 'Não cadastrado', 30),
    inspectorRank: rank
  };
}

async function allForumThreads(forum) {
  const threads = new Map();
  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) threads.set(thread.id, thread);
  let before;
  for (let page = 0; page < 15; page++) {
    const result = await forum.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) });
    for (const thread of result.threads.values()) threads.set(thread.id, thread);
    if (!result.hasMore || !result.threads.size) break;
    before = result.threads.last().archiveTimestamp;
  }
  return [...threads.values()];
}

async function resolveThread(guild, placeId, place) {
  const forum = await guild.channels.fetch(channels.forumRelatorios);
  if (!forum || forum.type !== 15) throw new Error('O canal de relatórios não é um fórum acessível.');
  if (place.attestationThreadId) {
    const saved = await guild.channels.fetch(place.attestationThreadId).catch(() => null);
    if (saved && saved.parentId === forum.id) return saved;
  }
  const threads = await allForumThreads(forum);
  const matches = threads.filter(t => normalize(t.name) === normalize(place.name) || normalize(t.name) === normalize(`${place.name} vistorias`) || normalize(t.name) === normalize(`${place.name} vistoria`));
  if (matches.length > 1) throw new Error('Existem múltiplas postagens com esse nome. A administração precisa identificar o tópico correto.');
  if (matches.length === 1) {
    await places(guild.id).doc(placeId).update({ attestationThreadId: matches[0].id });
    return matches[0];
  }
  // Evita criar automaticamente uma postagem duplicada quando o fórum tem muitos tópicos arquivados.
  if (threads.length >= 1500) throw new Error('Muitos tópicos no fórum. Associe manualmente a postagem antes de publicar.');
  const created = await forum.threads.create({ name: `${place.name} VISTORIAS`, message: { content: `Relatórios de vistorias — ${place.name}` }, reason: 'Novo estabelecimento com atestado SSFD' });
  await places(guild.id).doc(placeId).update({ attestationThreadId: created.id });
  return created;
}

const PHONE_MODAL = 'atest:phone:save';
const PHONE_INPUT = 'atest:phone:number';
const validPhone = phone => /^[0-9+() .-]{4,35}$/.test(phone) && phone.replace(/\D/g, '').length >= 4;

async function requirePhoneOrSelect(i) {
  const ref = guildDoc(i.guildId).collection('registrations').doc(i.user.id);
  const snapshot = await ref.get();
  const registration = snapshot.data();
  if (!snapshot.exists || registration?.status !== 'approved' || !registration?.name) {
    return i.reply({ content: 'Você precisa de um cadastro aprovado para emitir atestados.', flags: EP });
  }
  if (String(registration.phone || '').trim()) return selectPlace(i, 0);
  const modal = new ModalBuilder().setCustomId(PHONE_MODAL).setTitle('Cadastrar telefone RP');
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId(PHONE_INPUT).setLabel('Telefone do seu personagem')
    .setPlaceholder('Ex.: 555-1234').setStyle(TextInputStyle.Short)
    .setMinLength(4).setMaxLength(35).setRequired(true)));
  return i.showModal(modal);
}

async function savePhoneAndContinue(i) {
  const phone = i.fields.getTextInputValue(PHONE_INPUT).trim();
  if (!validPhone(phone)) return i.reply({ content: 'Telefone inválido. Informe pelo menos quatro dígitos; são aceitos espaços, hífens, parênteses e +.', flags: EP });
  const ref = guildDoc(i.guildId).collection('registrations').doc(i.user.id);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const registration = snap.data();
      if (!snap.exists || registration?.status !== 'approved' || !registration?.name) throw new Error('CADASTRO_INATIVO');
      // Não sobrescreve um telefone inserido em outra interação simultânea.
      if (!String(registration.phone || '').trim()) tx.update(ref, {
        phone,
        phoneUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        phoneUpdatedBy: i.user.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    console.error('[Atestados] Erro ao cadastrar telefone:', error);
    return i.reply({ content: 'Não foi possível salvar seu telefone. Verifique seu cadastro e tente novamente.', flags: EP });
  }
  return selectPlace(i, 0);
}

async function handleAtestados(i) {
  const id = i.customId;
  if (id === PHONE_MODAL) {
    await identifyInspector(i);
    return savePhoneAndContinue(i);
  }
  if (id === 'atest:start') {
    if (i.channelId !== channels.emissaoAtestados) return i.reply({ content: `Use o painel em <#${channels.emissaoAtestados}>.`, flags: EP });
    await identifyInspector(i);
    return requirePhoneOrSelect(i);
  }
  if (id.startsWith('atest:page:')) {
    await identifyInspector(i);
    return selectPlace(i, Number(id.split(':')[2]));
  }
  if (id === 'atest:choose') {
    await identifyInspector(i);
    const registration = await guildDoc(i.guildId).collection('registrations').doc(i.user.id).get();
    if (!String(registration.data()?.phone || '').trim()) return requirePhoneOrSelect(i);
    const placeId = i.values[0];
    const snap = await places(i.guildId).doc(placeId).get();
    if (!snap.exists || snap.data().active === false) return i.reply({ content: 'Estabelecimento indisponível.', flags: EP });
    const modal = new ModalBuilder().setCustomId(`atest:form:${placeId}`).setTitle('Emitir atestado');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('observations').setLabel('Observações da vistoria').setStyle(TextInputStyle.Paragraph)
      .setRequired(false).setMaxLength(350).setPlaceholder('Descreva as observações...')));
    return i.showModal(modal);
  }
  if (id.startsWith('atest:form:')) {
    await i.deferReply({ flags: EP });
    const inspector = await identifyInspector(i);
    const placeId = id.slice('atest:form:'.length);
    const snap = await places(i.guildId).doc(placeId).get();
    if (!snap.exists || snap.data().active === false) return i.editReply('Estabelecimento indisponível.');
    const place = snap.data();
    const data = {
      placeId,
      placeName: clean(place.name, 100),
      ownerName: clean(place.ownerName || 'Não cadastrado', 90),
      ownerId: clean(place.ownerId || 'Não cadastrado', 30),
      ownerPhone: clean(place.ownerPhone || 'Não cadastrado', 30),
      observations: clean(i.fields.getTextInputValue('observations'), 350),
      inspectedAt: new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z',
      ...inspector,
      authorId: i.user.id,
      createdAtMs: Date.now()
    };
    const png = await renderPNG(data);
    const draftId = randomUUID();
    await drafts(i.guildId).doc(draftId).set(data);
    const attachment = new AttachmentBuilder(png, { name: `atestado-ssfd-${draftId}.png` });
    return i.editReply({
      content: `**Prévia do atestado — ${data.placeName}**\nConfira o documento antes de publicar. O botão **Baixar Documento** abre o PNG para salvar.`,
      files: [attachment],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`atest:download:${draftId}`).setLabel('Baixar Documento').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`atest:publish:${draftId}`).setLabel('Publicar').setStyle(ButtonStyle.Success)
      )]
    });
  }
  if (id.startsWith('atest:download:')) {
    await i.deferReply({ flags: EP });
    const draftId = id.slice('atest:download:'.length);
    const snap = await drafts(i.guildId).doc(draftId).get();
    if (!snap.exists || snap.data().authorId !== i.user.id) return i.editReply('Documento indisponível.');
    const png = await renderPNG(snap.data());
    return i.editReply({
      content: 'Abra a imagem anexada e utilize a opção de download do Discord.',
      files: [new AttachmentBuilder(png, { name: `atestado-ssfd-${draftId}.png` })]
    });
  }
  if (id.startsWith('atest:publish:')) {
    await i.deferReply({ flags: EP });
    const draftId = id.slice('atest:publish:'.length);
    const ref = drafts(i.guildId).doc(draftId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().authorId !== i.user.id) return i.editReply('Prévia indisponível ou pertencente a outro usuário.');
    if (Date.now() - snapshot.data().createdAtMs > 60 * 60 * 1000) return i.editReply('Prévia expirada. Gere um novo documento.');
    const documentRef = documents(i.guildId).doc(draftId);
    const existing = await documentRef.get();
    if (existing.exists) return i.editReply('Este documento já foi publicado.');
    const placeSnap = await places(i.guildId).doc(snapshot.data().placeId).get();
    if (!placeSnap.exists || placeSnap.data().active === false) return i.editReply('Estabelecimento excluído. Publicação cancelada.');
    const data = snapshot.data();
    const png = await renderPNG(data);
    const thread = await resolveThread(i.guild, data.placeId, placeSnap.data());
    // Persistir publicação por ID para impedir duplo clique. Não apaga relatórios antigos.
    const claimed = await db.runTransaction(async tx => {
      const current = await tx.get(documentRef);
      if (current.exists) return false;
      tx.create(documentRef, { ...data, threadId: thread.id, status: 'publishing', createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return i.editReply('Este documento já está em publicação ou foi publicado.');
    try {
      const message = await thread.send({ files: [new AttachmentBuilder(png, { name: `atestado-${draftId}.png` })] });
      await documentRef.update({ status: 'published', messageId: message.id, messageUrl: message.url, publishedAt: admin.firestore.FieldValue.serverTimestamp() });
      return i.editReply(`Atestado publicado com sucesso: ${message.url}`);
    } catch (error) {
      await documentRef.update({ status: 'failed', failure: clean(error.message, 180) }).catch(() => {});
      console.error('[Atestados] Publicação falhou:', error);
      return i.editReply('Não foi possível publicar. Solicite à administração que verifique o envio antes de tentar novamente, para evitar duplicação.');
    }
  }
}

module.exports = { ensurePanel, handleAtestados, renderPNG };
