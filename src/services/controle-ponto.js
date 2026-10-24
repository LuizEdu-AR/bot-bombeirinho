const {administrativeLog}=require('./logs-administrativos');
const { randomBytes } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, UserSelectMenuBuilder, MessageFlags, AttachmentBuilder } = require('discord.js');
const { db, admin } = require('./firebase');
const { roles } = require('../config/ids');
const { hasAnyRole } = require('../utils/permissions');

const COMMAND = [roles.tenente, roles.capitao, roles.chefeBatalhao, roles.chefeAdjunto, roles.chefe];
const RESET_ROLES = [roles.chefe, roles.chefeAdjunto];
const privateReply = content => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const guildRef = guildId => db.collection('guilds').doc(guildId);
const pointsRef = guildId => guildRef(guildId).collection('pontos');
const settingsRef = guildId => guildRef(guildId).collection('settings').doc('rankingPonto');
const duration = ms => {
  const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return `${days ? `${days}d ` : ''}${hours}h ${String(mins).padStart(2, '0')}min`;
};

// Mantém apenas resultados temporários para exportação, sem novas consultas ao Firebase.
const rankingViews = new Map();
const RANKING_TTL_MS = 15 * 60 * 1000;
const RANKING_DESCRIPTION_LIMIT = 4096;
function cleanRankingViews() {
  const now = Date.now();
  for (const [token, view] of rankingViews) {
    if (view.expiresAt <= now) rankingViews.delete(token);
  }
  while (rankingViews.size >= 100) rankingViews.delete(rankingViews.keys().next().value);
}
function rankingEmbed(view) {
  const header = `**Início:** ${view.since ? `<t:${Math.floor(view.since / 1000)}:F>` : 'Desde o início dos registros'}\n\n`;
  const lines = view.totals.map((d, i) => `${i + 1}. <@${d.id}> — **${duration(d.ms)}**`);
  let description = header;
  let shown = 0;
  for (const line of lines) {
    if (description.length + line.length + 1 > RANKING_DESCRIPTION_LIMIT - 110) break;
    description += `${line}\n`;
    shown++;
  }
  if (!lines.length) description += 'Ainda não há horas encerradas neste período.';
  if (shown < lines.length) description += `\n_Exibindo ${shown} de ${lines.length} bombeiros. O CSV contém o ranking completo._`;
  const embed = new EmbedBuilder()
    .setColor(0xc62828)
    .setTitle('SSFD • Ranking de horas — período atual')
    .setDescription(description)
    .setFooter({ text: `${view.totals.length} bombeiro(s) • Ranking completo disponível em CSV` });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`controle:ranking:exportar:${view.token}`).setLabel('Exportar CSV').setStyle(ButtonStyle.Success)
  );
  return { content: '', embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}
function rankingCsv(view) {
  const rows = [['Posição', 'ID Discord', 'Bombeiro', 'Tempo trabalhado', 'Minutos trabalhados']];
  view.totals.forEach((d, i) => rows.push([
    String(i + 1), d.id, d.name || d.id, duration(d.ms), String(Math.floor(d.ms / 60000))
  ]));
  // UTF-8 com BOM e separador de ponto e vírgula para abrir corretamente no Excel em PT-BR.
  const quote = value => `"${String(value).replace(/"/g, '""')}"`;
  return Buffer.from('\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n') + '\r\n', 'utf8');
}
const timestampMs = value => typeof value?.toMillis === 'function' ? value.toMillis() : null;
const worked = d => d.workedMs ?? Math.max(0, (d.closedAtMs || Date.now()) - d.startedAtMs - (d.pausedMs || 0) - (d.status === 'paused' ? Date.now() - (d.pauseStartedMs || Date.now()) : 0));

function panel() {
  return {
    embeds: [new EmbedBuilder().setColor(0xc62828).setTitle('🚒 SSFD • Controle de Ponto')
      .setDescription('Painel administrativo de consulta dos expedientes.\n\n**Pontos abertos:** expedientes ativos e pausados.\n**Consultar bombeiro:** histórico total de horas trabalhadas.\n**Ranking:** horas contabilizadas no período atual.\n**Resetar ranking:** inicia um novo período sem apagar o histórico.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('controle:abertos').setLabel('Pontos abertos').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('controle:consultar').setLabel('Consultar bombeiro').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('controle:ranking').setLabel('Ranking').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('controle:reset').setLabel('Resetar ranking').setStyle(ButtonStyle.Danger)
    )]
  };
}

