const { roles } = require('../config/ids');
const PATENTES = [roles.cadete,roles.bombeiroI,roles.bombeiroII,roles.bombeiroIII,roles.tenente,roles.capitao,roles.chefeBatalhao,roles.chefeAdjunto,roles.chefe];
function hasPatente(member) { return PATENTES.some(id => member.roles.cache.has(id)); }
async function fetchMember(interaction) { return interaction.guild?.members.fetch({user:interaction.user.id,force:true}).catch(() => null); }
module.exports = {hasPatente,fetchMember,PATENTES};
