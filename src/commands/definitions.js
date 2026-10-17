const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
module.exports = [
 new SlashCommandBuilder().setName('analisar-estabelecimentos').setDescription('Lê o Jurídico antigo e gera relatório sem alterar o Firebase.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('sincronizar-cursos').setDescription('Salva cursos no Firebase (Chefia ou Manutenção).'),
 new SlashCommandBuilder().setName('cadastrar-bombeiro').setDescription('Cadastra manualmente um bombeiro no Firebase (Chefia ou Manutenção).')
  .addUserOption(o=>o.setName('usuario').setDescription('Membro do Discord').setRequired(true))
  .addStringOption(o=>o.setName('nome').setDescription('Nome do personagem no RP').setRequired(true).setMaxLength(80))
  .addStringOption(o=>o.setName('id').setDescription('ID do personagem no FiveM').setRequired(true).setMaxLength(15))
  .addStringOption(o=>o.setName('patente').setDescription('Patente atual no Discord').setRequired(true).addChoices(
   {name:'Cadete',value:'cadete'},{name:'Bombeiro I',value:'bombeiroI'},{name:'Bombeiro II',value:'bombeiroII'},
   {name:'Bombeiro III',value:'bombeiroIII'},{name:'Tenente',value:'tenente'},{name:'Capitão',value:'capitao'},
   {name:'Chefe de Batalhão',value:'chefeBatalhao'},{name:'Chefe Adjunto',value:'chefeAdjunto'},{name:'Chefe',value:'chefe'}))
  .addStringOption(o=>o.setName('telefone').setDescription('Telefone no RP (opcional)').setRequired(false).setMaxLength(35)),
 new SlashCommandBuilder().setName('sincronizar-ids').setDescription('Preenche IDs ausentes dos cadastros pelo apelido do Discord, com confirmação.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('padronizar-nicks').setDescription('Prévia e confirmação da padronização de apelidos, exceto Staff.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('ponto').setDescription('Inicia ou consulta seu ponto de serviço no SSFD.'),
 new SlashCommandBuilder().setName('ping').setDescription('Verifica se o Bombeirinho está online.'),
 new SlashCommandBuilder().setName('painel').setDescription('Publica um painel do Bombeirinho no canal correspondente.')
  .addStringOption(o => o.setName('tipo').setDescription('Painel a publicar').setRequired(true).addChoices({name:'Setagem',value:'setagem'}))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());