async function memberFor(interaction) {
  return interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
}

// Calcula somente os intervalos trabalhados dentro do período, incluindo sessões
// que começaram antes do reset e terminaram depois. Os eventos são a fonte das pausas.
async function periodWorked(sessionRef, d, sinceMs) {
  if (d.status !== 'closed') return 0;
  const start = Number(d.startedAtMs);
  const end = Number(d.closedAtMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= sinceMs) return 0;
  if (start >= sinceMs) return Math.max(0, Number(d.workedMs) || 0);
  const events = await sessionRef.parent.parent.collection('events').where('sessionId', '==', sessionRef.id).get();
  const timeline = events.docs.map(s => ({ type: s.data().type, at: timestampMs(s.data().at) }))
    .filter(e => e.at !== null && e.at >= start && e.at <= end && ['pause', 'resume'].includes(e.type))
    .sort((a, b) => a.at - b.at);
  // Para dados legados sem eventos de pausa, não é seguro atribuir tempo anterior ao reset.
  if (!timeline.length && (Number(d.pausedMs) || 0) > 0) return 0;
  let cursor = start, active = true, total = 0;
  for (const event of [...timeline, { type: 'close', at: end }]) {
    if (active) total += Math.max(0, event.at - Math.max(cursor, sinceMs));
    cursor = event.at;
    if (event.type === 'pause') active = false;
    else if (event.type === 'resume') active = true;
  }
  return Math.max(0, total);
}

async function sessionTotals(pointRef, sinceMs = null) {
  const sessions = await pointRef.collection('sessions').get();
  let total = 0, period = 0, count = 0, last = null;
  for (const session of sessions.docs) {
    const d = session.data();
    if (d.status !== 'closed') continue;
    count++;
    total += Math.max(0, Number(d.workedMs) || 0);
    const closed = Number(d.closedAtMs);
    if (Number.isFinite(closed) && (last === null || closed > last)) last = closed;
    if (sinceMs !== null) period += await periodWorked(session.ref, d, sinceMs);
  }
  return { total, period, count, last };
}

