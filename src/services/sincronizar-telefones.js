'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { db, admin } = require('./firebase');
const { roles } = require('../config/ids');

const SOURCE_CHANNEL = '1318928109831061534';
const PREFIX = 'synctel:';
const sessions = new Map();
const SESSION_MS = 10 * 60 * 1000;
const managerRoles = [roles.manutencao, roles.chefe, roles.chefeAdjunto, roles.chefeBatalhao];
const firefighterRoles = [roles.cadete, roles.bombeiroI, roles.bombeiroII, roles.bombeiroIII, roles.tenente, roles.capitao, roles.chefeBatalhao, roles.chefeAdjunto, roles.chefe];

function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || managerRoles.some(id => interaction.member?.roles?.cache?.has(id));
}
function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function nickParts(member) {
  const nick = member.nickname || member.displayName || '';
  const match = nick.match(/^\s*(\d+)\s*\|\s*(.+?)\s*$/);
  return match ? { passport: match[1], name: match[2] } : null;
}
function field(content, label) {
  const found = content.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\r\\n]+)`, 'im'));
  return found?.[1]?.trim() || '';
}
function parseMessage(message) {
  const content = [message.content || '', ...(message.embeds || []).map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n'))].join('\n');
  if (norm(field(content, 'cargo')) !== 'cadete') return null;
  const name = field(content, 'nome');
  const passport = field(content, 'passaporte');
  const phone = field(content, 'telefone|celular|phone');
  if (!name) return null;
  const digits = phone.replace(/\D/g, '');
  return { name, passport, phone: digits.length >= 4 && digits.length <= 20 ? phone : '', messageId: message.id, timestamp: message.createdTimestamp };
}
async function getHistory(channel) {
  let before, count = 0;
  const records = [];
  for (;;) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    count += page.size;
    for (const msg of page.values()) {
      const record = parseMessage(msg);
      if (record) records.push(record);
    }
    before = page.last().id;
    if (page.size < 100) break;
  }
  return { records, count };
}
function report(session) {
  const { stats, candidates, skipped } = session;
  const lines = [
    '**Prévia da sincronização de telefones RP**',
    `Mensagens analisadas: **${stats.messages}**`,
    `Mensagens com Cargo: Cadete: **${stats.cadets}**`,
    `Bombeiros ativos com cadastro aprovado: **${stats.active}**`,
    `Já possuem telefone no Firebase: **${stats.withPhone}**`,
    `Telefones novos encontrados com correspondência segura: **${candidates.length}**`,
    `Sem telefone nas mensagens correspondentes: **${stats.noPhone}**`,
    `Sem correspondência segura/ambíguos: **${stats.ambiguous}**`,
    '',
    '**Nenhum dado foi alterado ainda.** O botão confirma somente os telefones novos com correspondência segura.',
  ];
  if (candidates.length) {
    lines.push('', '**Prévia das atualizações:**');
    for (const c of candidates.slice(0, 15)) lines.push(`• ${c.name} (${c.passport}) → ${c.phone}`);
    if (candidates.length > 15) lines.push(`… e mais ${candidates.length - 15}.`);
  }
  if (skipped.length) {
    lines.push('', '**Pendências (amostra):**');
    for (const item of skipped.slice(0, 10)) lines.push(`• ${item}`);
    if (skipped.length > 10) lines.push(`… e mais ${skipped.length - 10}.`);
  }
  return lines.join('\n').slice(0, 1950);
}
async function analyze(interaction) {
  const channel = await interaction.guild.channels.fetch(SOURCE_CHANNEL);
  if (!channel?.messages?.fetch) throw new Error('Canal antigo indisponível ou sem permissão para ler o histórico.');
  const [{ records, count }, snapshot, members] = await Promise.all([
    getHistory(channel),
    db.collection('guilds').doc(interaction.guildId).collection('registrations').get(),
    interaction.guild.members.fetch(),
  ]);
  const byName = new Map();
  for (const r of records) {
    const key = norm(r.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  const stats = { messages: count, cadets: records.length, active: 0, withPhone: 0, noPhone: 0, ambiguous: 0 };
  const candidates = [], skipped = [];
  const registrations = snapshot.docs.filter(doc => doc.data().status === 'approved');
  for (const doc of registrations) {
    const data = doc.data();
    const member = members.get(doc.id);
    if (!member || !firefighterRoles.some(id => member.roles.cache.has(id))) continue;
    stats.active++;
    if (String(data.phone || '').trim()) { stats.withPhone++; continue; }
    const nick = nickParts(member);
    if (!nick) { stats.ambiguous++; skipped.push(`${data.name || doc.id}: apelido sem passaporte atual`); continue; }
    // Both the current nickname and Firestore name must identify the same character.
    if (norm(nick.name) !== norm(data.name)) { stats.ambiguous++; skipped.push(`${nick.name}: nome do Firebase divergente`); continue; }
    const matches = byName.get(norm(nick.name)) || [];
    if (!matches.length) { stats.noPhone++; skipped.push(`${nick.name}: sem setagem Cadete correspondente`); continue; }
    // Prefer the current-season passport when present; never trust an old passport.
    const current = matches.filter(r => r.passport === nick.passport);
    const group = current.length ? current : matches;
    const phones = [...new Set(group.map(r => r.phone).filter(Boolean))];
    if (!phones.length) { stats.noPhone++; skipped.push(`${nick.name}: setagem sem telefone`); continue; }
    if (phones.length > 1 || (!current.length && matches.some(r => r.passport && r.passport !== nick.passport))) {
      stats.ambiguous++; skipped.push(`${nick.name}: temporadas ou telefones divergentes`); continue;
    }
    // Unique normalized name among currently active members and approved records.
    const duplicate = registrations.some(other => other.id !== doc.id && norm(other.data().name) === norm(nick.name) && members.has(other.id));
    if (duplicate) { stats.ambiguous++; skipped.push(`${nick.name}: nome duplicado`); continue; }
    candidates.push({ userId: doc.id, name: nick.name, passport: nick.passport, phone: phones[0] });
  }
  return { stats, candidates, skipped, createdAt: Date.now(), owner: interaction.user.id, guildId: interaction.guildId };
}
async function handleSyncPhones(interaction) {
  if (!interaction.inGuild() || !isManager(interaction)) return interaction.reply({ content: 'Apenas chefia ou Manutenção pode usar esta sincronização.', flags: MessageFlags.Ephemeral });
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const session = await analyze(interaction);
      sessions.set(interaction.user.id, session);
      const components = session.candidates.length ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}apply`).setLabel('Confirmar atualizações').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}cancel`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
      )] : [];
      return interaction.editReply({ content: report(session), components });
    } catch (err) {
      console.error('[Sincronizar telefones] Análise:', err);
      return interaction.editReply('Falha ao analisar o canal antigo. Confira as permissões de Ver Canal e Ler Histórico de Mensagens.');
    }
  }
  if (!interaction.isButton() || !interaction.customId.startsWith(PREFIX)) return;
  const session = sessions.get(interaction.user.id);
  if (!session || session.guildId !== interaction.guildId || Date.now() - session.createdAt > SESSION_MS) {
    return interaction.reply({ content: 'Prévia expirada. Execute /sincronizar-telefones novamente.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === `${PREFIX}cancel`) {
    sessions.delete(interaction.user.id);
    return interaction.update({ content: 'Sincronização cancelada. Nenhum dado foi alterado.', components: [] });
  }
  if (interaction.customId !== `${PREFIX}apply`) return;
  sessions.delete(interaction.user.id);
  await interaction.deferUpdate();
  let updated = 0, ignored = 0;
  const registrations = db.collection('guilds').doc(interaction.guildId).collection('registrations');
  for (const candidate of session.candidates) {
    try {
      const member = await interaction.guild.members.fetch(candidate.userId).catch(() => null);
      const nick = member && nickParts(member);
      if (!nick || nick.passport !== candidate.passport || norm(nick.name) !== norm(candidate.name) || !firefighterRoles.some(id => member.roles.cache.has(id))) { ignored++; continue; }
      const applied = await db.runTransaction(async tx => {
        const ref = registrations.doc(candidate.userId);
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== 'approved' || String(snap.data().phone || '').trim() || norm(snap.data().name) !== norm(candidate.name)) return false;
        tx.update(ref, {
          phone: candidate.phone,
          phoneUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          phoneUpdatedBy: interaction.user.id,
          phoneSource: 'historico_setagem_cadete',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (applied) updated++; else ignored++;
    } catch (err) { console.error('[Sincronizar telefones] Registro:', candidate.userId, err); ignored++; }
  }
  return interaction.editReply({ content: `Sincronização concluída. **${updated}** telefone(s) preenchido(s) no Firebase; **${ignored}** ignorado(s) por segurança ou erro. Telefones existentes não foram substituídos.`, components: [] });
}
module.exports = { handleSyncPhones };
