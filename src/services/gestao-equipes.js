const { administrativePanel } = require('./panel-components-v2');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { db, admin } = require('./firebase');
const { roles, channels, teamRoles } = require('../config/ids');
const { hasAnyRole } = require('../utils/permissions');
const MANAGERS = [roles.chefeBatalhao, roles.chefeAdjunto, roles.chefe];
const captainIds = Object.values(teamRoles.captains), lieutenantIds = Object.values(teamRoles.lieutenants);
const root = g => db.collection('guilds').doc(g).collection('teams');
const state = g => db.collection('guilds').doc(g).collection('panels').doc('equipesPublicas');
const drafts = new Map();
const key = i => `${i.guildId}:${i.user.id}`;
const ephemeral = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
const rank = m => m.roles.cache.has(roles.capitao) ? 'captain' : m.roles.cache.has(roles.tenente) ? 'lieutenant' : [roles.bombeiroI, roles.bombeiroII, roles.bombeiroIII, roles.cadete].some(r => m.roles.cache.has(r)) ? 'firefighter' : null;
const name = m => (m.displayName || m.user.username).replace(/^\w+\s*\|\s*/, '').slice(0, 65);
const captaInRoles = m => captainIds.filter(id => m.roles.cache.has(id));
const cleanName = m => name(m).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 65) || m.id;
function panel() {
    return administrativePanel('SSFD • Gestão de Equipes', 'Gerencie capitães, tenentes e bombeiros. As tags são sincronizadas e o painel público é atualizado automaticamente.', [
        { id: 'equipes:captain', label: 'Criar / designar capitão', description: 'Cadastre ou designe um capitão para uma equipe.', style: ButtonStyle.Primary },
        { id: 'equipes:lieutenant', label: 'Designar tenente', description: 'Vincule um tenente a um capitão.', style: ButtonStyle.Primary },
        { id: 'equipes:firefighter', label: 'Gerenciar equipe', description: 'Adicione ou transfira bombeiros entre tenentes.', style: ButtonStyle.Success },
        { id: 'equipes:remove', label: 'Remover vínculo', description: 'Desvincule um integrante da equipe.', style: ButtonStyle.Danger }
    ]);
}
async function ensureMessage(guild, channelId, docId, content, title) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.messages?.fetch)
        throw Error(`Canal ${channelId} inacessível`);
    const ref = db.collection('guilds').doc(guild.id).collection('panels').doc(docId);
    const snap = await ref.get();
    let message = snap.data()?.channelId === channel.id && snap.data()?.messageId ? await channel.messages.fetch(snap.data().messageId).catch(() => null) : null;
    if (message?.author?.id !== guild.client.user.id)
        message = null;
    if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 });
        message = recent.find(m => m.author.id === guild.client.user.id && require('./panel-components-v2').hasPanelTitle(m, title)) || null;
    }
    if (message)
        await message.edit(content);
    else
        message = await channel.send(content);
    await ref.set({ channelId, messageId: message.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return message;
}
async function ensureTeamPanels(guild) {
    await ensureMessage(guild, channels.gestaoEquipes, 'gestaoEquipes', panel(), 'SSFD • Gestão de Equipes');
    await publishTeams(guild);
}
async function records(guildId) {
    const snap = await root(guildId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function publishTeams(guild) {
    const teams = await records(guild.id), captains = teams.filter(t => t.kind === 'captain' && t.active !== false).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const embeds = [];
    if (!captains.length)
        embeds.push(new EmbedBuilder().setColor(0xc62828).setTitle('SSFD • Equipes').setDescription('Nenhuma equipe cadastrada. A gestão poderá cadastrar os capitães pelo painel administrativo.'));
    for (const cap of captains) {
        const lts = teams.filter(t => t.kind === 'lieutenant' && t.parentId === cap.id && t.active !== false);
        const lines = [];
        for (const lt of lts) {
            lines.push(`**Tenente:** <@${lt.id}>`);
            lines.push('');
            const ff = teams.filter(t => t.kind === 'firefighter' && t.parentId === lt.id && t.active !== false);
            lines.push(...(ff.length ? ff.map(f => `• <@${f.id}>`) : ['_Nenhum bombeiro vinculado_']));
            lines.push('');
        }
        if (!lines.length)
            lines.push('_Nenhum tenente vinculado_');
        let description = '';
        let part = 1;
        for (const line of lines) {
            if (description.length + line.length + 1 > 3800) {
                embeds.push(new EmbedBuilder().setColor(0xc62828).setTitle(`SSFD • ${cap.name || 'Equipe'} (${part++})`).setDescription(description));
                description = '';
            }
            description += line + '\n';
        }
        embeds.push(new EmbedBuilder().setColor(0xc62828).setTitle(`SSFD • ${cap.name || 'Equipe'}`).setDescription(`**Capitão:** <@${cap.id}>\n\n${description}`));
    }
    const orphans = teams.filter(t => t.active !== false && t.kind !== 'captain' && (!t.parentId || !teams.some(p => p.id === t.parentId && p.active !== false)));
    if (orphans.length) {
        const lines = orphans.map(t => `• <@${t.id}> — ${t.kind === 'lieutenant' ? 'Tenente' : 'Bombeiro'} sem responsável`);
        let text = '';
        for (const line of lines) {
            if (text.length + line.length > 3800) {
                embeds.push(new EmbedBuilder().setColor(0xc62828).setTitle('SSFD • Vagas e pendências').setDescription(text));
                text = '';
            }
            text += line + '\n';
        }
        if (text)
            embeds.push(new EmbedBuilder().setColor(0xc62828).setTitle('SSFD • Vagas e pendências').setDescription(text));
    }
    // Uma mensagem persistente pode conter no máximo 10 embeds; separar blocos excedentes sem criar mensagens a cada atualização.
    const channel = await guild.channels.fetch(channels.equipes);
    if (!channel?.messages?.fetch)
        throw Error('Canal de equipes indisponível');
    const ref = state(guild.id), snap = await ref.get(), ids = Array.isArray(snap.data()?.messageIds) ? snap.data().messageIds : [];
    const chunks = [];
    for (let i = 0; i < embeds.length; i += 10)
        chunks.push(embeds.slice(i, i + 10));
    const next = [];
    for (let i = 0; i < chunks.length; i++) {
        let msg = ids[i] ? await channel.messages.fetch(ids[i]).catch(() => null) : null;
        if (msg?.author?.id !== guild.client.user.id)
            msg = null;
        if (!msg && i === 0) {
            const recent = await channel.messages.fetch({ limit: 100 });
            msg = recent.find(m => m.author.id === guild.client.user.id && m.embeds.some(e => e.title?.startsWith('SSFD • '))) || null;
        }
        const payload = { embeds: chunks[i], allowedMentions: { parse: [] } };
        if (msg)
            await msg.edit(payload);
        else
            msg = await channel.send(payload);
        next.push(msg.id);
    }
    for (const old of ids.slice(chunks.length)) {
        const msg = await channel.messages.fetch(old).catch(() => null);
        if (msg?.author?.id === guild.client.user.id)
            await msg.delete().catch(() => {
            });
    }
    await ref.set({ channelId: channel.id, messageIds: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
async function ensureIndividualRole(guild, member, kind, existingId) {
    if (existingId) {
        const found = await guild.roles.fetch(existingId).catch(() => null);
        if (found)
            return found;
    }
    const prefix = kind === 'captain' ? 'CAP. ' : 'LT. ', label = (prefix + cleanName(member)).slice(0, 100);
    const saved = (await root(guild.id).doc(member.id).get()).data();
    if (saved?.roleId) {
        const old = await guild.roles.fetch(saved.roleId).catch(() => null);
        if (old) {
            if (old.name !== label)
                await old.setName(label, 'Gestão de Equipes');
            return old;
        }
    }
    const matches = guild.roles.cache.filter(r => r.name.toLowerCase() === label.toLowerCase());
    // Nunca reutilizar cargo por nome se outro titular puder possuí-lo.
    const unassigned = [...matches.values()].find(r => !guild.members.cache.some(m => m.id !== member.id && m.roles.cache.has(r.id)));
    return unassigned || guild.roles.create({ name: label, permissions: [], mentionable: false, reason: 'Gestão de Equipes SSFD' });
}
async function setMemberTeam(guild, userId, parentId, actorId) {
    const member = await guild.members.fetch(userId), type = rank(member);
    if (!type)
        throw Error('Membro sem patente compatível');
    const all = await records(guild.id), previous = all.find(t => t.id === userId);
    if (type === 'captain' && parentId)
        throw Error('Capitão não possui superior na equipe');
    if (type !== 'captain') {
        const parent = all.find(t => t.id === parentId && t.active !== false);
        if (!parent || parent.kind !== (type === 'lieutenant' ? 'captain' : 'lieutenant'))
            throw Error('Responsável inválido ou não cadastrado');
    }
    let individual = previous?.roleId || null;
    if (type !== 'firefighter') {
        const known = type === 'captain' ? captainIds : lieutenantIds;
        const fromMember = known.find(id => member.roles.cache.has(id));
        const role = await ensureIndividualRole(guild, member, type, fromMember || individual);
        individual = role.id;
    }
    const roleIds = new Set([...captainIds, ...lieutenantIds, ...all.map(t => t.roleId).filter(Boolean)]);
    const wanted = new Set();
    if (individual)
        wanted.add(individual);
    if (type === 'lieutenant')
        wanted.add(all.find(t => t.id === parentId).roleId);
    if (type === 'firefighter')
        wanted.add(all.find(t => t.id === parentId).roleId);
    const toAdd = [...wanted].filter(id => !member.roles.cache.has(id));
    const toRemove = [...roleIds].filter(id => member.roles.cache.has(id) && !wanted.has(id));
    if (toAdd.length)
        await member.roles.add(toAdd, `Gestão de Equipes por ${actorId}`);
    if (toRemove.length)
        await member.roles.remove(toRemove, `Gestão de Equipes por ${actorId}`);
    await root(guild.id).doc(userId).set({ kind: type, parentId: parentId || null, roleId: individual || null, name: cleanName(member), active: true, updatedBy: actorId, updatedAt: admin.firestore.FieldValue.serverTimestamp(), createdAt: previous?.createdAt || admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await publishTeams(guild);
}
async function unlink(guild, userId, actorId) {
    const all = await records(guild.id), record = all.find(t => t.id === userId);
    if (!record)
        return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
        const ids = [record.roleId, record.kind === 'lieutenant' ? all.find(t => t.id === record.parentId)?.roleId : null, record.kind === 'firefighter' ? all.find(t => t.id === record.parentId)?.roleId : null].filter(Boolean);
        const present = ids.filter(id => member.roles.cache.has(id));
        if (present.length)
            await member.roles.remove(present, `Desvinculação por ${actorId}`);
    }
    await root(guild.id).doc(userId).set({ active: false, parentId: null, updatedBy: actorId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    // Subordinados permanecem cadastrados, mas sem responsável válido, até realocação administrativa.
    const children = all.filter(t => t.parentId === userId && t.active !== false);
    for (const child of children) {
        const subordinate = await guild.members.fetch(child.id).catch(() => null);
        if (subordinate && record.roleId && subordinate.roles.cache.has(record.roleId))
            await subordinate.roles.remove(record.roleId, `Desvinculação por ${actorId}`);
        await root(guild.id).doc(child.id).set({ parentId: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    await publishTeams(guild);
}
async function reconcileTeamRank(guild, userId, newRank, actorId) {
    const old = (await root(guild.id).doc(userId).get()).data();
    if (!old?.active)
        return;
    const expected = { captain: 'capitao', lieutenant: 'tenente', firefighter: null }[old.kind];
    if (newRank === 'dismissed' || (expected && newRank !== expected) || (!expected && !['bombeiroI', 'bombeiroII', 'bombeiroIII', 'cadete'].includes(newRank)))
        await unlink(guild, userId, actorId);
}
function menu(id, placeholder, options) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options.slice(0, 25)));
}
async function handleTeams(i) {
    const actor = await i.guild.members.fetch({ user: i.user.id, force: true }).catch(() => null);
    if (!hasAnyRole(actor, MANAGERS))
        return i.reply({ content: 'Apenas Chefe de Batalhão, Chefe Adjunto, Chefe e Manutenção podem gerenciar equipes.', ...ephemeral });
    const id = i.customId, all = await records(i.guildId);
    if (id === 'equipes:import')
        return i.reply({ content: 'Importar a hierarquia existente a partir das tags do Discord? Apenas integrantes com vínculos inequívocos serão incluídos. Nenhum cargo será removido.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('equipes:importconfirm').setLabel('Confirmar importação').setStyle(ButtonStyle.Success))], ...ephemeral });
    if (id === 'equipes:importconfirm') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const members = await i.guild.members.fetch();
        const current = await records(i.guildId);
        const existing = new Set(current.filter(t => t.active !== false).map(t => t.id));
        const recordsToWrite = [];
        const captainMap = new Map(), ltMap = new Map();
        for (const member of members.values()) {
            if (member.user.bot)
                continue;
            const owned = captainIds.filter(id => member.roles.cache.has(id));
            if (rank(member) === 'captain' && owned.length === 1) {
                captainMap.set(owned[0], member.id);
                if (!existing.has(member.id))
                    recordsToWrite.push({ member, kind: 'captain', parentId: null, roleId: owned[0] });
            }
        }
        for (const member of members.values()) {
            if (member.user.bot)
                continue;
            const owned = lieutenantIds.filter(id => member.roles.cache.has(id)), caps = captaInRoles(member);
            if (rank(member) === 'lieutenant' && owned.length === 1 && caps.length === 1 && captainMap.has(caps[0])) {
                ltMap.set(owned[0], member.id);
                if (!existing.has(member.id))
                    recordsToWrite.push({ member, kind: 'lieutenant', parentId: captainMap.get(caps[0]), roleId: owned[0] });
            }
        }
        for (const member of members.values()) {
            if (member.user.bot || rank(member) !== 'firefighter')
                continue;
            const owned = lieutenantIds.filter(id => member.roles.cache.has(id));
            if (owned.length === 1 && ltMap.has(owned[0]) && !existing.has(member.id))
                recordsToWrite.push({ member, kind: 'firefighter', parentId: ltMap.get(owned[0]), roleId: null });
        }
        for (const row of recordsToWrite)
            await root(i.guildId).doc(row.member.id).set({ kind: row.kind, parentId: row.parentId, roleId: row.roleId, name: cleanName(row.member), active: true, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: i.user.id }, { merge: true });
        await publishTeams(i.guild);
        return i.editReply({ content: `Importação concluída: ${recordsToWrite.length} vínculo(s) inequívoco(s) importado(s). Os demais não foram modificados.` });
    }
    if (['equipes:captain', 'equipes:lieutenant', 'equipes:firefighter', 'equipes:remove'].includes(id)) {
        const kind = id.split(':')[1];
        drafts.set(key(i), { kind, at: Date.now() });
        return i.reply({ content: kind === 'remove' ? 'Selecione o integrante que deseja desvincular:' : 'Selecione o integrante que deseja designar:', components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('equipes:user').setPlaceholder('Selecione o membro').setMinValues(1).setMaxValues(1))], ...ephemeral });
    }
    const draft = drafts.get(key(i));
    if (!draft || Date.now() - draft.at > 600000)
        return i.reply({ content: 'Operação expirada. Comece novamente pelo painel.', ...ephemeral });
    if (id === 'equipes:user') {
        const userId = i.values[0], member = await i.guild.members.fetch(userId).catch(() => null);
        if (!member || member.user.bot)
            return i.update({ content: 'Membro inválido.', components: [] });
        const expected = { captain: 'captain', lieutenant: 'lieutenant', firefighter: 'firefighter' }[draft.kind];
        if (expected && rank(member) !== expected)
            return i.update({ content: `O integrante não possui a patente exigida para ${draft.kind}.`, components: [] });
        draft.userId = userId;
        if (draft.kind === 'remove')
            return i.update({ content: `Confirma remover <@${userId}> da estrutura de equipes?`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('equipes:confirm').setLabel('Confirmar remoção').setStyle(ButtonStyle.Danger))], allowedMentions: { parse: [] } });
        if (draft.kind === 'captain')
            return i.update({ content: `Confirma designar <@${userId}> como capitão?`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('equipes:confirm').setLabel('Confirmar').setStyle(ButtonStyle.Success))], allowedMentions: { parse: [] } });
        const parents = all.filter(t => t.kind === (draft.kind === 'lieutenant' ? 'captain' : 'lieutenant') && t.active !== false);
        if (!parents.length)
            return i.update({ content: 'Cadastre primeiro o responsável hierárquico.', components: [] });
        return i.update({ content: 'Selecione o responsável:', components: [menu('equipes:parent', 'Responsável', parents.map(p => ({ label: p.name || p.id, value: p.id })))] });
    }
    if (id === 'equipes:parent') {
        draft.parentId = i.values[0];
        return i.update({ content: `Confirma a designação de <@${draft.userId}> para <@${draft.parentId}>?`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('equipes:confirm').setLabel('Confirmar').setStyle(ButtonStyle.Success))], allowedMentions: { parse: [] } });
    }
    if (id === 'equipes:confirm') {
        drafts.delete(key(i));
        await i.deferUpdate();
        try {
            if (draft.kind === 'remove')
                await unlink(i.guild, draft.userId, i.user.id);
            else
                await setMemberTeam(i.guild, draft.userId, draft.parentId || null, i.user.id);
            return i.editReply({ content: 'Gestão de Equipes atualizada. Cargos e painel público sincronizados.', components: [] });
        }
        catch (err) {
            console.error('[Equipes] Falha:', err);
            return i.editReply({ content: `Não foi possível concluir: ${err.message}. Confira permissões e os registros antes de tentar novamente.`, components: [] });
        }
    }
    return i.reply({ content: 'Ação de equipes desconhecida.', ...ephemeral });
}
module.exports = { panel, ensureTeamPanels, handleTeams, reconcileTeamRank, publishTeams };