async function handleControle(interaction) {
  if (!interaction.inGuild()) return interaction.reply(privateReply('Disponível apenas no servidor.'));
  const id = interaction.customId;
  if (!id?.startsWith('controle:')) return;
  const supported = ['controle:abertos', 'controle:consultar', 'controle:ranking', 'controle:selecionar:consultar', 'controle:reset', 'controle:reset:confirmar', 'controle:reset:cancelar'];
  const exportMatch = /^controle:ranking:exportar:([a-f0-9]{16})$/.exec(id);
  if (!supported.includes(id) && !exportMatch) return interaction.reply(privateReply('Esta ação foi removida do Controle de Ponto.'));
  const member = await memberFor(interaction);
  if (!member || !hasAnyRole(member, COMMAND)) return interaction.reply(privateReply('Você não possui permissão para esta ação.'));
  const canReset = hasAnyRole(member, RESET_ROLES);
  if (id.startsWith('controle:reset') && !canReset) return interaction.reply(privateReply('Somente Chefe, Chefe Adjunto ou Manutenção podem resetar o ranking.'));

  if (exportMatch) {
    const view = rankingViews.get(exportMatch[1]);
    if (!view || view.expiresAt <= Date.now() || view.guildId !== interaction.guildId) {
      return interaction.reply(privateReply('Este ranking expirou. Clique em Ranking novamente para exportar.'));
    }
    if (view.userId !== interaction.user.id) {
      return interaction.reply(privateReply('Este ranking pertence a outra consulta. Abra o seu pelo botão Ranking.'));
    }
    const file = new AttachmentBuilder(rankingCsv(view), { name: 'ranking-horas-ssfd.csv' });
    return interaction.reply({ content: 'Ranking completo em CSV:', files: [file], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  if (id === 'controle:consultar') {
    return interaction.reply({ content: '**Consultar bombeiro**\nSelecione um membro para visualizar suas horas totais.', flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('controle:selecionar:consultar').setPlaceholder('Selecione um membro').setMinValues(1).setMaxValues(1))] });
  }
  if (id === 'controle:selecionar:consultar') {
    await interaction.deferUpdate();
    const userId = interaction.values?.[0];
    if (!/^\d{17,20}$/.test(userId || '')) return interaction.editReply({ content: 'Não foi possível identificar o membro selecionado.', components: [] });
    const ref = pointsRef(interaction.guildId).doc(userId);
    const [snap, totals] = await Promise.all([ref.get(), sessionTotals(ref)]);
    const d = snap.exists ? snap.data() : null;
    const status = d ? ({ open: 'Em andamento', paused: 'Pausado', closed: 'Encerrado' }[d.status] || 'Desconhecido') : 'Sem registros';
    const last = totals.last ? `<t:${Math.floor(totals.last / 1000)}:F>` : 'Nenhum';
    return interaction.editReply({ content: `**🚒 SSFD • Histórico de Horas**\nBombeiro: <@${userId}>\n**Total trabalhado: ${duration(totals.total)}**\nExpedientes encerrados: **${totals.count}**\nStatus do último ponto: **${status}**\nÚltimo encerramento: ${last}\n\n_As horas totais não são afetadas pelo reset do ranking._`, components: [], allowedMentions: { parse: [] } });
  }
  if (id === 'controle:abertos') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snap = await pointsRef(interaction.guildId).get();
    const open = snap.docs.filter(d => ['open', 'paused'].includes(d.data().status));
    const lines = open.slice(0, 20).map(d => `<@${d.id}> — **${d.data().status === 'paused' ? 'Pausado' : 'Em andamento'}** — ${duration(worked(d.data()))}`);
    return interaction.editReply({ content: `**Pontos abertos (${open.length})**\n${lines.join('\n') || 'Nenhum expediente aberto.'}${open.length > 20 ? '\nMostrando os 20 primeiros.' : ''}`, allowedMentions: { parse: [] } });
  }
  if (id === 'controle:ranking') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [settings, snap] = await Promise.all([settingsRef(interaction.guildId).get(), pointsRef(interaction.guildId).get()]);
    const since = timestampMs(settings.data()?.periodStartedAt) ?? 0;
    const totals = [];
    for (const point of snap.docs) {
      const hours = await sessionTotals(point.ref, since);
      if (hours.period > 0) totals.push({ id: point.id, ms: hours.period });
    }
    totals.sort((a, b) => b.ms - a.ms);
    cleanRankingViews();
    const token = randomBytes(8).toString('hex');
    const view = { token, guildId: interaction.guildId, userId: interaction.user.id, since, totals, expiresAt: Date.now() + RANKING_TTL_MS };
    rankingViews.set(token, view);
    return interaction.editReply(rankingEmbed(view));
  }
  if (id === 'controle:reset') {
    const snap = await settingsRef(interaction.guildId).get();
    const since = timestampMs(snap.data()?.periodStartedAt);
    return interaction.reply({ content: `**⚠️ Confirmar reset do ranking**\nPeríodo atual: ${since ? `<t:${Math.floor(since / 1000)}:F>` : 'Desde o início dos registros'}.\n\nEsta ação iniciará um novo período. **O histórico e as horas totais dos bombeiros serão preservados.**`, flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('controle:reset:confirmar').setLabel('Confirmar reset').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('controle:reset:cancelar').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      )] });
  }
  if (id === 'controle:reset:cancelar') {
    return interaction.update({ content: 'Reset cancelado. O ranking não foi alterado.', components: [] });
  }
  if (id === 'controle:reset:confirmar') {
    await interaction.deferUpdate();
    const ref = settingsRef(interaction.guildId);
    const eventRef = guildRef(interaction.guildId).collection('rankingResets').doc();
    const now = admin.firestore.Timestamp.now();
    await db.runTransaction(async tx => {
      const previous = await tx.get(ref);
      tx.set(eventRef, { actorId: interaction.user.id, at: now, previousPeriodStartedAt: previous.data()?.periodStartedAt || null });
      tx.set(ref, { periodStartedAt: now, lastResetBy: interaction.user.id, updatedAt: now }, { merge: true });
    });
    await administrativeLog(interaction.guildId,'ranking_reset',{actorId:interaction.user.id,details:{'Período anterior':String(now.toDate().toISOString())},key:`ranking-${eventRef.id}`});
    return interaction.editReply({ content: `✅ Ranking reiniciado por <@${interaction.user.id}> em <t:${Math.floor(now.toMillis() / 1000)}:F>.\nAs horas históricas foram preservadas.`, components: [], allowedMentions: { parse: [] } });
  }
}
module.exports = { panel, handleControle };
